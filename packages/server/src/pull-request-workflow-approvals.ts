import type { LifecycleSnapshot } from './pull-request-lifecycle'
import { repositoryGitHubCredential, repositoryGitHubRequest } from './repository-pull-request'

type ForkHead = { repository: string, repositoryId: string, branch: string, commit: string, pull: number, viewer: string, node: string }
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

function queuedForApproval(run: WorkflowRun, repository: string, head: ForkHead) {
  return (run.status === 'action_required' || run.conclusion === 'action_required')
    && run.event === 'pull_request' && run.head_sha === head.commit && run.head_branch === head.branch
    && repositoryMatches(run.repository?.full_name, repository) && repositoryMatches(run.head_repository?.full_name, head.repository)
    && run.head_repository?.node_id === head.repositoryId
    && Array.isArray(run.pull_requests) && run.pull_requests.every(pull => pull?.number === head.pull)
}

async function listWorkflowRuns(path: string, repository: string, head: ForkHead, signal: AbortSignal, credential?: string) {
  const query = new URLSearchParams({ head_sha: head.commit, branch: head.branch, event: 'pull_request', status: 'action_required', per_page: '100' })
  const runs = new Map<number, { id: number, attempt: number, name: string, url: string }>()
  for (let page = 1; page <= 10; page++) {
    query.set('page', String(page))
    const response = await repositoryGitHubRequest(path, 'repos/' + repository + '/actions/runs?' + query, undefined, signal, credential)
    const body = response.body as { total_count?: number, workflow_runs?: WorkflowRun[] } | null
    if (response.status !== 200 || !Array.isArray(body?.workflow_runs) || (body.total_count ?? 0) > 1_000) return null
    for (const run of body.workflow_runs) {
      if (!run || !queuedForApproval(run, repository, head)) continue
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
