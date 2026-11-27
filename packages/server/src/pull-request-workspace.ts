import type { HarnessState, WorkspaceState } from '@harness/engine'
import type { ReviewComment, ReviewCommentWindow } from './pull-request-conversations'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { isWorkspaceGitRoot } from './diff'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { parsePullRequest, repositoryFromRemote } from './prompt-links'
import { placeReviewConversations, readReviewCommentPage, readReviewConversations, readReviewConversationState, reviewComment, reviewCommentCursor, ReviewConversationConflict, reviewConversationAnchor, reviewThreadId, writeReviewConversation, writeReviewReply } from './pull-request-conversations'
import { findPullRequestThread } from './pull-request-links'
import { readRepositoryBody, repositoryGit } from './repository-commit'
import { RepositoryPullRequestError, repositoryGitHubCredential, repositoryGitHubRequest } from './repository-pull-request'
import { readRepositoryPullRequestChecks } from './repository-pull-request-checks'
import { threadTitle } from './thread-search'
import { renderPullRequestCommentMarkdown } from './transcript-markdown'
import { FileViewedConflict, readViewedFiles, writeFileViewed } from './pull-request-viewed'

type Repository = { name: string, path: string, workspace: WorkspaceState }
type Pull = { repository: string, number: number, url: string, title: string, status: 'Open' | 'Draft' | 'Closed' | 'Merged', author: string,
  updated: string, created: string, head: string, headRef: string, baseRef: string, description: string, additions?: number, deletions?: number, changedFiles?: number }
type GitHubPull = { html_url?: string, number?: number, title?: string, body?: string | null, user?: { login?: string },
  state?: string, draft?: boolean, merged_at?: string | null, pull_request?: { merged_at?: string | null }, updated_at?: string, created_at?: string,
  head?: { sha?: string, ref?: string }, base?: { ref?: string }, additions?: number, deletions?: number, changed_files?: number }
type Activity = { id: string, author: string, time: string, state: string, text: string, commit?: string }
type ChangedFile = { path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string }

const listStates = ['open', 'closed', 'merged', 'all'] as const
const listSorts = ['updated', 'newest', 'oldest'] as const
type ListState = typeof listStates[number]
type ListSort = typeof listSorts[number]
const tabs = ['summary', 'timeline', 'code'] as const
const MAX_LIST_PAGE = 100

function integer(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function readPull(value: unknown, repository: string): Pull | null {
  if (!value || typeof value !== 'object') return null
  const pull = value as GitHubPull
  const address = typeof pull.html_url === 'string' ? parsePullRequest(pull.html_url) : null
  if (!address || address.repository.toLowerCase() !== repository.toLowerCase() || address.number !== pull.number
    || typeof pull.title !== 'string' || !['open', 'closed'].includes(pull.state ?? '')) return null
  const status = pull.merged_at || pull.pull_request?.merged_at ? 'Merged'
    : pull.state === 'closed' ? 'Closed' : pull.draft ? 'Draft' : 'Open'
  return { ...address, title: pull.title.slice(0, 512), status, author: pull.user?.login ?? '', updated: pull.updated_at ?? '', created: pull.created_at ?? '',
    head: pull.head?.sha ?? '', headRef: pull.head?.ref ?? '', baseRef: pull.base?.ref ?? '',
    description: typeof pull.body === 'string' ? pull.body.slice(0, 32_768) : '',
    additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changed_files }
}

async function repositoryNames(path: string) {
  const result = await repositoryGit(path, ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']).catch(() => null)
  return (result?.stdout ?? '').split('\0').flatMap((entry) => {
    const split = entry.indexOf('\n')
    const name = split >= 0 ? repositoryFromRemote(entry.slice(split + 1)) : null
    return name ? [name] : []
  })
}

async function trustedRepositories(workspaces: WorkspaceState[], signal: AbortSignal) {
  const found = new Map<string, Repository>()
  for (const workspace of workspaces) {
    signal.throwIfAborted()
    const roots = await scanProjectRepositories(workspace.path)
    const paths = await Promise.all(roots.map(root => resolveProjectRepository(workspace.path, root.key)))
    if (await isWorkspaceGitRoot(workspace.path)) paths.unshift(workspace.path)
    for (const path of paths) {
      if (!path) continue
      signal.throwIfAborted()
      for (const name of await repositoryNames(path)) if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, path, workspace })
    }
  }
  return found
}

