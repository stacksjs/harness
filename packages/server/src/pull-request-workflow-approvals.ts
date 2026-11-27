import type { LifecycleSnapshot } from './pull-request-lifecycle'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { lifecycleRevision } from './pull-request-lifecycle'
import { RepositoryPullRequestError, repositoryGitHubCredential, repositoryGitHubRequest } from './repository-pull-request'

type ForkHead = { repository: string, repositoryId: string, branch: string, commit: string, pull: number, viewer: string, node: string }
type RunSelection = { id: number, attempt: number }
type ApprovalRun = RunSelection & { name: string, url: string }
type PullHead = { id?: string, number?: number, headRefOid?: string, headRepository?: { id?: string, nameWithOwner?: string } | null }
type PullHeadReply = { errors?: unknown[], data?: { viewer?: { id?: string }, repository?: {
  nameWithOwner?: string
  pullRequests?: { nodes?: (PullHead | null)[], pageInfo?: { hasNextPage?: boolean, endCursor?: string | null } }
} } }
type WorkflowRun = {
  id?: number
  run_attempt?: number
  name?: string
  status?: string
  conclusion?: string | null
  event?: string
  head_branch?: string
  head_sha?: string
  head_repository?: { full_name?: string, node_id?: string } | null
  repository?: { full_name?: string } | null
  pull_requests?: ({ number?: number } | null)[]
}

const pullHeadsQuery = 'query HarnessPullRequestWorkflowHeads($owner: String!, $name: String!, $branch: String!, $cursor: String) {'
  + ' viewer { id } repository(owner: $owner, name: $name) { nameWithOwner'
  + ' pullRequests(headRefName: $branch, first: 100, after: $cursor) { pageInfo { hasNextPage endCursor }'
  + ' nodes { id number headRefOid headRepository { id nameWithOwner } } } } }'

function repositoryMatches(left: string | undefined, right: string) {
  return typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
}

export function workflowApprovalHead(repository: string, pull: LifecycleSnapshot): ForkHead | null {
  const source = pull.headRepository
  if (pull.state !== 'OPEN' || !source?.id || !source.nameWithOwner || repositoryMatches(source.nameWithOwner, repository) || !pull.headRefName) return null
  return { repository: source.nameWithOwner, repositoryId: source.id, branch: pull.headRefName, commit: pull.headRefOid,
    pull: pull.number, viewer: pull.viewer.id, node: pull.id }
}

async function uniqueForkHead(path: string, repository: string, head: ForkHead, signal: AbortSignal, credential?: string) {
  const [owner, name] = repository.split('/')
  let cursor: string | null = null
  let found = false
  for (let page = 0; page < 10; page++) {
    const response = await repositoryGitHubRequest(path, 'graphql', {
      query: pullHeadsQuery, variables: { owner, name, branch: head.branch, cursor },
    }, signal, credential)
    const body = response.body as PullHeadReply | null
    const source = body?.data?.repository
    const results = source?.pullRequests
    if (response.status !== 200 || body?.errors?.length || body?.data?.viewer?.id !== head.viewer
      || !repositoryMatches(source?.nameWithOwner, repository) || !Array.isArray(results?.nodes)
      || typeof results.pageInfo?.hasNextPage !== 'boolean') return false
    for (const pull of results.nodes) {
      if (pull?.headRefOid !== head.commit || pull.headRepository?.id !== head.repositoryId
        || !repositoryMatches(pull.headRepository?.nameWithOwner, head.repository)) continue
      if (found || pull.number !== head.pull || pull.id !== head.node) return false
      found = true
    }
    if (!results.pageInfo.hasNextPage) return found
    const end = results.pageInfo.endCursor
    if (!end || end === cursor) return false
    cursor = end
  }
  return false
}

