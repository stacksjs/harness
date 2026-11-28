import { basename } from 'node:path'
import type { InternalCommand } from '@harness/contract'
import { issueReference, issueRepositoryKey, sameIssue } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import type { GitHubWorkspaceRepository } from './github-workspace-repositories'
import type { IssueActivityItem } from './issue-activity'
import type { IssueCommentSubmission } from './issue-comment'
import type { IssueTextSubmission } from './issue-text'
import type { IssueMetadataEditor, IssueMetadataForm, IssueMetadataKind } from './issue-metadata'
import type { IssueReactionForm } from './issue-reactions'
import { listForgejoIssues, readForgejoIssue } from './forgejo-issues'
import { readGitLabIssueReactions } from './gitlab-issue-reactions'
import { gitLabIssueUsername, listGitLabIssues, readGitLabIssue, readGitLabIssueText } from './gitlab-issues'
import type { IssueRepository } from './issue-repositories'
import { issueReferenceForSelection, mergeIssueRepositories, trustedIssueProjects, trustedIssueRepositories } from './issue-repositories'
import { issueActivityCursor, readIssueActivity } from './issue-activity'
import { hostedStatusEditor, issueMetadataKind, readGitLabTriageEditor, readIssueMetadata } from './issue-metadata'
import { createIssueTextDraft, issueTextField, issueTextLimits } from './issue-text'
import { newThreadLink, parsePullRequest } from './prompt-links'
import { readFilterViewer, readRepositoryFilterChoices } from './pull-request-list-filters'
import { pullRequestLabels } from './pull-request-labels'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'
import { renderPullRequestCommentMarkdown } from './transcript-markdown'
import { threadTitle } from './thread-search'

const pageSize = 20
const searchLimit = 1000
const involvementQualifiers = { assigned: 'assignee', authored: 'author', mentioned: 'mentions' } as const
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

export type IssueRelatedRequest = { href: string, label: string, status?: string }

export interface IssueScope {
  state: 'open' | 'closed' | 'all'
  sort: 'updated' | 'created'
  search: string
  involvement: keyof typeof involvementQualifiers | ''
  assignee: string
  labels: string[]
  page: number
}

interface GitHubIssue {
  html_url?: unknown
  number?: unknown
  title?: unknown
  state?: unknown
  body?: unknown
  comments?: unknown
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
    tracker: 'github' as const, sourceKey: repository.toLowerCase(), repository, number, url, state: issue.state, title: issue.title.slice(0, 512), created, updated,
    author: login(issue.user?.login),
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map(assignee => login(assignee?.login)).filter(Boolean).slice(0, 20) : [],
    labels: (pullRequestLabels(issue.labels) ?? []).slice(0, 30),
  }
}

const issueForge = { github: 'GitHub', gitlab: 'GitLab', forgejo: 'Forgejo' } as const

function issueError(error: unknown, tracker: IssueRepository['tracker']): string {
  return error instanceof RepositoryPullRequestError ? error.message : issueForge[tracker] + ' did not respond. Try again.'
}

