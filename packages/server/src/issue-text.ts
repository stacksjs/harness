import type { HarnessState } from '@harness/engine'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey } from '@harness/contract'
import { gitLabIssueCredential, readGitLabIssueText, writeGitLabIssueText } from './gitlab-issues'
import { issueReferenceForSelection, trustedIssueRepositories } from './issue-repositories'
import { issueWriteScope, readIssueMetadataAuthority } from './issue-metadata'
import { repositoryGitHubCredential, repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const writing = new Set<string>()
export const issueTextLimits = { title: 256, body: 65_536 } as const

type Field = keyof typeof issueTextLimits
export function issueTextField(value: string | null): Field | null {
  return value === 'title' || value === 'body' ? value : null
}

const messages = {
  updated: 'Issue updated on GitHub.',
  preview: '',
  write: '',
  pending: 'GitHub has yet to confirm the edit. Check GitHub to recover it.',
  changed: 'The issue, project, or signed-in account changed. Your draft is still available to copy.',
  stale: 'This field changed on GitHub. Review its current value before saving your draft.',
  denied: 'This GitHub account cannot edit this issue.',
  invalid: 'Check the field length and make sure the title is filled in.',
  refused: 'GitHub rejected the edit. Review your draft and try again.',
  unavailable: 'Could not reach GitHub. Your draft is still here.',
  busy: 'Another edit is in progress. Your draft is still here.',
}
type Result = keyof typeof messages
type Draft = { field: Field, scope: string, before: string, intent: string, text: string }

function hash(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

export function createIssueTextDraft(field: Field, scope: string, text: string): Draft {
  return { field, scope, before: hash(text), intent: crypto.randomUUID(), text }
}

export async function submitIssueText(state: HarnessState, query: URLSearchParams, values: URLSearchParams,
  signal: AbortSignal, receipts: PullRequestReplyReceipts) {
  const profile = Number(query.get('profile'))
  const reference = issueReferenceForSelection(query.get('selected'), Number(query.get('issue')))
  const field = issueTextField(values.get('field'))
  const scope = values.get('scope') ?? ''
  const before = values.get('before') ?? ''
  const intent = values.get('intent') ?? ''
  const raw = values.get('text')
  const operation = values.get('operation') ?? 'save'
  if (!reference || reference.tracker === 'forgejo' || !state.profiles.has(profile) || !field || !digestPattern.test(scope) || !digestPattern.test(before)
    || !tokenPattern.test(intent) || raw === null || !['save', 'preview', 'write', 'rebase'].includes(operation)
    || (field === 'title' && (operation === 'preview' || operation === 'write'))) return null
  const text = raw.replace(/\r\n?/gu, '\n')
  const value = field === 'title' ? text.trim() : text
  const draft = { field, scope, before, intent, text }
  const forge = reference.tracker === 'gitlab' ? 'GitLab' : 'GitHub'
  const finish = (result: Result, current?: string, nextDraft = draft) =>
    ({ result, field, draft: nextDraft, current, currentVersion: current === undefined ? '' : hash(current), message: messages[result].replaceAll('GitHub', forge) })
  if (text.length > issueTextLimits[field] || text.includes('\0') || (field === 'title' && (!value || /\n/u.test(value))))
    return finish('invalid')
  let attempted = false
  const repositoryKey = issueRepositoryKey(reference)
  const key = repositoryKey + '#' + reference.number + ':' + field
  if (writing.has(key)) return finish('busy')
  if (operation === 'save') writing.add(key)
  try {
    const repository = (await trustedIssueRepositories(state.workspaces.values(), profile, signal)).get(repositoryKey)
    if (!repository || repository.tracker === 'forgejo') return finish('changed')
    const trusted = () => {
      const workspace = state.workspaces.get(repository.workspace.id)
      return Boolean(workspace?.trusted && !workspace.scratch && workspace.profileId === profile && workspace.path === repository.workspace.path)
    }
    const gitLab = repository.tracker === 'gitlab' ? { repository, credential: await gitLabIssueCredential(repository, signal) } : null
    const credential = gitLab ? undefined : await repositoryGitHubCredential(repository.path, signal)
    const read = async () => {
      if (gitLab) return readGitLabIssueText(gitLab.repository, reference.number, signal, gitLab.credential)
      const authority = await readIssueMetadataAuthority({ repository, number: reference.number, credential, signal, includeText: true })
      return authority && { ...authority, scope: issueWriteScope(repository, authority, 'issue-text') }
    }
    const authority = await read()
    if (!authority?.text) return finish('unavailable')
    if (!trusted() || authority.scope !== scope) return finish('changed')
    const fingerprint = hash(JSON.stringify([scope, field, before, value]))
    const prior = receipts.inspect(intent, fingerprint)
    if (prior === 'confirmed') return finish('updated')
    if (prior === 'conflict') return finish('changed')
    const current = authority.text[field]
    if (prior === 'pending') {
      if (current !== value) return finish('pending')
      receipts.confirm(intent, fingerprint)
      return finish('updated')
    }
    if (!authority.canEditText) return finish('denied')
    if (operation === 'rebase') {
      if (hash(current) !== values.get('currentVersion')) return finish('stale', current)
      return finish('write', undefined, { ...createIssueTextDraft(field, scope, current), text })
    }
    if (hash(current) !== before && current !== value) return finish('stale', current)
    if (operation === 'preview' || operation === 'write') return finish(operation)
    if (current === value) return finish('updated')
    const claim = receipts.claim(intent, fingerprint, trusted())
    if (claim !== 'claimed') return finish(claim === 'confirmed' ? 'updated' : claim === 'pending' ? 'pending' : 'changed')
    attempted = true
    const updateGitHub = async () => {
      const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
        query: `mutation HarnessUpdateIssueText($input: UpdateIssueInput!) {
          updateIssue(input: $input) { issue { id ${field} } }
        }`, variables: { input: { id: authority.issueId, [field]: value, clientMutationId: intent } },
      }, signal, credential).catch((error: unknown) =>
        error instanceof RepositoryPullRequestError && error.status ? { status: error.status, body: null } : null)
      const payload = reply?.body as { data?: { updateIssue?: { issue?: { id?: string, title?: string, body?: string } } }, errors?: { type?: string }[] } | null
      const applied = payload?.data?.updateIssue?.issue
      if (applied?.id === authority.issueId && applied[field] === value) return 'updated' as const
      const denied = reply?.status === 401 || reply?.status === 403 || payload?.errors?.some(error => error.type === 'FORBIDDEN')
      if (denied) return 'denied' as const
      if (reply?.status === 422 || payload?.errors?.some(error => error.type === 'UNPROCESSABLE')) return 'refused' as const
      return 'pending' as const
    }
    const outcome = gitLab
      ? await writeGitLabIssueText(gitLab.repository, reference.number, authority.issueId, field, value, signal, gitLab.credential)
      : await updateGitHub()
    if (outcome === 'updated') {
      receipts.confirm(intent, fingerprint)
      return finish('updated')
    }
    if (outcome === 'denied' || outcome === 'refused') {
      receipts.reject(intent, fingerprint)
      return finish(outcome)
    }
    const after = await read()
    if (after?.text?.[field] === value && trusted() && after.scope === scope) {
      receipts.confirm(intent, fingerprint)
      return finish('updated')
    }
    return finish('pending')
  }
  catch { return finish(attempted ? 'pending' : 'unavailable') }
  finally { if (operation === 'save') writing.delete(key) }
}

export type IssueTextSubmission = NonNullable<Awaited<ReturnType<typeof submitIssueText>>>