function matchesForkRun(run: WorkflowRun, repository: string, head: ForkHead) {
  return run.event === 'pull_request' && run.head_sha === head.commit && run.head_branch === head.branch
    && repositoryMatches(run.repository?.full_name, repository) && repositoryMatches(run.head_repository?.full_name, head.repository)
    && run.head_repository?.node_id === head.repositoryId
    && Array.isArray(run.pull_requests) && run.pull_requests.every(pull => pull?.number === head.pull)
}

function awaitingApproval(run: WorkflowRun) {
  return run.status === 'action_required' || run.conclusion === 'action_required'
}

async function listWorkflowRuns(path: string, repository: string, head: ForkHead, signal: AbortSignal, credential?: string) {
  const query = new URLSearchParams({ head_sha: head.commit, branch: head.branch, event: 'pull_request', status: 'action_required', per_page: '100' })
  const runs = new Map<number, ApprovalRun>()
  for (let page = 1; page <= 10; page++) {
    query.set('page', String(page))
    const response = await repositoryGitHubRequest(path, 'repos/' + repository + '/actions/runs?' + query, undefined, signal, credential)
    const body = response.body as { total_count?: number, workflow_runs?: WorkflowRun[] } | null
    if (response.status !== 200 || !Array.isArray(body?.workflow_runs) || (body.total_count ?? 0) > 1_000) return null
    for (const run of body.workflow_runs) {
      if (!run || !awaitingApproval(run) || !matchesForkRun(run, repository, head)) continue
      if (typeof run.id !== 'number' || !Number.isSafeInteger(run.id) || run.id <= 0
        || typeof run.run_attempt !== 'number' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0 || runs.has(run.id)) return null
      const name = typeof run.name === 'string' ? run.name.trim().slice(0, 512) : ''
      runs.set(run.id, { id: run.id, attempt: run.run_attempt, name: name || 'Workflow run ' + run.id,
        url: 'https://github.com/' + repository + '/actions/runs/' + run.id })
    }
    if (!response.hasNextPage) return [...runs.values()]
  }
  return null
}

export async function readWorkflowApprovals(path: string, repository: string, head: ForkHead, signal: AbortSignal, credential?: string) {
  const token = credential ?? await repositoryGitHubCredential(path, signal)
  const runs = await listWorkflowRuns(path, repository, head, signal, token)
  if (!runs?.length) return runs
  // Fork run payloads can omit pull_requests. Verify the source maps to exactly one PR.
  return await uniqueForkHead(path, repository, head, signal, token) ? runs : null
}

export function workflowRunSelection(runs: readonly RunSelection[]) {
  return [...runs].sort((a, b) => a.id - b.id).map(run => run.id + ':' + run.attempt).join(',')
}

export function parseWorkflowRunSelection(value: string | null) {
  if (!value || value.length > 34_000) return null
  const runs: RunSelection[] = []
  for (const item of value.split(',')) {
    if (!/^[1-9]\d{0,15}:[1-9]\d{0,15}$/u.test(item)) return null
    const [id, attempt] = item.split(':').map(Number) as [number, number]
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(attempt) || id <= (runs.at(-1)?.id ?? 0) || runs.length === 1_000) return null
    runs.push({ id, attempt })
  }
  return runs
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

type ApprovalSubmission = {
  token: string
  revision: string
  approvalRevision: string
  runs: RunSelection[]
}

export function workflowApprovalRevision(revision: string, runs: readonly ApprovalRun[]) {
  return digest([revision, workflowRunSelection(runs), [...runs].sort((a, b) => a.id - b.id).map(run => run.name)])
}

type ApprovalContext = {
  path: string
  repository: string
  before: LifecycleSnapshot
  read: () => Promise<LifecycleSnapshot | null>
  trusted: () => boolean
  authority: [number, number]
  receipts: PullRequestReplyReceipts
  signal: AbortSignal
  credential: string
}

