import { createHash } from 'node:crypto'
import { issueRepositoryKey, parseIssueUrl } from '@harness/contract'
import type { IssueActivityItem } from './issue-activity'
import type { GitLabIssueRepository } from './issue-repositories'
import { defaultGitLabIssueHost, gitLabCli } from './issue-repositories'
import { RepositoryPullRequestError } from './repository-pull-request'

const pageSize = 20
const searchLimit = 1000
const dates = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

type ListScope = {
  state: 'open' | 'closed' | 'all', sort: 'created' | 'updated', search: string, involvement: string,
  assignee: string, labels: string[], page: number,
}
type User = { username?: string }
type GitLabIssue = {
  iid?: number, web_url?: string, title?: string, description?: string, state?: string, created_at?: string, updated_at?: string,
  author?: User, assignees?: User[], labels?: string[], user_notes_count?: number,
}

function stamp(value?: string) { return Date.parse(value ?? '') || 0 }
export function gitLabIssueUsername(value: unknown) {
  return typeof value === 'string' && /^[a-z\d._-]{1,255}$/iu.test(value) ? value : ''
}

function account(user?: User) {
  return gitLabIssueUsername(user?.username)
}

function issueRow(repository: GitLabIssueRepository, issue?: GitLabIssue | null) {
  if (!issue || typeof issue.iid !== 'number' || !Number.isSafeInteger(issue.iid) || issue.iid < 1
    || typeof issue.title !== 'string' || (issue.state !== 'opened' && issue.state !== 'closed')) return null
  if (typeof issue.web_url !== 'string') return null
  const reference = parseIssueUrl(issue.web_url)
  if (!reference || reference.number !== issue.iid || issueRepositoryKey(reference) !== repository.key) return null
  return { tracker: 'gitlab' as const, sourceKey: repository.key, repository: repository.name, url: issue.web_url,
    sourceLabel: repository.host === 'gitlab.com' ? 'GitLab' : 'GitLab · ' + repository.host,
    number: issue.iid, title: issue.title.slice(0, 512), state: issue.state === 'opened' ? 'open' as const : 'closed' as const,
    created: stamp(issue.created_at), updated: stamp(issue.updated_at), author: account(issue.author),
    assignees: Array.isArray(issue.assignees) ? issue.assignees.map(account).filter(Boolean).slice(0, 50) : [],
    labels: Array.isArray(issue.labels) ? issue.labels.filter(label => typeof label === 'string').slice(0, 50)
      .map(name => ({ name: name.slice(0, 100), color: '' })) : [],
  }
}

function gitLabEnvironment(repository: GitLabIssueRepository, credential?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GLAB_DEBUG_HTTP: '', GLAB_NO_PROMPT: '1', GLAB_CHECK_UPDATE: '0', NO_COLOR: '1' }
  if (repository.host !== defaultGitLabIssueHost()) {
    // An environment credential belongs to the configured GitLab instance.
    for (const key of ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN', 'GLAB_TOKEN', 'CI_JOB_TOKEN', 'GITLAB_HOST', 'GITLAB_URI', 'GITLAB_URL', 'GL_HOST',
      'GITLAB_REPO', 'GITLAB_API_HOST', 'GITLAB_SUBFOLDER', 'GLAB_ENABLE_CI_AUTOLOGIN'])
      delete env[key]
  }
  if (credential) {
    env.GITLAB_HOST = repository.host
    env.GITLAB_TOKEN = credential
    env.GLAB_ENABLE_CI_AUTOLOGIN = 'false'
  }
  return env
}

type IssueCredential = { type: 'pat', token: string } | { type: 'oauth2', token: string, endpoint: URL }

export async function gitLabIssueCredential(repository: GitLabIssueRepository, signal: AbortSignal): Promise<IssueCredential> {
  const glab = gitLabCli()
  if (!glab) throw new RepositoryPullRequestError('Install the GitLab CLI on this host.')
  const child = Bun.spawn([glab, 'auth', 'credential-helper', '--repo', 'https://' + repository.host + '/' + repository.name], {
    cwd: repository.path, env: gitLabEnvironment(repository), stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', signal, timeout: 15_000,
  })
  const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (exit === 0) {
    try {
      const result = JSON.parse(output)
      const instance = new URL(result.instance_url)
      const token = result.token?.token
      if (result.type === 'success' && instance.protocol === 'https:' && instance.host === repository.host
        && !instance.username && !instance.password && !instance.search && !instance.hash
        && typeof token === 'string' && /^[\x21-\x7e]{1,8192}$/u.test(token)) {
        if (result.token.type === 'pat') return { type: 'pat', token }
        if (result.token.type === 'oauth2') {
          instance.pathname = instance.pathname.replace(/\/$/u, '') + '/api/graphql'
          return { type: 'oauth2', token, endpoint: instance }
        }
      }
    }
    catch { /* A failed credential read never exposes the helper output. */ }
  }
  throw new RepositoryPullRequestError('Sign in with the current GitLab CLI on this host to update issues.', 401)
}

