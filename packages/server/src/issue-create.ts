import type { HarnessState } from '@harness/engine'
import type { ForgejoIssueRepository, IssueRepository } from './issue-repositories'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey, parseForgejoIssueUrl, parseIssueUrl } from '@harness/contract'
import { forgejoLabels, forgejoRepoPath, readForgejoRepositoryAuthority } from './forgejo-issues'
import { forgejoTeaRequest } from './forgejo-tea'
import { githubIssueTemplates } from './github-issue-templates'
import { bindGitLabIssueCreation } from './gitlab-issue-creation'
import { issueReferenceForSelection, trustedIssueProjects } from './issue-repositories'
import { issueTextLimits } from './issue-text'
import { repositoryGitHubCredential, repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const digest = /^[a-f0-9]{64}$/u
const pageSize = 50
const pages = 10

type CreationResult = { key: string, displayKey: string, url: string }
type RawIssue = { number?: unknown, html_url?: unknown, user?: { id?: unknown }, title?: unknown, body?: unknown, pull_request?: unknown }
type GitLabCreatedIssue = { iid?: unknown, web_url?: unknown, author?: { id?: unknown }, title?: unknown, description?: unknown }
type Authority = { repoId: number, viewer: number, archived: unknown, issuesEnabled: boolean, canCreate?: boolean, canTriage: boolean, multipleAssignees?: boolean }
type TemplateList = Awaited<ReturnType<typeof githubIssueTemplates>>
type CreationPayload = { title: string, body: string, labels: string[], assignees: string[] }
export type IssueCreationAdapter = {
  readAuthority: () => Promise<Authority | null>
  templates: () => Promise<TemplateList>
  prepare: (payload: CreationPayload, authority: Authority) => Promise<{ body: object } | { status: 'refused' | 'unknown-label' | 'unknown-assignee' }>
  submit: (body: object) => Promise<unknown>
  list: (page: number) => Promise<{ body: unknown, more?: boolean }>
}

function hash(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

async function destination(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const profile = Number(query.get('profile'))
  const workspaceId = Number(query.get('workspace'))
  const ref = issueReferenceForSelection(query.get('repository'), 1)
  const workspace = state.workspaces.get(workspaceId)
  if (!state.profiles.has(profile) || !workspace?.trusted || workspace.scratch || workspace.profileId !== profile
    || !ref) return null
  const [project] = await trustedIssueProjects([workspace], profile, signal)
  const repository = project?.repositories.get(issueRepositoryKey(ref))
  if (!repository) return null
  const trusted = () => {
    const current = state.workspaces.get(workspaceId)
    return Boolean(current?.trusted && !current.scratch && current.profileId === profile && current.path === workspace.path)
  }
  return { repository, trusted }
}

function scopeFor(repository: IssueRepository, authority: Authority) {
  const connection = repository.tracker === 'forgejo' ? [repository.base, repository.login] : [repository.tracker === 'gitlab' ? repository.host : 'github.com']
  return hash([repository.tracker + '-issue-create', ...connection, repository.key, repository.workspace.profileId,
    repository.workspace.id, authority.repoId, authority.viewer])
}

function strings(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  const values: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim() || item.length > 255 || /\p{Cc}/u.test(item)) return null
    values.push(item.trim())
  }
  return [...new Set(values)]
}

type RawTemplate = { file_name?: unknown, name?: unknown, about?: unknown, title?: unknown, content?: unknown, labels?: unknown, assignees?: unknown }

async function forgejoTemplateList(repository: ForgejoIssueRepository, signal: AbortSignal): Promise<TemplateList> {
  const path = forgejoRepoPath(repository)
  const [listed, config] = await Promise.all([
    forgejoTeaRequest(repository, path + '/issue_templates', signal),
    forgejoTeaRequest(repository, path + '/issue_config', signal).catch((error: unknown) => {
      if (error instanceof RepositoryPullRequestError && error.status === 404) return { body: null }
      throw error
    }),
  ])
  if (listed.body !== null && !Array.isArray(listed.body)) throw new RepositoryPullRequestError('Forgejo returned unreadable issue templates.')
  const settings = config.body as { blank_issues_enabled?: unknown } | null
  const templates = new Map<string, { key: string, name: string, about: string, title: string, body: string, labels: string[], assignees: string[] }>()
  for (const template of ((listed.body ?? []) as RawTemplate[]).slice(0, 100)) {
    const key = typeof template?.file_name === 'string' ? template.file_name.trim() : ''
    if (!/\.md$/iu.test(key) || key.length > 255 || /\p{Cc}/u.test(key) || templates.has(key)) continue
    const labels = strings(template.labels ?? [], 50)
    const assignees = strings(template.assignees ?? [], 25)
    if (!labels || !assignees) continue
    templates.set(key, { key, name: typeof template.name === 'string' && template.name.trim() ? template.name.trim().slice(0, 255) : key,
      about: typeof template.about === 'string' ? template.about.slice(0, 1024) : '',
      title: typeof template.title === 'string' ? template.title.slice(0, issueTextLimits.title) : '',
      body: typeof template.content === 'string' ? template.content.slice(0, issueTextLimits.body) : '', labels, assignees,
    })
  }
  return { blankIssuesEnabled: settings?.blank_issues_enabled !== false, templates: [...templates.values()] }
}

