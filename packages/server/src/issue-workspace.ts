import type { InternalCommand } from '@harness/contract'
import { githubIssueReference, sameGitHubIssue } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import type { GitHubWorkspaceRepository } from './github-workspace-repositories'
import { trustedGitHubRepositories } from './github-workspace-repositories'
import { newThreadLink, parsePullRequest } from './prompt-links'
import { pullRequestLabels } from './pull-request-labels'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'
import { renderPullRequestCommentMarkdown } from './transcript-markdown'
import { threadTitle } from './thread-search'

const pageSize = 20
const searchLimit = 1000
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

interface IssueScope {
  state: 'open' | 'closed' | 'all'
  sort: 'updated' | 'created'
  search: string
  page: number
}

interface GitHubIssue {
  html_url?: unknown
  number?: unknown
  title?: unknown
  state?: unknown
  body?: unknown
  user?: { login?: unknown }
  assignees?: { login?: unknown }[]
  labels?: unknown
  created_at?: unknown
  updated_at?: unknown
  pull_request?: unknown
}

function positiveInteger(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : 0
}

function date(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

function login(value: unknown): string {
  return typeof value === 'string' && /^[\w-]{1,100}(?:\[bot\])?$/u.test(value) ? value : ''
}

function issueRow(value: unknown, repository: string) {
  if (!value || typeof value !== 'object') return null
  const issue = value as GitHubIssue
  const number = positiveInteger(issue.number)
  const url = 'https://github.com/' + repository + '/issues/' + number
  if (!number || issue.pull_request || typeof issue.html_url !== 'string' || issue.html_url.toLowerCase() !== url.toLowerCase()
    || typeof issue.title !== 'string' || (issue.state !== 'open' && issue.state !== 'closed')) return null
  const created = date(issue.created_at)
  const updated = date(issue.updated_at)
  return {
    repository, number, url, state: issue.state, title: issue.title.slice(0, 512), created, updated,
    author: login(issue.user?.login), labels: (pullRequestLabels(issue.labels) ?? []).slice(0, 30),
  }
}

function issueError(error: unknown): string {
  return error instanceof RepositoryPullRequestError ? error.message : 'GitHub did not respond. Try again.'
}

async function repositoryIssues(repository: GitHubWorkspaceRepository, scope: IssueScope, signal: AbortSignal) {
  const end = Math.min(searchLimit, scope.page * pageSize + 1)
  const size = Math.min(end, 100)
  const issues = new Map<number, NonNullable<ReturnType<typeof issueRow>>>()
  let partial = false
  for (let page = 1; (page - 1) * size < end; page++) {
    signal.throwIfAborted()
    const query = new URLSearchParams({
      sort: scope.sort, order: 'desc', per_page: String(size), page: String(page),
      q: ['is:issue', 'repo:' + repository.name, scope.state === 'all' ? '' : 'is:' + scope.state,
        scope.search ? 'in:title,body "' + scope.search + '"' : ''].filter(Boolean).join(' '),
    })
    const reply = await repositoryGitHubRequest(repository.path, 'search/issues?' + query, undefined, signal)
    const result = reply.body as { items?: unknown[], incomplete_results?: boolean, total_count?: number } | null
    if (reply.status !== 200 || !Array.isArray(result?.items))
      throw new RepositoryPullRequestError('GitHub could not list issues for this repository.')
    partial ||= Boolean(result.incomplete_results || (result.total_count ?? 0) > searchLimit)
    for (const item of result.items.slice(0, size)) {
      const row = issueRow(item, repository.name)
      if (row && (scope.state === 'all' || row.state === scope.state)) issues.set(row.number, row)
    }
    if (!reply.hasNextPage) break
  }
  return { rows: [...issues.values()], partial }
}

async function issueDetail(repository: GitHubWorkspaceRepository, number: number, commentPage: number, signal: AbortSignal) {
  const endpoint = 'repos/' + repository.name + '/issues/' + number
  const reply = await repositoryGitHubRequest(repository.path, endpoint, undefined, signal)
  const issue = reply.status === 200 ? issueRow(reply.body, repository.name) : null
  if (!issue || issue.number !== number) throw new RepositoryPullRequestError('This issue is unavailable to the GitHub account on this host.')

  const raw = reply.body as GitHubIssue
  const commentReply = await repositoryGitHubRequest(repository.path, endpoint + '/comments?' + new URLSearchParams({
    per_page: String(pageSize), page: String(commentPage),
  }), undefined, signal).catch(() => null)
  const commentsAvailable = commentReply?.status === 200 && Array.isArray(commentReply.body)
  const comments = commentsAvailable ? (commentReply.body as {
    id?: unknown, issue_url?: unknown, user?: { login?: unknown }, created_at?: unknown, body?: unknown,
  }[]).slice(0, pageSize).flatMap((comment) => {
    const id = positiveInteger(comment?.id)
    if (!id || typeof comment.issue_url !== 'string' || comment.issue_url.toLowerCase() !== ('https://api.github.com/' + endpoint).toLowerCase()
      || typeof comment.body !== 'string') return []
    const timestamp = date(comment.created_at)
    return [{ id, author: login(comment.user?.login), dateLabel: timestamp ? dates.format(timestamp) : '', body: comment.body.slice(0, 32_768) }]
  }) : []

  return {
    ...issue, dateLabel: issue.created ? dates.format(issue.created) : '',
    description: typeof raw.body === 'string' ? raw.body.slice(0, 65_536) : '',
    assignees: Array.isArray(raw.assignees) ? raw.assignees.map(assignee => login(assignee?.login)).filter(Boolean).slice(0, 20) : [],
    comments, commentsAvailable, moreComments: Boolean(commentsAvailable && commentReply.hasNextPage),
  }
}

export async function issueThreadUpdate(
  state: HarnessState, query: URLSearchParams, form: URLSearchParams, signal: AbortSignal,
): Promise<Extract<InternalCommand, { type: 'thread.issue.set' }> | null> {
  const issue = githubIssueReference({ tracker: 'github', repository: query.get('selected'), number: positiveInteger(query.get('issue')) })
  const profile = positiveInteger(query.get('profile'))
  const sessionId = positiveInteger(form.get('thread'))
  const action = form.get('action')
  const session = state.sessions.get(sessionId)
  const workspace = session && state.workspaces.get(session.workspaceId)
  if (!issue || !profile || !session || !workspace?.trusted || workspace.scratch || workspace.profileId !== profile
    || session.navigation?.archivedAt || (action !== 'link' && action !== 'unlink')) return null

  if (action === 'link') {
    const repositories = await trustedGitHubRepositories([workspace], profile, signal)
    if (!repositories.has(issue.repository)) return null
  }
  return { type: 'thread.issue.set', sessionId, issue, linked: action === 'link' }
}

export async function issueWorkspace(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const profiles = [...state.profiles.values()].map(({ id, name }) => ({ id, name }))
  const requestedProfile = positiveInteger(query.get('profile'))
  const profile = profiles.some(item => item.id === requestedProfile) ? requestedProfile : profiles[0]?.id || 0
  const repositories = await trustedGitHubRepositories(state.workspaces.values(), profile, signal)
  const repository = repositories.get((query.get('repository') || '').toLowerCase())
  const selectionName = query.get('selected') || ''
  const selection = repositories.get(selectionName.toLowerCase())
  const number = positiveInteger(query.get('issue'))
  const commentPage = Math.min(positiveInteger(query.get('comments')) || 1, 100)
  const filter = query.get('state')
  const scope: IssueScope = {
    state: filter === 'closed' || filter === 'all' ? filter : 'open',
    sort: query.get('sort') === 'created' ? 'created' : 'updated',
    search: (query.get('q') || '').slice(0, 160).replace(/["\\\p{Cc}]/gu, ' ').trim(),
    page: Math.min(positiveInteger(query.get('page')) || 1, searchLimit / pageSize),
  }
  const params = new URLSearchParams({ profile: String(profile), state: scope.state, sort: scope.sort })
  if (repository) params.set('repository', repository.name)
  if (scope.search) params.set('q', scope.search)
  if (scope.page > 1) params.set('page', String(scope.page))
  const href = (overrides: Record<string, string | number> = {}) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(overrides)) next.set(key, String(value))
    return '/issues?' + next
  }
  const detail = selection && number ? issueDetail(selection, number, commentPage, signal)
    .then(selected => ({ selected, error: '' }), error => ({ selected: null, error: issueError(error) })) : null
  const targets = repository ? [repository] : [...repositories.values()]
  const rows: Array<NonNullable<ReturnType<typeof issueRow>>> = []
  const failures: { repository: string, reason: string }[] = []
  let partial = false
  for (let offset = 0; offset < targets.length; offset += 4) {
    signal.throwIfAborted()
    const batch = targets.slice(offset, offset + 4)
    const outcomes = await Promise.allSettled(batch.map(target => repositoryIssues(target, scope, signal)))
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        rows.push(...outcome.value.rows)
        partial ||= outcome.value.partial
      }
      else failures.push({ repository: batch[index]!.name, reason: issueError(outcome.reason) })
    })
  }
  const { selected, error } = await detail ?? { selected: null, error: selectionName || number ? 'This issue is outside the selected profile.' : '' }
  signal.throwIfAborted()
  const selectedScope: Record<string, string | number> = selected ? { selected: selected.repository, issue: selected.number } : {}
  const pageEnd = scope.page * pageSize
  const reference = selected && githubIssueReference({ tracker: 'github', repository: selected.repository, number: selected.number })
  const linkedThreads = []
  const threadChoices = []
  const pullRequests = new Map<string, { href: string, label: string }>()
  if (reference && selection) {
    const threads = [...state.sessions.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || b.id - a.id)
    for (const thread of threads) {
      const workspace = state.workspaces.get(thread.workspaceId)
      if (!workspace?.trusted || workspace.scratch || workspace.profileId !== profile || thread.navigation?.archivedAt) continue
      const row = { id: thread.id, title: threadTitle(thread) }
      if (!thread.linkedIssues?.some(issue => sameGitHubIssue(issue, reference))) {
        if (thread.workspaceId === selection.workspace.id) threadChoices.push(row)
        continue
      }
      linkedThreads.push(row)
      const pulls = [...(thread.linkedPullRequests ?? []), ...(thread.pullRequest ? [thread.pullRequest] : [])]
      for (const pull of pulls) {
        const details = parsePullRequest(pull.repository + '/pull/' + pull.number)
        if (!details) continue
        const href = '/pull-requests?' + new URLSearchParams({ profile: String(profile), selectedUrl: details.url })
        pullRequests.set(details.url.toLowerCase(), { href, label: details.repository + '#' + details.number })
      }
    }
  }
  let draftHref = ''
  if (selected) {
    // The shared composer reviews the project and waits for an explicit send.
    // The link carries only the issue address, keeping private text off the URL.
    const draft = new URL(newThreadLink('http://localhost', selected.url, { repository: selected.repository }))
    draft.searchParams.set('profile', String(profile))
    draft.searchParams.set('issue', selected.url)
    draftHref = draft.pathname + draft.search
  }
  return {
    profiles, profile, repositories: [...repositories.values()].map(item => item.name).sort(),
    repository: repository?.name || '', scope, failures, partial, error, selected, draftHref,
    linkedThreads, threadChoices, pullRequests: [...pullRequests.values()],
    issueThreadAction: selected ? href(selectedScope).replace('/issues?', '/issues/threads?') : '',
    retryHref: href(selectedScope), datePurpose: scope.sort === 'created' ? 'Created' : 'Last updated',
    backHref: '/?' + new URLSearchParams({ profile: String(profile) }), listHref: href(),
    previousHref: scope.page > 1 ? href({ page: scope.page - 1 }) : '',
    nextHref: scope.page < searchLimit / pageSize && rows.length > pageEnd ? href({ page: scope.page + 1 }) : '',
    olderCommentsHref: selected && commentPage > 1 ? href({ ...selectedScope, comments: commentPage - 1 }) : '',
    newerCommentsHref: selected?.moreComments && commentPage < 100 ? href({ ...selectedScope, comments: commentPage + 1 }) : '',
    rows: rows.sort((a, b) => b[scope.sort] - a[scope.sort]).slice(pageEnd - pageSize, pageEnd).map(row => ({
      ...row, href: href({ selected: row.repository, issue: row.number }),
      dateLabel: row[scope.sort] ? dates.format(row[scope.sort]) : '',
      current: row.repository === selected?.repository && row.number === selected.number,
    })),
  }
}

export function renderIssueMarkdown(html: string, view: Awaited<ReturnType<typeof issueWorkspace>>) {
  if (!view.selected) return html
  const bodies = new Map(view.selected.comments.map(comment => [String(comment.id), comment.body]))
  bodies.set('description', view.selected.description)
  return new HTMLRewriter().on('[data-issue-markdown]', { element(element) {
    const text = bodies.get(element.getAttribute('data-issue-markdown') ?? '')
    if (text) element.setInnerContent(renderPullRequestCommentMarkdown(text), { html: true })
  } }).transform(html)
}