async function api(repository: GitLabIssueRepository, endpoint: string, signal: AbortSignal,
  request?: { body: object, credential?: string },
) {
  const glab = gitLabCli()
  if (!glab) throw new RepositoryPullRequestError('Install the GitLab CLI on this host to read issues.')
  const child = Bun.spawn([glab, 'api', endpoint, '--hostname', repository.host, '--include',
    ...(request ? ['--method', 'POST', '--input', '-', '--header', 'Content-Type: application/json'] : []),
  ], {
    cwd: repository.path, env: gitLabEnvironment(repository, request?.credential),
    stdin: request ? new Blob([JSON.stringify(request.body)]) : 'ignore',
    stdout: 'pipe', stderr: 'ignore', signal, timeout: 15_000,
  })
  const [output, exit] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const split = /\r?\n\r?\n/u.exec(output)
  const status = Number(/^HTTP\/\S+ (\d{3})\b/u.exec(output)?.[1])
  if (status === 404) throw new RepositoryPullRequestError('GitLab could not find this resource or grant access to it.', status)
  if (status === 429) throw new RepositoryPullRequestError('GitLab is rate limiting requests. Try again shortly.', status)
  if (status === 401 || status === 403 || (!status && exit !== 0))
    throw new RepositoryPullRequestError('GitLab access is unavailable. Check glab auth status for this host.', status)
  if (status !== 200 || !split) throw new RepositoryPullRequestError('GitLab could not load this resource.', status)
  let body: unknown
  try { body = JSON.parse(output.slice(split.index + split[0].length)) }
  catch { throw new RepositoryPullRequestError('GitLab returned an unreadable response.') }
  const headers = output.slice(0, split.index)
  const next = /^x-next-page:[ \t]*(\d+)?[ \t]*\r?$/imu.exec(headers)
  const link = /^link:[^\r\n]+/imu.exec(headers)?.[0]
  return { body, more: next ? Boolean(next[1]) : link ? /;\s*rel="next"/u.test(link) : undefined }
}

function projectPath(repository: GitLabIssueRepository) {
  return 'projects/' + encodeURIComponent(repository.name)
}

type IssueTextField = 'title' | 'body'

