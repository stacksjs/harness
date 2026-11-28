import type { HarnessState } from '@harness/engine'
import type { IssueRepository } from '../issue-repositories'
import { basename } from 'node:path'
import { hashToken } from '../access'
import { forgejoRepoPath, readForgejoRepositoryAuthority } from '../forgejo-issues'
import { forgejoTeaRequest } from '../forgejo-tea'
import { gitLabIssueCredential, gitLabIssueRest } from '../gitlab-issues'
import { issueCreationMarker } from '../issue-creation-marker'
import { trustedIssueProjects } from '../issue-repositories'
import { repositoryGitHubCredential, repositoryGitHubRequest } from '../repository-pull-request'

export interface WorkflowTrackerTrigger {
  id: string
  profile: number
  project: number | string
  repository?: string
  kind: 'issue' | 'pull-request'
  query?: string
  labels?: string[]
}

export type TrackerStatus = 'waiting' | 'polling' | 'ready' | 'unavailable' | 'account-changed' | 'backlog'
export type WorkflowTrackerItem = {
  kind: WorkflowTrackerTrigger['kind']
  tracker: IssueRepository['tracker']
  projectId: number
  repository: string
  host: string
  number: number
  key: string
  displayKey: string
  url: string
  title: string
  state: 'open' | 'closed' | 'merged'
  createdAt: string
  updatedAt: string
  author: string
  labels: string[]
  body: string
}

type TrackerRow = {
  number?: number, iid?: number, html_url?: string, web_url?: string, title?: string, state?: string,
  pull_request?: { merged_at?: string }, merged_at?: string, created_at?: string, updated_at?: string,
  body?: string, description?: string, user?: { login?: string }, author?: { username?: string }, labels?: unknown[],
}
type Feed = { scope: string, read: (page: number) => Promise<{ items: unknown[], more?: boolean }>, verify: () => Promise<string> }
type Identity = { id: number, full_name?: string, path_with_namespace?: string }

const namePattern = /^[a-z\d][a-z\d._-]{0,79}$/iu

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/\p{Cc}/u.test(value)
}

export function readTrackerTriggers(input: unknown): WorkflowTrackerTrigger[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new Error('Workflow tracker triggers need a list.')
  const seen = new Set<string>()
  return input.map((item) => {
    const value = item as Partial<WorkflowTrackerTrigger> | null
    if (!value || typeof value.id !== 'string' || !namePattern.test(value.id)
      || !Number.isSafeInteger(value.profile) || value.profile! < 1
      || !(Number.isSafeInteger(value.project) && Number(value.project) > 0 || text(value.project, 4096) && value.project.trim())
      || (value.kind !== 'issue' && value.kind !== 'pull-request')
      || (value.repository !== undefined && (!text(value.repository, 512) || !value.repository.trim()))
      || (value.query !== undefined && !text(value.query, 160))
      || (value.labels !== undefined && (value.kind !== 'issue' || !Array.isArray(value.labels) || value.labels.length > 10
        || [...value.labels].some(label => !text(label, 100) || !label.trim()))))
      throw new Error('A tracker trigger needs a valid ID, profile, project, and issue or pull request kind.')
    const { id, profile, project, kind, repository, query, labels } = value as WorkflowTrackerTrigger
    const identity = JSON.stringify([profile, id])
    if (seen.has(identity)) throw new Error('Tracker trigger IDs must be unique within a workflow and profile.')
    seen.add(identity)
    return { id, profile, project, kind, repository: repository?.trim().toLowerCase(), query: query?.trim(),
      labels: labels?.length ? [...new Set(labels.map(label => label.trim().toLowerCase()))].sort() : undefined,
    }
  })
}

export function workflowProject(state: HarnessState, profile: number, project: string | number) {
  const projects = [...state.workspaces.values()].filter(workspace => workspace.profileId === profile && workspace.trusted && !workspace.scratch
    && (workspace.id === project || workspace.path === project || basename(workspace.path) === project))
  return projects.length === 1 ? projects[0] : undefined
}

export function trackerKey(workflow: string, trigger: WorkflowTrackerTrigger) {
  return hashToken(JSON.stringify([workflow, trigger]))
}

