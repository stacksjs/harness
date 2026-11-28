import type { HarnessState } from '@harness/engine'
import type { GitHubWorkspaceRepository } from './github-workspace-repositories'
import type { RawIssueStatus, RawPlanningStatuses } from './issue-status'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { githubIssueReference } from '@harness/contract'
import { trustedGitHubRepositories } from './github-workspace-repositories'
import { issueStatusPlan, saveIssueStatus } from './issue-status'
import { applyPullRequestLabelChanges, parseLabelSelection, readPullRequestLabelEditor } from './pull-request-labels'
import { repositoryGitHubCredential, repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const maxAssigneeOptions = 150
const changingStatus = new Set<string>()
const triage = new Set(['TRIAGE', 'MODERATE', 'WRITE', 'MAINTAIN', 'ADMIN'])
const nodeId = /^[A-Za-z0-9_+\/=:.-]{1,256}$/u
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export type IssueMetadataKind = 'labels' | 'assignees' | 'state'
export function issueMetadataKind(value: string | null): IssueMetadataKind | null {
  return value === 'labels' || value === 'assignees' || value === 'state' ? value : null
}

type Person = { key: string, name: string, description: string }
type Option = Person & { applied: boolean, checked: boolean, archived?: boolean }
type Change = Option & { apply: boolean }
type Authority = { repositoryId: string, issueId: string, viewer: string, canEdit: boolean, canEditText: boolean, text: { title: string, body: string } | null, commentBlocked: string, assignees: Person[], status: ReturnType<typeof issueStatusPlan> }
type MetadataContext = { repository: GitHubWorkspaceRepository, number: number, credential?: string, signal: AbortSignal, includeText?: boolean }
export type IssueMetadataForm = { kind: IssueMetadataKind, intent: string, revision: string, scope: string, checked: string[] }
export type IssueMetadataEditor = IssueMetadataForm & { options: Option[], search: string, more: boolean, matches: number }

function id(value: unknown): value is string {
  return typeof value === 'string' && nodeId.test(value)
}

function person(value: { id?: unknown, login?: unknown, name?: unknown } | null): Person | null {
  if (!id(value?.id) || typeof value.login !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}(?:\[bot\])?$/iu.test(value.login)) return null
  return { key: value.id, name: value.login, description: typeof value.name === 'string' ? value.name.slice(0, 160) : '' }
}

