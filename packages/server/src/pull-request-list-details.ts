import { pullRequestReviewDecision } from './pull-request-review-outcomes'
import { repositoryGitHubRequest } from './repository-pull-request'

type ListItem = { number: number, head: string }
type GitHubListDetails = {
  number: number
  headRefOid: string
  isDraft: boolean
  mergeable?: string
  reviewDecision?: string | null
  additions?: number
  deletions?: number
  reviewRequests?: {
    nodes?: ({ requestedReviewer?: { login?: string } | null } | null)[]
  } | null
  commits?: {
    nodes?: ({ commit?: { oid?: string, statusCheckRollup?: { state?: string } | null } } | null)[]
  }
}

type ListDetails = {
  isDraft: boolean
  reviewRequested: boolean
  reviewDecision: string
  checks: 'Passing' | 'Failing' | 'Pending' | ''
  conflicts: boolean
  additions?: number
  deletions?: number
}

const validOid = /^[a-f0-9]{40}$/u
const validLogin = /^[a-z0-9][a-z0-9-]{0,99}(?:\[bot\])?$/iu
const detailFields = `number headRefOid isDraft mergeable reviewDecision additions deletions
  reviewRequests(first: 100) { nodes { requestedReviewer { ... on User { login } } } }
  commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }`

function readChecks(state: string | undefined) {
  if (state === 'SUCCESS') return 'Passing'
  if (state === 'FAILURE' || state === 'ERROR') return 'Failing'
  if (state === 'PENDING' || state === 'EXPECTED') return 'Pending'
  return ''
}

export async function readPullRequestListDetails(path: string, repository: string, items: ListItem[], signal: AbortSignal) {
  const [owner, name] = repository.split('/')
  // The REST page provides these positive integers. GraphQL aliases tie each
  // response to its requested row, even if another row is absent or inaccessible.
  const numbers = [...new Set(items.map(item => item.number))]
  const fields = numbers.map(number => `pr${number}: pullRequest(number: ${number}) { ${detailFields} }`).join('\n')
  const response = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessPullRequestListDetails($owner: String!, $name: String!) {
      viewer { login }
      repository(owner: $owner, name: $name) { nameWithOwner isPrivate ${fields} }
    }`,
    variables: { owner, name },
  }, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))
  const body = response.body as { data?: { viewer?: { login?: string }, repository?: {
    nameWithOwner?: string
    isPrivate?: boolean
    [key: `pr${number}`]: GitHubListDetails | null | undefined
  } }, errors?: unknown[] } | null
  const data = body?.data?.repository
  if (response.status !== 200 || typeof data?.nameWithOwner !== 'string'
    || data.nameWithOwner.toLowerCase() !== repository.toLowerCase()) return null
  const login = body?.data?.viewer?.login
  const viewer = typeof login === 'string' && validLogin.test(login) ? login.toLowerCase() : ''
  const details = new Map<number, ListDetails>()
  for (const item of items) {
    const entry = data[`pr${item.number}`]
    if (entry?.number !== item.number || !validOid.test(entry.headRefOid)
      || (item.head && item.head !== entry.headRefOid) || typeof entry.isDraft !== 'boolean') continue
    const commit = entry.commits?.nodes?.[0]?.commit
    details.set(item.number, {
      isDraft: entry.isDraft,
      reviewRequested: Boolean(viewer && entry.reviewRequests?.nodes?.some(request =>
        request?.requestedReviewer?.login?.toLowerCase() === viewer)),
      reviewDecision: pullRequestReviewDecision(entry.reviewDecision),
      checks: readChecks(commit?.oid === entry.headRefOid ? commit.statusCheckRollup?.state : undefined),
      conflicts: entry.mergeable === 'CONFLICTING',
      additions: Number.isSafeInteger(entry.additions) && entry.additions! >= 0 ? entry.additions : undefined,
      deletions: Number.isSafeInteger(entry.deletions) && entry.deletions! >= 0 ? entry.deletions : undefined,
    })
  }
  return { viewer, isPrivate: data.isPrivate === true, details, incomplete: Boolean(body?.errors?.length || details.size < numbers.length) }
}