async function gitLabGraphQL(repository: GitLabIssueRepository, query: string, variables: object, signal: AbortSignal, credential?: IssueCredential) {
  if (credential?.type !== 'oauth2')
    return (await api(repository, 'graphql', signal, { body: { query, variables }, credential: credential?.token })).body

  // Overriding the token in glab's environment changes it to PAT authentication.
  // Preserve the resolved OAuth account by sending its access token as a Bearer credential.
  const response = await fetch(credential.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { 'Authorization': 'Bearer ' + credential.token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new RepositoryPullRequestError('GitLab could not complete this request.', response.status)
  }
  return response.json()
}

export async function readGitLabIssueText(repository: GitLabIssueRepository, number: number, signal: AbortSignal, credential?: IssueCredential) {
  type PermissionResponse = {
    data?: {
      currentUser?: { id?: string }
      project?: { id?: string, fullPath?: string, archived?: boolean, issue?: {
        id?: string, iid?: string, webUrl?: string, title?: string, description?: string | null,
        discussionLocked?: boolean, userPermissions?: { updateIssue?: boolean, createNote?: boolean },
      } }
    }
    errors?: unknown[]
  }
  const reply = await gitLabGraphQL(repository, `query HarnessGitLabIssueText($path: ID!, $iid: String!) {
    currentUser { id }
    project(fullPath: $path) {
      id fullPath archived
      issue(iid: $iid) { id iid webUrl title description discussionLocked userPermissions { updateIssue createNote } }
    }
  }`, { path: repository.name, iid: String(number) }, signal, credential) as PermissionResponse | null
  const project = reply?.data?.project
  const issue = project?.issue
  const viewer = reply?.data?.currentUser?.id
  const reference = typeof issue?.webUrl === 'string' ? parseIssueUrl(issue.webUrl) : null
  if (reply?.errors?.length || typeof project?.id !== 'string' || !/^gid:\/\/gitlab\/Project\/\d+$/u.test(project.id)
    || project.fullPath?.toLowerCase() !== repository.name.toLowerCase() || !reference || issueRepositoryKey(reference) !== repository.key
    || reference.number !== number || issue?.iid !== String(number) || typeof issue.id !== 'string' || !/^gid:\/\/gitlab\/(?:Issue|WorkItem)\/\d+$/u.test(issue.id)
    || typeof viewer !== 'string' || !/^gid:\/\/gitlab\/User\/\d+$/u.test(viewer) || typeof issue.title !== 'string'
    || (issue.description !== null && typeof issue.description !== 'string')) return null
  const identity = [repository.key, repository.workspace.profileId, repository.workspace.id, project.id, issue.id, viewer]
  const scope = (operation: string) => createHash('sha256').update(JSON.stringify([operation, ...identity])).digest('hex')
  const commentBlocked = project.archived !== false ? 'This project is archived.'
    : issue.userPermissions?.createNote === true ? ''
      : issue.discussionLocked ? 'This issue is locked.' : 'This GitLab account cannot comment on this issue.'
  return { scope: scope('issue-text'), commentScope: scope('issue-comment'), commentBlocked, viewer,
    issueId: issue.id, canEditText: project.archived === false && issue.userPermissions?.updateIssue === true,
    text: { title: issue.title, body: issue.description ?? '' } }
}

export async function writeGitLabIssueText(repository: GitLabIssueRepository, number: number, issueId: string,
  field: IssueTextField, value: string, signal: AbortSignal, credential: IssueCredential,
): Promise<'updated' | 'denied' | 'refused' | 'pending'> {
  const property = field === 'title' ? 'title' : 'description'
  const reply = await gitLabGraphQL(repository, `mutation HarnessGitLabEditIssue($input: UpdateIssueInput!) {
    updateIssue(input: $input) { issue { id ${property} } errors }
  }`, { input: { projectPath: repository.name, iid: String(number), [property]: value } }, signal, credential)
    .catch((error: unknown) => {
      const status = error instanceof RepositoryPullRequestError ? error.status : undefined
      return status === 401 || status === 403 ? 'denied' : status === 400 || status === 422 ? 'refused' : null
    })
  if (reply === 'denied' || reply === 'refused') return reply
  const result = (reply as { data?: { updateIssue?: { issue?: { id?: string, title?: string, description?: string | null }, errors?: string[] } } } | null)
    ?.data?.updateIssue
  if (result?.issue?.id === issueId && (result.issue[property] === value || (property === 'description' && value === '' && result.issue.description === null)))
    return 'updated'
  if (!result?.issue && result?.errors?.length) return 'refused'
  return 'pending'
}

type GitLabNote = {
  id?: string, body?: string, noteableId?: number, noteableType?: string, system?: boolean, internal?: boolean, author?: { id?: string }
}
const noteFields = 'id body noteableId noteableType system internal author { id }'

function gitLabCommentId(note: GitLabNote | null | undefined, issueId: string, viewer: string, body: string) {
  const boundary = body.indexOf('\n\n')
  if (boundary < 1 || note?.author?.id !== viewer || String(note.noteableId) !== issueId.split('/').at(-1)
    || (note.noteableType !== 'Issue' && note.noteableType !== 'WorkItem') || note.system !== false || note.internal !== false
    || typeof note.body !== 'string' || !note.body.startsWith(body.slice(0, boundary))) return null
  // Check the unique marker so quick actions and later edits do not hide an already posted note.
  const id = Number(typeof note.id === 'string' ? /^gid:\/\/gitlab\/Note\/([1-9]\d*)$/u.exec(note.id)?.[1] : undefined)
  return Number.isSafeInteger(id) ? id : null
}

export async function postGitLabIssueComment(repository: GitLabIssueRepository, issueId: string, viewer: string,
  body: string, signal: AbortSignal, credential: IssueCredential,
): Promise<number | 'denied' | 'refused' | null> {
  const reply = await gitLabGraphQL(repository, `mutation HarnessPostGitLabIssueComment($input: CreateNoteInput!) {
    createNote(input: $input) { note { ${noteFields} } errors quickActionsStatus { commandNames } }
  }`, { input: { noteableId: issueId, body } }, signal, credential)
    .catch((error: unknown) => {
      const status = error instanceof RepositoryPullRequestError ? error.status : undefined
      return status === 401 || status === 403 ? 'denied' : status === 400 || status === 422 ? 'refused' : null
    })
  if (reply === 'denied' || reply === 'refused') return reply
  const result = (reply as { data?: { createNote?: { note?: GitLabNote, errors?: string[], quickActionsStatus?: { commandNames?: string[] } } } } | null)
    ?.data?.createNote
  const id = gitLabCommentId(result?.note, issueId, viewer, body)
  if (id) return id
  if (!result?.note && result?.errors?.length && !result.quickActionsStatus?.commandNames?.length) return 'refused'
  return null
}

export async function findGitLabIssueComment(repository: GitLabIssueRepository, number: number, issueId: string, viewer: string,
  body: string, signal: AbortSignal, credential: IssueCredential, trusted: () => boolean,
): Promise<number | null> {
  type Reply = { errors?: unknown[], data?: { currentUser?: { id?: string }, project?: { issue?: {
    id?: string, notes?: { nodes?: (GitLabNote | null)[], pageInfo?: { hasPreviousPage?: boolean, startCursor?: string } },
  } } } }
  let before: string | undefined
  for (let page = 0; page < 10 && trusted(); page++) {
    const reply = await gitLabGraphQL(repository, `query HarnessFindGitLabIssueComment($path: ID!, $iid: String!, $before: String) {
      currentUser { id }
      project(fullPath: $path) {
        issue(iid: $iid) {
          id
          notes(last: 50, before: $before) { nodes { ${noteFields} } pageInfo { hasPreviousPage startCursor } }
        }
      }
    }`, { path: repository.name, iid: String(number), before }, signal, credential) as Reply | null
    const issue = reply?.data?.project?.issue
    const notes = issue?.notes
    if (!trusted() || reply?.errors?.length || reply?.data?.currentUser?.id !== viewer || issue?.id !== issueId || !Array.isArray(notes?.nodes)) break
    for (const note of notes.nodes) {
      const id = gitLabCommentId(note, issueId, viewer, body)
      if (id) return id
    }
    const cursor = notes.pageInfo?.startCursor
    if (!notes.pageInfo?.hasPreviousPage || !cursor || cursor === before) break
    before = cursor
  }
  return null
}

export async function searchGitLabIssueChoices(repository: GitLabIssueRepository, kind: 'labels' | 'assignees', search: string, signal: AbortSignal) {
  const labels = kind === 'labels'
  const limit = 50
  const query = new URLSearchParams({ [labels ? 'search' : 'query']: search, per_page: String(limit) })
  if (labels) query.set('include_ancestor_groups', 'true')
  const reply = await api(repository, projectPath(repository) + (labels ? '/labels?' : '/members/all?') + query, signal)
  if (!Array.isArray(reply.body)) throw new RepositoryPullRequestError('GitLab returned unreadable filter choices.')
  const options = reply.body.slice(0, limit).flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    if (!labels) {
      const value = account(entry)
      return value ? [{ value, description: typeof entry.name === 'string' ? entry.name.slice(0, 160) : '' }] : []
    }
    const value = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!value || value.length > 100 || /\p{Cc}/u.test(value)) return []
    const color = typeof entry.color === 'string' && /^#[a-f\d]{6}$/iu.test(entry.color) ? entry.color.slice(1) : undefined
    return [{ value, color, description: typeof entry.description === 'string' ? entry.description.slice(0, 160) : '' }]
  })
  return { options, more: reply.more ?? reply.body.length >= limit }
}

