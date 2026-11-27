import { createHash } from 'node:crypto'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

const sha = /^[0-9a-f]{40}$/u
const fields = 'id number state isDraft headRefOid baseRefOid updatedAt viewerCanUpdate'
const status = ['OPEN', 'CLOSED', 'MERGED'] as const
type PullState = typeof status[number]
type LifecycleSnapshot = {
  id: string
  number: number
  state: PullState
  isDraft: boolean
  headRefOid: string
  baseRefOid: string
  updatedAt: string
  viewerCanUpdate: boolean
  viewer: { id: string, login: string }
}

export const lifecycleActions = {
  ready: { label: 'Ready for review', success: 'Pull request is ready for review.', mutation: 'markPullRequestReadyForReview' },
  draft: { label: 'Convert to draft', success: 'Pull request converted to draft.', mutation: 'convertPullRequestToDraft' },
  close: { label: 'Close pull request', success: 'Pull request closed.', mutation: 'closePullRequest' },
  reopen: { label: 'Reopen pull request', success: 'Pull request reopened.', mutation: 'reopenPullRequest' },
}

export type LifecycleAction = keyof typeof lifecycleActions

export function lifecycleAction(value: string | null): LifecycleAction | null {
  return value && Object.hasOwn(lifecycleActions, value) ? value as LifecycleAction : null
}

type ReadReply = {
  errors?: unknown[]
  data?: { viewer?: LifecycleSnapshot['viewer'], repository?: { nameWithOwner?: string, isArchived?: boolean, pullRequest?: LifecycleSnapshot } }
}

export async function readPullRequestLifecycle(path: string, repository: string, number: number, signal: AbortSignal, credential?: string): Promise<LifecycleSnapshot | null> {
  const [owner, name] = repository.split('/')
  const reply = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessPullRequestLifecycle($owner: String!, $name: String!, $number: Int!) {
      viewer { id login }
      repository(owner: $owner, name: $name) {
        nameWithOwner isArchived
        pullRequest(number: $number) { ${fields} }
      }
    }`,
    variables: { owner, name, number },
  }, signal, credential)
  const result = reply.body as ReadReply | null
  const repo = result?.data?.repository
  const pull = repo?.pullRequest
  const viewer = result?.data?.viewer
  if (reply.status !== 200 || result?.errors?.length || repo?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()
    || !pull?.id || pull.number !== number || !status.includes(pull.state) || !sha.test(pull.headRefOid) || !sha.test(pull.baseRefOid)
    || typeof pull.isDraft !== 'boolean' || !Number.isFinite(Date.parse(pull.updatedAt)) || !viewer?.id || !viewer.login) return null
  return { ...pull, viewer, viewerCanUpdate: !repo.isArchived && pull.viewerCanUpdate === true }
}

export function lifecycleRevision(pull: LifecycleSnapshot) {
  return createHash('sha256').update(JSON.stringify([pull.id, pull.viewer.id, pull.state, pull.isDraft, pull.headRefOid,
    pull.baseRefOid, pull.updatedAt])).digest('hex')
}

export function availableLifecycleActions(pull: LifecycleSnapshot): LifecycleAction[] {
  if (!pull.viewerCanUpdate || pull.state === 'MERGED') return []
  if (pull.state === 'CLOSED') return ['reopen']
  return [pull.isDraft ? 'ready' : 'draft', 'close']
}

export function lifecycleTargetReached(pull: LifecycleSnapshot, action: LifecycleAction) {
  if (action === 'close') return pull.state === 'CLOSED'
  if (pull.state !== 'OPEN') return false
  return action === 'reopen' || pull.isDraft === (action === 'draft')
}

export async function writePullRequestLifecycle(path: string, id: string, action: LifecycleAction, signal: AbortSignal, credential: string) {
  const { mutation } = lifecycleActions[action]
  try {
    const reply = await repositoryGitHubRequest(path, 'graphql', {
      query: `mutation HarnessSetPullRequestLifecycle($id: ID!) {
        ${mutation}(input: { pullRequestId: $id }) { pullRequest { id } }
      }`,
      variables: { id },
    }, signal, credential)
    const errors = (reply.body as { errors?: { type?: string }[] } | null)?.errors
    if (reply.status === 200 && errors?.length && errors.every(error => error.type === 'FORBIDDEN')) return 'denied'
    if (reply.status === 422 || (reply.status === 200 && errors?.length && errors.every(error => error.type === 'UNPROCESSABLE'))) return 'refused'
  }
  catch (error) {
    if (error instanceof RepositoryPullRequestError && (error.status === 401 || error.status === 403)) return 'denied'
  }
  // The caller confirms the resulting state independently, including after a lost response.
  return 'unconfirmed'
}
