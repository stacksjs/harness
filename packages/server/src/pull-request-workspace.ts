import type { HarnessState, WorkspaceState } from '@harness/engine'
import type { ReviewComment, ReviewCommentWindow } from './pull-request-conversations'
import type { LifecycleAction, LifecycleSnapshot, MergeMethod } from './pull-request-lifecycle'
import type { PullRequestLabel } from './pull-request-labels'
import type { PendingReviewer } from './pull-request-review-outcomes'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import type { GitHubWorkspaceRepository as Repository } from './github-workspace-repositories'
import { trustedGitHubRepositories } from './github-workspace-repositories'
import { parsePullRequest } from './prompt-links'
import { placeReviewConversations, readReviewCommentPage, readReviewConversations, readReviewConversationState, reviewComment, reviewCommentCursor, ReviewConversationConflict, reviewConversationAnchor, reviewLineSelection, reviewThreadId, writeReviewConversation, writeReviewReply } from './pull-request-conversations'
import { deleteWorkspacePullRequestBranch } from './pull-request-delete-branch'
import { findPullRequestThread } from './pull-request-links'
import { availableLifecycleActions, behindBase, branchUpdateMethods, deletableSourceBranch, isMergeAction, lifecycleAction, lifecycleActions, lifecycleRevision, lifecycleTargetReached, mergeMethod, mergeMethods, readPullRequestLifecycle, takesMergeMethod, writePullRequestLifecycle } from './pull-request-lifecycle'
import { readPullRequestListDetails } from './pull-request-list-details'
import { pullRequestFilterQualifiers, readFilterLookup, readFilterViewer, readPullRequestFilterChoices, readPullRequestListSearch, writePullRequestFilters } from './pull-request-list-filters'
import { applyPullRequestLabelChanges, parseLabelSelection, pullRequestLabels, readPullRequestLabelEditor } from './pull-request-labels'
import { anchoredReviewComment, fileAnchor, inlineReviewBody, inlineReviewMarker, matchesInlineReview, readInlineReview } from './pull-request-review'
import { mergePullRequestReviewers, pullRequestReviewDecision, pullRequestReviewParticipation, readPullRequestReviewOutcomes } from './pull-request-review-outcomes'
import { applyPullRequestReviewerChanges, parseReviewerSelection, readPullRequestReviewerEditor, reviewerOptions } from './pull-request-reviewers'
import { revertWorkspacePullRequest } from './pull-request-revert'
import { readRepositoryBody } from './repository-commit'
import { RepositoryPullRequestError, repositoryGitHubCredential, repositoryGitHubRequest } from './repository-pull-request'
import { readRepositoryPullRequestChecks } from './repository-pull-request-checks'
import { threadTitle } from './thread-search'
import { renderPullRequestCommentMarkdown } from './transcript-markdown'
import { FileViewedConflict, readViewedFiles, writeFileViewed } from './pull-request-viewed'
import { approveWorkspaceWorkflows, parseWorkflowRunSelection, readWorkflowApprovals, workflowApprovalHead, workflowApprovalRevision, workflowRunSelection } from './pull-request-workflow-approvals'

type Pull = { repository: string, number: number, url: string, title: string, status: 'Open' | 'Draft' | 'Closed' | 'Merged', author: string,
  updated: string, created: string, head: string, headRef: string, baseRef: string, baseSha: string, description: string, labels: PullRequestLabel[],
  requestedReviewers: PendingReviewer[], additions?: number, deletions?: number, changedFiles?: number }
const listGroups = [
  { key: 'authored', label: 'Authored' },
  { key: 'reviewing', label: 'Review requested' },
  { key: 'other', label: 'Others' },
] as const
type ListGroup = typeof listGroups[number]['key']
type PagedPull = Pull & { listPage: number }
type ListRow = PagedPull & { group: ListGroup, checks: string, reviewDecision: string, conflicts: boolean, isPrivate: boolean }
type GitHubPull = { html_url?: string, number?: number, title?: string, body?: string | null, user?: { login?: string },
  state?: string, draft?: boolean, merged_at?: string | null, pull_request?: { merged_at?: string | null }, updated_at?: string, created_at?: string,
  head?: { sha?: string, ref?: string }, base?: { ref?: string, sha?: string }, additions?: number, deletions?: number, changed_files?: number,
  labels?: unknown, requested_reviewers?: unknown, requested_teams?: unknown }
type Activity = { id: string, author: string, time: string, state: string, text: string, commit?: string }
type ChangedFile = { path: string, previousPath?: string, status: string, additions: number, deletions: number, patch: string }

const listStates = ['open', 'closed', 'merged', 'all'] as const
const listSorts = ['updated', 'newest', 'oldest'] as const
type ListState = typeof listStates[number]
type ListSort = typeof listSorts[number]
const tabs = ['summary', 'timeline', 'code'] as const
const MAX_LIST_PAGE = 100
const LIST_PAGE_SIZE = 20
const MAX_RESTORED_ROWS = 500
const REST_BATCH_SIZE = 100
const MAX_GITHUB_SEARCH_RESULTS = 1000

function integer(value: string | null) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

function requestedReviewers(pull: GitHubPull, organization: string): PendingReviewer[] {
  const people = Array.isArray(pull.requested_reviewers) ? pull.requested_reviewers : []
  const teams = Array.isArray(pull.requested_teams) ? pull.requested_teams : []
  const reviewers = new Map<string, PendingReviewer>()
  for (const { login } of people.filter(person => person && typeof person === 'object')) {
    if (typeof login === 'string' && /^[\w-]{1,100}(?:\[bot\])?$/u.test(login))
      reviewers.set(login.toLowerCase(), { name: '@' + login, team: false })
  }
  for (const { slug } of teams.filter(team => team && typeof team === 'object')) {
    if (typeof slug === 'string' && /^[\w-]{1,100}$/u.test(slug)) {
      const name = '@' + organization + '/' + slug
      reviewers.set(name.toLowerCase(), { name, team: true })
    }
  }
  return [...reviewers.values()]
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
    head: pull.head?.sha ?? '', headRef: pull.head?.ref ?? '', baseRef: pull.base?.ref ?? '', baseSha: pull.base?.sha ?? '',
    description: typeof pull.body === 'string' ? pull.body.slice(0, 32_768) : '', labels: pullRequestLabels(pull.labels) ?? [],
    requestedReviewers: requestedReviewers(pull, repository.split('/')[0]!),
    additions: pull.additions, deletions: pull.deletions, changedFiles: pull.changed_files }
}

function listQuery(repository: string, state: ListState, search: string, page: number, sort: ListSort, filters: string[], size = LIST_PAGE_SIZE) {
  const params = new URLSearchParams({ page: String(page), per_page: String(size), sort: sort === 'updated' ? 'updated' : 'created' })
  const order = sort === 'oldest' ? 'asc' : 'desc'
  const useSearch = Boolean(filters.length || search || state === 'merged' || state === 'closed')
  if (!useSearch) {
    params.set('state', state)
    params.set('direction', order)
    return { endpoint: 'repos/' + repository + '/pulls?' + params, useSearch }
  }
  const qualifier = state === 'all' ? '' : state === 'closed' ? ' is:closed is:unmerged' : ' is:' + state
  params.set('order', order)
  params.set('q', ['is:pr repo:' + repository + qualifier, ...(search ? ['in:title,body,comments "' + search + '"'] : []), ...filters].join(' '))
  return { endpoint: 'search/issues?' + params, useSearch }
}

