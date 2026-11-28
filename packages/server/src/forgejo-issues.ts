import { issueRepositoryKey, parseForgejoIssueUrl } from '@harness/contract'
import type { IssueActivityItem } from './issue-activity'
import type { ForgejoIssueRepository } from './issue-repositories'
import type { IssueScope } from './issue-workspace'
import { forgejoTeaRequest } from './forgejo-tea'
import { pullRequestLabels } from './pull-request-labels'
import { RepositoryPullRequestError } from './repository-pull-request'

const involvementParameter = { assigned: 'assigned_by', authored: 'created_by', mentioned: 'mentioned_by' } as const
const pageSize = 20
const sourcePageSize = 50
const requestLimit = 10
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

type User = { login?: unknown, full_name?: unknown }
type RawIssue = {
  number?: unknown, html_url?: unknown, title?: unknown, body?: unknown, state?: unknown, created_at?: unknown, updated_at?: unknown,
  user?: User, assignees?: User[], labels?: unknown, comments?: unknown, pull_request?: unknown,
}
type RawComment = { id?: unknown, body?: unknown, created_at?: unknown, user?: User, issue_url?: unknown }

function username(value?: User) {
  return typeof value?.login === 'string' && /^[a-z\d._-]{1,100}$/iu.test(value.login) ? value.login : ''
}