export async function readIssueMetadataAuthority({ repository, number, credential, signal, includeText }: MetadataContext): Promise<Authority | null> {
  const [owner, name] = repository.name.split('/')
  type AuthorityResponse = {
    errors?: { extensions?: { type?: string, code?: string, fieldName?: string } }[], data?: { viewer?: { id?: unknown }, repository?: {
      id?: unknown, nameWithOwner?: string, isArchived?: boolean, viewerPermission?: string,
      planningStatuses?: RawPlanningStatuses,
      issue?: RawIssueStatus & { id?: unknown, number?: number, locked?: boolean, viewerCanUpdate?: boolean, title?: unknown, body?: unknown, assignees?: { nodes?: (Parameters<typeof person>[0])[], pageInfo?: { hasNextPage?: boolean } } },
    } },
  }
  const fields = 'id name category { state stateReason }'
  const request = (planning: boolean) => repositoryGitHubRequest(repository.path, 'graphql', {
    query: `query HarnessIssueMetadataAuthority($owner: String!, $name: String!, $number: Int!) {
      viewer { id }
      repository(owner: $owner, name: $name) {
        id nameWithOwner viewerPermission isArchived
        ${planning ? `planningStatuses(first: 50) { nodes { ${fields} } pageInfo { hasNextPage } }` : ''}
        issue(number: $number) {
          id number state stateReason viewerCanClose viewerCanReopen locked viewerCanUpdate
          ${includeText ? 'title body' : ''}
          ${planning ? `viewerCanSetStatus status { ${fields} }` : ''}
          assignees(first: 100) { nodes { id login name } pageInfo { hasNextPage } }
        }
      }
    }`, variables: { owner, name, number },
  }, signal, credential)
  let reply = await request(true)
  let response = reply.body as AuthorityResponse | null
  if (response?.errors?.length && response.errors.every(({ extensions }) =>
    (extensions?.code ?? extensions?.type) === 'undefinedField' && ['planningStatuses', 'viewerCanSetStatus', 'status'].includes(extensions?.fieldName ?? ''))) {
    reply = await request(false)
    response = reply.body as AuthorityResponse | null
  }
  const repo = response?.data?.repository
  const issue = repo?.issue
  const viewer = response?.data?.viewer?.id
  const nodes = issue?.assignees?.nodes
  if (reply.status !== 200 || response?.errors?.length || repo?.nameWithOwner?.toLowerCase() !== repository.name.toLowerCase()
    || !id(repo.id) || !id(issue?.id) || issue.number !== number || !id(viewer)
    || issue.assignees?.pageInfo?.hasNextPage !== false || !Array.isArray(nodes)) return null
  const assignees = nodes.map(person)
  if (assignees.some(actor => !actor)) return null
  const canEdit = repo.isArchived === false && triage.has(repo.viewerPermission ?? '')
  const commentBlocked = repo.isArchived !== false ? 'This repository is archived.'
    : issue.locked !== false && !canEdit ? 'This issue is locked.' : ''
  const canEditText = repo.isArchived === false && issue.viewerCanUpdate === true
  const text = typeof issue.title === 'string' && typeof issue.body === 'string' ? { title: issue.title, body: issue.body } : null
  return { repositoryId: repo.id, issueId: issue.id, viewer, canEdit, canEditText, text, commentBlocked, assignees: assignees.filter(actor => actor !== null),
    status: issueStatusPlan(issue, repo.planningStatuses, repo.isArchived === false) }
}

async function searchAssignees({ repository, credential, signal }: MetadataContext, search: string) {
  const [owner, name] = repository.name.split('/')
  const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
    query: `query HarnessIssueAssignablePeople($owner: String!, $name: String!, $search: String!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        assignableUsers(first: 50, query: $search) { nodes { id login name } pageInfo { hasNextPage } }
      }
    }`, variables: { owner, name, search },
  }, signal, credential)
  const response = reply.body as { errors?: unknown[], data?: { repository?: {
    nameWithOwner?: string, assignableUsers?: { nodes?: Parameters<typeof person>[0][], pageInfo?: { hasNextPage?: boolean } },
  } } } | null
  const repo = response?.data?.repository
  const users = repo?.assignableUsers
  if (reply.status !== 200 || response?.errors?.length || repo?.nameWithOwner?.toLowerCase() !== repository.name.toLowerCase()
    || !Array.isArray(users?.nodes)) return null
  return { users: users.nodes.map(person).filter(actor => actor !== null), more: users.pageInfo?.hasNextPage === true }
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function revision(context: MetadataContext, authority: Authority, form: Pick<IssueMetadataForm, 'kind' | 'intent' | 'scope'>) {
  return hash(['issue-metadata', context.repository.workspace.profileId, context.repository.workspace.id,
    authority.repositoryId, authority.issueId, authority.viewer, form.kind, form.intent, form.scope])
}

function parseAssignees(scope: string, checked: string[]) {
  let rows: unknown
  try { rows = JSON.parse(scope) }
  catch { return null }
  if (!Array.isArray(rows) || rows.length > maxAssigneeOptions) return null
  const selected = new Set(checked)
  if (selected.size !== checked.length) return null
  const options = new Map<string, Option>()
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 4 || typeof row[3] !== 'boolean') return null
    const actor = person({ id: row[0], login: row[1], name: row[2] })
    if (!actor || options.has(actor.key)) return null
    options.set(actor.key, { ...actor, applied: row[3], checked: selected.has(actor.key) })
  }
  if (checked.some(key => !options.has(key))) return null
  return {
    options: [...options.values()],
    changes: [...options.values()].filter(option => option.checked !== option.applied).map(option => ({ ...option, apply: option.checked })),
  }
}

