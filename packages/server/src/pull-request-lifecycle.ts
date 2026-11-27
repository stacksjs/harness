import { createHash } from 'node:crypto'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

const sha = /^[0-9a-f]{40}$/u
const fields = `id number state isDraft headRefOid baseRefOid baseRefName updatedAt viewerCanUpdate
  mergeable mergeStateStatus isMergeQueueEnabled mergeQueueEntry { id } autoMergeRequest { mergeMethod }
  viewerCanEnableAutoMerge viewerCanDisableAutoMerge viewerCanUpdateBranch
  revertUrl mergeCommit { oid }
  baseRef { compare(headRef: $headRef) { behindBy } }`
const status = ['OPEN', 'CLOSED', 'MERGED'] as const
const mergeableStates = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])
const writePermissions = new Set(['WRITE', 'MAINTAIN', 'ADMIN'])
type PullState = typeof status[number]
type Pull = {
  id: string
  number: number
  state: PullState
  isDraft: boolean
  headRefOid: string
  baseRefOid: string
  baseRefName: string
  updatedAt: string
  viewerCanUpdate: boolean
  mergeable?: string
  mergeStateStatus?: string
  isMergeQueueEnabled?: boolean
  mergeQueueEntry?: { id?: string } | null
  autoMergeRequest?: { mergeMethod?: string } | null
  viewerCanEnableAutoMerge?: boolean
  viewerCanDisableAutoMerge?: boolean
  viewerCanUpdateBranch?: boolean
  revertUrl?: string | null
  mergeCommit?: { oid?: string } | null
  baseRef?: { compare?: { behindBy?: number } | null } | null
}
export type LifecycleSnapshot = Pull & {
  viewer: { id: string, login: string }
  branch: { behind: number | null, canUpdate: boolean }
  merge: {
    canWrite: boolean
    methods: MergeMethod[]
    canEnableAutoMerge: boolean
    canDisableAutoMerge: boolean
  }
}

export const mergeMethods = { MERGE: 'Merge commit', SQUASH: 'Squash and merge', REBASE: 'Rebase and merge' }
export type MergeMethod = keyof typeof mergeMethods
export const branchUpdateMethods = [{ value: 'MERGE', label: 'Update with merge' }, { value: 'REBASE', label: 'Update with rebase' }] as const

export function mergeMethod(value: string | null): MergeMethod | null {
  return value && Object.hasOwn(mergeMethods, value) ? value as MergeMethod : null
}

export const lifecycleActions = {
  ready: { label: 'Ready for review', success: 'Pull request is ready for review.', mutation: 'markPullRequestReadyForReview' },
  draft: { label: 'Convert to draft', success: 'Pull request converted to draft.', mutation: 'convertPullRequestToDraft' },
  close: { label: 'Close pull request', success: 'Pull request closed.', mutation: 'closePullRequest' },
  reopen: { label: 'Reopen pull request', success: 'Pull request reopened.', mutation: 'reopenPullRequest' },
  merge: { label: 'Merge pull request', success: 'Pull request merged.', mutation: 'mergePullRequest' },
  'enable-auto-merge': { label: 'Enable auto-merge', success: 'Auto-merge enabled.', mutation: 'enablePullRequestAutoMerge' },
  'disable-auto-merge': { label: 'Disable auto-merge', success: 'Auto-merge disabled.', mutation: 'disablePullRequestAutoMerge' },
  enqueue: { label: 'Join merge queue', success: 'Pull request added to the merge queue.', mutation: 'enqueuePullRequest' },
  dequeue: { label: 'Leave merge queue', success: 'Pull request removed from the merge queue.', mutation: 'dequeuePullRequest' },
  'update-branch': { label: 'Update branch', success: 'Branch is up to date with the reviewed base.', mutation: 'updatePullRequestBranch' },
  revert: { label: 'Revert changes', success: 'Revert pull request opened on GitHub.', mutation: 'revertPullRequest' },
}

export type LifecycleAction = keyof typeof lifecycleActions

export function isMergeAction(action: LifecycleAction) {
  return action === 'merge' || action === 'enable-auto-merge' || action === 'disable-auto-merge' || action === 'enqueue' || action === 'dequeue'
}

export function takesMergeMethod(action: LifecycleAction) {
  return action === 'merge' || action === 'enable-auto-merge'
}

export function lifecycleAction(value: string | null): LifecycleAction | null {
  return value && Object.hasOwn(lifecycleActions, value) ? value as LifecycleAction : null
}