export async function listGitLabIssues(repository: GitLabIssueRepository, scope: ListScope, signal: AbortSignal) {
  if (scope.involvement === 'mentioned') throw new RepositoryPullRequestError('GitLab does not offer a mentions filter.')
  const viewer = scope.involvement || scope.assignee === '@me' ? account((await api(repository, 'user', signal)).body as User) : ''
  if ((scope.involvement || scope.assignee === '@me') && !viewer)
    throw new RepositoryPullRequestError('GitLab could not identify the signed-in account.')
  const assignee = scope.assignee === '@me' ? viewer : scope.assignee
  const required = [...new Set([assignee, scope.involvement === 'assigned' ? viewer : ''].filter(Boolean).map(name => name.toLowerCase()))]
  const end = Math.min(searchLimit, scope.page * pageSize + 1)
  const size = required.length > 1 ? 100 : Math.min(end, 100)
  const filters = new URLSearchParams({ scope: 'all', order_by: scope.sort + '_at', sort: 'desc', per_page: String(size) })
  if (scope.state !== 'all') filters.set('state', scope.state === 'open' ? 'opened' : 'closed')
  if (scope.search) filters.set('search', scope.search)
  if (scope.labels.length && scope.labels.every(label => !label.includes(','))) filters.set('labels', scope.labels.join(','))
  if (scope.involvement === 'authored') filters.set('author_username', viewer)
  if (required.length) filters.set('assignee_username', required[0]!)
  const rows = new Map<number, NonNullable<ReturnType<typeof issueRow>>>()
  let partial = false
  for (let page = 1; (page - 1) * size < searchLimit && rows.size < end; page++) {
    filters.set('page', String(page))
    const reply = await api(repository, projectPath(repository) + '/issues?' + filters, signal)
    if (!Array.isArray(reply.body)) throw new RepositoryPullRequestError('GitLab returned an unreadable issue list.')
    for (const item of reply.body.slice(0, size)) {
      const row = issueRow(repository, item as GitLabIssue)
      if (row && (scope.state === 'all' || row.state === scope.state)
        && required.every(name => row.assignees.some(person => person.toLowerCase() === name))
        && scope.labels.every(label => row.labels.some(item => item.name.toLowerCase() === label.toLowerCase())))
        rows.set(row.number, row)
    }
    if (!(reply.more ?? reply.body.length === size)) break
    if (page * size >= searchLimit) partial = true
  }
  return { rows: [...rows.values()], partial }
}