async function readPullRequestListBatch(repository: Repository, state: ListState, search: string, page: number, sort: ListSort, filters: string[],
  signal: AbortSignal, size: number) {
  const { endpoint, useSearch } = listQuery(repository.name, state, search, page, sort, filters, size)
  const lastPage = MAX_GITHUB_SEARCH_RESULTS / size
  if (useSearch && page > lastPage) return { items: [], more: false, incomplete: false, capped: true }
  const reply = await repositoryGitHubRequest(repository.path, endpoint, undefined, signal)
  const indexed = useSearch ? reply.body as { items?: unknown[], incomplete_results?: boolean, total_count?: number } | null : null
  const items = useSearch ? indexed?.items : reply.body
  if (reply.status !== 200 || !Array.isArray(items))
    throw new RepositoryPullRequestError('GitHub could not list this repository. Check the host account and repository permissions.')
  return {
    items: items.slice(0, size),
    more: reply.hasNextPage && (!useSearch || page < lastPage),
    incomplete: indexed?.incomplete_results === true,
    capped: (indexed?.total_count ?? 0) > MAX_GITHUB_SEARCH_RESULTS,
  }
}

async function readPullRequestPages(repository: Repository, scope: {
  state: ListState, text: string, page: number, through: number, sort: ListSort,
}, filters: string[], signal: AbortSignal) {
  const { state, text, page, through, sort } = scope
  const size = through === page ? LIST_PAGE_SIZE : REST_BATCH_SIZE
  const start = (page - 1) * LIST_PAGE_SIZE
  const end = through * LIST_PAGE_SIZE
  const pulls: PagedPull[] = []
  let more = false
  let incomplete = false
  let capped = false
  for (let offset = Math.floor(start / size) * size; offset < end; offset += size) {
    signal.throwIfAborted()
    const batch = await readPullRequestListBatch(repository, state, text, offset / size + 1, sort, filters, signal, size)
    const sliceStart = Math.max(0, start - offset)
    pulls.push(...batch.items.slice(sliceStart, end - offset).flatMap((item, index) => {
      const pull = readPull(item, repository.name)
      return pull ? [{ ...pull, listPage: Math.floor((offset + sliceStart + index) / LIST_PAGE_SIZE) + 1 }] : []
    }))
    more = offset + batch.items.length > end || batch.more
    incomplete = incomplete || batch.incomplete
    capped ||= batch.capped
    if (!batch.more) break
  }
  return { pulls, more, incomplete, capped }
}

async function listRepository(repository: Repository, scope: {
  state: ListState, text: string, page: number, through: number, sort: ListSort, qualifiers: string[], partition: boolean, explicitAuthor: string,
}, viewer: string, resolveViewer: () => Promise<string>, signal: AbortSignal) {
  const { page, through, qualifiers, partition, explicitAuthor } = scope
  const readPage = (filters: string[]) => readPullRequestPages(repository, scope, filters, signal)
  let result = await readPage(qualifiers)
  let partitionsUnavailable = false
  const assignedGroups = new Map<number, ListGroup>()
  // The broad page is enough if it already contains every result and no team
  // request needs GitHub to resolve membership. Preserve the normal list if
  // any priority search cannot confirm its part of the listing.
  if (partition && (result.more || ((page > 1 || through > page) && result.pulls.length > 0)
    || result.pulls.some(pull => pull.requestedReviewers.some(reviewer => reviewer.team)))) {
    viewer ||= await resolveViewer().catch(() => '')
    if (!viewer) partitionsUnavailable = true
    else if (explicitAuthor.toLowerCase() !== viewer.toLowerCase()) {
      const notAuthored = explicitAuthor ? [] : ['-author:' + viewer]
      const plans: [ListGroup, string[]][] = [
        ['reviewing', [...notAuthored, 'review-requested:' + viewer]],
        ['other', [...notAuthored, '-review-requested:' + viewer]],
      ]
      if (!explicitAuthor) plans.unshift(['authored', ['author:' + viewer]])
      const sections = await Promise.all(plans.map(async ([key, filters]) => {
        const section = await readPage([...qualifiers, ...filters]).catch(() => null)
        return { key, section }
      }))
      signal.throwIfAborted()
      if (sections.every(item => item.section && !item.section.incomplete)) {
        const pulls: PagedPull[] = []
        let more = false
        let capped = false
        for (const { key, section } of sections) {
          if (!section) continue
          more = more || section.more
          capped = capped || section.capped
          for (const pull of section.pulls) {
            if (assignedGroups.has(pull.number)) continue
            assignedGroups.set(pull.number, key)
            pulls.push(pull)
          }
        }
        if (page === 1 && result.pulls.some(pull => !assignedGroups.has(pull.number))) {
          // GitHub can return a REST row before it enters the search index.
          assignedGroups.clear()
          partitionsUnavailable = true
        }
        else result = { pulls, more, capped, incomplete: false }
      }
      else partitionsUnavailable = true
    }
  }
  const summaries: NonNullable<Awaited<ReturnType<typeof readPullRequestListDetails>>>[] = []
  let detailsUnavailable = false
  for (let offset = 0; offset < result.pulls.length; offset += 60) {
    const summary = await readPullRequestListDetails(repository.path, repository.name, result.pulls.slice(offset, offset + 60), signal).catch(() => null)
    if (summary) summaries.push(summary)
    detailsUnavailable ||= !summary || summary.incomplete
  }
  const login = viewer.toLowerCase() || summaries[0]?.viewer || ''
  const detailsByNumber = new Map(summaries.flatMap(summary => [...summary.details]))
  const rows = result.pulls.map((row): ListRow => {
    const details = detailsByNumber.get(row.number)
    const authored = Boolean(login && row.author.toLowerCase() === login)
    const reviewing = details?.reviewRequested ?? Boolean(login && row.requestedReviewers.some(reviewer =>
      !reviewer.team && reviewer.name.toLowerCase() === '@' + login))
    const status = row.status === 'Open' && details?.isDraft ? 'Draft' : row.status
    return { ...row, status, group: authored ? 'authored' : assignedGroups.get(row.number) ?? (reviewing ? 'reviewing' : 'other'),
      checks: details?.checks ?? '', reviewDecision: details?.reviewDecision ?? '',
      conflicts: status === 'Open' && details?.conflicts === true, isPrivate: summaries[0]?.isPrivate === true,
      additions: details?.additions ?? row.additions, deletions: details?.deletions ?? row.deletions }
  })
  return {
    rows,
    more: result.more, incomplete: result.incomplete, capped: result.capped, partitionsUnavailable,
    detailsUnavailable,
  }
}

const activityLabels: Record<string, string> = { commented: 'Commented', reviewed: 'Reviewed', review_dismissed: 'Dismissed a review', closed: 'Closed the request',
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
      time: entry.submitted_at || entry.created_at || '', state, text: typeof entry.body === 'string' ? entry.body.replace(inlineReviewMarker, '').slice(0, 32_768) : '' }]
  })
  if (page === 1 && pull.created) items.push({ id: 'opened', author: pull.author, time: pull.created, state: 'Opened the request', text: '' })
  return { items: items.sort((a, b) => a.time.localeCompare(b.time)), more: reply.hasNextPage }
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

function carryReviewView(from: URLSearchParams, to: URLSearchParams) {
  for (const key of [...commentViewKeys, 'reviewLine', 'reviewStart', 'reviewHead', 'reviewBase']) {
    const raw = from.get(key)
    const value = reviewCommentCursor(raw)
    if (value || (key === 'reviewBase' && raw === '')) to.set(key, value ?? '')
  }
}

