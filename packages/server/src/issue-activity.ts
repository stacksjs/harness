import type { HarnessState } from '@harness/engine'
import type { GitHubWorkspaceRepository } from './github-workspace-repositories'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueReferenceForSelection } from './issue-repositories'
import { issueReactionEmoji, issueReactionId, reactionBar } from './issue-reactions'
import type { IssueReactionBar, IssueReactionContent, ReactionSubject } from './issue-reactions'
import { submitGitLabIssueReaction } from './gitlab-issue-reactions'
import { trustedGitHubRepositories } from './github-workspace-repositories'
import { issueWriteScope } from './issue-metadata'
import { repositoryGitHubCredential, repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const digest = /^[a-f0-9]{64}$/u
const intentPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const dateFormatter = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

type RawSubject = ReactionSubject & {
  __typename?: string, id?: string, fullDatabaseId?: string, url?: string, body?: string, createdAt?: string,
  issue?: { id?: string }, author?: { login?: string },
}

export type IssueActivityItem = {
  kind: 'comment' | 'event', id: string | number, dateLabel: string, author: string, body?: string,
  url?: string, label?: string, linkLabel?: string, reactions?: IssueReactionBar | null,
}
type RawEvent = RawSubject & {
  actor?: { login?: string }, assignee?: { login?: string }, label?: { name?: string }, currentTitle?: string, source?: {
    __typename?: string, number?: number, url?: string, repository?: { nameWithOwner?: string },
  },
}
type ActivityWindow = { before?: string, after?: string, ids?: string[] }
const reactionFields = 'id viewerCanReact reactionGroups { content viewerHasReacted reactors { totalCount } }'
const commentFields = `fullDatabaseId url body createdAt author { login } issue { id } ${reactionFields}`
const eventTypes = {
  ClosedEvent: ['CLOSED_EVENT', '', 'closed the issue'],
  ReopenedEvent: ['REOPENED_EVENT', '', 'reopened the issue'],
  LabeledEvent: ['LABELED_EVENT', 'label { name }', 'added label'],
  UnlabeledEvent: ['UNLABELED_EVENT', 'label { name }', 'removed label'],
  AssignedEvent: ['ASSIGNED_EVENT', 'assignee { ... on User { login } ... on Bot { login } }', 'assigned'],
  UnassignedEvent: ['UNASSIGNED_EVENT', 'assignee { ... on User { login } ... on Bot { login } }', 'unassigned'],
  RenamedTitleEvent: ['RENAMED_TITLE_EVENT', 'currentTitle', 'renamed the issue to'],
  CrossReferencedEvent: ['CROSS_REFERENCED_EVENT', 'source { __typename ... on Issue { number url repository { nameWithOwner } } ... on PullRequest { number url repository { nameWithOwner } } }', 'mentioned the issue from'],
} as const

export function issueActivityCursor(value: string | null | undefined) {
  return value && /^[A-Za-z0-9_+/=:-]{1,1024}$/u.test(value) ? value : ''
}

function reacted(subject: RawSubject | null | undefined, content: string) {
  const group = subject?.reactionGroups?.find(item => item?.content === content)
  return typeof group?.viewerHasReacted === 'boolean' ? group.viewerHasReacted : null
}

function dateLabel(value?: string) {
  const time = Date.parse(value ?? '')
  return Number.isFinite(time) ? dateFormatter.format(time) : ''
}

function commentItem(node: RawEvent, issueId: string, issueUrl: string, scope: string, allowed: boolean): IssueActivityItem | null {
  const id = Number(node.fullDatabaseId)
  if (!Number.isSafeInteger(id) || id < 1 || node.issue?.id !== issueId || node.url?.toLowerCase() !== issueUrl + '#issuecomment-' + id
    || typeof node.body !== 'string') return null
  return { kind: 'comment', id, author: node.author?.login ?? '', dateLabel: dateLabel(node.createdAt),
    body: node.body.slice(0, 32_768), url: issueUrl + '#issuecomment-' + id, reactions: reactionBar(node, scope, allowed, id) }
}

function eventItem(node: RawEvent): IssueActivityItem | null {
  if (!node.id || !node.__typename || !Object.hasOwn(eventTypes, node.__typename)) return null
  const [, , description] = eventTypes[node.__typename as keyof typeof eventTypes]
  const detail = node.label?.name ?? node.assignee?.login ?? node.currentTitle ?? ''
  const source = node.source
  const repo = source?.repository?.nameWithOwner
  const number = source?.number
  const kind = source?.__typename === 'Issue' ? 'issues' : source?.__typename === 'PullRequest' ? 'pull' : ''
  const valid = kind && repo && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)
    && Number.isSafeInteger(number) && number! > 0
  const url = valid ? 'https://github.com/' + repo + '/' + kind + '/' + number : ''
  const link = url && source?.url?.toLowerCase() === url.toLowerCase()
  return { kind: 'event', id: node.id, author: node.actor?.login ?? '', dateLabel: dateLabel(node.createdAt),
    label: detail ? description + ' ' + detail.slice(0, 512) : description + (source && !link ? ' another item' : ''),
    ...(link && { url, linkLabel: repo + ' #' + number }) }
}

