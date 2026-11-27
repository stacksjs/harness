import type { RepositoryPullRequest } from '@harness/contract'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

const checksQuery = `query PullRequestChecks($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title state isDraft headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $cursor) {
                nodes {
                  __typename
                  ... on CheckRun { id name status conclusion detailsUrl }
                  ... on StatusContext { id context state description targetUrl }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }
      }
    }
  }
}`

type CheckStatus = 'failed' | 'cancelled' | 'action-required' | 'pending' | 'passed' | 'skipped' | 'neutral' | 'unknown'
type Check = { id: string, name: string, status: CheckStatus, description?: string, url?: string }
type GitHubCheck = { __typename?: string, id?: string, name?: string, context?: string, status?: string, conclusion?: string | null,
  state?: string, description?: string | null, detailsUrl?: string | null, targetUrl?: string | null }
type GitHubContexts = { nodes: (GitHubCheck | null)[], pageInfo: { hasNextPage: boolean, endCursor: string | null } }
type GitHubPull = { title: string, state: 'OPEN' | 'CLOSED' | 'MERGED', isDraft: boolean, headRefOid: string,
  commits: { nodes: { commit: { oid: string, statusCheckRollup: { contexts: GitHubContexts } | null } }[] } }

function checkStatus(node: GitHubCheck): CheckStatus {
  const state = node.__typename === 'CheckRun' ? node.conclusion ?? node.status : node.state
  switch (state) {
    case 'ERROR': case 'FAILURE': case 'STARTUP_FAILURE': case 'TIMED_OUT': case 'STALE': return 'failed'
    case 'CANCELLED': return 'cancelled'
    case 'ACTION_REQUIRED': return 'action-required'
    case 'EXPECTED': case 'IN_PROGRESS': case 'PENDING': case 'QUEUED': case 'REQUESTED': case 'WAITING': return 'pending'
    case 'SUCCESS': return 'passed'
    case 'SKIPPED': return 'skipped'
    case 'NEUTRAL': return 'neutral'
    default: return 'unknown'
  }
}

function toCheck(node: GitHubCheck | null): Check | null {
  if (node?.__typename !== 'CheckRun' && node?.__typename !== 'StatusContext') return null
  const name = node.name ?? node.context
  if (typeof node.id !== 'string' || typeof name !== 'string' || !name) return null
  const target = node.detailsUrl ?? node.targetUrl
  const parsed = typeof target === 'string' && target.length <= 4096 ? URL.parse(target) : null
  return { id: node.id, name: name.slice(0, 512), status: checkStatus(node),
    description: typeof node.description === 'string' ? node.description.slice(0, 512) : undefined,
    url: parsed?.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : undefined }
}

export async function readRepositoryPullRequestChecks(path: string, link: RepositoryPullRequest, signal: AbortSignal) {
  const [owner, name] = link.repository.split('/')
  const checks = new Map<string, Check>()
  let summary: { title: string, state: GitHubPull['state'], draft: boolean, head: string } | undefined
  let cursor: string | null = null
  // Each page uses the same pull request head. A concurrent push requires a fresh read.
  for (let page = 0; page < 8; page++) {
    signal.throwIfAborted()
    const reply = await repositoryGitHubRequest(path, 'graphql', { query: checksQuery, variables: { owner, name, number: link.number, cursor } }, signal)
    const result = reply.body as { errors?: unknown[], data?: { repository?: { pullRequest?: GitHubPull | null } | null } } | null
    const pull = result?.data?.repository?.pullRequest
    if (reply.status !== 200 || result?.errors?.length || !pull)
      throw new RepositoryPullRequestError('GitHub could not read this pull request. Check the host account and repository permissions.')
    const commit = pull.commits?.nodes?.[0]?.commit
    if (!commit || !/^[0-9a-f]{40}$/u.test(pull.headRefOid) || commit.oid !== pull.headRefOid
      || (summary && summary.head !== commit.oid))
      throw new RepositoryPullRequestError('The pull request head could not be confirmed. Refresh checks and try again.')
    summary ??= { title: pull.title, state: pull.state, draft: pull.isDraft, head: commit.oid }
    const contexts = commit.statusCheckRollup?.contexts
    for (const node of contexts?.nodes ?? []) {
      const check = toCheck(node)
      if (check) checks.set(check.id, check)
    }
    if (!contexts?.pageInfo.hasNextPage) return { ...summary, checks: [...checks.values()], truncated: false }
    if (!contexts.pageInfo.endCursor || contexts.pageInfo.endCursor === cursor)
      throw new RepositoryPullRequestError('GitHub could not finish reading checks. Refresh checks and try again.')
    cursor = contexts.pageInfo.endCursor
  }
  return { ...summary!, checks: [...checks.values()], truncated: true }
}