function stamp(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

function repoPath(repository: ForgejoIssueRepository) {
  return 'repos/' + repository.apiName.split('/').map(encodeURIComponent).join('/')
}

function forgejoLabels(value: unknown) {
  return pullRequestLabels(Array.isArray(value) ? value.map(label => label && typeof label.color === 'string'
    ? { ...label, color: label.color.replace(/^#/u, '') } : label) : value)
}

function issueRow(repository: ForgejoIssueRepository, raw: RawIssue | null) {
  if (!raw || raw.pull_request || typeof raw.html_url !== 'string' || typeof raw.title !== 'string'
    || (raw.state !== 'open' && raw.state !== 'closed')) return null
  const reference = parseForgejoIssueUrl(raw.html_url)
  if (!reference || issueRepositoryKey(reference) !== repository.key || reference.number !== raw.number) return null
  return {
    tracker: 'forgejo' as const, sourceKey: repository.key, repository: repository.name,
    sourceLabel: 'Forgejo · ' + repository.host, number: reference.number, url: raw.html_url,
    state: raw.state, title: raw.title.slice(0, 512), created: stamp(raw.created_at), updated: stamp(raw.updated_at),
    author: username(raw.user), assignees: Array.isArray(raw.assignees) ? raw.assignees.map(username).filter(Boolean).slice(0, 50) : [],
    labels: (forgejoLabels(raw.labels) ?? []).slice(0, 50),
  }
}

export async function listForgejoIssues(repository: ForgejoIssueRepository, scope: IssueScope, signal: AbortSignal) {
  const viewer = scope.involvement || scope.assignee === '@me'
    ? username((await forgejoTeaRequest(repository, 'user', signal)).body as User) : ''
  if ((scope.involvement || scope.assignee === '@me') && !viewer)
    throw new RepositoryPullRequestError('Forgejo could not identify the signed-in account.')
  const assignee = scope.assignee === '@me' ? viewer : scope.assignee
  const requiredAssignees = [...new Set([assignee, scope.involvement === 'assigned' ? viewer : ''].filter(Boolean).map(value => value.toLowerCase()))]
  const request = new URLSearchParams({ type: 'issues', state: scope.state, sort: scope.sort === 'created' ? 'latest' : 'recentupdate',
    limit: String(sourcePageSize) })
  if (scope.search) request.set('q', scope.search)
  if (scope.labels.length && scope.labels.every(value => !value.includes(','))) request.set('labels', scope.labels.join(','))
  if (scope.involvement) request.set(involvementParameter[scope.involvement], viewer)
  if (assignee) request.set('assigned_by', assignee)
  const rows = new Map<number, NonNullable<ReturnType<typeof issueRow>>>()
  const end = scope.page * pageSize + 1
  let partial = false
  for (let page = 1; page <= requestLimit && rows.size < end; page++) {
    request.set('page', String(page))
    const result = await forgejoTeaRequest(repository, repoPath(repository) + '/issues?' + request, signal)
    if (!Array.isArray(result.body)) throw new RepositoryPullRequestError('Forgejo returned an unreadable issue list.')
    for (const item of result.body.slice(0, sourcePageSize)) {
      const row = issueRow(repository, item)
      if (row && (scope.state === 'all' || row.state === scope.state)
        && (scope.involvement !== 'authored' || row.author.toLowerCase() === viewer.toLowerCase())
        && requiredAssignees.every(name => row.assignees.some(person => person.toLowerCase() === name))
        && scope.labels.every(name => row.labels.some(label => label.name.toLowerCase() === name.toLowerCase())))
        rows.set(row.number, row)
    }
    if (!(result.more ?? result.body.length > 0)) break
    if (page === requestLimit && rows.size < end) partial = true
  }
  return { rows: [...rows.values()], partial }
}

export async function readForgejoIssue(repository: ForgejoIssueRepository, number: number, requestedPage: number | 'latest' | null, signal: AbortSignal) {
  const endpoint = repoPath(repository) + '/issues/' + number
  const reply = await forgejoTeaRequest(repository, endpoint, signal)
  const raw = reply.body as RawIssue | null
  const row = issueRow(repository, raw)
  if (!row || !raw || row.number !== number) throw new RepositoryPullRequestError('Forgejo could not verify this issue.')
  const commentTotal = typeof raw.comments === 'number' && Number.isSafeInteger(raw.comments) ? Math.max(0, raw.comments) : 0
  const replyComments = await forgejoTeaRequest(repository, endpoint + '/comments', signal).catch(() => null)
  const comments = Array.isArray(replyComments?.body) ? replyComments.body : null
  const page = typeof requestedPage === 'number' ? requestedPage : requestedPage === 'latest'
    ? Math.max(1, Math.ceil((comments?.length ?? commentTotal) / pageSize)) : 1
  const activity = (comments ?? []).slice((page - 1) * pageSize, page * pageSize).flatMap<IssueActivityItem>((comment: RawComment | null) => {
    const id = comment?.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || typeof comment?.body !== 'string') return []
    if (typeof comment.issue_url === 'string' && comment.issue_url.toLowerCase() !== (repository.base + '/api/v1/' + endpoint).toLowerCase()) return []
    const date = stamp(comment.created_at)
    return [{ kind: 'comment', id, body: comment.body.slice(0, 32_768), author: username(comment.user),
      dateLabel: date ? dates.format(date) : '', url: row.url + '#issuecomment-' + id }]
  })
  return { ...row, description: typeof raw.body === 'string' ? raw.body.slice(0, 65_536) : '',
    dateLabel: row.created ? dates.format(row.created) : '', activity, reactions: null, commentTotal,
    activityAvailable: Boolean(comments), activityDegraded: false, olderActivity: '', newerActivity: '',
    commentPage: page, moreComments: Boolean(comments && comments.length > page * pageSize), relatedRequests: [] as { href: string, label: string }[],
  }
}

export async function searchForgejoIssueChoices(repository: ForgejoIssueRepository, kind: 'labels' | 'assignees', search: string, signal: AbortSignal) {
  const options = new Map<string, { value: string, description: string, color?: string }>()
  const query = search.toLowerCase()
  for (let page = 1; page <= requestLimit; page++) {
    const result = await forgejoTeaRequest(repository, repoPath(repository) + '/' + kind + '?limit=50&page=' + page, signal)
    if (!Array.isArray(result.body)) throw new RepositoryPullRequestError('Forgejo returned unreadable filter choices.')
    const rows = kind === 'labels' ? (forgejoLabels(result.body) ?? []).map(label => ({ value: label.name, description: label.description, color: label.color }))
      : result.body.map(user => ({ value: username(user), description: typeof user?.full_name === 'string' ? user.full_name.slice(0, 160) : '' }))
    for (const row of rows) {
      if (row.value && (row.value.toLowerCase().includes(query) || row.description.toLowerCase().includes(query))) options.set(row.value.toLowerCase(), row)
    }
    if (options.size > sourcePageSize) return { options: [...options.values()].slice(0, sourcePageSize), more: true }
    if (!(result.more ?? result.body.length > 0)) return { options: [...options.values()], more: false }
  }
  return { options: [...options.values()], more: true }
}