type Identity = { repositoryId: string, issueId: string, viewer: string }
type ActivityQuery = {
  errors?: unknown[], data?: { viewer?: { id?: string }, nodes?: (RawEvent | null)[], subject?: RawSubject | null,
    repository?: { id?: string, nameWithOwner?: string, isArchived?: boolean, issue?: RawSubject & {
      number?: number, locked?: boolean, comments?: { totalCount?: number }, timelineItems?: {
        nodes?: (RawEvent | null)[], pageInfo?: { hasPreviousPage?: boolean, hasNextPage?: boolean, startCursor?: string, endCursor?: string },
      },
    } },
  },
}

function readScope(reply: Awaited<ReturnType<typeof repositoryGitHubRequest>>, repository: GitHubWorkspaceRepository, number: number) {
  const body = reply.body as ActivityQuery | null
  const data = body?.data
  const repo = data?.repository
  const issue = repo?.issue
  if (reply.status !== 200 || body?.errors?.length || !repo?.id || repo.nameWithOwner?.toLowerCase() !== repository.name.toLowerCase()
    || !issue?.id || issue.number !== number || !data?.viewer?.id) return null
  const identity: Identity = { repositoryId: repo.id, issueId: issue.id, viewer: data.viewer.id }
  return { identity, issue, data, allowed: repo.isArchived === false && issue.locked === false,
    scope: issueWriteScope(repository, identity, 'issue-reaction') }
}

export async function readIssueActivity(repository: GitHubWorkspaceRepository, number: number, window: ActivityWindow, signal: AbortSignal) {
  const [owner, name] = repository.name.split('/')
  const events = Object.values(eventTypes).map(event => event[0]).join(', ')
  const fragments = Object.entries(eventTypes).map(([name, [, fields]]) =>
    `... on ${name} { id createdAt actor { login } ${fields} }`).join('\n')
  const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
    query: `query HarnessIssueActivity($owner: String!, $name: String!, $number: Int!, $before: String, $after: String,
      $last: Int, $first: Int, $legacy: Boolean!, $ids: [ID!]!) {
      viewer { id }
      repository(owner: $owner, name: $name) {
        id nameWithOwner isArchived
        issue(number: $number) {
          number locked ${reactionFields}
          comments { totalCount }
          timelineItems(last: $last, first: $first, before: $before, after: $after, itemTypes: [ISSUE_COMMENT, ${events}])
            @skip(if: $legacy) {
            nodes { __typename ... on IssueComment { ${commentFields} } ${fragments} }
            pageInfo { hasPreviousPage hasNextPage startCursor endCursor }
          }
        }
      }
      nodes(ids: $ids) @include(if: $legacy) { __typename ... on IssueComment { ${commentFields} } }
    }`, variables: { owner, name, number, before: window.before, after: window.after, legacy: Boolean(window.ids), ids: window.ids ?? [],
      ...(window.after ? { first: 20 } : { last: 20 }) },
  }, signal)
  const read = readScope(reply, repository, number)
  if (!read) return null
  const timeline = read.issue.timelineItems
  const nodes = window.ids ? read.data.nodes : timeline?.nodes
  if (!Array.isArray(nodes)) return null
  const url = ('https://github.com/' + repository.name + '/issues/' + number).toLowerCase()
  const items = new Map<string, IssueActivityItem>()
  for (const node of nodes) {
    if (!node) continue
    const row = node.__typename === 'IssueComment' ? commentItem(node, read.identity.issueId, url, read.scope, read.allowed) : eventItem(node)
    if (row) items.set(row.kind + ':' + row.id, row)
  }
  return { items: [...items.values()], reactions: reactionBar(read.issue, read.scope, read.allowed),
    total: Number.isSafeInteger(read.issue.comments?.totalCount) ? read.issue.comments!.totalCount! : 0,
    // GitHub only guarantees the page-info flag in the direction it queried.
    older: timeline?.pageInfo?.hasPreviousPage || window.after ? issueActivityCursor(timeline?.pageInfo?.startCursor) : '',
    newer: timeline?.pageInfo?.hasNextPage || window.before ? issueActivityCursor(timeline?.pageInfo?.endCursor) : '' }
}

const messages = { updated: 'Reaction updated on GitHub.', changed: 'The issue, comment, or GitHub account changed.',
  denied: 'This GitHub account cannot react here.', unavailable: 'Could not check this reaction on GitHub.',
  pending: 'GitHub has yet to confirm the reaction. Refresh the issue to check it.' }