function listQuery(repository: string, state: ListState, search: string, page: number, sort: ListSort) {
  const params = new URLSearchParams({ page: String(page), per_page: '20', sort: sort === 'updated' ? 'updated' : 'created' })
  const order = sort === 'oldest' ? 'asc' : 'desc'
  const useSearch = Boolean(search || state === 'merged' || state === 'closed')
  if (!useSearch) {
    params.set('state', state)
    params.set('direction', order)
    return { endpoint: 'repos/' + repository + '/pulls?' + params, useSearch }
  }
  const qualifier = state === 'all' ? '' : state === 'closed' ? ' is:closed is:unmerged' : ' is:' + state
  params.set('order', order)
  params.set('q', 'is:pr repo:' + repository + qualifier + (search ? ' in:title "' + search + '"' : ''))
  return { endpoint: 'search/issues?' + params, useSearch }
}

async function listRepository(repository: Repository, state: ListState, search: string, page: number, sort: ListSort, signal: AbortSignal) {
  const { endpoint, useSearch } = listQuery(repository.name, state, search, page, sort)
  const reply = await repositoryGitHubRequest(repository.path, endpoint, undefined, signal)
  const items = useSearch ? (reply.body as { items?: unknown[] } | null)?.items : reply.body
  if (reply.status !== 200 || !Array.isArray(items))
    throw new RepositoryPullRequestError('GitHub could not list this repository. Check the host account and repository permissions.')
  return { rows: items.flatMap(item => readPull(item, repository.name) ?? []), more: reply.hasNextPage }
}

const activityLabels: Record<string, string> = { commented: 'Commented', reviewed: 'Reviewed', closed: 'Closed the request',
  reopened: 'Reopened the request', merged: 'Merged the request', 'ready_for_review': 'Marked ready for review', 'convert_to_draft': 'Converted to draft' }
const reviewLabels: Record<string, string> = { approved: 'Approved', changes_requested: 'Requested changes', dismissed: 'Dismissed review' }

async function readActivity(repository: Repository, pull: Pull, page: number, signal: AbortSignal) {
  const reply = await repositoryGitHubRequest(repository.path, `repos/${repository.name}/issues/${pull.number}/timeline?per_page=30&page=${page}`, undefined, signal)
  if (reply.status !== 200 || !Array.isArray(reply.body)) throw new RepositoryPullRequestError('GitHub could not load the conversation for this request.')
  const items = reply.body.flatMap<Activity>((entry, index) => {
    if (entry?.event === 'committed' && typeof entry.sha === 'string' && /^[0-9a-f]{40}$/u.test(entry.sha)) {
      const subject = typeof entry.message === 'string' ? (entry.message.split('\n')[0] ?? '').slice(0, 256) : ''
      return [{ id: `activity-${index}`, author: entry.author?.name || '', time: entry.author?.date || '',
        state: subject || 'Committed changes', text: '', commit: entry.sha }]
    }
    if (typeof entry?.event !== 'string' || !Object.hasOwn(activityLabels, entry.event) || entry.state?.toLowerCase() === 'pending') return []
    const state = entry.event === 'reviewed' && Object.hasOwn(reviewLabels, entry.state?.toLowerCase() ?? '')
      ? reviewLabels[entry.state.toLowerCase()]! : activityLabels[entry.event]!
    return [{ id: `activity-${index}`, author: entry.user?.login || entry.actor?.login || 'Unknown author',
      time: entry.submitted_at || entry.created_at || '', state, text: typeof entry.body === 'string' ? entry.body.slice(0, 32_768) : '' }]
  })
  if (page === 1 && pull.created) items.push({ id: 'opened', author: pull.author, time: pull.created, state: 'Opened the request', text: '' })
  return { items: items.sort((a, b) => a.time.localeCompare(b.time)), more: reply.hasNextPage }
}

function fileAnchor(path: string) {
  return 'file-' + createHash('sha256').update(path).digest('hex').slice(0, 24)
}

function stillTrusted(state: HarnessState, workspace: WorkspaceState) {
  const current = state.workspaces.get(workspace.id)
  return current?.trusted && current.path === workspace.path && current.profileId === workspace.profileId
}

