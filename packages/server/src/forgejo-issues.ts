import { createHash } from 'node:crypto'
import { gitLabProject, issueRepositoryKey, parseForgejoIssueUrl } from '@harness/contract'
import type { IssueActivityItem } from './issue-activity'
import type { ForgejoIssueRepository } from './issue-repositories'
import type { IssueRelatedRequest, IssueScope } from './issue-workspace'
import { forgejoTeaRequest } from './forgejo-tea'
import { issueCreationMarker } from './issue-creation-marker'
import { openClosedIssueStatusPlan } from './issue-status'
import { pullRequestLabels } from './pull-request-labels'
import { RepositoryPullRequestError } from './repository-pull-request'

const involvementParameter = { assigned: 'assigned_by', authored: 'created_by', mentioned: 'mentioned_by' } as const
const pageSize = 20
const sourcePageSize = 50
const requestLimit = 10
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

type User = { id?: unknown, login?: unknown, full_name?: unknown }
type RawIssue = {
  id?: unknown, is_locked?: unknown, number?: unknown, html_url?: unknown, title?: unknown, body?: unknown, state?: unknown, created_at?: unknown, updated_at?: unknown,
  user?: User, assignees?: User[], labels?: unknown, comments?: unknown, pull_request?: unknown,
}
type RawComment = { id?: unknown, body?: unknown, created_at?: unknown, user?: User, issue_url?: unknown }
type RawTimelineEntry = {
  id?: unknown, type?: unknown, body?: unknown, user?: User, created_at?: unknown, assignee?: User,
  removed_assignee?: unknown, new_title?: unknown, label?: { name?: unknown },
  ref_issue?: { number?: unknown, html_url?: unknown, repository?: { full_name?: unknown }, pull_request?: unknown },
}
type CitedPull = { repository: string, number: number, href: string }
type TimedActivity = IssueActivityItem & { id: number, created: number }

function username(value?: User) {
  return typeof value?.login === 'string' && /^[a-z\d._-]{1,100}$/iu.test(value.login) ? value.login : ''
}

function stamp(value: unknown) {
  return typeof value === 'string' ? Date.parse(value) || 0 : 0
}

export function forgejoRepoPath(repository: ForgejoIssueRepository) {
  return 'repos/' + repository.apiName.split('/').map(encodeURIComponent).join('/')
}