export async function submitIssueReaction(state: HarnessState, query: URLSearchParams, values: URLSearchParams, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const profile = Number(query.get('profile'))
  const reference = issueReferenceForSelection(query.get('selected'), Number(query.get('issue')))
  const subject = values.get('subject') ?? ''
  const scope = values.get('scope') ?? ''
  const intent = values.get('intent') ?? ''
  const [kind, content, extra] = (values.get('reaction') ?? '').split(':')
  if (!reference || !state.profiles.has(profile) || !issueReactionId.test(subject) || !digest.test(scope) || !intentPattern.test(intent)
    || extra !== undefined || !content || (kind !== 'add' && kind !== 'remove') || !issueReactionEmoji.some(([value]) => value === content)) return null
  if (reference.tracker === 'gitlab')
    return submitGitLabIssueReaction(state, profile, reference, { subject, scope, intent, content: content as IssueReactionContent, desired: kind === 'add' }, signal, receipts)
  let comment = 0
  let attempted = false
  const finish = (result: keyof typeof messages) => ({ result, message: messages[result], comment })
  try {
    const repository = (await trustedGitHubRepositories(state.workspaces.values(), profile, signal)).get(reference.repository)
    if (!repository) return finish('changed')
    const trusted = () => {
      const current = state.workspaces.get(repository.workspace.id)
      return Boolean(current?.trusted && !current.scratch && current.profileId === profile && current.path === repository.workspace.path)
    }
    const [owner, name] = repository.name.split('/')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const read = async () => readScope(await repositoryGitHubRequest(repository.path, 'graphql', {
      query: `query HarnessIssueReactionTarget($owner: String!, $name: String!, $number: Int!, $subject: ID!) {
        viewer { id }
        repository(owner: $owner, name: $name) { id nameWithOwner isArchived issue(number: $number) { id number locked } }
        subject: node(id: $subject) { __typename ... on Issue { ${reactionFields} }
          ... on IssueComment { fullDatabaseId issue { id } ${reactionFields} } }
      }`, variables: { owner, name, number: reference.number, subject },
    }, signal, credential), repository, reference.number)
    const before = await read()
    if (!before || !trusted() || before.scope !== scope) return finish('changed')
    const target = before.data.subject
    if (target?.id !== subject || (target.__typename === 'Issue' ? subject !== before.identity.issueId
      : target.__typename !== 'IssueComment' || target.issue?.id !== before.identity.issueId)) return finish('changed')
    const numericId = Number(target.fullDatabaseId)
    if (Number.isSafeInteger(numericId) && numericId > 0) comment = numericId
    const active = reacted(target, content)
    if (active === null) return finish('unavailable')
    const desired = kind === 'add'
    const key = createHash('sha256').update(JSON.stringify([intent, subject, content])).digest('hex')
    const fingerprint = createHash('sha256').update(JSON.stringify([scope, subject, content, desired])).digest('hex')
    const previous = receipts.inspect(key, fingerprint)
    if (previous === 'confirmed') return finish('updated')
    if (previous === 'conflict') return finish('changed')
    if (previous === 'pending') {
      if (active !== desired) return finish('pending')
      receipts.confirm(key, fingerprint)
      return finish('updated')
    }
    if (!before.allowed || target.viewerCanReact !== true) return finish('denied')
    const claim = receipts.claim(key, fingerprint, trusted())
    if (claim !== 'claimed') return finish(claim === 'confirmed' ? 'updated' : claim === 'pending' ? 'pending' : 'changed')
    attempted = true
    if (active !== desired) {
      const operation = desired ? 'addReaction' : 'removeReaction'
      const input = desired ? 'AddReactionInput' : 'RemoveReactionInput'
      const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
        query: `mutation HarnessChangeIssueReaction($input: ${input}!) {
          ${operation}(input: $input) { subject { ${reactionFields} } }
        }`, variables: { input: { subjectId: subject, content, clientMutationId: key } },
      }, signal, credential).catch((error: unknown) =>
        error instanceof RepositoryPullRequestError && error.status ? { status: error.status, body: null } : null)
      const body = reply?.body as { errors?: { type?: string }[], data?: Record<string, { subject?: RawSubject }> } | null
      const applied = body?.data?.[operation]?.subject
      if (applied?.id === subject && reacted(applied, content) === desired) {
        receipts.confirm(key, fingerprint)
        return finish('updated')
      }
      if (reply?.status === 401 || reply?.status === 403 || body?.errors?.some(error => error.type === 'FORBIDDEN')) {
        receipts.reject(key, fingerprint)
        return finish('denied')
      }
      const after = await read()
      const afterTarget = after?.data.subject
      if (!after || after.scope !== scope || !trusted() || afterTarget?.id !== subject
        || (target.__typename === 'IssueComment' && afterTarget.issue?.id !== after.identity.issueId)
        || reacted(afterTarget, content) !== desired)
        return finish('pending')
    }
    receipts.confirm(key, fingerprint)
    return finish('updated')
  }
  catch { return finish(attempted ? 'pending' : 'unavailable') }
}