type ReadReply = {
  errors?: { path?: (string | number)[] }[]
  data?: { viewer?: LifecycleSnapshot['viewer'], repository?: {
    nameWithOwner?: string
    isArchived?: boolean
    viewerPermission?: string
    mergeCommitAllowed?: boolean
    squashMergeAllowed?: boolean
    rebaseMergeAllowed?: boolean
    autoMergeAllowed?: boolean
    pullRequest?: Pull
  } }
}

export async function readPullRequestLifecycle(path: string, repository: string, number: number, signal: AbortSignal, credential?: string): Promise<LifecycleSnapshot | null> {
  const [owner, name] = repository.split('/')
  const reply = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessPullRequestLifecycle($owner: String!, $name: String!, $number: Int!, $headRef: String!) {
      viewer { id login }
      repository(owner: $owner, name: $name) {
        nameWithOwner isArchived viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed
        pullRequest(number: $number) { ${fields} }
      }
    }`,
    variables: { owner, name, number, headRef: `refs/pull/${number}/head` },
  }, signal, credential)
  const result = reply.body as ReadReply | null
  const repo = result?.data?.repository
  const pull = repo?.pullRequest
  const viewer = result?.data?.viewer
  const errors = result?.errors ?? []
  // A deleted pull ref can make just the comparison unavailable.
  if (reply.status !== 200 || errors.some(error => error.path?.join('.') !== 'repository.pullRequest.baseRef.compare')
    || repo?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()
    || !pull?.id || pull.number !== number || !status.includes(pull.state) || !sha.test(pull.headRefOid) || !sha.test(pull.baseRefOid)
    || typeof pull.isDraft !== 'boolean' || !Number.isFinite(Date.parse(pull.updatedAt)) || !viewer?.id || !viewer.login) return null
  const canWrite = repo.isArchived === false && writePermissions.has(repo.viewerPermission ?? '')
  const methods: MergeMethod[] = []
  if (repo.mergeCommitAllowed === true) methods.push('MERGE')
  if (repo.squashMergeAllowed === true) methods.push('SQUASH')
  if (repo.rebaseMergeAllowed === true) methods.push('REBASE')
  const count = errors.length ? undefined : pull.baseRef?.compare?.behindBy
  const branch = { behind: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null,
    canUpdate: repo.isArchived === false && pull.viewerCanUpdateBranch === true && Boolean(pull.baseRefName) }
  return { ...pull, viewer, branch, viewerCanUpdate: !repo.isArchived && pull.viewerCanUpdate === true, merge: {
    canWrite: canWrite && typeof pull.baseRefName === 'string' && Boolean(pull.baseRefName),
    methods,
    canEnableAutoMerge: (repo.autoMergeAllowed === true || pull.isMergeQueueEnabled === true) && pull.viewerCanEnableAutoMerge === true,
    canDisableAutoMerge: pull.viewerCanDisableAutoMerge === true,
  } }
}

export function lifecycleRevision(pull: LifecycleSnapshot) {
  return createHash('sha256').update(JSON.stringify([pull.id, pull.viewer.id, pull.state, pull.isDraft, pull.headRefOid,
    pull.baseRefOid, pull.updatedAt, pull.baseRefName, pull.mergeStateStatus, pull.mergeable, pull.isMergeQueueEnabled,
    pull.mergeQueueEntry?.id, pull.autoMergeRequest?.mergeMethod, pull.merge, pull.branch,
    pull.revertUrl, pull.mergeCommit?.oid])).digest('hex')
}

export function behindBase(pull: LifecycleSnapshot) {
  return pull.state === 'OPEN' && pull.mergeable === 'MERGEABLE' && pull.branch.behind !== null && pull.branch.behind > 0
    ? pull.branch.behind
    : null
}

export function availableLifecycleActions(pull: LifecycleSnapshot): LifecycleAction[] {
  if (pull.state === 'MERGED') return pull.merge.canWrite && pull.revertUrl && sha.test(pull.mergeCommit?.oid ?? '') ? ['revert'] : []
  if (pull.state === 'CLOSED') return pull.viewerCanUpdate ? ['reopen'] : []
  const actions: LifecycleAction[] = pull.viewerCanUpdate ? [pull.isDraft ? 'ready' : 'draft'] : []
  if (pull.branch.canUpdate && behindBase(pull) !== null) actions.push('update-branch')
  if (pull.merge.canWrite) {
    const canMergeNow = pull.mergeable === 'MERGEABLE' && mergeableStates.has(pull.mergeStateStatus ?? '')
    if (pull.mergeQueueEntry?.id) actions.push('dequeue')
    else if (pull.autoMergeRequest) {
      if (pull.merge.canDisableAutoMerge) actions.push('disable-auto-merge')
    }
    else if (!pull.isDraft) {
      if (canMergeNow && pull.isMergeQueueEnabled === true) actions.push('enqueue')
      else if (canMergeNow && pull.isMergeQueueEnabled === false && pull.merge.methods.length) actions.push('merge')
      else if (pull.merge.canEnableAutoMerge && pull.merge.methods.length) actions.push('enable-auto-merge')
    }
  }
  if (pull.viewerCanUpdate) actions.push('close')
  return actions
}

export function lifecycleTargetReached(pull: LifecycleSnapshot, action: LifecycleAction, method: MergeMethod | null, previousHead: string) {
  if (action === 'update-branch') return pull.headRefOid !== previousHead && pull.branch.behind === 0
  if (action === 'merge') return pull.state === 'MERGED'
  if (action === 'enqueue') return pull.state === 'MERGED' || Boolean(pull.mergeQueueEntry?.id)
  if (action === 'enable-auto-merge') {
    return pull.state === 'MERGED' || Boolean(pull.mergeQueueEntry?.id)
      || Boolean(pull.autoMergeRequest && (pull.isMergeQueueEnabled || pull.autoMergeRequest.mergeMethod === method))
  }
  if (action === 'close') return pull.state === 'CLOSED'
  if (pull.state !== 'OPEN') return false
  if (action === 'dequeue') return pull.mergeQueueEntry === null
  if (action === 'disable-auto-merge') return pull.autoMergeRequest === null
  return action === 'reopen' || pull.isDraft === (action === 'draft')
}

const lifecycleInputType = {
  merge: 'MergePullRequestInput',
  'enable-auto-merge': 'EnablePullRequestAutoMergeInput',
  enqueue: 'EnqueuePullRequestInput',
  dequeue: 'DequeuePullRequestInput',
  'disable-auto-merge': 'DisablePullRequestAutoMergeInput',
  'update-branch': 'UpdatePullRequestBranchInput',
} as const

export async function writePullRequestLifecycle(path: string, pull: LifecycleSnapshot, action: Exclude<LifecycleAction, 'revert'>, method: MergeMethod | null,
  signal: AbortSignal, credential: string) {
  const { mutation } = lifecycleActions[action]
  const inputType = Object.hasOwn(lifecycleInputType, action) ? lifecycleInputType[action as keyof typeof lifecycleInputType] : null
  const parameters = inputType ? `$input: ${inputType}!` : '$id: ID!'
  const argument = inputType ? '$input' : '{ pullRequestId: $id }'
  const payload = action === 'update-branch' ? { pullRequestId: pull.id, expectedHeadOid: pull.headRefOid, updateMethod: method }
    : action === 'dequeue' ? { id: pull.id } : {
    pullRequestId: pull.id,
    ...(action === 'merge' || action === 'enqueue' || action === 'enable-auto-merge' ? { expectedHeadOid: pull.headRefOid } : {}),
    ...(method && { mergeMethod: method }),
  }
  const write = await requestPullRequestMutation(path, {
    query: `mutation HarnessSetPullRequestLifecycle(${parameters}) { ${mutation}(input: ${argument}) { __typename } }`,
    variables: inputType ? { input: payload } : { id: pull.id },
  }, signal, credential)
  return typeof write === 'string' ? write : 'unconfirmed'
}

export async function requestPullRequestMutation<T = unknown>(path: string, payload: object, signal: AbortSignal, credential: string): Promise<'denied' | 'refused' | { data?: T }> {
  try {
    const reply = await repositoryGitHubRequest(path, 'graphql', payload, signal, credential)
    const body = reply.body as { data?: T, errors?: { type?: string }[] } | null
    const errors = body?.errors
    if (reply.status === 200 && errors?.length && errors.every(error => error.type === 'FORBIDDEN')) return 'denied'
    if (reply.status === 422 || (reply.status === 200 && errors?.length && errors.every(error => error.type === 'UNPROCESSABLE'))) return 'refused'
    if (reply.status === 200 && !errors?.length) return { data: body?.data }
  }
  catch (error) {
    if (error instanceof RepositoryPullRequestError && (error.status === 401 || error.status === 403)) return 'denied'
  }
  return {}
}