export function forgejoLabels(value: unknown) {
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
    const result = await forgejoTeaRequest(repository, forgejoRepoPath(repository) + '/issues?' + request, signal)
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

type RawRepository = { id?: unknown, full_name?: unknown, archived?: unknown, has_issues?: unknown, permissions?: { push?: boolean } }

function numericId(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function belongsToIssue(repository: ForgejoIssueRepository, endpoint: string, comment: RawComment) {
  return comment.issue_url == null
    || (typeof comment.issue_url === 'string' && comment.issue_url.toLowerCase() === (repository.base + '/api/v1/' + endpoint).toLowerCase())
}

function forgejoIssueEndpoint(repository: ForgejoIssueRepository, number: number) {
  return forgejoRepoPath(repository) + '/issues/' + number
}

export function forgejoReactionEndpoint(repository: ForgejoIssueRepository, number: number, comment: number) {
  return (comment ? forgejoRepoPath(repository) + '/issues/comments/' + comment : forgejoIssueEndpoint(repository, number)) + '/reactions'
}

export async function forgejoIssueHasComment(repository: ForgejoIssueRepository, number: number, comment: number, signal: AbortSignal) {
  const endpoint = forgejoIssueEndpoint(repository, number)
  const { body } = await forgejoTeaRequest(repository, endpoint + '/comments', signal)
  return Array.isArray(body) && body.some(row => numericId(row?.id) === comment && typeof row.body === 'string'
    && belongsToIssue(repository, endpoint, row))
}

type ForgejoTriageKind = 'labels' | 'assignees'

function appliedForgejoChoices(issue: RawIssue, kind: ForgejoTriageKind) {
  if (issue[kind] == null) return []
  if (kind === 'labels') return forgejoLabels(issue.labels)?.map(label =>
    ({ key: String(label.id), name: label.name, description: label.description.slice(0, 160) })) ?? null
  if (!Array.isArray(issue.assignees)) return null
  const people = new Map<string, { key: string, name: string, description: string }>()
  for (const user of issue.assignees) {
    const id = numericId(user?.id)
    const name = username(user)
    if (!id || !name || people.has(String(id))) return null
    const key = String(id)
    people.set(key, { key, name, description: typeof user.full_name === 'string' ? user.full_name.slice(0, 160) : '' })
  }
  return [...people.values()]
}

export async function readForgejoRepositoryAuthority(repository: ForgejoIssueRepository, signal: AbortSignal) {
  const [repoReply, userReply] = await Promise.all([
    forgejoTeaRequest(repository, forgejoRepoPath(repository), signal),
    forgejoTeaRequest(repository, 'user', signal),
  ])
  const repo = repoReply.body as RawRepository | null
  const user = userReply.body as User | null
  const repoId = numericId(repo?.id)
  const viewer = numericId(user?.id)
  if (!repoId || !viewer || typeof repo?.full_name !== 'string' || repo.full_name.toLowerCase() !== repository.apiName.toLowerCase()) return null
  return { repoId, viewer, viewerLogin: username(user ?? undefined), archived: repo.archived,
    issuesEnabled: repo.has_issues !== false, canPush: repo.permissions?.push === true }
}

export async function readForgejoIssueAuthority(repository: ForgejoIssueRepository, number: number, signal: AbortSignal,
  issue?: RawIssue, triage?: ForgejoTriageKind) {
  const endpoint = forgejoIssueEndpoint(repository, number)
  const [raw, project] = await Promise.all([
    issue ?? forgejoTeaRequest(repository, endpoint, signal).then(reply => reply.body as RawIssue | null),
    readForgejoRepositoryAuthority(repository, signal),
  ])
  const issueId = numericId(raw?.id)
  if (!raw || !issueRow(repository, raw) || raw.number !== number || !issueId || !project) return null
  const { repoId, viewer, viewerLogin, archived, canPush } = project
  const identity = [repository.base, repository.login, repository.key, repository.workspace.profileId,
    repository.workspace.id, repoId, issueId, viewer]
  const scope = (operation: string) => createHash('sha256').update(JSON.stringify([operation, ...identity])).digest('hex')
  const canEdit = archived === false && (canPush || numericId(raw.user?.id) === viewer)
  const commentBlocked = archived === true ? 'This Forgejo repository is archived.'
    : raw.is_locked === true && !canPush ? 'This Forgejo issue is locked.'
      : typeof archived !== 'boolean' || typeof raw.is_locked !== 'boolean' ? 'Forgejo could not check commenting access.' : ''
  const marker = typeof raw.body === 'string' ? raw.body.match(issueCreationMarker)?.[0] ?? '' : ''
  const text = typeof raw.title === 'string' && (raw.body == null || typeof raw.body === 'string')
    ? { title: raw.title, body: raw.body?.slice(marker.length) ?? '' } : null
  return { commentScope: scope('forgejo-issue-comment'), commentBlocked, viewer, endpoint,
    issueId, viewerLogin, creationMarker: marker.trimEnd(), reactionScope: scope('forgejo-issue-reaction'), canReact: archived === false,
    scope: scope('forgejo-issue-text'), canEditText: canEdit, text,
    triageScope: scope('forgejo-issue-triage'), canTriage: archived === false && canPush,
    applied: triage ? appliedForgejoChoices(raw, triage) : null, multipleAssignees: true,
    status: openClosedIssueStatusPlan(raw.state, canEdit), statusScope: scope('forgejo-issue-status') }
}

export async function forgejoIssueCommentWriter(repository: ForgejoIssueRepository, number: number, signal: AbortSignal) {
  const access = await readForgejoIssueAuthority(repository, number, signal)
  if (!access) return null
  const { commentScope: scope, commentBlocked: blocked, viewer, endpoint } = access
  const matches = (comment: RawComment | null, body: string) => comment?.body === body
    && numericId(comment.user?.id) === viewer && belongsToIssue(repository, endpoint, comment) ? numericId(comment.id) : null
  const current = async () => (await readForgejoIssueAuthority(repository, number, signal))?.commentScope === scope
  return {
    scope, blocked,
    async post(body: string) {
      const reply = await forgejoTeaRequest(repository, endpoint + '/comments', signal, { method: 'POST', body: { body } }).catch((error: unknown) => {
        if (error instanceof RepositoryPullRequestError && error.status) return error.status
        return null
      })
      if (reply === 401 || reply === 403) return 'denied' as const
      if (reply === 400 || reply === 404 || reply === 422) return 'refused' as const
      const id = reply && typeof reply === 'object' ? matches(reply.body as RawComment | null, body) : null
      return id && await current() ? id : null
    },
    async find(body: string, trusted: () => boolean) {
      const reply = await forgejoTeaRequest(repository, endpoint + '/comments', signal)
      if (!trusted() || !Array.isArray(reply.body)) return null
      const id = reply.body.map(comment => matches(comment, body)).find(id => id !== null)
      return id && await current() && trusted() ? id : null
    },
  }
}

async function writeForgejoIssue(repository: ForgejoIssueRepository, endpoint: string, method: 'PATCH' | 'PUT', body: object, signal: AbortSignal) {
  try {
    await forgejoTeaRequest(repository, endpoint, signal, { method, body })
    return 'acknowledged' as const
  }
  catch (error) {
    if (error instanceof RepositoryPullRequestError) {
      if (error.status === 401 || error.status === 403) return 'denied' as const
      if (error.status === 400 || error.status === 404 || error.status === 422) return 'refused' as const
    }
  }
  return null
}

export async function patchForgejoIssue(repository: ForgejoIssueRepository, number: number,
  body: { state: 'open' | 'closed' } | { title: string } | { body: string }, signal: AbortSignal) {
  const result = await writeForgejoIssue(repository, forgejoIssueEndpoint(repository, number), 'PATCH', body, signal)
  return result === 'acknowledged' ? null : result
}

export function writeForgejoTriage(repository: ForgejoIssueRepository, number: number, kind: ForgejoTriageKind,
  target: { key: string, name: string }[], signal: AbortSignal) {
  const endpoint = forgejoIssueEndpoint(repository, number)
  return kind === 'labels'
    ? writeForgejoIssue(repository, endpoint + '/labels', 'PUT', { labels: target.map(row => Number(row.key)) }, signal)
    : writeForgejoIssue(repository, endpoint, 'PATCH', { assignees: target.map(row => row.name) }, signal)
}

// Forgejo also puts prose comments on the timeline. The dedicated comments
// endpoint supplies their bodies, stable anchors and comment pagination.
function timelineEvent(entry: RawTimelineEntry | null): TimedActivity | null {
  const id = numericId(entry?.id)
  if (!id || !entry) return null
  const created = stamp(entry.created_at)
  const event = (label: string, detail?: unknown): TimedActivity => ({
    kind: 'event', id, created, dateLabel: created ? dates.format(created) : '', author: username(entry.user),
    label: typeof detail === 'string' && detail ? label + ' ' + detail.slice(0, 512) : label,
  })
  switch (entry.type) {
    case 'close': return event('closed the issue')
    case 'reopen': return event('reopened the issue')
    case 'assignees': return event(entry.removed_assignee === true ? 'unassigned' : 'assigned', username(entry.assignee))
    case 'change_title': return event('renamed the issue to', entry.new_title)
    case 'label': return event(entry.body === '1' ? 'added label' : 'removed label', entry.label?.name)
    case 'issue_ref':
    case 'commit_ref':
    case 'comment_ref':
    case 'pull_ref': {
      const number = numericId(entry.ref_issue?.number)
      return event('referenced', number ? '#' + number : undefined)
    }
    default: return null
  }
}

function citeForgejoPull(repository: ForgejoIssueRepository, entry: RawTimelineEntry | null): CitedPull | null {
  const source = entry?.ref_issue
  const number = numericId(source?.number)
  if (entry?.type !== 'pull_ref' || !number || !source?.pull_request || typeof source.html_url !== 'string') return null
  const name = source.repository?.full_name ?? repository.apiName
  if (typeof name !== 'string' || name.split('/').length !== 2 || !gitLabProject(repository.host, name)) return null
  const href = repository.base + '/' + name + '/pulls/' + number
  if (source.html_url.toLowerCase() !== href.toLowerCase()) return null
  return { repository: name, number, href }
}

async function readForgejoRelatedPulls(repository: ForgejoIssueRepository, sources: Iterable<CitedPull>, signal: AbortSignal) {
  const cites = [...sources]
  const rows: IssueRelatedRequest[] = []
  let incomplete = false
  const concurrency = 4
  for (let start = 0; start < cites.length && !signal.aborted; start += concurrency) {
    const batch = await Promise.all(cites.slice(start, start + concurrency).map(async (cite) => {
      const path = cite.repository.split('/').map(encodeURIComponent).join('/')
      try {
        const result = (await forgejoTeaRequest(repository, 'repos/' + path + '/pulls/' + cite.number, signal)).body as {
          number?: unknown, title?: unknown, html_url?: unknown, state?: unknown, merged?: unknown, draft?: unknown,
        } | null
        if (result?.number !== cite.number || typeof result.title !== 'string' || typeof result.html_url !== 'string'
          || result.html_url.toLowerCase() !== cite.href.toLowerCase()
          || (result.state !== 'open' && result.state !== 'closed') || typeof result.merged !== 'boolean') {
          incomplete = true
          return null
        }
        const status = result.merged ? 'Merged' : result.state === 'closed' ? 'Closed' : result.draft === true ? 'Draft' : 'Open'
        return { href: cite.href, label: cite.repository + ' #' + cite.number + ' · ' + result.title.slice(0, 240), status }
      }
      catch (error) {
        incomplete ||= !(error instanceof RepositoryPullRequestError && error.status === 404)
        return null
      }
    }))
    rows.push(...batch.filter(row => row !== null))
  }
  return { rows, incomplete: incomplete || signal.aborted }
}

async function readForgejoTimeline(repository: ForgejoIssueRepository, endpoint: string, signal: AbortSignal) {
  const events = new Map<number, TimedActivity>()
  const cited = new Map<string, CitedPull>()
  let available = false
  for (let page = 1; page <= requestLimit; page++) {
    const reply = await forgejoTeaRequest(repository, endpoint + '/timeline?limit=' + sourcePageSize + '&page=' + page, signal).catch(() => null)
    if (!reply || !(reply.body === null || Array.isArray(reply.body))) break
    available = true
    const rows = (reply.body ?? []) as RawTimelineEntry[]
    for (const entry of rows.slice(0, sourcePageSize)) {
      const event = timelineEvent(entry)
      if (event) events.set(event.id, event)
      const pull = citeForgejoPull(repository, entry)
      if (event && pull) cited.set(pull.href.toLowerCase(), pull)
    }
    if (!rows.length || reply.more === false) return { events: [...events.values()], cited, available, partial: false }
  }
  return { events: [...events.values()], cited, available, partial: true }
}

function byActivityTime(left: { id: number, created: number }, right: { id: number, created: number }) {
  return left.created - right.created || left.id - right.id
}

export async function readForgejoIssue(repository: ForgejoIssueRepository, number: number, requestedPage: number | 'latest' | null, signal: AbortSignal, commentFocus = 0) {
  const endpoint = forgejoIssueEndpoint(repository, number)
  const reply = await forgejoTeaRequest(repository, endpoint, signal)
  const raw = reply.body as RawIssue | null
  const row = issueRow(repository, raw)
  if (!row || !raw || row.number !== number) throw new RepositoryPullRequestError('Forgejo could not verify this issue.')
  const commentTotal = typeof raw.comments === 'number' && Number.isSafeInteger(raw.comments) ? Math.max(0, raw.comments) : 0
  const [replyComments, authority, timeline] = await Promise.all([
    forgejoTeaRequest(repository, endpoint + '/comments', signal).catch(() => null),
    readForgejoIssueAuthority(repository, number, signal, raw).catch(() => null),
    readForgejoTimeline(repository, endpoint, signal),
  ])
  const comments = Array.isArray(replyComments?.body) ? replyComments.body.flatMap<TimedActivity>(comment => {
    const id = numericId(comment?.id)
    if (!id || typeof comment.body !== 'string' || !belongsToIssue(repository, endpoint, comment)) return []
    const created = stamp(comment.created_at)
    return [{ kind: 'comment', id, created, body: comment.body.slice(0, 32_768), author: username(comment.user),
      dateLabel: created ? dates.format(created) : '', url: row.url + '#issuecomment-' + id }]
  }).sort(byActivityTime) : replyComments?.body === null ? [] : null
  const focusedIndex = commentFocus ? comments?.findIndex(comment => comment.id === commentFocus) ?? -1 : -1
  const page = typeof requestedPage === 'number' ? requestedPage : requestedPage === 'latest'
    ? Math.max(1, Math.ceil((focusedIndex >= 0 ? focusedIndex + 1 : comments?.length ?? commentTotal) / pageSize)) : 1
  const start = (page - 1) * pageSize
  const end = page * pageSize
  // Use the next page's first comment as the boundary so intervening
  // events stay visible exactly once when a reader follows Older/Newer.
  const first = start ? comments?.[start] : undefined
  const next = comments?.[end]
  const events = timeline.events.filter(event => (!start || (first && byActivityTime(event, first) >= 0))
    && (!next || byActivityTime(event, next) < 0))
  const activity = [...(comments ?? []).slice(start, end), ...events].sort(byActivityTime)
  const related = await readForgejoRelatedPulls(repository, timeline.cited.values(), signal)
  return { ...row, description: typeof raw.body === 'string' ? raw.body.replace(issueCreationMarker, '').slice(0, 65_536) : '',
    dateLabel: row.created ? dates.format(row.created) : '', activity, reactions: null, commentTotal,
    authority, activityAvailable: Boolean(comments) || timeline.available, activityDegraded: timeline.partial || !comments, olderActivity: '', newerActivity: '',
    commentPage: page, moreComments: Boolean(comments && comments.length > page * pageSize),
    relatedRequests: related.rows, relatedRequestsIncomplete: related.incomplete,
  }
}

export async function searchForgejoIssueChoices(repository: ForgejoIssueRepository, kind: 'labels' | 'assignees', search: string, signal: AbortSignal) {
  const options = new Map<string, { value: string, key: string | null, description: string, color?: string }>()
  const query = search.toLowerCase()
  for (let page = 1; page <= requestLimit; page++) {
    const result = await forgejoTeaRequest(repository, forgejoRepoPath(repository) + '/' + kind + '?limit=50&page=' + page, signal)
    if (!Array.isArray(result.body)) throw new RepositoryPullRequestError('Forgejo returned unreadable filter choices.')
    const rows = kind === 'labels' ? (forgejoLabels(result.body) ?? []).map(label => ({ value: label.name, key: String(label.id), description: label.description, color: label.color }))
      : result.body.map(user => ({ value: username(user), key: numericId(user?.id) ? String(user.id) : null,
        description: typeof user?.full_name === 'string' ? user.full_name.slice(0, 160) : '' }))
    for (const row of rows) {
      if (row.value && (row.value.toLowerCase().includes(query) || row.description.toLowerCase().includes(query))) options.set(row.value.toLowerCase(), row)
    }
    if (options.size > sourcePageSize) return { options: [...options.values()].slice(0, sourcePageSize), more: true }
    if (!(result.more ?? result.body.length > 0)) return { options: [...options.values()], more: false }
  }
  return { options: [...options.values()], more: true }
}