function selectReviewConversation(params: URLSearchParams, anchor: string) {
  if (params.get('conversation') !== anchor) for (const key of commentViewKeys) params.delete(key)
  params.set('conversation', anchor)
}

async function readReviewFiles(repository: Repository, number: number, page: number, signal: AbortSignal, credential?: string) {
  const reply = await repositoryGitHubRequest(repository.path, `repos/${repository.name}/pulls/${number}/files?per_page=30&page=${page}`, undefined, signal, credential)
  if (reply.status !== 200 || !Array.isArray(reply.body)) throw new RepositoryPullRequestError('GitHub could not load changes for this request.')
  const files: ChangedFile[] = reply.body.flatMap(file => typeof file?.filename === 'string' ? [{ path: file.filename,
    previousPath: file.previous_filename, status: file.status, additions: file.additions, deletions: file.deletions,
    patch: typeof file.patch === 'string' ? file.patch : '' }] : [])
  return { files, more: reply.hasNextPage }
}

async function readFiles(repository: Repository, pull: Pull, page: number, signal: AbortSignal, query: URLSearchParams) {
  const { number, head } = pull
  const selectedComments = commentView(query)
  const { files, more } = await readReviewFiles(repository, number, page, signal)
  const current = await repositoryGitHubRequest(repository.path, `repos/${repository.name}/pulls/${number}`, undefined, signal)
  const currentPull = current.status === 200 ? readPull(current.body, repository.name) : null
  if (!currentPull || !head || currentPull.head !== head || currentPull.baseSha !== pull.baseSha || currentPull.baseRef !== pull.baseRef)
    throw new RepositoryPullRequestError('The pull request changed during the read. Refresh to load its current files.')
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
  const requestedLine = query.get('reviewLine')
  const requestedStart = query.get('reviewStart')
  const sameDiff = query.get('reviewHead') === head && query.get('reviewBase') === pull.baseSha
  const lines = files.map(file => {
    const anchor = fileAnchor(file.path)
    const sections = placeReviewConversations(file.patch, assigned.get(file) ?? [])
    const lineSelection = sameDiff ? reviewLineSelection(sections, anchor, requestedLine, requestedStart) : null
    const firstLine = sections.find(section => section.rows.some(row => row.before || row.after))?.rows.find(row => row.before || row.after)?.position
    return { ...file, anchor, firstLine, formPath: encodeURIComponent(file.path), viewed: review?.states.get(file.path), sections, lineSelection }
  })
  const reviewViewer = review?.viewer ?? (discussion?.login ? { id: discussion.viewer, login: discussion.login } : null)
  return {
    files: lines,
    lineNotice: requestedLine !== null && !lines.some(file => file.lineSelection)
      ? sameDiff ? 'This line selection is unavailable on this file page.' : 'The pull request comparison changed. Select a line in the current diff.' : '',
    viewer: review?.viewer, reviewViewer, more, conversationViewer: discussion?.viewer,
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

const pullRequestDates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

async function readPullRequestWorkspace(state: HarnessState, query: URLSearchParams, signal: AbortSignal, listOnly: boolean) {
  const profiles = [...state.profiles.values()].map(profile => ({ id: profile.id, name: profile.name }))
  const requestedProfile = integer(query.get('profile'))
  const profile = profiles.some(item => item.id === requestedProfile) ? requestedProfile : profiles[0]?.id || 0
  const repositories = await trustedGitHubRepositories(state.workspaces.values(), profile, signal)
  const repository = repositories.get((query.get('repository') ?? '').toLowerCase())
  const selectionInProfile = !query.has('selectionProfile') || query.get('selectionProfile') === String(profile)
  const selection = selectionInProfile ? parsePullRequest((query.get('selectedUrl') ?? '').slice(0, 512)) : null
  const selectionRepo = selection && repositories.get(selection.repository.toLowerCase())
  const filter = listStates.find(value => value === query.get('state')) ?? 'open'
  const sort = listSorts.find(value => value === query.get('sort')) ?? 'updated'
  const { search, text, filters, menu } = readPullRequestListSearch(query)
  const activeFilterCount = [menu.involvement, filters.draft, menu.review, menu.checks, menu.author, repository,
    filter !== 'open', profiles[0] && profile !== profiles[0].id].filter(Boolean).length + menu.label.length
  const lookup = readFilterLookup(query)
  const tab = tabs.find(value => value === query.get('tab')) ?? 'summary'
  const page = Math.min(integer(query.get('page')) || 1, MAX_LIST_PAGE)
  const through = Math.max(page, Math.min(integer(query.get('through')), MAX_LIST_PAGE, page + MAX_RESTORED_ROWS / LIST_PAGE_SIZE - 1))
  const detailPage = Math.min(integer(query.get('detailPage')) || 1, MAX_LIST_PAGE)
  const list = repository ? [repository] : [...repositories.values()]
  const params = new URLSearchParams({ profile: String(profile), state: filter, sort })
  if (search) params.set('q', search)
  if (repository) params.set('repository', repository.name)
  const clearFilters = new URLSearchParams(params)
  writePullRequestFilters(params, menu)
  const savedViewScope = params.toString()
  if (page > 1) params.set('page', String(page))
  if (through > page) params.set('through', String(through))
  const href = (overrides: Record<string, string | number> = {}) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(overrides)) next.set(key, String(value))
    return '/pull-requests?' + next
  }
  const rows: ListRow[] = []
  const continuing = listOnly && query.get('continuation') === '1'
  const failures: { repository: string, reason: string }[] = []
  let nextPage = false
  let incompleteSearch = false
  let cappedSearch = false
  let detailsUnavailable = false
  let partitionsUnavailable = false
  const filterChoices = !listOnly && lookup ? readPullRequestFilterChoices(list, lookup, signal)
    .catch(() => ({ ...lookup, options: [], more: false, failed: list.length })) : Promise.resolve(null)
  const detail = !listOnly && selection && selectionRepo ? (async () => {
    const editingLabels = tab === 'summary' && query.get('labels') === 'edit'
    const editingReviewers = tab === 'summary' && query.get('reviewers') === 'edit'
    const credential = editingLabels || editingReviewers ? await repositoryGitHubCredential(selectionRepo.path, signal).catch(() => undefined) : undefined
    const reply = await repositoryGitHubRequest(selectionRepo.path, `repos/${selectionRepo.name}/pulls/${selection.number}`, undefined, signal, credential)
    const data = reply.status === 200 ? readPull(reply.body, selectionRepo.name) : null
    if (!data || data.number !== selection.number) throw new RepositoryPullRequestError('This pull request is unavailable to the GitHub account on this host.')
    const tabData = tab === 'timeline' ? readActivity(selectionRepo, data, detailPage, signal)
      : tab === 'code' ? readFiles(selectionRepo, data, detailPage, signal, query)
        : readRepositoryPullRequestChecks(selectionRepo.path, { ...selection, repositoryKey: '' }, signal)
    const [extra, current, reviewHistory] = await Promise.all([
      tabData.catch(error => ({ error: message(error) })),
      readPullRequestLifecycle(selectionRepo.path, selectionRepo.name, data.number, signal, credential, tab === 'summary').catch(() => null),
      tab === 'summary' ? readPullRequestReviewOutcomes(selectionRepo.path, selectionRepo.name, data.number, data.head, signal, credential).catch(() => null) : undefined,
    ])
    const result = 'checks' in extra ? extra.head === data.head
      ? { checks: extra.checks, truncated: extra.truncated }
      : { error: 'The pull request head changed during the read. Refresh to load its current checks.' }
      : extra
    const session = findPullRequestThread(state, selection, profile)
    const currentStatus = current?.state === 'OPEN' ? current.isDraft ? 'Draft' : 'Open'
      : current?.state === 'CLOSED' ? 'Closed' : 'Merged'
    const actions = current ? availableLifecycleActions(current) : []
    const mergeAction = current?.baseRefName === data.baseRef ? actions.find(isMergeAction) : undefined
    const behind = current?.baseRefName === data.baseRef && current ? behindBase(current) : null
    const branchToDelete = current?.headRefName === data.headRef && current ? deletableSourceBranch(current) : null
    const lifecycle = current && current.headRefOid === data.head && current.baseRefOid === data.baseSha && currentStatus === data.status
      ? { viewer: current.viewer, revision: lifecycleRevision(current), token: crypto.randomUUID(),
          mergeStatus: current.state !== 'OPEN' ? '' : current.mergeQueueEntry?.id ? 'In merge queue' : current.autoMergeRequest ? 'Auto-merge enabled' : '',
          methods: current.merge.methods.map(value => ({ value, label: mergeMethods[value] })),
          actions: actions.filter(action => action !== 'update-branch' && !isMergeAction(action) && (action !== 'delete-branch' || branchToDelete))
            .map(action => ({ action, label: lifecycleActions[action].label })),
          branchToDelete,
          branchUpdate: behind === null ? null : { behind, canUpdate: actions.includes('update-branch'), methods: branchUpdateMethods },
          mergeAction: mergeAction ? { action: mergeAction, label: lifecycleActions[mergeAction].label, chooseMethod: takesMergeMethod(mergeAction) } : null }
      : null
    const fork = tab === 'summary' && lifecycle && current?.headRefName === data.headRef ? workflowApprovalHead(selectionRepo.name, current) : null
    const approvalRuns = fork
      ? await readWorkflowApprovals(selectionRepo.path, selectionRepo.name, fork, signal).catch(() => null)
      : undefined
    const workflowApproval = lifecycle && current?.merge.canWrite && approvalRuns?.length && fork
      && (!('checks' in extra) || extra.head === data.head)
      ? { revision: workflowApprovalRevision(lifecycle.revision, approvalRuns), runs: workflowRunSelection(approvalRuns), repository: fork.repository }
      : null
    const canEditLabels = tab === 'summary' && Boolean(lifecycle && current?.canTriage)
    const labelEditor = editingLabels && canEditLabels && credential && current
      ? await reviewLabelEditor(selectionRepo, data.number, current, profile, credential, signal).catch(() => null)
      : null
    const canEditReviewers = tab === 'summary' && Boolean(lifecycle && current?.canRequestReviewers)
    const reviewerEditor = editingReviewers && canEditReviewers && credential && current
      ? await reviewReviewerEditor(selectionRepo, data.number, current, profile, credential, signal).catch(() => null)
      : null
    const reviewHeadChanged = Boolean(current && current.headRefOid !== data.head)
    const reviewers = mergePullRequestReviewers(data.requestedReviewers, pullRequestReviewParticipation(lifecycle && current?.latestReviews?.nodes),
      reviewHeadChanged ? [] : reviewHistory?.outcomes ?? [])
    const reviewDecision = tab === 'summary' && lifecycle ? pullRequestReviewDecision(current?.reviewDecision) : ''
    const reviewOutcomesNotice = tab !== 'summary' ? ''
      : reviewHeadChanged ? 'The pull request changed while loading reviews. Refresh to see its current review outcomes.'
        : !reviewHistory ? 'Could not load review outcomes from GitHub.'
          : reviewHistory.truncated ? 'Open the pull request on GitHub to see its full review history.' : ''
    return { ...data, lifecycle, approvalRuns, workflowApproval, canEditLabels, labelEditor, labelEditorUnavailable: editingLabels && canEditLabels && !labelEditor,
      reviewers, reviewDecision, reviewOutcomesNotice, canEditReviewers, reviewerEditor, reviewerEditorUnavailable: editingReviewers && canEditReviewers && !reviewerEditor,
      thread: session ? { href: '/s/' + session.id, title: threadTitle(session) } : null,
      startHref: '/new?' + new URLSearchParams({ pr: data.url, profile: String(profile) }), ...result }
  })().catch(error => ({ error: message(error) })) : Promise.resolve(null)

  const needsViewer = Boolean(filters.involvement || filters.author === '@me')
  const viewer = needsViewer && list[0] ? await readFilterViewer(list[0].path, signal).catch((error) => {
    failures.push({ repository: 'GitHub', reason: message(error) })
    return null
  }) : ''
  const qualifiers = viewer === null ? null : pullRequestFilterQualifiers(filters, viewer)
  const scope = qualifiers ? { state: filter, text, page, through, sort, qualifiers, partition: !search && !filters.involvement,
    explicitAuthor: filters.author === '@me' ? viewer ?? '' : filters.author } : null
  let partitionViewer: Promise<string> | undefined
  const resolveViewer = () => partitionViewer ??= readFilterViewer(list[0]!.path, signal)
  // Keep the host responsive and preserve any successful repository results.
  for (let index = 0; scope && index < list.length; index += 4) {
    signal.throwIfAborted()
    const batch = list.slice(index, index + 4)
    const results = await Promise.allSettled(batch.map(item => listRepository(item, scope, viewer ?? '', resolveViewer, signal)))
    for (const [offset, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        if (!continuing || (!result.value.incomplete && !result.value.partitionsUnavailable)) rows.push(...result.value.rows)
        nextPage ||= result.value.more
        incompleteSearch = incompleteSearch || result.value.incomplete
        cappedSearch = cappedSearch || result.value.capped
        detailsUnavailable ||= result.value.detailsUnavailable
        partitionsUnavailable ||= result.value.partitionsUnavailable
      }
      else failures.push({ repository: batch[offset]!.name, reason: message(result.reason) })
    }
  }
  const [selected, choices] = await Promise.all([detail, filterChoices])
  signal.throwIfAborted()
  if ([...repositories.values()].some(item => !stillTrusted(state, item.workspace))) throw new RepositoryPullRequestError('The trusted projects changed while loading pull requests.')
  const selectedUrl = selection?.url ?? ''
  const savedViewDetail = new URLSearchParams()
  if (selectionRepo) {
    savedViewDetail.set('selectedUrl', selectedUrl)
    savedViewDetail.set('tab', tab)
    if (detailPage > 1) savedViewDetail.set('detailPage', String(detailPage))
    if (tab === 'code') carryReviewView(query, savedViewDetail)
  }
  for (const [name, value] of savedViewDetail) clearFilters.set(name, value)
  const listSelectionFields = selectionRepo ? [...savedViewDetail, ['selectionProfile', String(profile)]] : []
  const detailsHref = (detailTab: string, nextPage = 1) => href({ selectedUrl, tab: detailTab, detailPage: nextPage })
  const commentsBase = detailsHref('code', detailPage)
  const lifecycleParams = new URLSearchParams(detailsHref(tab, detailPage).split('?')[1])
  if (tab === 'code') carryReviewView(query, lifecycleParams)
  const reviewAction = (action: string) => {
    const actionParams = new URLSearchParams(commentsBase.split('?')[1])
    carryReviewView(query, actionParams)
    return '/pull-requests/' + action + '?' + actionParams
  }
  const marks = (row: ListRow) => ({ ...row, selected: row.url.toLowerCase() === selectedUrl.toLowerCase(), href: href({ selectedUrl: row.url }),
    updatedLabel: Number.isFinite(Date.parse(row.updated)) ? pullRequestDates.format(new Date(row.updated)) : '',
    firstLabel: row.labels[0], remainingLabels: row.labels.slice(1).map(label => label.name).join(', '), moreLabels: row.labels.length - 1 })
  const pageHref = (number: number) => {
    const target = new URLSearchParams(params)
    target.delete('through')
    target.set('page', String(number))
    for (const [name, value] of savedViewDetail) target.set(name, value)
    return '/pull-requests?' + target
  }
  const restoreRetry = through > page && (incompleteSearch || partitionsUnavailable || failures.length > 0)
    ? '/pull-requests?' + new URLSearchParams([...params, ...savedViewDetail]) : ''
  rows.sort((a, b) => {
    const time = sort === 'updated' ? b.updated.localeCompare(a.updated)
      : sort === 'oldest' ? a.created.localeCompare(b.created) : b.created.localeCompare(a.created)
    return a.listPage - b.listPage || time || a.repository.localeCompare(b.repository) || b.number - a.number
  })
  const seen = new Set<string>()
  const entries = rows.flatMap((row) => {
    const key = row.url.toLowerCase()
    if (seen.has(key)) return []
    seen.add(key)
    return [marks(row)]
  })
  const groups = (filters.involvement ? [{ key: 'filtered', label: '', entries }]
    : listGroups.map(group => ({ ...group, entries: entries.filter(entry => entry.group === group.key) }))).filter(group => group.entries.length)
  return {
    profiles, profile, backHref: profile ? '/?profile=' + profile : '/', repository: repository?.name ?? '',
    repositories: [...repositories.values()].map(item => ({ name: item.name })),
    filter, filters: menu, draftChoice: filters.draft, choices, clearFiltersHref: '/pull-requests?' + clearFilters, activeFilterCount,
    incompleteSearch, cappedSearch, sort, search, page, through, tab, detailPage, groups, detailsUnavailable, partitionsUnavailable, failures,
    restoreRetry, clippedRestoration: false,
    listUnavailable: viewer === null || (list.length > 0 && failures.length === list.length),
    pageBack: page > 1 ? pageHref(page - 1) : '',
    pageNext: !restoreRetry && nextPage && through < MAX_LIST_PAGE ? pageHref(through + 1) : '',
    selected, savedViewScope, savedViewDetail: savedViewDetail.toString(), listSelectionFields,
    selectionError: selectionInProfile && query.has('selectedUrl') && !selectionRepo ? 'Choose a pull request in a trusted GitHub project in this profile.' : '',
    listHref: href(), summaryHref: detailsHref('summary'), timelineHref: detailsHref('timeline'), codeHref: detailsHref('code'),
    detailBack: detailsHref(tab, detailPage - 1), detailNext: detailsHref(tab, detailPage + 1),
    viewedAction: reviewAction('viewed'),
    viewedAnchor: query.get('file') ?? '', viewedNotice: viewedMessages.get(query.get('viewedResult') ?? '') ?? '',
    conversationAction: reviewAction('conversation'),
    conversationAnchor: query.get('conversation') ?? '',
    conversationNotice: conversationMessages.get(query.get('conversationResult') ?? '') ?? '',
    replyAction: reviewAction('reply'),
    replyNotice: query.get('replyResult') === 'posted' ? 'Reply posted.' : '',
    inlineReviewAction: reviewAction('review'),
    inlineReviewNotice: query.get('reviewResult') === 'posted' ? 'Review submitted to GitHub.' : '',
    inlineReviewEdit: reviewCommentCursor(query.get('reviewEdit')) ?? '',
    lifecycleEndpoint: '/pull-requests/lifecycle?' + lifecycleParams,
    lifecycleNotice: lifecycleSuccess(query.get('lifecycleResult')),
    labelsHref: href({ selectedUrl, tab: 'summary', labels: 'edit' }) + '#pr-labels',
    labelsEndpoint: detailsHref('summary').replace('/pull-requests?', '/pull-requests/labels?') + '#pr-labels',
    labelsNotice: query.get('labelsResult') === 'updated' ? 'Labels updated on GitHub.' : '',
    reviewersHref: href({ selectedUrl, tab: 'summary', reviewers: 'edit' }) + '#pr-reviewers',
    reviewersEndpoint: detailsHref('summary').replace('/pull-requests?', '/pull-requests/reviewers?') + '#pr-reviewers',
    reviewersNotice: query.get('reviewersResult') === 'updated' ? 'Review requests updated on GitHub.' : '',
    commentsBase,
    commentsAction: commentsBase.replace('/pull-requests?', '/pull-requests/comments?'),
  }
}

