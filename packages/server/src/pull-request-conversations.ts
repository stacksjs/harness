import { createHash } from 'node:crypto'
import { parseFilePatch } from './diff-patch'
import { repositoryGitHubRequest } from './repository-pull-request'

type Page<T> = { nodes?: (T | null)[], pageInfo?: { endCursor?: string, hasNextPage?: boolean } }
type CommentNode = { id?: string, author?: { login?: string }, body?: string, createdAt?: string, url?: string, isMinimized?: boolean }
type ThreadState = { id: string, isResolved: boolean, viewerCanResolve: boolean, viewerCanUnresolve: boolean }
type ThreadNode = Partial<ThreadState> & {
  path?: string
  line?: number | null
  startLine?: number | null
  diffSide?: string
  startDiffSide?: string | null
  originalLine?: number | null
  originalStartLine?: number | null
  isOutdated?: boolean
  comments?: Page<CommentNode>
}

const threadFields = 'id isResolved viewerCanResolve viewerCanUnresolve'
const threadPageQuery = `query PullRequestReviewConversations($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { id }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid
      reviewThreads(first: 40, after: $cursor) {
        nodes {
          ${threadFields}
          path line startLine diffSide startDiffSide originalLine originalStartLine isOutdated
          comments(first: 20) {
            pageInfo { hasNextPage }
            nodes { id author { login } body createdAt url isMinimized }
          }
        }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
}`
const singleThreadQuery = `query PullRequestReviewConversation($id: ID!) {
  viewer { id }
  node(id: $id) {
    ... on PullRequestReviewThread {
      ${threadFields}
      pullRequest { number headRefOid repository { nameWithOwner } }
    }
  }
}`

export const reviewThreadId = /^[A-Za-z0-9_+=/-]{1,256}$/u
export class ReviewConversationConflict extends Error {}

export function reviewConversationAnchor(id: string): string {
  return 'review-' + createHash('sha256').update(id).digest('hex').slice(0, 24)
}

function threadState(node?: ThreadNode | null): ThreadState | null {
  if (!node?.id || !reviewThreadId.test(node.id) || typeof node.isResolved !== 'boolean'
    || typeof node.viewerCanResolve !== 'boolean' || typeof node.viewerCanUnresolve !== 'boolean') return null
  return { id: node.id, isResolved: node.isResolved, viewerCanResolve: node.viewerCanResolve, viewerCanUnresolve: node.viewerCanUnresolve }
}

function reviewComment(node: CommentNode | null, thread: string, address: string) {
  if (!node?.id || !reviewThreadId.test(node.id)) return null
  const url = typeof node.url === 'string' ? URL.parse(node.url) : null
  const pull = new URL(address)
  const href = url && url.origin === pull.origin && !url.username && !url.password && !url.search
    && url.pathname.toLowerCase() === pull.pathname.toLowerCase() && /^#discussion_r\d+$/u.test(url.hash) ? url.href : ''
  return { anchor: reviewConversationAnchor(thread + ':' + node.id), href,
    author: node.author?.login?.slice(0, 128) || 'Unknown author',
    time: node.createdAt ?? '',
    text: !node.isMinimized && typeof node.body === 'string' ? node.body.slice(0, 32_768) : '',
    minimized: Boolean(node.isMinimized) }
}