async function resolveForgejoLabels(repository: ForgejoIssueRepository, names: string[], signal: AbortSignal) {
  const ids = new Map<string, number>()
  for (let page = 1; page <= pages && ids.size < names.length; page++) {
    const { body, more } = await forgejoTeaRequest(repository, forgejoRepoPath(repository) + '/labels?limit=' + pageSize + '&page=' + page, signal)
    const labels = body === null ? [] : forgejoLabels(body)
    if (!labels) return null
    for (const label of labels) {
      if (label.id !== undefined && names.includes(label.name)) ids.set(label.name, label.id)
    }
    if (!labels.length || more === false) break
  }
  return ids.size === names.length ? names.map(name => ids.get(name)!) : null
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

async function bindAdapter(repository: IssueRepository, signal: AbortSignal): Promise<IssueCreationAdapter> {
  if (repository.tracker === 'gitlab') return bindGitLabIssueCreation(repository, signal, pageSize)
  if (repository.tracker === 'forgejo') {
    const endpoint = forgejoRepoPath(repository) + '/issues'
    return {
      async readAuthority() {
        const authority = await readForgejoRepositoryAuthority(repository, signal)
        return authority && { ...authority, canTriage: authority.canPush }
      },
      templates: () => forgejoTemplateList(repository, signal),
      async prepare(payload) {
        const labels = await resolveForgejoLabels(repository, payload.labels, signal)
        return labels ? { body: { ...payload, labels } } : { status: 'unknown-label' }
      },
      submit: async payload => (await forgejoTeaRequest(repository, endpoint, signal, { method: 'POST', body: payload })).body,
      list: page => forgejoTeaRequest(repository, endpoint + '?state=all&sort=latest&limit=' + pageSize + '&page=' + page, signal),
    }
  }
  const credential = await repositoryGitHubCredential(repository.path, signal)
  const repoPath = 'repos/' + repository.name
  const endpoint = repoPath + '/issues'
  const request = async (path: string, payload?: object) => {
    const reply = await repositoryGitHubRequest(repository.path, path, payload, signal, credential)
    if (reply.status !== (payload ? 201 : 200))
      throw new RepositoryPullRequestError('GitHub could not complete the issue request.', reply.status)
    return reply
  }
  return {
    async readAuthority() {
      const [repoReply, userReply] = await Promise.all([request(repoPath), request('user')])
      const repo = repoReply.body as { id?: unknown, full_name?: string, archived?: boolean, has_issues?: boolean, permissions?: { push?: boolean } } | null
      const user = userReply.body as { id?: unknown } | null
      if (!positiveId(repo?.id) || !positiveId(user?.id) || typeof repo.full_name !== 'string'
        || repo.full_name.toLowerCase() !== repository.name.toLowerCase()) return null
      return { repoId: repo.id, viewer: user.id, archived: repo.archived, issuesEnabled: repo.has_issues === true, canTriage: repo.permissions?.push === true }
    },
    templates: () => githubIssueTemplates(repository, credential, signal),
    prepare: async body => ({ body }),
    submit: async payload => (await request(endpoint, payload)).body,
    async list(page) {
      const reply = await request(endpoint + '?state=all&sort=created&direction=desc&per_page=' + pageSize + '&page=' + page)
      return { body: reply.body, more: reply.hasNextPage }
    },
  }
}

export async function issueCreationScope(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const target = await destination(state, query, signal)
  if (!target) return null
  const adapter = await bindAdapter(target.repository, signal)
  const authority = await adapter.readAuthority()
  return authority && target.trusted() && authority.issuesEnabled ? scopeFor(target.repository, authority) : null
}

export async function issueTemplates(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const target = await destination(state, query, signal)
  if (!target) return null
  const { repository, trusted } = target
  const adapter = await bindAdapter(repository, signal)
  const initial = await adapter.readAuthority()
  if (!initial || !trusted() || !initial.issuesEnabled) return null
  const choices = await adapter.templates()
  const current = await adapter.readAuthority()
  const scope = scopeFor(repository, initial)
  if (!trusted() || !current?.issuesEnabled || scopeFor(repository, current) !== scope) return null
  const canCreate = current.archived === false && current.canCreate !== false
  return { scope, canCreate, canTriage: canCreate && current.canTriage, ...choices }
}

function validateResult(repository: IssueRepository, value: unknown): CreationResult | null {
  const issue = value as { key?: unknown, url?: unknown } | null
  if (typeof issue?.key !== 'string' || typeof issue.url !== 'string') return null
  const ref = repository.tracker === 'forgejo' ? parseForgejoIssueUrl(issue.url) : parseIssueUrl(issue.url)
  return ref?.tracker === repository.tracker && issueRepositoryKey(ref) === repository.key && issue.key === String(ref.number)
    ? { key: issue.key, displayKey: '#' + issue.key, url: issue.url } : null
}

export async function createIssue(state: HarnessState, query: URLSearchParams, value: unknown, signal: AbortSignal,
  receipts: PullRequestReplyReceipts,
) {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!input || typeof input.intent !== 'string' || !uuid.test(input.intent) || typeof input.scope !== 'string' || !digest.test(input.scope)
    || typeof input.title !== 'string' || input.title.length > issueTextLimits.title || !input.title.trim() || /\p{Cc}/u.test(input.title)
    || typeof input.body !== 'string' || input.body.length > issueTextLimits.body || input.body.includes('\0')) return null
  const labels = strings(input.labels, 50)
  const assignees = strings(input.assignees, 25)
  if (!labels || !assignees || assignees.some(name => !/^[a-z\d._-]{1,100}$/iu.test(name))) return null
  const result = (status: 'changed' | 'denied' | 'unavailable' | 'unknown-label' | 'unknown-assignee' | 'refused' | 'pending') => ({ status })
  let attempted = false
  try {
    const target = await destination(state, query, signal)
    if (!target) return result('changed')
    const { repository, trusted } = target
    const adapter = await bindAdapter(repository, signal)
    const read = adapter.readAuthority
    const authority = await read()
    const scope = input.scope
    const sameAccount = (current: Authority | null) => Boolean(current && trusted() && scopeFor(repository, current) === scope)
    if (!sameAccount(authority) || !authority) return result('changed')
    const title = input.title.trim()
    const body = input.body.replace(/\r\n?/gu, '\n')
    const intent = hash([repository.tracker + '-issue-create', input.intent])
    const fingerprint = hash([scope, title, body, [...labels].sort(), [...assignees].sort()])
    const prior = receipts.inspect(intent, fingerprint)
    if (prior === 'conflict') return result('changed')
    if (prior === 'confirmed') {
      const saved = receipts.confirmedResult(intent, fingerprint)
      const issue = saved && validateResult(repository, JSON.parse(saved))
      return issue ? { status: 'created' as const, issue, replayed: true } : result('pending')
    }
    attempted = prior === 'pending'
    const marker = '<!-- harness:issue-create:' + hash([scope, intent]) + ' -->'
    const matches = (value: unknown): CreationResult | null => {
      const gitLab = repository.tracker === 'gitlab' ? value as GitLabCreatedIssue | null : null
      const raw = gitLab ? { number: gitLab.iid, html_url: gitLab.web_url, title: gitLab.title, body: gitLab.description, user: gitLab.author }
        : value as RawIssue | null
      if (!raw || raw.pull_request || raw.user?.id !== authority.viewer || raw.title !== title
        || typeof raw.body !== 'string' || (raw.body !== marker && !raw.body.startsWith(marker + '\n\n'))) return null
      return validateResult(repository, { key: String(raw.number), url: raw.html_url })
    }
    const accept = async (issue: CreationResult, replayed: boolean) => {
      if (!sameAccount(await read().catch(() => null))) return result('pending')
      receipts.confirm(intent, fingerprint, JSON.stringify(issue))
      return { status: 'created' as const, issue, replayed }
    }
    if (!prior) {
      const allowed = (current: Authority) => current.issuesEnabled && current.archived === false && current.canCreate !== false
        && (current.canTriage || (!labels.length && !assignees.length))
      if (!allowed(authority)) return result('denied')
      const prepared = await adapter.prepare({ title, body: marker + '\n\n' + body, labels, assignees }, authority)
      if ('status' in prepared) return result(prepared.status)
      const current = await read()
      if (!current || !sameAccount(current) || current.multipleAssignees !== authority.multipleAssignees) return result('changed')
      if (!allowed(current)) return result('denied')
      const claim = receipts.claim(intent, fingerprint, trusted())
      if (claim !== 'claimed') {
        if (claim === 'pending' || claim === 'confirmed') return result('pending')
        return result('changed')
      }
      attempted = true
      try {
        const issue = matches(await adapter.submit(prepared.body))
        if (issue) return await accept(issue, false)
      }
      catch (error) {
        const status = error instanceof RepositoryPullRequestError ? error.status : undefined
        if (status === 401 || status === 403 || status === 400 || status === 404 || status === 410 || status === 422) {
          receipts.reject(intent, fingerprint)
          return result(status === 401 || status === 403 ? 'denied' : 'refused')
        }
      }
    }
    for (let page = 1; page <= pages; page++) {
      const reply = await adapter.list(page)
      if (!Array.isArray(reply.body)) break
      const issue = reply.body.map(matches).find(candidate => candidate !== null)
      if (issue) return await accept(issue, true)
      if (!reply.body.length || reply.more === false) break
    }
    return result('pending')
  }
  catch { return result(attempted ? 'pending' : 'unavailable') }
}
