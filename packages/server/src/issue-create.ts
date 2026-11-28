import type { HarnessState } from '@harness/engine'
import type { ForgejoIssueRepository } from './issue-repositories'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey, parseForgejoIssueUrl } from '@harness/contract'
import { forgejoLabels, forgejoRepoPath, readForgejoRepositoryAuthority } from './forgejo-issues'
import { forgejoTeaRequest } from './forgejo-tea'
import { issueReferenceForSelection, trustedIssueProjects } from './issue-repositories'
import { issueTextLimits } from './issue-text'
import { RepositoryPullRequestError } from './repository-pull-request'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const digest = /^[a-f0-9]{64}$/u
const pageSize = 50
const pages = 10

type CreationResult = { key: string, displayKey: string, url: string }
type RawIssue = { number?: unknown, html_url?: unknown, user?: { id?: unknown }, title?: unknown, body?: unknown, pull_request?: unknown }
type Authority = NonNullable<Awaited<ReturnType<typeof readForgejoRepositoryAuthority>>>

function hash(parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

async function destination(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const profile = Number(query.get('profile'))
  const workspaceId = Number(query.get('workspace'))
  const ref = issueReferenceForSelection(query.get('repository'), 1)
  const workspace = state.workspaces.get(workspaceId)
  if (!state.profiles.has(profile) || !workspace?.trusted || workspace.scratch || workspace.profileId !== profile
    || ref?.tracker !== 'forgejo') return null
  const [project] = await trustedIssueProjects([workspace], profile, signal)
  const repository = project?.repositories.get(issueRepositoryKey(ref))
  if (repository?.tracker !== 'forgejo') return null
  const trusted = () => {
    const current = state.workspaces.get(workspaceId)
    return Boolean(current?.trusted && !current.scratch && current.profileId === profile && current.path === workspace.path)
  }
  return { repository, trusted }
}

function scopeFor(repository: ForgejoIssueRepository, authority: Authority) {
  return hash(['forgejo-issue-create', repository.base, repository.login, repository.key, repository.workspace.profileId,
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

export async function forgejoIssueTemplates(state: HarnessState, query: URLSearchParams, signal: AbortSignal) {
  const target = await destination(state, query, signal)
  if (!target) return null
  const { repository, trusted } = target
  const initial = await readForgejoRepositoryAuthority(repository, signal)
  if (!initial || !trusted() || !initial.issuesEnabled) return null
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
  const current = await readForgejoRepositoryAuthority(repository, signal)
  const scope = scopeFor(repository, initial)
  if (!trusted() || !current?.issuesEnabled || scopeFor(repository, current) !== scope) return null
  return { scope, canCreate: current.archived === false, canTriage: current.archived === false && current.canPush,
    blankIssuesEnabled: settings?.blank_issues_enabled !== false, templates: [...templates.values()] }
}

async function resolveLabels(repository: ForgejoIssueRepository, names: string[], signal: AbortSignal) {
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

function validateResult(repository: ForgejoIssueRepository, value: unknown): CreationResult | null {
  const issue = value as { key?: unknown, url?: unknown } | null
  if (typeof issue?.key !== 'string' || typeof issue.url !== 'string') return null
  const ref = parseForgejoIssueUrl(issue.url)
  return ref && issueRepositoryKey(ref) === repository.key && issue.key === String(ref.number)
    ? { key: issue.key, displayKey: '#' + issue.key, url: issue.url } : null
}

export async function createForgejoIssue(state: HarnessState, query: URLSearchParams, value: unknown, signal: AbortSignal,
  receipts: PullRequestReplyReceipts,
) {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : null
  if (!input || typeof input.intent !== 'string' || !uuid.test(input.intent) || typeof input.scope !== 'string' || !digest.test(input.scope)
    || typeof input.title !== 'string' || input.title.length > issueTextLimits.title || !input.title.trim() || /\p{Cc}/u.test(input.title)
    || typeof input.body !== 'string' || input.body.length > issueTextLimits.body || input.body.includes('\0')) return null
  const labels = strings(input.labels, 50)
  const assignees = strings(input.assignees, 25)
  if (!labels || !assignees || assignees.some(name => !/^[a-z\d._-]{1,100}$/iu.test(name))) return null
  const result = (status: 'changed' | 'denied' | 'unavailable' | 'unknown-label' | 'refused' | 'pending') => ({ status })
  let attempted = false
  try {
    const target = await destination(state, query, signal)
    if (!target) return result('changed')
    const { repository, trusted } = target
    const read = () => readForgejoRepositoryAuthority(repository, signal)
    const authority = await read()
    const scope = input.scope
    const sameAccount = (current: Authority | null) => Boolean(current && trusted() && scopeFor(repository, current) === scope)
    if (!sameAccount(authority) || !authority) return result('changed')
    const title = input.title.trim()
    const body = input.body.replace(/\r\n?/gu, '\n')
    const intent = hash(['forgejo-issue-create', input.intent])
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
    const matches = (raw: RawIssue | null): CreationResult | null => {
      if (!raw || raw.pull_request || raw.user?.id !== authority.viewer || raw.title !== title
        || typeof raw.body !== 'string' || (raw.body !== marker && !raw.body.startsWith(marker + '\n\n'))) return null
      return validateResult(repository, { key: String(raw.number), url: raw.html_url })
    }
    const accept = async (issue: CreationResult, replayed: boolean) => {
      if (!sameAccount(await read().catch(() => null))) return result('pending')
      receipts.confirm(intent, fingerprint, JSON.stringify(issue))
      return { status: 'created' as const, issue, replayed }
    }
    const endpoint = forgejoRepoPath(repository) + '/issues'
    if (!prior) {
      const allowed = (current: Authority) => current.issuesEnabled && current.archived === false && (current.canPush || (!labels.length && !assignees.length))
      if (!allowed(authority)) return result('denied')
      const ids = await resolveLabels(repository, labels, signal)
      if (!ids) return result('unknown-label')
      const current = await read()
      if (!current || !sameAccount(current)) return result('changed')
      if (!allowed(current)) return result('denied')
      const claim = receipts.claim(intent, fingerprint, trusted())
      if (claim !== 'claimed') {
        if (claim === 'pending' || claim === 'confirmed') return result('pending')
        return result('changed')
      }
      attempted = true
      try {
        const reply = await forgejoTeaRequest(repository, endpoint, signal, {
          method: 'POST', body: { title, body: marker + '\n\n' + body, labels: ids, assignees },
        })
        const issue = matches(reply.body as RawIssue | null)
        if (issue) return await accept(issue, false)
      }
      catch (error) {
        const status = error instanceof RepositoryPullRequestError ? error.status : undefined
        if (status === 401 || status === 403 || status === 400 || status === 404 || status === 422) {
          receipts.reject(intent, fingerprint)
          return result(status === 401 || status === 403 ? 'denied' : 'refused')
        }
      }
    }
    for (let page = 1; page <= pages; page++) {
      const reply = await forgejoTeaRequest(repository, endpoint + '?state=all&sort=latest&limit=' + pageSize + '&page=' + page, signal)
      if (!Array.isArray(reply.body)) break
      const issue = reply.body.map(matches).find(candidate => candidate !== null)
      if (issue) return await accept(issue, true)
      if (!reply.body.length || reply.more === false) break
    }
    return result('pending')
  }
  catch { return result(attempted ? 'pending' : 'unavailable') }
}