async function repositoryIssues(repository: GitHubWorkspaceRepository, scope: IssueScope, signal: AbortSignal) {
  if (scope.assignee && scope.assignee !== '@me' && !login(scope.assignee)) return { rows: [], partial: false }
  const end = Math.min(searchLimit, scope.page * pageSize + 1)
  const issues = new Map<number, NonNullable<ReturnType<typeof issueRow>>>()
  let partial = false
  const viewer = scope.involvement || scope.assignee === '@me' ? await readFilterViewer(repository.path, signal) : ''
  const assignee = scope.assignee === '@me' ? viewer : scope.assignee
  const qualifiers = [
    'is:issue', 'repo:' + repository.name, scope.state === 'all' ? '' : 'is:' + scope.state,
    scope.involvement ? involvementQualifiers[scope.involvement] + ':' + viewer : '',
    assignee && !(scope.involvement === 'assigned' && assignee.toLowerCase() === viewer.toLowerCase()) ? 'assignee:' + assignee : '',
    ...scope.labels.map(label => 'label:' + JSON.stringify(label)),
    scope.search ? 'in:title,body "' + scope.search + '"' : '',
  ].filter(Boolean).join(' ')
  const requiredAssignees = [assignee, scope.involvement === 'assigned' ? viewer : ''].filter(Boolean).map(name => name.toLowerCase())
  // Repeated assignee qualifiers can return either person. Read larger pages
  // when verifying the intersection against the returned assignments.
  const size = new Set(requiredAssignees).size > 1 ? 100 : Math.min(end, 100)
  for (let page = 1; issues.size < end && page * size <= searchLimit; page++) {
    signal.throwIfAborted()
    const query = new URLSearchParams({
      sort: scope.sort, order: 'desc', per_page: String(size), page: String(page),
      q: qualifiers,
    })
    const reply = await repositoryGitHubRequest(repository.path, 'search/issues?' + query, undefined, signal)
    const result = reply.body as { items?: unknown[], incomplete_results?: boolean, total_count?: number } | null
    if (reply.status !== 200 || !Array.isArray(result?.items))
      throw new RepositoryPullRequestError('GitHub could not list issues for this repository.')
    partial ||= Boolean(result.incomplete_results || (result.total_count ?? 0) > searchLimit)
    for (const item of result.items.slice(0, size)) {
      const row = issueRow(item, repository.name)
      if (row && (scope.state === 'all' || row.state === scope.state)
        && requiredAssignees.every(name => row.assignees.some(assignee => assignee.toLowerCase() === name)))
        issues.set(row.number, row)
    }
    if (!reply.hasNextPage) break
  }
  return { rows: [...issues.values()], partial }
}

async function issueDetail(repository: GitHubWorkspaceRepository, number: number, requestedComments: number | 'latest' | null, before: string, after: string, signal: AbortSignal) {
  const endpoint = 'repos/' + repository.name + '/issues/' + number
  const [reply, activity] = await Promise.all([
    repositoryGitHubRequest(repository.path, endpoint, undefined, signal),
    typeof requestedComments === 'number' ? null : readIssueActivity(repository, number, { before: before || undefined, after: after || undefined }, signal).catch(() => null),
  ])
  const issue = reply.status === 200 ? issueRow(reply.body, repository.name) : null
  if (!issue || issue.number !== number) throw new RepositoryPullRequestError('This issue is unavailable to the GitHub account on this host.')

  const raw = reply.body as GitHubIssue
  const details = { ...issue, dateLabel: issue.created ? dates.format(issue.created) : '',
    description: typeof raw.body === 'string' ? raw.body.slice(0, 65_536) : '', relatedRequests: [] as IssueRelatedRequest[] }
  if (activity) return { ...details, activity: activity.items, reactions: activity.reactions, commentTotal: activity.total,
    activityAvailable: true, activityDegraded: false, olderActivity: activity.older, newerActivity: activity.newer, commentPage: 0, moreComments: false }
  const commentPage = requestedComments === 'latest'
    ? Math.max(1, Math.ceil(positiveInteger(raw.comments) / pageSize)) : requestedComments ?? 1
  const commentReply = await repositoryGitHubRequest(repository.path, endpoint + '/comments?' + new URLSearchParams({
    per_page: String(pageSize), page: String(commentPage),
  }), undefined, signal).catch(() => null)
  const commentsAvailable = commentReply?.status === 200 && Array.isArray(commentReply.body)
  const comments = commentsAvailable ? (commentReply.body as {
    id?: unknown, node_id?: string, issue_url?: unknown, user?: { login?: unknown }, created_at?: unknown, body?: unknown,
  }[]).slice(0, pageSize).flatMap((comment) => {
    const id = positiveInteger(comment?.id)
    if (!id || typeof comment.issue_url !== 'string' || comment.issue_url.toLowerCase() !== ('https://api.github.com/' + endpoint).toLowerCase()
      || typeof comment.body !== 'string') return []
    const timestamp = date(comment.created_at)
    return [{ node: comment.node_id, item: { id, author: login(comment.user?.login), dateLabel: timestamp ? dates.format(timestamp) : '',
      body: comment.body.slice(0, 32_768), url: issue.url + '#issuecomment-' + id } }]
  }) : []

  const legacy = await readIssueActivity(repository, number, {
    ids: comments.flatMap(comment => comment.node ? [comment.node] : []),
  }, signal).catch(() => null)
  const bars = new Map(legacy?.items.map(item => [item.id, item.reactions]))
  const items: IssueActivityItem[] = comments.map(({ item }) =>
    ({ ...item, kind: 'comment', reactions: bars.get(item.id) }))
  return { ...details, activity: items, reactions: legacy?.reactions, commentTotal: positiveInteger(raw.comments),
    activityAvailable: commentsAvailable, activityDegraded: commentsAvailable && typeof requestedComments !== 'number', olderActivity: '', newerActivity: '', commentPage, moreComments: Boolean(commentsAvailable && commentReply.hasNextPage) }
}