const commentViewKeys = ['conversation', 'commentScope', 'commentsAfter', 'commentsBefore', 'commentsLatest'] as const

function reviewCommentScope(head: string, viewer: string, id: string) {
  return createHash('sha256').update(JSON.stringify([head, viewer, id])).digest('hex').slice(0, 24)
}

function commentView(query: URLSearchParams) {
  const fields = ['commentsAfter', 'commentsBefore', 'commentsLatest'].filter(key => query.has(key))
  if (fields.length === 0) return null
  const field = fields.length === 1 ? fields[0] : undefined
  const cursor = field ? reviewCommentCursor(query.get(field)) : null
  const window: ReviewCommentWindow | null = field === 'commentsLatest' && cursor === '1' ? { direction: 'latest' }
    : cursor && field === 'commentsAfter' ? { direction: 'after', cursor }
      : cursor && field === 'commentsBefore' ? { direction: 'before', cursor } : null
  return { anchor: query.get('conversation'), scope: query.get('commentScope'), window }
}

function carryCommentView(from: URLSearchParams, to: URLSearchParams) {
  for (const key of commentViewKeys) {
    const value = reviewCommentCursor(from.get(key))
    if (value) to.set(key, value)
  }
}

function selectReviewConversation(params: URLSearchParams, anchor: string) {
  if (params.get('conversation') !== anchor) for (const key of commentViewKeys) params.delete(key)
  params.set('conversation', anchor)
}

async function readFiles(repository: Repository, pull: Pull, page: number, signal: AbortSignal, selectedComments: ReturnType<typeof commentView>) {
  const { number, head } = pull
  const reply = await repositoryGitHubRequest(repository.path, `repos/${repository.name}/pulls/${number}/files?per_page=30&page=${page}`, undefined, signal)
  if (reply.status !== 200 || !Array.isArray(reply.body)) throw new RepositoryPullRequestError('GitHub could not load changes for this request.')
  const files: ChangedFile[] = reply.body.flatMap(file => typeof file?.filename === 'string' ? [{ path: file.filename,
    previousPath: file.previous_filename, status: file.status, additions: file.additions, deletions: file.deletions,
    patch: typeof file.patch === 'string' ? file.patch : '' }] : [])
  const current = await repositoryGitHubRequest(repository.path, `repos/${repository.name}/pulls/${number}`, undefined, signal)
  if (current.status !== 200 || !head || readPull(current.body, repository.name)?.head !== head)
    throw new RepositoryPullRequestError('The pull request head changed during the read. Refresh to load its current files.')
  let review = null
  let discussion = null
  let commentsNotice = ''
  if (files.length || page === 1) {
    try {
      const credential = await repositoryGitHubCredential(repository.path, signal)
      const [viewed, conversations] = await Promise.allSettled([
        files.length ? readViewedFiles(repository.path, repository.name, number, head, files.map(file => file.path), signal, credential) : null,
        readReviewConversations(repository.path, repository.name, number, head, pull.url, signal, credential),
      ])
      if (viewed.status === 'rejected' && viewed.reason instanceof FileViewedConflict) throw viewed.reason
      if (conversations.status === 'rejected' && conversations.reason instanceof ReviewConversationConflict) throw conversations.reason
      review = viewed.status === 'fulfilled' ? viewed.value : null
      discussion = conversations.status === 'fulfilled' ? conversations.value : null
      if (review && discussion && review.viewer.id !== discussion.viewer) throw new ReviewConversationConflict()
      if (selectedComments && discussion) {
        const target = discussion.conversations.find(thread => thread.anchor === selectedComments.anchor)
        if (!target || !selectedComments.window || selectedComments.scope !== reviewCommentScope(head, discussion.viewer, target.id))
          commentsNotice = 'The comment page belongs to a different review. Open the current conversation to continue.'
        else {
          try {
            const page = await readReviewCommentPage(repository.path, repository.name, number, head, discussion.viewer,
              target.id, pull.url, signal, credential, selectedComments.window)
            if (page) Object.assign(target, page)
            else commentsNotice = 'Could not load that comment page. The first comments are shown.'
          }
          catch { commentsNotice = 'Could not load that comment page. The first comments are shown.' }
        }
      }
    }
    catch (error) {
      if (error instanceof FileViewedConflict || error instanceof ReviewConversationConflict)
        throw new RepositoryPullRequestError('The pull request head or account changed. Refresh to load the current files.')
    }
  }
  const byPath = new Map(files.map(file => [file.path, file]))
  const byPreviousPath = new Map(files.flatMap(file => file.previousPath ? [[file.previousPath, file] as const] : []))
  const assigned = Map.groupBy(discussion?.conversations ?? [], thread =>
    byPath.get(thread.path) ?? (thread.outdated || thread.side === 'before' ? byPreviousPath.get(thread.path) : undefined))
  return {
    files: files.map(file => ({ ...file, anchor: fileAnchor(file.path), formPath: encodeURIComponent(file.path),
      viewed: review?.states.get(file.path), sections: placeReviewConversations(file.patch, assigned.get(file) ?? []) })),
    viewer: review?.viewer, more: reply.hasNextPage, conversationViewer: discussion?.viewer,
    conversationsUnavailable: !discussion, conversationsTruncated: discussion?.truncated,
    detachedConversations: page === 1 ? assigned.get(undefined) ?? [] : [],
    commentsNotice,
    commentScopes: discussion
      ? Object.fromEntries(discussion.conversations.map(thread => [thread.anchor, reviewCommentScope(head, discussion.viewer, thread.id)])) : {},
  }
}