function assigneeOptions(authority: Authority, catalog: Person[], staged: Change[]) {
  const options = new Map<string, Option>(authority.assignees.map(actor => [actor.key, { ...actor, applied: true, checked: true }]))
  for (const change of staged) if (options.has(change.key) !== change.apply)
    options.set(change.key, { ...change, applied: options.has(change.key), checked: change.apply })
  if (options.size > maxAssigneeOptions) return null
  for (const actor of catalog) {
    if (options.size >= maxAssigneeOptions) break
    if (!options.has(actor.key)) options.set(actor.key, { ...actor, applied: false, checked: false })
  }
  return [...options.values()]
}

type LabelChanges = NonNullable<ReturnType<typeof parseLabelSelection>>['changes']
async function makeEditor(context: MetadataContext & { credential: string }, authority: Authority, kind: IssueMetadataKind,
  search = '', intent: string = crypto.randomUUID(), labels: LabelChanges = [], assignees: Change[] = []): Promise<IssueMetadataEditor | null> {
  if (kind === 'state') {
    const status = authority.status
    if (!status?.choices.length) return null
    const form = { kind, intent, scope: status.scope }
    return { ...form, revision: revision(context, authority, form), checked: [], search: '', more: false,
      matches: status.choices.length, options: status.choices.map(option => ({
        key: option.key, name: option.name, description: '', applied: false, checked: false,
      })) }
  }
  let options: Option[], scope: string, more: boolean, matches: number
  if (kind === 'labels') {
    const editor = await readPullRequestLabelEditor({ path: context.repository.path, repository: context.repository.name,
      number: context.number, signal: context.signal, credential: context.credential }, search, labels)
    if (!editor) return null
    options = editor.labels
    scope = editor.scope
    more = editor.more
    matches = editor.matches
  }
  else {
    const catalog = await searchAssignees(context, search)
    if (!catalog) return null
    const candidates = assigneeOptions(authority, catalog.users, assignees)
    if (!candidates) return null
    options = candidates
    scope = JSON.stringify(options.map(option => [option.key, option.name, option.description, option.applied]))
    more = catalog.more
    matches = catalog.users.length
  }
  return { kind, intent, scope, revision: revision(context, authority, { kind, intent, scope }),
    checked: options.filter(option => option.checked).map(option => option.key), options, search, more, matches }
}

export function issueWriteScope(repository: GitHubWorkspaceRepository, authority: Pick<Authority, 'repositoryId' | 'issueId' | 'viewer'>, operation: 'issue-comment' | 'issue-text' | 'issue-reaction') {
  return hash([operation, repository.workspace.profileId, repository.workspace.id, authority.repositoryId, authority.issueId, authority.viewer])
}

export async function readIssueMetadata(context: MetadataContext, kind: IssueMetadataKind | null) {
  const credential = (kind || context.includeText) ? await repositoryGitHubCredential(context.repository.path, context.signal).catch(() => undefined) : undefined
  const authority = await readIssueMetadataAuthority({ ...context, credential }).catch(() => null)
  const editor = authority && kind && credential && (kind === 'state' || authority.canEdit)
    ? await makeEditor({ ...context, credential }, authority, kind).catch(() => null)
    : null
  return { canEdit: Boolean(authority?.canEdit), editor, status: authority?.status?.current,
    canChangeStatus: Boolean(authority?.status?.choices.length),
    canEditText: Boolean(authority?.canEditText),
    editableText: context.includeText && credential && authority?.canEditText && authority.text
      ? { ...authority.text, scope: issueWriteScope(context.repository, authority, 'issue-text') } : null,
    commentScope: authority ? issueWriteScope(context.repository, authority, 'issue-comment') : '',
    commentBlocked: authority?.commentBlocked ?? 'GitHub could not check commenting access.' }
}