export async function pullRequestWorkspace(state: HarnessState, query: URLSearchParams, signal: AbortSignal, listOnly = false) {
  const view = await readPullRequestWorkspace(state, query, signal, listOnly)
  if (view.through === view.page || view.groups.reduce((count, group) => count + group.entries.length, 0) <= MAX_RESTORED_ROWS) return view
  const firstPage = new URLSearchParams(query)
  firstPage.delete('through')
  return { ...await readPullRequestWorkspace(state, firstPage, signal, listOnly), clippedRestoration: true }
}

function reviewReturnParams(query: URLSearchParams, profile: number, url: string, tab: typeof tabs[number] = 'code') {
  const params = new URLSearchParams({ profile: String(profile), selectedUrl: url, tab })
  for (const key of ['state', 'sort', 'repository', 'page', 'through', 'detailPage']) {
    const value = query.get(key)
    if (value && value.length <= 512) params.set(key, value)
  }
  const { search, menu } = readPullRequestListSearch(query)
  if (search) params.set('q', search)
  writePullRequestFilters(params, menu)
  if (tab === 'code') carryReviewView(query, params)
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
  return (await trustedGitHubRepositories(state.workspaces.values(), profile, signal)).get(repository.toLowerCase())
}

function reviewerRevision(profile: number, repository: Repository, current: LifecycleSnapshot, intent: string, scope: string) {
  return createHash('sha256').update(JSON.stringify(['pr-reviewers', profile, repository.workspace.id,
    repository.name.toLowerCase(), current.id, current.viewer.id, intent, scope])).digest('hex')
}