function message(error: unknown) {
  return error instanceof RepositoryPullRequestError ? error.message : 'GitHub could not respond. Try again.'
}

export async function pullRequestWorkspace(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const profiles = [...state.profiles.values()].map(profile => ({ id: profile.id, name: profile.name }))
  const requestedProfile = integer(query.get('profile'))
  const profile = profiles.some(item => item.id === requestedProfile) ? requestedProfile : profiles[0]?.id || 0
  const workspaces = [...state.workspaces.values()].filter(workspace => workspace.profileId === profile && workspace.trusted && !workspace.scratch)
  const repositories = await trustedRepositories(workspaces, signal)
  const repository = repositories.get((query.get('repository') ?? '').toLowerCase())
  const selection = parsePullRequest((query.get('selectedUrl') ?? '').slice(0, 512))
  const selectionRepo = selection && repositories.get(selection.repository.toLowerCase())
  const filter = listStates.find(value => value === query.get('state')) ?? 'open'
  const sort = listSorts.find(value => value === query.get('sort')) ?? 'updated'
  const tab = tabs.find(value => value === query.get('tab')) ?? 'summary'
  const search = (query.get('q') ?? '').trim().slice(0, 120).replace(/["\\\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  const page = Math.min(integer(query.get('page')) || 1, MAX_LIST_PAGE)
  const detailPage = Math.min(integer(query.get('detailPage')) || 1, MAX_LIST_PAGE)
  const list = repository ? [repository] : [...repositories.values()]
  const params = new URLSearchParams({ profile: String(profile), state: filter, sort })
  if (search) params.set('q', search)
  if (repository) params.set('repository', repository.name)
  if (page > 1) params.set('page', String(page))
  const href = (overrides: Record<string, string | number> = {}) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(overrides)) next.set(key, String(value))
    return '/pull-requests?' + next
  }
  const rows: Pull[] = []
  const failures: { repository: string, reason: string }[] = []
  let nextPage = false
  const detail = selection && selectionRepo ? (async () => {
    const reply = await repositoryGitHubRequest(selectionRepo.path, `repos/${selectionRepo.name}/pulls/${selection.number}`, undefined, signal)
    const data = reply.status === 200 ? readPull(reply.body, selectionRepo.name) : null
    if (!data || data.number !== selection.number) throw new RepositoryPullRequestError('This pull request is unavailable to the GitHub account on this host.')
    const tabData = tab === 'timeline' ? readActivity(selectionRepo, data, detailPage, signal)
      : tab === 'code' ? readFiles(selectionRepo, data, detailPage, signal, commentView(query))
        : readRepositoryPullRequestChecks(selectionRepo.path, { ...selection, repositoryKey: '' }, signal)
    const extra = await tabData.catch(error => ({ error: message(error) }))
    const result = 'checks' in extra ? extra.head === data.head
      ? { checks: extra.checks, truncated: extra.truncated }
      : { error: 'The pull request head changed during the read. Refresh to load its current checks.' }
      : extra
    const session = findPullRequestThread(state, selection, profile)
    return { ...data, thread: session ? { href: '/s/' + session.id, title: threadTitle(session) } : null,
      startHref: '/new?' + new URLSearchParams({ pr: data.url, profile: String(profile) }), ...result }
  })().catch(error => ({ error: message(error) })) : Promise.resolve(null)

  // Keep the host responsive and preserve any successful repository results.
  for (let index = 0; index < list.length; index += 4) {
    signal.throwIfAborted()
    const batch = list.slice(index, index + 4)
    const results = await Promise.allSettled(batch.map(item => listRepository(item, filter, search, page, sort, signal)))
    for (const [offset, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        rows.push(...result.value.rows)
        nextPage ||= result.value.more
      }
      else failures.push({ repository: batch[offset]!.name, reason: message(result.reason) })
    }
  }
  const selected = await detail
  signal.throwIfAborted()
  if ([...repositories.values()].some(item => !stillTrusted(state, item.workspace))) throw new RepositoryPullRequestError('The trusted projects changed while loading pull requests.')
  const selectedUrl = selection?.url ?? ''
  const detailsHref = (detailTab: string, nextPage = 1) => href({ selectedUrl, tab: detailTab, detailPage: nextPage })
  const commentsBase = detailsHref('code', detailPage)
  const reviewAction = (action: string) => {
    const actionParams = new URLSearchParams(commentsBase.split('?')[1])
    carryCommentView(query, actionParams)
    return '/pull-requests/' + action + '?' + actionParams
  }
  const marks = (row: Pull) => ({ ...row, selected: row.url.toLowerCase() === selectedUrl.toLowerCase(), href: href({ selectedUrl: row.url }) })
  rows.sort((a, b) => {
    const time = sort === 'updated' ? b.updated.localeCompare(a.updated)
      : sort === 'oldest' ? a.created.localeCompare(b.created) : b.created.localeCompare(a.created)
    return time || a.repository.localeCompare(b.repository) || b.number - a.number
  })
  return {
    profiles, profile, backHref: profile ? '/?profile=' + profile : '/', repository: repository?.name ?? '',
    repositories: [...repositories.values()].map(item => ({ name: item.name })),
    filter, sort, search, page, tab, detailPage, rows: rows.map(marks), failures,
    pageBack: page > 1 ? href({ page: page - 1, ...(selectedUrl && { selectedUrl, tab }) }) : '',
    pageNext: nextPage && page < MAX_LIST_PAGE ? href({ page: page + 1, ...(selectedUrl && { selectedUrl, tab }) }) : '',
    selected, selectionError: query.has('selectedUrl') && !selectionRepo ? 'Choose a pull request in a trusted GitHub project in this profile.' : '',
    listHref: href(), summaryHref: detailsHref('summary'), timelineHref: detailsHref('timeline'), codeHref: detailsHref('code'),
    detailBack: detailsHref(tab, detailPage - 1), detailNext: detailsHref(tab, detailPage + 1),
    viewedAction: reviewAction('viewed'),
    viewedAnchor: query.get('file') ?? '', viewedNotice: viewedMessages.get(query.get('viewedResult') ?? '') ?? '',
    conversationAction: reviewAction('conversation'),
    conversationAnchor: query.get('conversation') ?? '',
    conversationNotice: conversationMessages.get(query.get('conversationResult') ?? '') ?? '',
    replyAction: reviewAction('reply'),
    replyNotice: query.get('replyResult') === 'posted' ? 'Reply posted.' : '',
    commentsBase,
    commentsAction: commentsBase.replace('/pull-requests?', '/pull-requests/comments?'),
  }
}