export async function approveWorkspaceWorkflows(context: ApprovalContext, submission: ApprovalSubmission) {
  const { path, repository, before, read, trusted, receipts, signal, credential } = context
  const { token, revision, approvalRevision, runs } = submission
  const head = workflowApprovalHead(repository, before)
  if (!head) return 'changed'
  if (!before.merge.canWrite) return 'denied'
  const scope = [repository.toLowerCase(), head.node, head.repositoryId, head.repository.toLowerCase(), head.branch, head.commit]
  const selected = workflowRunSelection(runs)
  const batch = digest(['workflow-approval', context.authority, scope, head.viewer, before.baseRefName, before.baseRefOid, revision, approvalRevision, selected])
  const previous = receipts.inspect(token, batch)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict') return 'changed'
  if (!previous) {
    if (revision !== lifecycleRevision(before)) return 'changed'
    const current = await readWorkflowApprovals(path, repository, head, signal, credential)
    if (!current || selected !== workflowRunSelection(current) || approvalRevision !== workflowApprovalRevision(revision, current)) return 'changed'
    const claimed = receipts.claim(token, batch, trusted())
    if (claimed === 'denied' || claimed === 'conflict') return 'changed'
    if (claimed === 'confirmed') return 'confirmed'
  }

  try {
    for (const target of runs) {
      const runKey = digest(['workflow-run-approval', repository.toLowerCase(), target.id, target.attempt])
      const fingerprint = digest([scope, target])
      const receipt = receipts.inspect(runKey, fingerprint)
      if (receipt === 'conflict') return 'changed'
      if (receipt === 'confirmed') continue

      const current = await read()
      if (!current) return 'pending'
      const currentHead = workflowApprovalHead(repository, current)
      if (!currentHead || currentHead.viewer !== head.viewer || currentHead.repositoryId !== head.repositoryId
        || !repositoryMatches(currentHead.repository, head.repository) || currentHead.node !== head.node
        || currentHead.branch !== head.branch || currentHead.commit !== head.commit
        || current.baseRefName !== before.baseRefName || current.baseRefOid !== before.baseRefOid) return 'changed'
      if (!current.merge.canWrite) return 'denied'
      if (!trusted() || !await uniqueForkHead(path, repository, head, signal, credential)) return 'changed'

      const endpoint = 'repos/' + repository + '/actions/runs/' + target.id
      const readRun = async () => {
        const response = await repositoryGitHubRequest(path, endpoint, undefined, signal, credential)
        const run = response.body as WorkflowRun | null
        if (response.status !== 200) return null
        return run
      }
      const matches = (run: WorkflowRun) => run.id === target.id && run.run_attempt === target.attempt
        && typeof run.status === 'string' && matchesForkRun(run, repository, head)
      const run = await readRun()
      if (!run) return receipt ? 'pending' : 'changed'
      if (!matches(run) || !trusted()) return 'changed'
      if (receipt && awaitingApproval(run)) return 'pending'
      signal.throwIfAborted()
      const claimed = receipts.claim(runKey, fingerprint, true)
      if (claimed === 'conflict') return 'changed'
      if (claimed === 'confirmed') continue
      if (!awaitingApproval(run)) {
        receipts.confirm(runKey, fingerprint)
        continue
      }
      if (claimed !== 'claimed') return 'pending'

      try {
        const response = await repositoryGitHubRequest(path, endpoint + '/approve', {}, signal, credential)
        if (response.status === 201 || response.status === 204) {
          receipts.confirm(runKey, fingerprint)
          continue
        }
        if (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 422) {
          receipts.reject(runKey, fingerprint)
          return response.status === 401 || response.status === 403 ? 'denied' : 'refused'
        }
      }
      catch (error) {
        if (error instanceof RepositoryPullRequestError && (error.status === 401 || error.status === 403)) {
          receipts.reject(runKey, fingerprint)
          return 'denied'
        }
      }
      const after = await readRun()
      if (!after) return 'pending'
      if (!matches(after)) return 'changed'
      if (awaitingApproval(after)) return 'pending'
      receipts.confirm(runKey, fingerprint)
    }
    receipts.confirm(token, batch)
    return 'updated'
  }
  catch { return 'pending' }
}