function reviewerContext(repository: Repository, number: number, current: LifecycleSnapshot, credential: string, signal: AbortSignal) {
  return { path: repository.path, repository: repository.name, number, pullId: current.id, credential, signal }
}

async function reviewReviewerEditor(repository: Repository, number: number, current: LifecycleSnapshot, profile: number, credential: string, signal: AbortSignal,
  search = '', staged: NonNullable<ReturnType<typeof parseReviewerSelection>>['changes'] = [], intent: string = crypto.randomUUID()) {
  const review = await readPullRequestReviewerEditor(reviewerContext(repository, number, current, credential, signal), search, staged)
  return review ? { ...review, viewer: current.viewer.id, head: current.headRefOid, intent,
    revision: reviewerRevision(profile, repository, current, intent, review.scope) } : null
}

export type PullRequestReviewerEditor = NonNullable<Awaited<ReturnType<typeof reviewReviewerEditor>>>
export type PullRequestReviewerDraft = { viewer: string, head: string, intent: string, scope: string, revision: string, checked: string[] }

const reviewerMessages = {
  updated: 'Review requests updated on GitHub.',
  confirmed: 'GitHub already confirmed the earlier review requests.',
  search: '',
  denied: 'This GitHub account cannot change review requests.',
  changed: 'The pull request, account, or reviewed people changed. Open Change reviewers to review again.',
  unavailable: 'Could not load reviewers from GitHub. Try again.',
  refused: 'GitHub refused a review request change. Open Change reviewers to review current access.',
  pending: 'GitHub has yet to confirm every reviewed change.',
}