function reviewReturnParams(query: URLSearchParams, profile: number, url: string) {
  const params = new URLSearchParams({ profile: String(profile), selectedUrl: url, tab: 'code' })
  for (const key of ['state', 'sort', 'q', 'repository', 'page', 'detailPage']) {
    const value = query.get(key)
    if (value && value.length <= 512) params.set(key, value)
  }
  carryCommentView(query, params)
  return params
}

async function readReviewSubmission(state: HarnessState, query: URLSearchParams, request: Request, maxBytes = 16_384) {
  const profile = integer(query.get('profile'))
  const selection = parsePullRequest((query.get('selectedUrl') ?? '').slice(0, 512))
  const raw = await readRepositoryBody(request, maxBytes)
  const values = new URLSearchParams(raw ?? '')
  const head = values.get('head') ?? ''
  const viewer = values.get('viewer') ?? ''
  if (!selection || !profile || !state.profiles.has(profile) || !/^[0-9a-f]{40}$/u.test(head) || !viewer || viewer.length > 256) return null
  return { profile, selection, values, head, viewer }
}

async function reviewRepository(state: HarnessState, profile: number, repository: string, signal: AbortSignal) {
  const workspaces = [...state.workspaces.values()].filter(workspace => workspace.profileId === profile && workspace.trusted && !workspace.scratch)
  return (await trustedRepositories(workspaces, signal)).get(repository.toLowerCase())
}

