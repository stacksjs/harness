import type { HarnessState, WorkspaceState } from '@harness/engine'
import { createHash } from 'node:crypto'
import { isWorkspaceGitRoot } from './diff'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { parsePullRequest, repositoryFromRemote } from './prompt-links'
import { placeReviewConversations, readReviewConversations, readReviewConversationState, ReviewConversationConflict, reviewConversationAnchor, reviewThreadId, writeReviewConversation } from './pull-request-conversations'
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

async function readFiles(repository: Repository, pull: Pull, page: number, signal: AbortSignal) {
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
      : tab === 'code' ? readFiles(selectionRepo, data, detailPage, signal)
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
    viewedAction: detailsHref('code', detailPage).replace('/pull-requests?', '/pull-requests/viewed?'),
    viewedAnchor: query.get('file') ?? '', viewedNotice: viewedMessages.get(query.get('viewedResult') ?? '') ?? '',
    conversationAction: detailsHref('code', detailPage).replace('/pull-requests?', '/pull-requests/conversation?'),
    conversationAnchor: query.get('conversation') ?? '',
    conversationNotice: conversationMessages.get(query.get('conversationResult') ?? '') ?? '',
  }
}

function reviewReturnParams(query: URLSearchParams, profile: number, url: string) {
  const params = new URLSearchParams({ profile: String(profile), selectedUrl: url, tab: 'code' })
  for (const key of ['state', 'sort', 'q', 'repository', 'page', 'detailPage']) {
    const value = query.get(key)
    if (value && value.length <= 512) params.set(key, value)
  }
  return params
}

async function readReviewSubmission(state: HarnessState, query: URLSearchParams, request: Request) {
  const profile = integer(query.get('profile'))
  const selection = parsePullRequest((query.get('selectedUrl') ?? '').slice(0, 512))
  const raw = await readRepositoryBody(request, 16_384)
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
  params.set('conversation', anchor)
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