async function saveAssignees(context: MetadataContext & { credential: string }, authority: Authority, changes: Change[],
  receipts: PullRequestReplyReceipts, form: IssueMetadataForm, fingerprint: string, trusted: () => boolean) {
  const previous = receipts.inspect(form.intent, fingerprint)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict') return 'changed'
  if (!changes.length) return 'updated'
  let applied = new Set(authority.assignees.map(actor => actor.key))
  if (changes.some(change => change.apply && !applied.has(change.key)) && applied.size
    + changes.filter(change => change.apply && !applied.has(change.key)).length
    - changes.filter(change => !change.apply && applied.has(change.key)).length > 10) return 'limit'
  // Resolve each new actor in this repository before accepting a reviewed change.
  for (const change of changes.filter(change => change.apply && !applied.has(change.key))) {
    if (receipts.inspect(hash(['issue-assignee', form.intent, change.key]), fingerprint)) continue
    const candidates = await searchAssignees(context, change.name).catch(() => null)
    if (!candidates) return previous ? 'pending' : 'unavailable'
    if (!candidates.users.some(person => person.key === change.key && person.name.toLowerCase() === change.name.toLowerCase())) return 'changed'
  }
  const batch = receipts.claim(form.intent, fingerprint, trusted())
  if (batch === 'confirmed') return 'confirmed'
  if (batch === 'conflict' || batch === 'denied') return 'changed'
  try {
    for (const change of changes.sort((a, b) => Number(a.apply) - Number(b.apply))) {
      if (!trusted()) return 'changed'
      const key = hash(['issue-assignee', form.intent, change.key])
      const receipt = receipts.claim(key, fingerprint, true)
      if (receipt === 'confirmed') continue
      if (receipt === 'conflict') return 'changed'
      if (applied.has(change.key) === change.apply) {
        receipts.confirm(key, fingerprint)
        continue
      }
      if (receipt !== 'claimed') return 'pending'
      const name = change.apply ? 'addAssigneesToAssignable' : 'removeAssigneesFromAssignable'
      const input = change.apply ? 'AddAssigneesToAssignableInput' : 'RemoveAssigneesFromAssignableInput'
      const result = await repositoryGitHubRequest(context.repository.path, 'graphql', {
        query: `mutation HarnessIssueAssignee($input: ${input}!) {
          ${name}(input: $input) { clientMutationId }
        }`, variables: { input: { assignableId: authority.issueId, assigneeIds: [change.key], clientMutationId: key } },
      }, context.signal, context.credential)
        .catch((error: unknown) => error instanceof RepositoryPullRequestError && error.status ? { status: error.status, body: null } : null)
      if (result?.status === 401 || result?.status === 403) {
        receipts.reject(key, fingerprint)
        return 'denied'
      }
      const after = await readIssueMetadataAuthority(context)
      if (!after || after.viewer !== authority.viewer || after.issueId !== authority.issueId || after.repositoryId !== authority.repositoryId)
        return 'pending'
      applied = new Set(after.assignees.map(actor => actor.key))
      if (applied.has(change.key) === change.apply) {
        receipts.confirm(key, fingerprint)
        if (!after.canEdit) return 'pending'
        continue
      }
      const errors = (result?.body as { errors?: unknown[] } | null)?.errors
      if (result?.status === 404 || result?.status === 422 || errors?.length) {
        receipts.reject(key, fingerprint)
        return 'refused'
      }
      return 'pending'
    }
    receipts.confirm(form.intent, fingerprint)
    return 'updated'
  }
  catch { return 'pending' }
}

const messages = {
  updated: 'Issue updated on GitHub.',
  confirmed: 'GitHub already confirmed these changes.',
  search: '',
  changed: 'The issue, project, account, or selection changed. Reopen the editor to review the current issue.',
  denied: 'Changing issue labels or assignees requires triage access.',
  unavailable: 'Could not load issue editing from GitHub. Try again.',
  refused: 'GitHub refused a reviewed change. Reopen the editor to check the current issue.',
  pending: 'GitHub has yet to confirm every change.',
  busy: 'An issue status change is in progress. Reopen the issue to check the result.',
  limit: 'GitHub allows up to 10 assignees per issue.',
}
type Result = keyof typeof messages