function renderReviewComment(comment: ReviewComment) {
  return { anchor: comment.anchor, href: comment.href, author: comment.author, time: comment.time, minimized: comment.minimized,
    html: renderPullRequestCommentMarkdown(comment.text) }
}

export async function loadWorkspaceReviewComments(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const profile = integer(query.get('profile'))
  const selection = parsePullRequest((query.get('selectedUrl') ?? '').slice(0, 512))
  const head = query.get('head') ?? ''
  const viewer = query.get('viewer') ?? ''
  const id = query.get('thread') ?? ''
  const cursor = reviewCommentCursor(query.get('after'))
  const fail = (status: number, message: string) => ({ status, body: { message } })
  if (!selection || !profile || !state.profiles.has(profile) || !/^[0-9a-f]{40}$/u.test(head)
    || !viewer || viewer.length > 256 || !reviewThreadId.test(id) || !cursor) return fail(400, 'Choose a valid comment page.')
  const changed = () => fail(409, 'The pull request, conversation, or account changed. Refresh the Code view.')
  const unavailable = () => fail(503, 'Could not load more comments. Try again.')
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return changed()
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const page = await readReviewCommentPage(repository.path, repository.name, selection.number, head, viewer,
      id, selection.url, signal, credential, { direction: 'after', cursor })
    if (!stillTrusted(state, repository.workspace)) return changed()
    if (!page) return unavailable()
    return { status: 200, body: { comments: page.comments.map(renderReviewComment), nextComments: page.nextComments } }
  }
  catch (error) { return error instanceof ReviewConversationConflict ? changed() : unavailable() }
}

const viewedMessages = new Map([
  ['viewed', 'File marked as viewed.'],
  ['unviewed', 'File marked as unviewed.'],
  ['changed', 'The pull request head, file, or GitHub account changed. Review the current file and try again.'],
  ['unavailable', 'Could not confirm the viewed state on GitHub. Check the account and try again.'],
  ['busy', 'A file review update is in progress. Try again shortly.'],
])

type ViewedResult = 'viewed' | 'unviewed' | 'changed' | 'unavailable' | 'busy'

const viewedWrites = new Set<string>()

export async function updateWorkspaceFileViewed(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal) {
  const submission = await readReviewSubmission(state, query, request)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  let file: string
  try { file = decodeURIComponent(values.get('path') ?? '') }
  catch { return null }
  const intent = values.get('viewed')
  if (!file || Buffer.byteLength(file) > 4096 || file.includes('\0') || (intent !== 'true' && intent !== 'false')) return null
  const viewed = intent === 'true'
  const params = reviewReturnParams(query, profile, selection.url)
  params.set('file', fileAnchor(file))
  const reply = (result: ViewedResult) => {
    params.set('viewedResult', result)
    return { result, message: viewedMessages.get(result), location: '/pull-requests?' + params + '#' + fileAnchor(file) }
  }
  const key = selection.repository.toLowerCase() + '#' + selection.number
  if (viewedWrites.has(key)) return reply('busy')
  viewedWrites.add(key)
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return reply('changed')
    // Pin the host's active credential while verifying and writing, even if the CLI changes accounts mid-request.
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const read = () => readViewedFiles(repository.path, repository.name, selection.number, head, [file], signal, credential)
    const before = await read()
    if (!before) return reply('unavailable')
    if (before.viewer.id !== viewer || !before.states.has(file) || !stillTrusted(state, repository.workspace)) return reply('changed')
    const desired = viewed ? 'VIEWED' : 'UNVIEWED'
    if (before.states.get(file) !== desired) {
      // A dropped response can follow a successful write. Confirm by reading the matching head and file.
      await writeFileViewed(repository.path, before.id, file, viewed, signal, credential).catch(() => {})
      const after = await read()
      if (!after || after.viewer.id !== viewer || after.states.get(file) !== desired) return reply('unavailable')
    }
    return reply(viewed ? 'viewed' : 'unviewed')
  }
  catch (error) { return reply(error instanceof FileViewedConflict ? 'changed' : 'unavailable') }
  finally { viewedWrites.delete(key) }
}