export async function updateWorkspacePullRequestReviewers(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const submission = await readReviewSubmission(state, query, request, 650_000)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const scope = values.get('scope') ?? ''
  const revision = values.get('revision') ?? ''
  const intent = values.get('intent') ?? ''
  const operation = values.get('operation') ?? 'save'
  const selected = parseReviewerSelection(scope, values.getAll('reviewer'))
  if (!selected || !['search', 'save'].includes(operation) || !/^[0-9a-f]{64}$/u.test(revision)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(intent)) return null
  const params = reviewReturnParams(query, profile, selection.url, 'summary')
  const finish = (result: keyof typeof reviewerMessages, editor?: PullRequestReviewerEditor) => {
    const target = new URLSearchParams(params)
    if (result === 'updated' || result === 'confirmed') target.set('reviewersResult', 'updated')
    const fallback: PullRequestReviewerDraft | undefined = result === 'pending'
      ? { viewer, head, intent, scope, revision, checked: selected.checked } : undefined
    return { result, message: reviewerMessages[result], params, fallback, editor, location: '/pull-requests?' + target + '#pr-reviewers' }
  }
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return finish('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const current = await readPullRequestLifecycle(repository.path, repository.name, selection.number, signal, credential)
    if (!current) return finish('unavailable')
    if (current.viewer.id !== viewer || revision !== reviewerRevision(profile, repository, current, intent, scope)) return finish('changed')
    if (!current.canRequestReviewers) return finish('denied')
    if (operation === 'search') {
      if (receipts.inspect(intent, revision)) return finish('changed')
      const search = (values.get('query') ?? '').slice(0, 100).replace(/\p{Cc}/gu, '').trim()
      const editor = await reviewReviewerEditor(repository, selection.number, current, profile, credential, signal, search, selected.changes, intent).catch(() => null)
      return editor ? finish('search', editor) : finish('unavailable', { scope, intent, revision, viewer, head, search, more: false, matches: -1,
        options: reviewerOptions(selected.rows, repository.name, new Set(selected.checked)) })
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(['pr-reviewer-changes', revision, selected.checked])).digest('hex')
    const result = await applyPullRequestReviewerChanges({ ...reviewerContext(repository, selection.number, current, credential, signal), receipts,
      trusted: () => Boolean(stillTrusted(state, repository.workspace)),
    }, selected.changes, intent, fingerprint)
    return finish(result)
  }
  catch { return finish('unavailable') }
}

function labelReviewRevision(profile: number, workspace: number, repository: string, pull: string, viewer: string, scope: string) {
  return createHash('sha256').update(JSON.stringify(['pr-label-review', profile, workspace, repository.toLowerCase(), pull, viewer, scope])).digest('hex')
}

async function reviewLabelEditor(repository: Repository, number: number, current: LifecycleSnapshot, profile: number, credential: string, signal: AbortSignal,
  search = '', staged: NonNullable<ReturnType<typeof parseLabelSelection>>['changes'] = [], intent: string = crypto.randomUUID()) {
  const editor = await readPullRequestLabelEditor({ path: repository.path, repository: repository.name, number, credential, signal }, search, staged)
  return editor ? { ...editor, head: current.headRefOid, viewer: current.viewer.id, intent,
    revision: labelReviewRevision(profile, repository.workspace.id, repository.name, current.id, current.viewer.id, editor.scope) } : null
}

export type PullRequestLabelEditor = NonNullable<Awaited<ReturnType<typeof reviewLabelEditor>>>
export type PullRequestLabelDraft = { viewer: string, head: string, intent: string, scope: string, revision: string, checked: string[] }

const labelMessages = {
  updated: 'Labels updated on GitHub.',
  confirmed: 'GitHub already confirmed the earlier label changes.',
  search: '',
  denied: 'This GitHub account cannot change these labels.',
  changed: 'The pull request, account, or reviewed labels changed. Open Change labels to review again.',
  unavailable: 'Could not load the labels from GitHub. Try again.',
  refused: 'GitHub refused a reviewed label change. Open Change labels to review the current labels.',
  pending: 'GitHub has yet to confirm all the reviewed label changes.',
}

export async function updateWorkspacePullRequestLabels(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const submission = await readReviewSubmission(state, query, request, 3_300_000)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const scope = values.get('scope') ?? ''
  const revision = values.get('revision') ?? ''
  const intent = values.get('intent') ?? ''
  const operation = values.get('operation') ?? 'save'
  const labels = parseLabelSelection(scope, values.getAll('label'))
  if (!labels || !['save', 'search'].includes(operation) || (operation === 'search' && labels.legacy) || !/^[0-9a-f]{64}$/u.test(revision)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(intent)) return null
  const params = reviewReturnParams(query, profile, selection.url, 'summary')
  const finish = (result: keyof typeof labelMessages, editor?: PullRequestLabelEditor) => {
    const target = new URLSearchParams(params)
    if (result === 'updated' || result === 'confirmed') target.set('labelsResult', 'updated')
    const fallback: PullRequestLabelDraft | undefined = result === 'pending'
      ? { viewer, head, intent, scope, revision, checked: labels.checked } : undefined
    return { result, message: labelMessages[result], params, fallback, editor, location: '/pull-requests?' + target + '#pr-labels' }
  }
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return finish('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const current = await readPullRequestLifecycle(repository.path, repository.name, selection.number, signal, credential)
    if (!current) return finish('unavailable')
    if (current.viewer.id !== viewer || revision !== labelReviewRevision(profile, repository.workspace.id, repository.name, current.id, viewer, scope))
      return finish('changed')
    if (!current.canTriage) return finish('denied')
    if (operation === 'search') {
      if (receipts.inspect(intent, revision)) return finish('changed')
      const search = (values.get('query') ?? '').slice(0, 120).replace(/\p{Cc}/gu, '').trim()
      const editor = await reviewLabelEditor(repository, selection.number, current, profile, credential, signal, search, labels.changes, intent).catch(() => null)
      return editor ? finish('search', editor) : finish('unavailable', { scope, intent, revision, viewer, head, search, more: false, matches: -1, labels: labels.labels })
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(['pr-label-changes', revision, labels.checked])).digest('hex')
    const result = await applyPullRequestLabelChanges({
      path: repository.path, repository: repository.name, number: selection.number, credential, signal, receipts,
      trusted: () => Boolean(stillTrusted(state, repository.workspace)),
    }, labels.changes, intent, fingerprint)
    return finish(result)
  }
  catch { return finish('unavailable') }
}

const lifecycleMessages = {
  changed: 'The pull request or GitHub account changed. Review its current state before trying again.',
  'branch-changed': 'The remote branch changed on GitHub. Review its current commit before trying again.',
  'approval-changed': 'The pull request or its workflow runs changed. Review the current runs before approving.',
  unavailable: 'Could not reach GitHub. Try again when the host is connected.',
  denied: 'This GitHub account cannot update the pull request.',
  refused: 'GitHub refused this transition. Check the pull request on GitHub for more details.',
  busy: 'A pull request update is in progress. Try again shortly.',
  pending: 'GitHub has yet to confirm this update. Check GitHub again to recover its result.',
}