export async function updateIssueMetadata(state: HarnessState, query: URLSearchParams, values: URLSearchParams,
  signal: AbortSignal, receipts: PullRequestReplyReceipts) {
  const profile = Number(query.get('profile'))
  const reference = githubIssueReference({ tracker: 'github', repository: query.get('selected'), number: Number(query.get('issue')) })
  const kind = issueMetadataKind(values.get('kind'))
  const scope = values.get('scope') ?? ''
  const intent = values.get('intent') ?? ''
  const reviewed = values.get('revision') ?? ''
  const selected = values.getAll('choice').sort()
  const operation = values.get('operation') ?? 'save'
  if (!reference || !state.profiles.has(profile) || !kind || !uuid.test(intent) || !/^[a-f0-9]{64}$/u.test(reviewed)
    || !scope.startsWith('[') || scope.length > 950_000 || !['save', 'search'].includes(operation)) return null
  const labels = kind === 'labels' ? parseLabelSelection(scope, selected) : null
  const assignees = kind === 'assignees' ? parseAssignees(scope, selected) : null
  if (kind === 'state' ? operation !== 'save' || selected.length !== 1 || !id(selected[0]) || scope.length > 40_000
    : !labels && !assignees) return null
  const form: IssueMetadataForm = { kind, scope, intent, revision: reviewed, checked: selected }
  const finish = (result: Result, editor?: IssueMetadataEditor | null) => ({
    result, kind, message: kind === 'state' && result === 'denied' ? 'GitHub does not allow this issue status change.'
      : messages[result], editor, draft: result === 'pending' ? form : null,
  })
  try {
    const repository = (await trustedGitHubRepositories(state.workspaces.values(), profile, signal)).get(reference.repository)
    if (!repository) return finish('changed')
    const trusted = () => {
      const current = state.workspaces.get(repository.workspace.id)
      return Boolean(current?.trusted && !current.scratch && current.profileId === profile && current.path === repository.workspace.path)
    }
    const key = reference.repository + '#' + reference.number
    if (kind === 'state' && changingStatus.has(key)) return finish('busy')
    if (kind === 'state') changingStatus.add(key)
    try {
      const credential = await repositoryGitHubCredential(repository.path, signal)
      const context = { repository, number: reference.number, credential, signal }
      const authority = await readIssueMetadataAuthority(context)
      if (!authority) return finish('unavailable')
      if (!trusted() || revision(context, authority, form) !== reviewed) return finish('changed')
      const fingerprint = hash(['issue-metadata-write', reviewed, selected])
      if (kind === 'state') {
        if (!authority.status) return finish('unavailable')
        return finish(await saveIssueStatus({ ...context, path: repository.path, name: repository.name, issueId: authority.issueId },
          authority.status, selected[0]!, scope, intent, fingerprint, receipts, trusted, async () => {
            const after = await readIssueMetadataAuthority(context)
            return after && revision(context, after, form) === reviewed ? after.status : null
          }))
      }
      if (!authority.canEdit) return finish('denied')
      if (operation === 'search') {
        if (receipts.inspect(intent, fingerprint)) return finish('changed')
        const search = (values.get('query') ?? '').slice(0, 120).replace(/\p{Cc}/gu, '').trim()
        const editor = await makeEditor(context, authority, kind, search, intent, labels?.changes, assignees?.changes).catch(() => null)
        return editor ? finish('search', editor) : finish('unavailable', { ...form, options: labels?.labels ?? assignees?.options ?? [], search, more: false, matches: -1 })
      }
      if (labels) return finish(await applyPullRequestLabelChanges({ path: repository.path, repository: repository.name,
        number: reference.number, credential, signal, receipts, trusted }, labels.changes, intent, fingerprint))
      return finish(await saveAssignees(context, authority, assignees!.changes, receipts, form, fingerprint, trusted))
    }
    finally { if (kind === 'state') changingStatus.delete(key) }
  }
  catch { return finish('unavailable') }
}