const conversationMessages = new Map([
  ['resolved', 'Conversation resolved.'],
  ['reopened', 'Conversation reopened.'],
  ['changed', 'The pull request, conversation, or GitHub account changed. Refresh the Code view and try again.'],
  ['denied', 'This GitHub account cannot change the conversation.'],
  ['unavailable', 'Could not confirm the conversation on GitHub. Try again.'],
  ['busy', 'This conversation is already being updated. Try again shortly.'],
])
type ConversationResult = 'resolved' | 'reopened' | 'changed' | 'denied' | 'unavailable' | 'busy'
const conversationWrites = new Set<string>()

export async function updateWorkspaceReviewConversation(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal) {
  const submission = await readReviewSubmission(state, query, request)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const id = values.get('thread') ?? ''
  const intent = values.get('resolved')
  if (!reviewThreadId.test(id) || (intent !== 'true' && intent !== 'false')) return null
  const resolved = intent === 'true'
  const anchor = reviewConversationAnchor(id)
  const params = reviewReturnParams(query, profile, selection.url)
  selectReviewConversation(params, anchor)
  const reply = (result: ConversationResult, conversation?: { isResolved: boolean, viewerCanResolve: boolean, viewerCanUnresolve: boolean }) => {
    params.set('conversationResult', result)
    return { result, message: conversationMessages.get(result), location: '/pull-requests?' + params + '#' + anchor,
      conversation: conversation && { isResolved: conversation.isResolved, viewerCanResolve: conversation.viewerCanResolve,
        viewerCanUnresolve: conversation.viewerCanUnresolve } }
  }
  if (conversationWrites.has(id)) return reply('busy')
  conversationWrites.add(id)
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return reply('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const read = () => readReviewConversationState(repository.path, repository.name, selection.number, head, id, signal, credential)
    const before = await read()
    if (!before) return reply('unavailable')
    if (before.viewer !== viewer || !stillTrusted(state, repository.workspace)) return reply('changed')
    const success = resolved ? 'resolved' : 'reopened'
    if (before.thread.isResolved === resolved) return reply(success, before.thread)
    if (!(resolved ? before.thread.viewerCanResolve : before.thread.viewerCanUnresolve)) return reply('denied', before.thread)
    await writeReviewConversation(repository.path, id, resolved, signal, credential).catch(() => {})
    const after = await read()
    if (!after) return reply('unavailable')
    if (after.viewer !== viewer || !stillTrusted(state, repository.workspace)) return reply('changed')
    return after.thread.isResolved === resolved ? reply(success, after.thread) : reply('unavailable')
  }
  catch (error) { return reply(error instanceof ReviewConversationConflict ? 'changed' : 'unavailable') }
  finally { conversationWrites.delete(id) }
}

const replyMessages = {
  posted: 'Reply posted.',
  invalid: 'Enter a reply of up to 16 KB.',
  changed: 'The pull request, conversation, account, or submitted reply changed. Refresh to review it.',
  denied: 'This GitHub account cannot reply to the conversation.',
  unavailable: 'Could not reach GitHub. Your draft is still here.',
  pending: 'GitHub has yet to confirm this reply. Check again to recover it.',
}
type ReplyResult = keyof typeof replyMessages
export type PullRequestReplyDraft = { anchor: string, viewer: string, head: string, token: string, text: string, message: string, pending: boolean }