export async function readGitLabIssue(repository: GitLabIssueRepository, number: number, requestedPage: number | 'latest' | null, signal: AbortSignal) {
  const endpoint = projectPath(repository) + '/issues/' + number
  const raw = (await api(repository, endpoint, signal)).body as GitLabIssue
  const row = issueRow(repository, raw)
  if (!row || row.number !== number) throw new RepositoryPullRequestError('GitLab could not verify this issue.')
  const page = typeof requestedPage === 'number' ? requestedPage : 1
  const [notes, related] = await Promise.all([
    api(repository, endpoint + '/notes?' + new URLSearchParams({ sort: 'desc', per_page: String(pageSize), page: String(page) }), signal).catch(() => null),
    api(repository, endpoint + '/related_merge_requests', signal).catch(() => null),
  ])
  const items: IssueActivityItem[] = Array.isArray(notes?.body) ? notes.body.flatMap<IssueActivityItem>(note => {
    if (!Number.isSafeInteger(note?.id) || note.id < 1 || typeof note.body !== 'string') return []
    const created = stamp(note.created_at)
    const data = { id: note.id, author: account(note.author), dateLabel: created ? dates.format(created) : '' }
    return note.system === true ? [{ ...data, kind: 'event' as const, label: note.body.slice(0, 512) }]
      : [{ ...data, kind: 'comment' as const, body: note.body.slice(0, 32_768), url: row.url + '#note_' + note.id }]
  }).reverse() : []
  const relatedRequests = Array.isArray(related?.body) ? related.body.flatMap(request => {
    const url = typeof request?.web_url === 'string' ? request.web_url : ''
    const match = /\/-\/merge_requests\/([1-9]\d*)$/u.exec(url)
    const reference = match ? parseIssueUrl(url.slice(0, match.index) + '/-/issues/' + match[1]) : null
    if (reference?.tracker !== 'gitlab' || reference.host !== repository.host) return []
    return [{ href: url, label: typeof request.title === 'string' ? request.title.slice(0, 160) : 'Merge request' }]
  }) : []
  return { ...row, description: typeof raw.description === 'string' ? raw.description.slice(0, 65_536) : '',
    dateLabel: row.created ? dates.format(row.created) : '', activity: items, reactions: null, commentTotal: typeof raw.user_notes_count === 'number' && Number.isSafeInteger(raw.user_notes_count) ? Math.max(0, raw.user_notes_count) : 0,
    activityAvailable: Array.isArray(notes?.body), activityDegraded: false, olderActivity: '', newerActivity: '',
    commentPage: page, moreComments: Boolean(notes?.more ?? (Array.isArray(notes?.body) && notes.body.length === pageSize)),
    relatedRequests }
}