export async function issueThreadUpdate(
  state: HarnessState, query: URLSearchParams, form: URLSearchParams, signal: AbortSignal,
): Promise<Extract<InternalCommand, { type: 'thread.issue.set' }> | null> {
  const issue = issueReferenceForSelection(query.get('selected'), positiveInteger(query.get('issue')))
  const profile = positiveInteger(query.get('profile'))
  const sessionId = positiveInteger(form.get('thread'))
  const action = form.get('action')
  const session = state.sessions.get(sessionId)
  const workspace = session && state.workspaces.get(session.workspaceId)
  if (!issue || !profile || !session || !workspace?.trusted || workspace.scratch || workspace.profileId !== profile
    || session.navigation?.archivedAt || (action !== 'link' && action !== 'unlink')) return null

  if (action === 'link') {
    const repositories = await trustedIssueRepositories([workspace], profile, signal)
    if (!repositories.has(issueRepositoryKey(issue))) return null
  }
  return { type: 'thread.issue.set', sessionId, issue, linked: action === 'link' }
}

export async function issueWorkspace(state: HarnessState, query: URLSearchParams, signal: AbortSignal,
  writes: {
    metadata?: { kind: IssueMetadataKind, message: string, editor?: IssueMetadataEditor | null, draft?: IssueMetadataForm | null }
    comment?: IssueCommentSubmission
    text?: IssueTextSubmission
    reaction?: { message: string, comment: number, draft?: IssueReactionForm | null }
  } = {}) {
  const { metadata: metadataSubmission, comment: commentSubmission, text: textSubmission } = writes
  const profiles = [...state.profiles.values()].map(({ id, name }) => ({ id, name }))
  const requestedProfile = positiveInteger(query.get('profile'))
  const profile = profiles.some(item => item.id === requestedProfile) ? requestedProfile : profiles[0]?.id || 0
  const projects = await trustedIssueProjects(state.workspaces.values(), profile, signal)
  const repositories = mergeIssueRepositories(projects)
  const projectIds = new Set(projects.map(project => project.workspace.id))
  const hiddenProjects = new Set(query.getAll('hideProject').map(positiveInteger).filter(id => projectIds.has(id)))
  const includedRepositories = hiddenProjects.size ? mergeIssueRepositories(
    projects.filter(project => !hiddenProjects.has(project.workspace.id)),
  ) : repositories
  const repository = repositories.get((query.get('repository') || '').toLowerCase())
  const selectionProfile = positiveInteger(query.get('selectionProfile'))
  const preserveSelection = !selectionProfile || selectionProfile === profile
  const selectionName = preserveSelection ? query.get('selected') || '' : ''
  const selection = repositories.get(selectionName.toLowerCase())
  const number = preserveSelection ? positiveInteger(query.get('issue')) : 0
  const requestedComments = query.get('comments') === 'latest' ? 'latest'
    : Math.min(positiveInteger(query.get('comments')), 10_000) || null
  const activityBefore = issueActivityCursor(query.get('activityBefore'))
  const activityAfter = activityBefore ? '' : issueActivityCursor(query.get('activityAfter'))
  const filter = query.get('state')
  const involvement = query.get('involvement')
  const findAssignee = query.has('findAssignees') ? (query.get('assignee') ?? '').slice(0, 100).replace(/\p{Cc}/gu, '').trim() : ''
  const assignee = (query.get('pickAssignee') ?? (findAssignee ? query.get('shownAssignee') : query.get('assignee')) ?? '').trim().toLowerCase()
  const username = assignee.replace(/^@/u, '')
  const labels = new Map<string, string>()
  for (const value of query.getAll('label').slice(0, 100)) {
    const label = value.trim()
    if (label && label.length <= 100 && !/\p{Cc}/u.test(label) && !labels.has(label.toLowerCase()))
      labels.set(label.toLowerCase(), label)
    if (labels.size === 10) break
  }
  const hidden = new Set(query.getAll('hideRepository').slice(0, 100).map(name => name.toLowerCase()).filter(name => repositories.has(name)))
  const scope: IssueScope = {
    state: filter === 'closed' || filter === 'all' ? filter : 'open',
    sort: query.get('sort') === 'created' ? 'created' : 'updated',
    search: (query.get('q') || '').slice(0, 160).replace(/["\\\p{Cc}]/gu, ' ').trim(),
    involvement: involvement === 'assigned' || involvement === 'authored' || involvement === 'mentioned' ? involvement : '',
    assignee: assignee === '@me' ? assignee : (login(username) || gitLabIssueUsername(username)),
    labels: [...labels.values()],
    page: Math.min(positiveInteger(query.get('page')) || 1, searchLimit / pageSize),
  }
  const params = new URLSearchParams({ profile: String(profile), state: scope.state, sort: scope.sort })
  if (repository) params.set('repository', repository.key)
  if (scope.search) params.set('q', scope.search)
  if (scope.involvement) params.set('involvement', scope.involvement)
  if (scope.assignee) params.set('assignee', scope.assignee)
  for (const value of scope.labels) params.append('label', value)
  for (const name of [...hidden].sort()) params.append('hideRepository', name)
  for (const id of [...hiddenProjects].sort((a, b) => a - b)) params.append('hideProject', String(id))
  const savedViewScope = params.toString()
  if (scope.page > 1) params.set('page', String(scope.page))
  const href = (overrides: Record<string, string | number> = {}) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(overrides)) next.set(key, String(value))
    return '/issues?' + next
  }
  const detail = selection && number ? (selection.tracker === 'gitlab'
    ? readGitLabIssue(selection, number, requestedComments, signal).then(async (issue) => {
        const reactions = await readGitLabIssueReactions(selection, number, issue.activity, signal).catch(() => null)
        if (!reactions) return issue
        return { ...issue, reactions: reactions.issue,
          activity: issue.activity.map(item => ({ ...item, reactions: reactions.comments.get(Number(item.id)) })) }
      })
    : selection.tracker === 'forgejo' ? readForgejoIssue(selection, number, requestedComments, signal, positiveInteger(query.get('commentFocus')))
      : issueDetail(selection, number, requestedComments, activityBefore, activityAfter, signal))
    .then(selected => ({ selected, error: '' }), error => ({ selected: null, error: issueError(error, selection.tracker) })) : null
  const editMetadata = issueMetadataKind(query.get('editMetadata'))
  const editText = issueTextField(query.get('editText'))
  const metadataRead = selection?.tracker === 'github' && number
    ? readIssueMetadata({ repository: selection, number, signal, includeText: Boolean(editText && !textSubmission) },
        metadataSubmission ? null : editMetadata)
    : null
  const gitLabTextRead = selection?.tracker === 'gitlab' && number
    ? readGitLabIssueText(selection, number, signal).catch(() => null) : null
  const gitLabTriageRead = selection?.tracker === 'gitlab' && number && !metadataSubmission && (editMetadata === 'labels' || editMetadata === 'assignees')
    ? readGitLabTriageEditor(selection, number, signal, editMetadata).catch(() => null) : null
  const targets = [...includedRepositories].flatMap(([key, repo]) =>
    !hidden.has(key) && (!repository || key === repository.key) ? [repo] : [])
  const findLabel = (query.get('findLabel') ?? '').slice(0, 100).replace(/\p{Cc}/gu, '').trim()
  const lookup = findAssignee ? readRepositoryFilterChoices(targets, { kind: 'assignees', search: findAssignee }, signal)
    : query.has('findLabels') && findLabel ? readRepositoryFilterChoices(targets, { kind: 'labels', search: findLabel }, signal) : null
  const rows: (NonNullable<ReturnType<typeof issueRow>> | Awaited<ReturnType<typeof listGitLabIssues>>['rows'][number]
    | Awaited<ReturnType<typeof listForgejoIssues>>['rows'][number])[] = []
  const failures: { repository: string, reason: string }[] = []
  let partial = false
  for (let offset = 0; offset < targets.length; offset += 4) {
    signal.throwIfAborted()
    const batch = targets.slice(offset, offset + 4)
    const outcomes = await Promise.allSettled(batch.map(target => target.tracker === 'gitlab' ? listGitLabIssues(target, scope, signal)
      : target.tracker === 'forgejo' ? listForgejoIssues(target, scope, signal) : repositoryIssues(target, scope, signal)))
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        rows.push(...outcome.value.rows)
        partial ||= outcome.value.partial
      }
      else {
        const source = batch[index]!
        failures.push({ repository: source.tracker === 'github' ? source.name : source.host + '/' + source.name,
          reason: issueError(outcome.reason, source.tracker) })
      }
    })
  }
  const { selected, error } = await detail ?? { selected: null, error: selectionName || number ? 'This issue is outside the selected profile.' : '' }
  const [choices, metadata, gitLabText, gitLabTriage] = await Promise.all([lookup, metadataRead, gitLabTextRead, gitLabTriageRead])
  const forgejoAuthority = selected?.tracker === 'forgejo' ? selected.authority : null
  const hostedAuthority = gitLabText ?? forgejoAuthority
  const labelChoices = choices?.kind === 'labels' ? choices : null
  const people = choices?.kind === 'assignees' ? choices : null
  signal.throwIfAborted()
  const labelOptions = new Map(labels)
  for (const value of [...(labelChoices?.options.map(option => option.value) ?? []), ...rows.flatMap(row => row.labels.map(label => label.name))]) {
    const key = value.toLowerCase()
    if (!labelOptions.has(key)) labelOptions.set(key, value)
    if (labelOptions.size >= 50) break
  }
  const commentPage = selected?.commentPage ?? 1
  const selectedScope: Record<string, string | number> = selected ? { selected: selected.sourceKey, issue: selected.number } : {}
  const savedViewDetail = new URLSearchParams()
  if (selected) {
    savedViewDetail.set('selected', selected.sourceKey)
    savedViewDetail.set('issue', String(selected.number))
    if (commentPage > 0 && requestedComments !== null) savedViewDetail.set('comments', String(commentPage))
    if (activityBefore) savedViewDetail.set('activityBefore', activityBefore)
    if (activityAfter) savedViewDetail.set('activityAfter', activityAfter)
  }
  const metadataFields = selected ? Object.fromEntries(savedViewDetail) : {}
  const metadataHref = selected ? href(metadataFields) : ''
  const editableText = hostedAuthority?.canEditText && hostedAuthority.text
    ? { ...hostedAuthority.text, scope: hostedAuthority.scope } : metadata?.editableText
  const textForge = issueForge[selection?.tracker ?? 'github']
  const textDraft = textSubmission?.draft
    ?? (editText && editableText ? createIssueTextDraft(editText, editableText.scope, editableText[editText]) : null)
  const textResult = textSubmission?.result
  const textPreview = textResult === 'preview'
  const textPending = textResult === 'pending'
  const textConflict = textResult === 'stale'
  const textLocked = textResult === 'changed' || textResult === 'denied'
  const metadataEditor = metadataSubmission ? metadataSubmission.editor : metadata?.editor ?? gitLabTriage
    ?? (gitLabText && editMetadata === 'state' ? hostedStatusEditor(gitLabText.status, gitLabText.statusScope) : null)
  const statusEdit = editMetadata === 'state' || metadataSubmission?.kind === 'state'
  const metadataMessage = metadataSubmission?.message
    ?? (selected && query.get('metadataResult') === 'updated' ? 'Issue updated on ' + textForge + '.' : '')
  const statusMessage = statusEdit ? metadataMessage
    : selected && query.get('metadataResult') === 'state' ? 'Issue status updated on ' + textForge + '.' : ''
  const pageEnd = scope.page * pageSize
  const reference = selected && selection && issueReference({ tracker: selection.tracker,
    ...(selection.tracker !== 'github' && { host: selection.host }), repository: selected.repository, number: selected.number })
  const linkedThreads = []
  const threadChoices = []
  const pullRequests = new Map<string, IssueRelatedRequest>()
  if (reference && selection) {
    const threads = [...state.sessions.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || b.id - a.id)
    for (const thread of threads) {
      const workspace = state.workspaces.get(thread.workspaceId)
      if (!workspace?.trusted || workspace.scratch || workspace.profileId !== profile || thread.navigation?.archivedAt) continue
      const row = { id: thread.id, title: threadTitle(thread) }
      if (!thread.linkedIssues?.some(issue => sameIssue(issue, reference))) {
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
    const draft = new URL(newThreadLink('http://localhost', selected.url, { repository: selected.sourceKey }))
    draft.searchParams.set('profile', String(profile))
    draft.searchParams.set('issue', selected.url)
    draftHref = draft.pathname + draft.search
  }
  const nameCounts = new Map<string, number>()
  for (const { workspace } of projects) {
    const name = basename(workspace.path).toLowerCase()
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  const projectFilters = projects.map(({ workspace }) => {
    const name = basename(workspace.path) || workspace.path
    return {
      id: workspace.id,
      name,
      path: (nameCounts.get(name.toLowerCase()) ?? 0) > 1 ? workspace.path : '',
      hidden: hiddenProjects.has(workspace.id),
    }
  }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  const activityRows = (selected?.activity ?? []).map(item => {
    if (item.kind !== 'event' || !item.url) return { ...item, href: '', external: false }
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)$/u.exec(item.url)
    if (!match || !repositories.has(match[1]!.toLowerCase())) return { ...item, href: item.url, external: true }
    return { ...item, external: false, href: match[2] === 'issues' ? href({ selected: match[1]!, issue: match[3]! })
      : '/pull-requests?' + new URLSearchParams({ profile: String(profile), selectedUrl: item.url }) }
  })
  return {
    profiles, profile, repositories: [...repositories.keys()].sort(),
    repositoryOptions: [...repositories.values()].map(item => ({ key: item.key,
      label: item.tracker === 'github' ? item.name : item.host + '/' + item.name })).sort((a, b) => a.label.localeCompare(b.label)),
    repository: repository?.key || '', scope, failures, partial, error, selected, draftHref,
    hasIncludedRepositories: targets.length > 0,
    filterCount: Number(Boolean(repository)) + Number(scope.state !== 'open') + Number(Boolean(scope.involvement))
      + Number(Boolean(scope.assignee)) + scope.labels.length + Number(hidden.size > 0) + Number(hiddenProjects.size > 0),
    projectFilters,
    repositoryFilters: [...repositories].map(([key, repo]) => ({ key, name: repo.tracker === 'github' ? repo.name : repo.host + '/' + repo.name, hidden: hidden.has(key) })),
    labelOptions: [...labelOptions].map(([key, name]) => ({ name, checked: labels.has(key) })),
    assigneeOptions: [...new Set(rows.flatMap(row => row.assignees))].sort().slice(0, 30),
    findLabel: labelChoices ? findLabel : '', labelFound: labelChoices?.options.length || 0,
    findAssignee, assigneeChoices: people?.options ?? [], lookupLimited: Boolean(choices?.failed || choices?.more),
    savedViewScope, savedViewDetail: savedViewDetail.toString(),
    listSelectionFields: selected ? [...savedViewDetail, ['selectionProfile', String(profile)]] : [],
    linkedThreads, threadChoices, pullRequests: [...pullRequests.values(), ...(selected?.relatedRequests ?? [])],
    relatedRequestsIncomplete: selected?.tracker === 'forgejo' && selected.relatedRequestsIncomplete,
    canEditMetadata: Boolean(selected && (metadata?.canEdit || gitLabText?.canTriage)),
    metadataEditor: selected && !statusEdit ? metadataEditor : null,
    metadataDraft: selected && !statusEdit ? metadataSubmission?.draft : null,
    metadataMessage: statusEdit ? '' : metadataMessage,
    metadataUnavailable: Boolean(selected && editMetadata && !statusEdit && !metadataSubmission && !metadataEditor),
    issueStatus: hostedAuthority?.status?.current ?? metadata?.status ?? (selected?.state === 'closed' ? 'Closed' : 'Open'),
    canChangeIssueStatus: Boolean(selected && (hostedAuthority?.status?.choices.length || metadata?.canChangeStatus)),
    forgejoStatusMenu: forgejoAuthority && !metadataSubmission?.draft ? hostedStatusEditor(forgejoAuthority.status, forgejoAuthority.statusScope) : null,
    statusEditor: selected && statusEdit ? metadataEditor : null,
    statusDraft: selected && statusEdit ? metadataSubmission?.draft : null,
    statusMessage,
    statusUnavailable: Boolean(selected && editMetadata === 'state' && !metadataSubmission && !metadataEditor),
    statusHref: selected ? href({ ...metadataFields, editMetadata: 'state' }) : '',
    metadataHref,
    commentAction: metadataHref.replace('/issues?', '/issues/comments?') + '#issue-comment-composer',
    commentText: commentSubmission?.text ?? '',
    commentScope: commentSubmission?.result === 'pending' ? commentSubmission.scope : hostedAuthority?.commentScope ?? metadata?.commentScope ?? '',
    commentIntent: commentSubmission?.result === 'pending' ? commentSubmission.intent : crypto.randomUUID(),
    commentPending: commentSubmission?.result === 'pending',
    commentBlocked: hostedAuthority?.commentBlocked ?? metadata?.commentBlocked ?? textForge + ' could not check commenting access.',
    commentMessage: commentSubmission?.message
      ?? (selected && query.get('commentResult') === 'posted' ? 'Comment posted to ' + textForge + '.' : ''),
    metadataLabelsHref: selected ? href({ ...metadataFields, editMetadata: 'labels' }) : '',
    metadataAssigneesHref: selected ? href({ ...metadataFields, editMetadata: 'assignees' }) : '',
    metadataAction: metadataHref.replace('/issues?', '/issues/metadata?'),
    canEditText: Boolean(selected && (metadata?.canEditText || editableText)),
    textForge,
    textDraft, textPreview, textPending, textConflict, textLocked,
    textLimit: textDraft ? issueTextLimits[textDraft.field] : 0,
    textTitle: textDraft?.field === 'title' ? 'Issue title' : 'Description',
    currentText: textSubmission?.current ?? '',
    currentVersion: textSubmission?.currentVersion ?? '',
    textMessageField: issueTextField(query.get('textResult')) ?? editText ?? 'title',
    textMessage: textSubmission?.message ?? (selected && issueTextField(query.get('textResult')) ? 'Issue text saved on ' + textForge + '.'
      : editText && !textDraft ? textForge + ' could not open this editor.' : ''),
    textAction: metadataHref.replace('/issues?', '/issues/text?') + '#issue-text-editor',
    titleEditHref: selected ? href({ ...metadataFields, editText: 'title' }) + '#issue-text-input' : '',
    bodyEditHref: selected ? href({ ...metadataFields, editText: 'body' }) + '#issue-text-input' : '',
    reactionAction: metadataHref.replace('/issues?', '/issues/reactions?'),
    reactionMessage: writes.reaction?.message ?? '',
    reactionComment: writes.reaction?.comment ?? 0,
    reactionDraft: writes.reaction?.draft ?? null,
    activityRows,
    issueReactions: selected?.reactions ?? null,
    olderActivityHref: selected?.olderActivity ? href({ ...selectedScope, activityBefore: selected.olderActivity }) + '#issue-comments' : '',
    newerActivityHref: selected?.newerActivity ? href({ ...selectedScope, activityAfter: selected.newerActivity }) + '#issue-comments' : '',
    issueThreadAction: selected ? href(selectedScope).replace('/issues?', '/issues/threads?') : '',
    retryHref: href(selectedScope), datePurpose: scope.sort === 'created' ? 'Created' : 'Last updated',
    backHref: '/?' + new URLSearchParams({ profile: String(profile) }), listHref: href(),
    previousHref: scope.page > 1 ? href({ page: scope.page - 1 }) : '',
    nextHref: scope.page < searchLimit / pageSize && rows.length > pageEnd ? href({ page: scope.page + 1 }) : '',
    olderCommentsHref: selected?.tracker === 'gitlab'
      ? selected.moreComments && commentPage < 10_000 ? href({ ...selectedScope, comments: commentPage + 1 }) + '#issue-comments' : ''
      : selected && commentPage > 1 ? href({ ...selectedScope, comments: commentPage - 1 }) : '',
    newerCommentsHref: selected?.tracker === 'gitlab'
      ? commentPage > 1 ? href({ ...selectedScope, comments: commentPage - 1 }) + '#issue-comments' : ''
      : selected?.moreComments && commentPage < 10_000 ? href({ ...selectedScope, comments: commentPage + 1 }) : '',
    rows: rows.sort((a, b) => b[scope.sort] - a[scope.sort]).slice(pageEnd - pageSize, pageEnd).map(row => ({
      ...row, href: href({ selected: row.sourceKey, issue: row.number }),
      dateLabel: row[scope.sort] ? dates.format(row[scope.sort]) : '',
      current: row.sourceKey === selected?.sourceKey && row.number === selected.number,
    })),
  }
}

export function renderIssueMarkdown(html: string, view: Awaited<ReturnType<typeof issueWorkspace>>) {
  if (!view.selected) return html
  const bodies = new Map(view.selected.activity.flatMap(item => item.kind === 'comment' && item.body ? [[String(item.id), item.body]] : []))
  bodies.set('description', view.selected.description)
  if (view.textPreview && view.textDraft?.text.trim()) bodies.set('preview', view.textDraft.text)
  return new HTMLRewriter().on('[data-issue-markdown]', { element(element) {
    const text = bodies.get(element.getAttribute('data-issue-markdown') ?? '')
    if (text) element.setInnerContent(renderPullRequestCommentMarkdown(text), { html: true })
  } }).transform(html)
}