export async function trackerRepository(state: HarnessState, trigger: WorkflowTrackerTrigger, signal: AbortSignal) {
  const workspace = workflowProject(state, trigger.profile, trigger.project)
  if (!workspace) return null
  const [project] = await trustedIssueProjects([workspace], trigger.profile, signal)
  if (!project) return null
  return trigger.repository ? project.repositories.get(trigger.repository)
    : project.repositories.size === 1 ? project.repositories.values().next().value : null
}

function scope(repository: IssueRepository, repo: unknown, account: unknown) {
  if (typeof repo !== 'number' || !Number.isSafeInteger(repo) || repo <= 0
    || typeof account !== 'number' || !Number.isSafeInteger(account) || account <= 0)
    throw new Error('The tracker account or repository could not be identified.')
  return hashToken(JSON.stringify([repository.tracker, repository.key, repository.workspace.id,
    repository.tracker === 'forgejo' ? [repository.base, repository.login] : null, repo, account]))
}

function page(items: unknown, more?: boolean) {
  if (!Array.isArray(items)) throw new Error('The tracker returned an unreadable list.')
  return { items, more }
}

export async function openTrackerFeed(repository: IssueRepository, trigger: WorkflowTrackerTrigger, signal: AbortSignal): Promise<Feed> {
  const issue = trigger.kind === 'issue'
  if (repository.tracker === 'github') {
    const credential = await repositoryGitHubCredential(repository.path, signal)
    const path = 'repos/' + repository.name
    const request = (endpoint: string) => repositoryGitHubRequest(repository.path, endpoint, undefined, signal, credential)
    const verify = async () => {
      const [repo, viewer] = await Promise.all([request(path), request('user')])
      const identity = repo.body as Identity | null
      if (repo.status !== 200 || viewer.status !== 200 || identity?.full_name?.toLowerCase() !== repository.key)
        throw new Error('GitHub could not confirm the tracker connection.')
      return scope(repository, identity.id, (viewer.body as Identity | null)?.id)
    }
    return { scope: await verify(), verify, async read(number) {
      const params = new URLSearchParams({ sort: 'created', page: String(number), per_page: '100' })
      const phrase = trigger.query?.replace(/["\\]/gu, ' ').trim()
      if (phrase) {
        params.set('order', 'desc')
        params.set('q', (issue ? 'is:issue' : 'is:pr') + ' repo:' + repository.name
          + (issue ? ' in:title,body "' : ' in:title,body,comments "') + phrase + '"')
      }
      else {
        params.set('state', 'all')
        params.set('direction', 'desc')
      }
      const result = await request((phrase ? 'search/issues' : path + (issue ? '/issues' : '/pulls')) + '?' + params)
      if (result.status !== 200) throw new Error('GitHub could not read the tracker feed.')
      if (!phrase) return page(result.body, result.hasNextPage)
      const search = result.body as { items?: unknown[], incomplete_results?: boolean } | null
      if (search?.incomplete_results) throw new Error('GitHub returned incomplete search results.')
      return page(search?.items, result.hasNextPage)
    } }
  }
  if (repository.tracker === 'gitlab') {
    const credential = await gitLabIssueCredential(repository, signal)
    const path = 'projects/' + encodeURIComponent(repository.name)
    const request = (endpoint: string) => gitLabIssueRest(repository, endpoint, signal, credential)
    const verify = async () => {
      const [repo, viewer] = await Promise.all([request(path), request('user')])
      const identity = repo.body as Identity | null
      if (identity?.path_with_namespace?.toLowerCase() !== repository.name.toLowerCase())
        throw new Error('GitLab could not confirm the tracker connection.')
      return scope(repository, identity.id, (viewer.body as Identity | null)?.id)
    }
    return { scope: await verify(), verify, async read(number) {
      const params = new URLSearchParams({ scope: 'all', state: 'all', order_by: 'created_at', sort: 'desc', page: String(number), per_page: '100' })
      if (trigger.query) params.set('search', trigger.query)
      const result = await request(path + (issue ? '/issues?' : '/merge_requests?') + params)
      return page(result.body, result.more ?? (Array.isArray(result.body) && result.body.length > 0))
    } }
  }
  const verify = async () => {
    const authority = await readForgejoRepositoryAuthority(repository, signal)
    return scope(repository, authority?.repoId, authority?.viewer)
  }
  return { scope: await verify(), verify, async read(number) {
    const params = new URLSearchParams({ state: 'all', page: String(number), limit: '50' })
    if (issue) {
      params.set('type', 'issues')
      params.set('sort', 'latest')
      if (trigger.query) params.set('q', trigger.query)
    }
    const result = await forgejoTeaRequest(repository, forgejoRepoPath(repository) + (issue ? '/issues?' : '/pulls?') + params, signal)
    return page(result.body, result.more ?? (Array.isArray(result.body) && result.body.length > 0))
  } }
}

function item(repository: IssueRepository, trigger: WorkflowTrackerTrigger, row: TrackerRow): WorkflowTrackerItem | null {
  const issue = trigger.kind === 'issue'
  const gitlab = repository.tracker === 'gitlab'
  const number = gitlab ? row.iid : row.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || typeof row.title !== 'string'
    || (issue && row.pull_request)) return null
  const host = repository.tracker === 'github' ? 'github.com' : repository.host
  const base = repository.tracker === 'forgejo' ? repository.base + '/' + repository.apiName : 'https://' + host + '/' + repository.name
  const url = base + (gitlab ? (issue ? '/-/issues/' : '/-/merge_requests/')
    : issue ? '/issues/' : repository.tracker === 'forgejo' ? '/pulls/' : '/pull/') + number
  const address = gitlab ? row.web_url : row.html_url
  if (typeof address !== 'string' || address.toLowerCase() !== url.toLowerCase()
    || !['opened', 'open', 'closed', 'merged', 'locked'].includes(row.state ?? '')) return null
  const created = Date.parse(row.created_at ?? '')
  if (!Number.isFinite(created)) return null
  const updated = Date.parse(row.updated_at ?? '')
  const state = row.state === 'merged' || row.merged_at || row.pull_request?.merged_at ? 'merged'
    : row.state === 'open' || row.state === 'opened' ? 'open' : 'closed'
  const labels = (Array.isArray(row.labels) ? row.labels : []).flatMap((label) => {
    const name = typeof label === 'string' ? label : (label as { name?: unknown } | null)?.name
    return typeof name === 'string' ? [name.slice(0, 100)] : []
  }).slice(0, 100)
  if (trigger.labels?.some(label => !labels.some(value => value.toLowerCase() === label))) return null
  const rawBody = (gitlab ? row.description : row.body)
  const body = typeof rawBody === 'string' ? rawBody.replace(issueCreationMarker, '').slice(0, 65_536) : ''
  if (repository.tracker === 'forgejo' && !issue && trigger.query
    && !(row.title + ' ' + body).toLowerCase().includes(trigger.query.toLowerCase())) return null
  const author = gitlab ? row.author?.username : row.user?.login
  return { kind: trigger.kind, tracker: repository.tracker, projectId: repository.workspace.id, repository: repository.name, host,
    number, key: String(number), displayKey: (gitlab && !issue ? '!' : '#') + number, url, title: row.title.slice(0, 512), state,
    createdAt: new Date(created).toISOString(), updatedAt: new Date(Number.isFinite(updated) ? updated : created).toISOString(),
    author: typeof author === 'string' ? author.slice(0, 255) : '', labels, body,
  }
}

export async function readTrackerBatch(feed: Feed, repository: IssueRepository, trigger: WorkflowTrackerTrigger, since: number) {
  const rows = new Map<string, WorkflowTrackerItem>()
  for (let number = 1; number <= 10; number++) {
    const { items, more } = await feed.read(number)
    for (const value of items) {
      if (!value || typeof value !== 'object') continue
      const raw = value as TrackerRow
      if (Date.parse(raw.created_at ?? '') < since) return { rows: [...rows.values()], complete: true }
      const row = item(repository, trigger, raw)
      if (row) rows.set(row.url.toLowerCase(), row)
    }
    if (!more || !items.length) return { rows: [...rows.values()], complete: true }
  }
  return { rows: [...rows.values()], complete: false }
}