export async function submitWorkspaceReviewReply(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const submission = await readReviewSubmission(state, query, request, 200_000)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const id = values.get('thread') ?? ''
  const token = values.get('intent') ?? ''
  const draft = (values.get('body') ?? '').replace(/\r\n?/gu, '\n')
  const text = draft.trim()
  if (!reviewThreadId.test(id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(token)) return null
  const anchor = reviewConversationAnchor(id)
  const params = reviewReturnParams(query, profile, selection.url)
  selectReviewConversation(params, anchor)
  const finish = (result: ReplyResult, comment?: ReviewComment) => {
    const message = replyMessages[result]
    const fallback: PullRequestReplyDraft = { anchor, viewer, head, token, text: draft, message, pending: result === 'pending' }
    const returned = new URLSearchParams(params)
    if (result === 'posted') {
      returned.delete('commentsAfter')
      returned.delete('commentsBefore')
      returned.set('commentsLatest', '1')
      returned.set('commentScope', reviewCommentScope(head, viewer, id))
    }
    return {
      result, message, fallback, params,
      location: '/pull-requests?' + returned + '&replyResult=posted#' + anchor,
      comment: comment && renderReviewComment(comment),
    }
  }
  if (!text || Buffer.byteLength(text) > 16_384 || text.includes('\0')) return finish('invalid')
  let attempted = false
  let confirmed = false
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return finish('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const read = (window?: ReviewCommentWindow) =>
      readReviewConversationState(repository.path, repository.name, selection.number, head, id, signal, credential, window)
    const before = await read()
    if (!before) return finish('unavailable')
    if (before.viewer !== viewer || !stillTrusted(state, repository.workspace)) return finish('changed')
    const fingerprint = createHash('sha256').update(JSON.stringify([profile, repository.workspace.id,
      repository.name.toLowerCase(), selection.number, head, viewer, id, text])).digest('hex')
    const receipt = receipts.claim(token, fingerprint, before.thread.viewerCanReply)
    if (receipt === 'conflict') return finish('changed')
    if (receipt === 'denied') return finish('denied')
    confirmed = receipt === 'confirmed'
    attempted = true
    // GitHub echoes clientMutationId without deduplicating writes. An HTML
    // comment lets an interrupted operation be recognized in the actual thread.
    const postedBody = '<!-- harness:review-reply:' + token + ' -->\n\n' + text
    const matches = (node: { author?: { id?: string }, body?: string } | null | undefined) =>
      node?.author?.id === viewer && node.body === postedBody
    const supplied = receipt === 'claimed'
      ? await writeReviewReply(repository.path, id, postedBody, signal, credential).catch(() => null) : null
    let recovered = matches(supplied) ? supplied : null
    let cursor: string | undefined
    for (let page = 0; !recovered && page < 10; page++) {
      const current = await read({ direction: 'recovery', cursor })
      if (!current || current.viewer !== viewer || !stillTrusted(state, repository.workspace)) break
      const node = current.comments?.nodes?.find(matches)
      if (node) { recovered = node; break }
      const next = current.comments?.pageInfo?.startCursor
      if (!current.comments?.pageInfo?.hasPreviousPage || !next || next === cursor) break
      cursor = next
    }
    if (!stillTrusted(state, repository.workspace)) return finish('changed')
    if (!recovered) return finish(confirmed ? 'posted' : 'pending')
    const comment = reviewComment(recovered, id, selection.url)
    if (!comment) return finish('pending')
    if (!confirmed) receipts.confirm(token, fingerprint)
    return finish('posted', comment)
  }
  catch (error) {
    return finish(error instanceof ReviewConversationConflict ? 'changed' : confirmed ? 'posted' : attempted ? 'pending' : 'unavailable')
  }
}

export function renderPullRequestMarkdown(html: string, view: Awaited<ReturnType<typeof pullRequestWorkspace>>) {
  const selected = view.selected
  if (!selected || !('description' in selected)) return html
  const bodies = new Map<string, string>([['description', selected.description]])
  if ('items' in selected) for (const item of selected.items) bodies.set(item.id, item.text)
  if ('files' in selected) {
    const conversations = selected.files.flatMap(file => file.sections.flatMap(section => section.conversations)).concat(selected.detachedConversations)
    for (const thread of conversations) for (const comment of thread.comments) bodies.set(comment.anchor, comment.text)
  }
  return new HTMLRewriter().on('[data-pr-markdown]', { element(element) {
    const text = bodies.get(element.getAttribute('data-pr-markdown') ?? '')
    if (text) element.setInnerContent(renderPullRequestCommentMarkdown(text), { html: true })
  } }).transform(html)
}