function positiveLine(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function reviewConversation(node: ThreadNode | null, address: string) {
  const state = threadState(node)
  if (!state || !node?.path || typeof node.path !== 'string' || Buffer.byteLength(node.path) > 4096) return null
  const outdated = Boolean(node.isOutdated)
  const line = positiveLine(outdated ? node.originalLine : node.line)
  const start = positiveLine(outdated ? node.originalStartLine : node.startLine)
  const side = node.diffSide === 'LEFT' ? 'before' : node.diffSide === 'RIGHT' ? 'after' : null
  const rangeOnSameSide = !node.startDiffSide || node.startDiffSide === node.diffSide
  const location = line ? start && start < line && rangeOnSameSide ? 'Lines ' + start + ' to ' + line : 'Line ' + line : ''
  return { ...state, anchor: reviewConversationAnchor(state.id), path: node.path, outdated, line, side,
    location: location && side ? location + (side === 'before' ? ' before changes' : ' after changes') : location,
    comments: (node.comments?.nodes ?? []).flatMap(comment => reviewComment(comment, state.id, address) ?? []),
    moreComments: Boolean(node.comments?.pageInfo?.hasNextPage) }
}

export type ReviewConversation = NonNullable<ReturnType<typeof reviewConversation>>
export type ReviewPatchSection = { patch: string, conversations: ReviewConversation[] }
const patchPrefixes = { context: ' ', addition: '+', deletion: '-' } as const

export function placeReviewConversations(patch: string, conversations: ReviewConversation[]): ReviewPatchSection[] {
  if (!conversations.length) return patch ? [{ patch, conversations }] : []
  const pending = new Set(conversations)
  const byLine = Map.groupBy(conversations.filter(thread => !thread.outdated && thread.line && thread.side), thread => thread.side + ':' + thread.line)
  const sections: ReviewPatchSection[] = []
  let lines: string[] = []
  if (byLine.size) for (const hunk of parseFilePatch(patch)) {
    lines.push(hunk.header)
    for (const line of hunk.lines) {
      lines.push(patchPrefixes[line.kind] + line.text)
      if (line.newlineNote) lines.push('\\ ' + line.newlineNote)
      const attached = [...(byLine.get('before:' + line.before) ?? []), ...(byLine.get('after:' + line.after) ?? [])]
        .filter(thread => pending.delete(thread))
      if (attached.length) {
        sections.push({ patch: lines.join('\n'), conversations: attached })
        lines = []
      }
    }
  }
  if (sections.length) {
    if (lines.length) sections.push({ patch: lines.join('\n'), conversations: [] })
  }
  else if (patch) sections.push({ patch, conversations: [] })
  if (pending.size) sections.push({ patch: '', conversations: [...pending] })
  return sections
}

export async function readReviewConversations(path: string, repository: string, number: number, head: string, address: string, signal: AbortSignal, credential: string) {
  const [owner, name] = repository.split('/')
  type PullPage = { id: string, headRefOid: string, reviewThreads?: Page<ThreadNode> }
  type Response = { viewer?: { id?: string }, repository?: { pullRequest?: PullPage } }
  const conversations = new Map<string, ReviewConversation>()
  let cursor: string | undefined
  let viewer = ''
  let pullId = ''
  for (let page = 0; page < 25; page++) {
    signal.throwIfAborted()
    const reply = await repositoryGitHubRequest(path, 'graphql', { query: threadPageQuery, variables: { owner, name, number, cursor } }, signal, credential)
    const result = reply.body as { data?: Response, errors?: unknown[] } | null
    const pull = result?.data?.repository?.pullRequest
    const account = result?.data?.viewer?.id
    if (reply.status !== 200 || result?.errors?.length || !account || !pull?.id || !Array.isArray(pull.reviewThreads?.nodes)) return null
    if (pull.headRefOid !== head || (viewer && viewer !== account) || (pullId && pullId !== pull.id)) throw new ReviewConversationConflict()
    viewer = account
    pullId = pull.id
    for (const node of pull.reviewThreads.nodes) {
      const thread = reviewConversation(node, address)
      if (thread) conversations.set(thread.id, thread)
    }
    if (!pull.reviewThreads.pageInfo?.hasNextPage) return { viewer, conversations: [...conversations.values()], truncated: false }
    const next = pull.reviewThreads.pageInfo.endCursor
    if (!next || next === cursor) break
    cursor = next
  }
  return { viewer, conversations: [...conversations.values()], truncated: true }
}

export async function readReviewConversationState(path: string, repository: string, number: number, head: string, id: string,
  signal: AbortSignal, credential: string) {
  type ScopedThread = ThreadNode & { pullRequest?: { headRefOid?: string, number?: number, repository?: { nameWithOwner?: string } } }
  const reply = await repositoryGitHubRequest(path, 'graphql', { query: singleThreadQuery, variables: { id } }, signal, credential)
  const result = reply.body as { data?: { viewer?: { id?: string }, node?: ScopedThread }, errors?: unknown[] } | null
  const node = result?.data?.node
  const viewer = result?.data?.viewer?.id
  if (reply.status !== 200 || result?.errors?.length || !viewer) return null
  const thread = threadState(node)
  if (!thread || thread.id !== id || node?.pullRequest?.number !== number || node.pullRequest.headRefOid !== head
    || node.pullRequest.repository?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()) throw new ReviewConversationConflict()
  return { thread, viewer }
}

export async function writeReviewConversation(path: string, id: string, resolved: boolean, signal: AbortSignal, credential: string) {
  const operation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread'
  const query = `mutation SetPullRequestConversationResolved($id: ID!) { ${operation}(input: { threadId: $id }) { thread { id isResolved } } }`
  await repositoryGitHubRequest(path, 'graphql', { query, variables: { id } }, signal, credential)
}