const workflowApprovalMessages: Partial<Record<keyof typeof lifecycleMessages, string>> = {
  denied: 'This GitHub account cannot approve these workflow runs.',
  refused: 'GitHub refused approval for a reviewed run. Check the workflow on GitHub.',
  pending: 'GitHub has yet to confirm every reviewed workflow.',
}

function lifecycleSuccess(value: string | null) {
  if (value === 'confirmed') return 'GitHub already confirmed the earlier update.'
  const action = lifecycleAction(value)
  return action ? lifecycleActions[action].success : ''
}

export type PullRequestLifecycleDraft = { action: LifecycleAction, revision: string, token: string, head: string, base: string,
  baseBranch: string, sourceBranch: string, sourceRepositoryId: string, approvalRuns: string, approvalRevision: string,
  method: MergeMethod | null, viewer: string, message: string }

const lifecycleWrites = new Set<string>()

export async function updateWorkspacePullRequestLifecycle(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const submission = await readReviewSubmission(state, query, request, 48_000)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const action = lifecycleAction(values.get('action'))
  const base = values.get('base') ?? ''
  const token = values.get('intent') ?? ''
  const revision = values.get('revision') ?? ''
  if (!action || !/^[0-9a-f]{40}$/u.test(base) || !/^[0-9a-f]{64}$/u.test(revision)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(token)) return null
  const merging = isMergeAction(action)
  const updatingBranch = action === 'update-branch'
  const reverting = action === 'revert'
  const deletingBranch = action === 'delete-branch'
  const approving = action === 'approve-workflows'
  const scopedBranch = merging || updatingBranch || reverting || deletingBranch || approving
  const baseBranch = scopedBranch ? values.get('baseBranch') ?? '' : ''
  const sourceBranch = deletingBranch ? values.get('sourceBranch') ?? '' : ''
  const sourceRepositoryId = deletingBranch ? values.get('sourceRepositoryId') ?? '' : ''
  const approvalRuns = approving ? values.get('approvalRuns') ?? '' : ''
  const approvalRevision = approving ? values.get('approvalRevision') ?? '' : ''
  const runs = approving ? parseWorkflowRunSelection(approvalRuns) : null
  const methodValue = values.get('method')
  const method = mergeMethod(methodValue)
  if ((takesMergeMethod(action) || updatingBranch ? !method : Boolean(methodValue))
    || (updatingBranch && !branchUpdateMethods.some(option => option.value === method))
    || (scopedBranch && (!baseBranch || baseBranch.length > 1024 || /\p{Cc}/u.test(baseBranch)))
    || (approving && (!runs || !/^[0-9a-f]{64}$/u.test(approvalRevision)))
    || (deletingBranch && (!sourceBranch || sourceBranch.length > 1024 || /\p{Cc}/u.test(sourceBranch)
      || !sourceRepositoryId || sourceRepositoryId.length > 256 || /\p{Cc}/u.test(sourceRepositoryId)))) return null
  const tab = tabs.find(value => query.get('tab') === value) ?? 'summary'
  const params = reviewReturnParams(query, profile, selection.url, tab)
  const finish = (result: 'updated' | keyof typeof lifecycleMessages, confirmedAction: LifecycleAction | 'confirmed' = action, newPull?: number) => {
    const message = result === 'updated' ? lifecycleSuccess(confirmedAction)
      : (approving ? workflowApprovalMessages[result] : undefined) ?? lifecycleMessages[result]
    const fallback: PullRequestLifecycleDraft | undefined = result === 'pending'
      ? { action, revision, token, head, base, baseBranch, sourceBranch, sourceRepositoryId, approvalRuns, approvalRevision, method, viewer, message }
      : undefined
    const target = newPull === undefined ? new URLSearchParams(params)
      : reviewReturnParams(query, profile, `https://github.com/${selection.repository}/pull/${newPull}`, 'summary')
    if (newPull !== undefined) {
      target.set('state', 'open')
      target.delete('q')
      target.delete('detailPage')
      target.delete('page')
    }
    if (result === 'updated') {
      if (updatingBranch) for (const key of ['reviewLine', 'reviewStart', 'reviewHead', 'reviewBase']) target.delete(key)
      target.set('lifecycleResult', confirmedAction)
    }
    return { result, message, fallback, params, location: '/pull-requests?' + target + '#pr-lifecycle' }
  }
  const reach = (pull: LifecycleSnapshot) => lifecycleTargetReached(pull, action, method, head)
  const confirm = (pull: LifecycleSnapshot) => finish('updated', !reach(pull) ? 'confirmed' : merging && pull.state === 'MERGED' ? 'merge' : action)
  const key = selection.repository.toLowerCase() + '#' + selection.number
  if (lifecycleWrites.has(key)) return finish('busy')
  lifecycleWrites.add(key)
  let attempted = false
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return finish('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const read = () => readPullRequestLifecycle(repository.path, repository.name, selection.number, signal, credential)
    const before = await read()
    if (!before) return finish('unavailable')
    if (before.viewer.id !== viewer || !stillTrusted(state, repository.workspace)) return finish('changed')
    if (approving) {
      if (!runs) return null
      if (before.headRefOid !== head || before.baseRefOid !== base || before.baseRefName !== baseBranch) return finish('approval-changed')
      const result = await approveWorkspaceWorkflows({
        path: repository.path, repository: repository.name, before, read, receipts, signal, credential,
        trusted: () => Boolean(stillTrusted(state, repository.workspace)), authority: [profile, repository.workspace.id],
      }, { token, revision, approvalRevision, runs })
      if (result === 'confirmed') return finish('updated', 'confirmed')
      return finish(result === 'changed' ? 'approval-changed' : result)
    }
    if (deletingBranch) {
      if (before.headRefOid !== head) return finish('changed')
      const canStart = before.baseRefName === baseBranch && before.baseRefOid === base && revision === lifecycleRevision(before)
      const result = await deleteWorkspacePullRequestBranch(repository.path, before, { name: sourceBranch, repositoryId: sourceRepositoryId },
        canStart, () => Boolean(stillTrusted(state, repository.workspace)), receipts, signal, credential)
      return result === 'confirmed' ? finish('updated', 'confirmed') : finish(result)
    }
    if (reverting) {
      if (before.state !== 'MERGED' || before.baseRefName !== baseBranch || before.baseRefOid !== base || before.headRefOid !== head)
        return finish('changed')
      const canStart = revision === lifecycleRevision(before) && availableLifecycleActions(before).includes('revert')
      const result = await revertWorkspacePullRequest(repository.path, repository.name, before, canStart, receipts, signal, credential)
      if (typeof result === 'number') return finish('updated', 'revert', result)
      return result === 'confirmed' ? finish('updated', 'confirmed') : finish(result)
    }
    // Reloading a still-behind PR keeps the same receipt for an update of these exact commits.
    const branchReceipt = ['pr-branch-update', profile, repository.workspace.id, key, before.id, viewer, head, base, baseBranch]
    const receiptToken = updatingBranch ? createHash('sha256').update(JSON.stringify(branchReceipt)).digest('hex') : token
    const fingerprint = createHash('sha256').update(JSON.stringify(updatingBranch ? [...branchReceipt, method]
      : ['lifecycle', profile, repository.workspace.id, key, before.id, viewer, action, revision, head, base, ...(merging ? [baseBranch, method] : [])])).digest('hex')
    const result = receipts.inspect(receiptToken, fingerprint)
    const sameTarget = (pull: LifecycleSnapshot) => updatingBranch ? pull.baseRefName === baseBranch && pull.baseRefOid === base
      : pull.headRefOid === head && (merging ? pull.baseRefName === baseBranch : pull.baseRefOid === base)
    if (result === 'confirmed') return sameTarget(before) ? confirm(before) : finish('updated', 'confirmed')
    if (result === 'conflict' || !sameTarget(before)) return finish('changed')
    if (result === 'pending') {
      if (!reach(before)) return finish('pending')
      receipts.confirm(receiptToken, fingerprint)
      return confirm(before)
    }
    if (!(updatingBranch ? before.branch.canUpdate : merging ? before.merge.canWrite : before.viewerCanUpdate)) return finish('denied')
    if (before.headRefOid !== head || before.baseRefOid !== base || revision !== lifecycleRevision(before) || !availableLifecycleActions(before).includes(action)
      || (merging && method && !before.merge.methods.includes(method))) return finish('changed')
    const claimed = receipts.claim(receiptToken, fingerprint, true)
    if (claimed === 'confirmed') return confirm(before)
    if (claimed === 'conflict') return finish('changed')
    if (claimed !== 'claimed') return finish('pending')
    attempted = true
    const write = await writePullRequestLifecycle(repository.path, before, action, method, signal, credential)
    if (write === 'denied' || write === 'refused') {
      receipts.reject(receiptToken, fingerprint)
      return finish(write)
    }
    const after = await read()
    if (!after) return finish('pending')
    if (after.viewer.id !== viewer || after.id !== before.id || !sameTarget(after)
      || !stillTrusted(state, repository.workspace)) return finish('changed')
    if (!reach(after)) return finish('pending')
    receipts.confirm(receiptToken, fingerprint)
    return confirm(after)
  }
  catch { return finish(attempted ? 'pending' : 'unavailable') }
  finally { lifecycleWrites.delete(key) }
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

const inlineReviewMessages = {
  posted: 'Review submitted to GitHub.',
  invalid: 'GitHub rejected the review. Check its verdict and comments before submitting again.',
  changed: 'The pull request, selected lines, or GitHub account changed. Refresh the Code view before continuing.',
  denied: 'This GitHub account cannot submit that review.',
  unavailable: 'Could not prepare the review with GitHub. Your draft is still here.',
  pending: 'GitHub has yet to confirm this review. Check again to recover it.',
}

export async function submitWorkspaceInlineReview(state: HarnessState, query: URLSearchParams, request: Request, signal: AbortSignal,
  receipts: PullRequestReplyReceipts) {
  const submission = await readReviewSubmission(state, query, request, 900_000)
  if (!submission) return null
  const { profile, selection, values, head, viewer } = submission
  const input = readInlineReview(values)
  if (!input) return null
  const { token, base, verdict, summary, drafts } = input
  const finish = (result: keyof typeof inlineReviewMessages) => {
    const params = reviewReturnParams(query, profile, selection.url)
    params.set('reviewResult', 'posted')
    return { result, message: inlineReviewMessages[result],
      location: result === 'posted' ? '/pull-requests?' + params + '#inline-review-controls' : undefined }
  }
  let attempted = false
  try {
    const repository = await reviewRepository(state, profile, selection.repository, signal)
    if (!repository || !stillTrusted(state, repository.workspace)) return finish('changed')
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const api = (endpoint: string, payload?: object) => repositoryGitHubRequest(repository.path, endpoint, payload, signal, credential)
    const [owner, name] = repository.name.split('/')
    const identity = await api('graphql', {
      query: `query HarnessPullRequestReviewAccount($owner: String!, $name: String!, $number: Int!) {
        viewer { id login }
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { viewerDidAuthor } }
      }`,
      variables: { owner, name, number: selection.number },
    })
    const response = identity.body as { data?: { viewer?: { id?: string, login?: string }, repository?: { pullRequest?: { viewerDidAuthor?: boolean } } }, errors?: unknown[] } | null
    const account = response?.data?.viewer
    const author = response?.data?.repository?.pullRequest?.viewerDidAuthor
    if (identity.status !== 200 || response?.errors?.length || !account?.login || typeof author !== 'boolean') return finish('unavailable')
    if (account.id !== viewer || !stillTrusted(state, repository.workspace)) return finish('changed')
    const endpoint = `repos/${repository.name}/pulls/${selection.number}`
    const fingerprint = createHash('sha256').update(JSON.stringify(['inline-review', profile, repository.workspace.id,
      repository.name.toLowerCase(), selection.number, head, base, viewer, verdict, summary, drafts])).digest('hex')
    const body = inlineReviewBody(token, summary)
    const matches = (value: unknown) => matchesInlineReview(value, account.login!, head, body, verdict)
    const recover = async () => {
      for (let page = 1; page <= 10; page++) {
        if (!stillTrusted(state, repository.workspace)) return finish('changed')
        const list = await api(`${endpoint}/reviews?per_page=100&page=${page}`)
        if (list.status !== 200 || !Array.isArray(list.body)) break
        if (list.body.some(matches)) {
          receipts.confirm(token, fingerprint)
          return finish('posted')
        }
        if (!list.hasNextPage) break
      }
      return finish('pending')
    }
    const existing = receipts.inspect(token, fingerprint)
    if (existing === 'confirmed') return finish('posted')
    if (existing === 'conflict') return finish('changed')
    if (existing === 'pending') {
      attempted = true
      return await recover()
    }
    if (author && verdict !== 'COMMENT') return finish('denied')
    const pages = [...new Set(drafts.map(draft => draft.page))]
    const files = new Map<number, Map<string, string>>()
    for (let index = 0; index < pages.length; index += 4) {
      await Promise.all(pages.slice(index, index + 4).map(async (page) => {
        const change = await readReviewFiles(repository, selection.number, page, signal, credential)
        files.set(page, new Map(change.files.map(file => [file.path, file.patch])))
      }))
    }
    const comments = drafts.map(draft => anchoredReviewComment(draft, files.get(draft.page)?.get(draft.path) ?? ''))
    if (comments.some(comment => !comment)) return finish('changed')
    const current = await api(endpoint)
    const pull = current.status === 200 ? readPull(current.body, repository.name) : null
    if (!pull || pull.number !== selection.number || pull.head !== head || pull.baseSha !== base || !stillTrusted(state, repository.workspace))
      return finish('changed')
    const claimed = receipts.claim(token, fingerprint, true)
    if (claimed === 'confirmed') return finish('posted')
    if (claimed === 'conflict') return finish('changed')
    attempted = true
    if (claimed === 'pending') return await recover()
    try {
      const posted = await api(endpoint + '/reviews', { commit_id: head, event: verdict, body, comments })
      if ([404, 409, 422].includes(posted.status)) {
        receipts.reject(token, fingerprint)
        return finish(posted.status === 422 ? 'invalid' : 'changed')
      }
      if ([200, 201].includes(posted.status) && matches(posted.body)) {
        receipts.confirm(token, fingerprint)
        return finish('posted')
      }
    }
    catch (error) {
      if (error instanceof RepositoryPullRequestError && (error.status === 401 || error.status === 403)) {
        receipts.reject(token, fingerprint)
        return finish('denied')
      }
    }
    return await recover()
  }
  catch { return finish(attempted ? 'pending' : 'unavailable') }
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
