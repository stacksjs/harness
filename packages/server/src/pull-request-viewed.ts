import { repositoryGitHubRequest } from './repository-pull-request'

const fileStatesQuery = `query PullRequestViewedFiles($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { id login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid
      files(first: 100, after: $cursor) {
        nodes { path viewerViewedState }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`

export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED'
type Viewer = { id: string, login: string }
type FileState = { path: string, viewerViewedState: string }
type ViewPage = { viewer?: Viewer, repository?: { pullRequest?: { id: string, headRefOid: string,
  files?: { nodes?: (FileState | null)[], pageInfo?: { endCursor?: string, hasNextPage?: boolean } } } } }
export class FileViewedConflict extends Error {}

export async function readViewedFiles(path: string, repository: string, number: number, head: string, paths: string[], signal: AbortSignal, credential?: string) {
  const [owner, name] = repository.split('/')
  const remaining = new Set(paths)
  const states = new Map<string, ViewedState>()
  let cursor: string | undefined
  let viewer: Viewer | undefined
  let id: string | undefined
  for (let i = 0; i < 30; i++) {
    signal.throwIfAborted()
    const reply = await repositoryGitHubRequest(path, 'graphql', { query: fileStatesQuery, variables: { owner, name, number, cursor } }, signal, credential)
    const result = reply.body as { data?: ViewPage, errors?: unknown[] } | null
    const pull = result?.data?.repository?.pullRequest
    const account = result?.data?.viewer
    const files = pull?.files
    if (reply.status !== 200 || result?.errors?.length || !pull?.id || !account?.id || !account.login || !files) return null
    if (pull.headRefOid !== head || (viewer && viewer.id !== account.id) || (id && id !== pull.id)) throw new FileViewedConflict()
    viewer = account
    id = pull.id
    for (const entry of files.nodes ?? []) {
      if (!entry || !remaining.has(entry.path)) continue
      const state = entry.viewerViewedState
      if (state === 'VIEWED' || state === 'UNVIEWED' || state === 'DISMISSED') {
        states.set(entry.path, state)
        remaining.delete(entry.path)
      }
    }
    if (!remaining.size || !files.pageInfo?.hasNextPage) return { viewer, id, states }
    const next = files.pageInfo.endCursor
    if (!next || next === cursor) return null
    cursor = next
  }
  return viewer && id ? { viewer, id, states } : null
}

export async function writeFileViewed(path: string, id: string, file: string, viewed: boolean, signal: AbortSignal, credential: string) {
  const operation = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const query = `mutation SetPullRequestFileViewed($id: ID!, $path: String!) { ${operation}(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
  await repositoryGitHubRequest(path, 'graphql', { query, variables: { id, path: file } }, signal, credential)
}
