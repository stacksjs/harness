import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

export type PullRequestLabel = { key: string, id?: number, name: string, color: string, description: string, archived: boolean }
type GitHubLabel = { id?: number, node_id?: string, name?: string, color?: string, description?: string | null, archived_at?: string | null }
type ReviewedLabel = { id: string, applied: boolean, nameHash: string, label?: PullRequestLabel }

const maxOptions = 1_000
const labelKey = /^[A-Za-z0-9_+\/=:.-]{1,128}$/u
const labelColor = /^#[a-f0-9]{6}$/iu

function nameHash(name: string) {
  return createHash('sha256').update(name).digest('hex').slice(0, 24)
}

function validLabelName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 256 && !/\p{Cc}/u.test(name)
}

function validNodeKey(value: unknown): value is string {
  return typeof value === 'string' && labelKey.test(value)
}

export function pullRequestLabels(value: unknown): PullRequestLabel[] | null {
  if (!Array.isArray(value)) return null
  const labels = new Map<string, PullRequestLabel>()
  for (const item of value as (GitHubLabel | null)[]) {
    if (!item || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0 || !validLabelName(item.name)) return null
    const key = validNodeKey(item.node_id) ? item.node_id : String(item.id)
    if (labels.has(key)) return null
    const color = typeof item.color === 'string' && labelColor.test('#' + item.color) ? '#' + item.color : ''
    labels.set(key, { key, id: item.id, name: item.name, color, description: typeof item.description === 'string' ? item.description.slice(0, 512) : '',
      archived: typeof item.archived_at === 'string' && Boolean(item.archived_at) })
  }
  return [...labels.values()]
}

async function readLabels(path: string, endpoint: string, credential: string, signal: AbortSignal, pageLimit: number) {
  const labels = new Map<string, PullRequestLabel>()
  for (let page = 1; page <= pageLimit; page++) {
    const response = await repositoryGitHubRequest(path, endpoint + '?per_page=100&page=' + page, undefined, signal, credential)
    const items = response.status === 200 ? pullRequestLabels(response.body) : null
    if (!items) return null
    for (const item of items) {
      if (labels.has(item.key)) return null
      labels.set(item.key, item)
    }
    if (!response.hasNextPage) return { labels: [...labels.values()], more: false }
  }
  return { labels: [...labels.values()], more: true }
}

async function readAppliedPullRequestLabels({ path, repository, number, credential, signal }: LabelContext) {
  const result = await readLabels(path, 'repos/' + repository + '/issues/' + number + '/labels', credential, signal, 10)
  return result && !result.more ? result.labels : null
}

export async function searchRepositoryLabels({ path, repository, credential, signal }: Omit<LabelContext, 'number'>, search: string) {
  const [owner, name] = repository.split('/')
  const response = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessSearchRepositoryLabels($owner: String!, $name: String!, $search: String!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        labels(first: 100, query: $search, orderBy: { field: NAME, direction: ASC }) {
          nodes { id name color description }
          pageInfo { hasNextPage }
        }
      }
    }`, variables: { owner, name, search },
  }, signal, credential)
  const result = response.body as { errors?: unknown[], data?: { repository?: { nameWithOwner?: string,
    labels?: { nodes?: { id?: string, name?: string, color?: string, description?: string | null }[], pageInfo?: { hasNextPage?: boolean } } } } } | null
  const repo = result?.data?.repository
  const rows = repo?.labels?.nodes
  if (response.status !== 200 || result?.errors?.length || repo?.nameWithOwner?.toLowerCase() !== repository.toLowerCase() || !Array.isArray(rows)) return null
  const labels = new Map<string, PullRequestLabel>()
  for (const row of rows) {
    if (!row || !validNodeKey(row.id) || !validLabelName(row.name) || labels.has(row.id)) return null
    const color = typeof row.color === 'string' && labelColor.test('#' + row.color) ? '#' + row.color : ''
    labels.set(row.id, { key: row.id, name: row.name, color, description: typeof row.description === 'string' ? row.description.slice(0, 512) : '', archived: false })
  }
  return { labels: [...labels.values()], more: repo?.labels?.pageInfo?.hasNextPage === true }
}

function writePullRequestLabel(path: string, repository: string, number: number, label: PullRequestLabel, apply: boolean,
  credential: string, signal: AbortSignal) {
  const endpoint = 'repos/' + repository + '/issues/' + number + '/labels'
  return apply
    ? repositoryGitHubRequest(path, endpoint, { labels: [label.name] }, signal, credential)
    : repositoryGitHubRequest(path, endpoint + '/' + encodeURIComponent(label.name), undefined, signal, credential, 'DELETE')
}

type LabelContext = { path: string, repository: string, number: number, credential: string, signal: AbortSignal }

type LabelOption = PullRequestLabel & { applied: boolean, checked: boolean }
type LabelChange = ReviewedLabel & { apply: boolean }

export async function readPullRequestLabelEditor(context: LabelContext, search = '', staged: LabelChange[] = []) {
  const { path, repository, credential, signal } = context
  const [catalog, applied] = await Promise.all([
    search ? searchRepositoryLabels(context, search) : readLabels(path, 'repos/' + repository + '/labels', credential, signal, 2),
    readAppliedPullRequestLabels(context),
  ])
  if (!catalog || !applied) return null
  const options = new Map<string, LabelOption>(applied.map(label => [label.key, { ...label, applied: true, checked: true }]))
  for (const change of staged) {
    if (change.label) options.set(change.id, { ...change.label, applied: change.applied, checked: change.apply })
  }
  if (options.size > maxOptions) return null
  for (const label of catalog.labels) {
    if (options.size >= maxOptions) break
    if (!label.archived && !options.has(label.key)) options.set(label.key, { ...label, applied: false, checked: false })
  }
  const matchingKeys = new Set(search ? catalog.labels.map(label => label.key) : [])
  const labels = [...options.values()].sort((a, b) => Number(matchingKeys.has(b.key)) - Number(matchingKeys.has(a.key))
    || Number(b.applied) - Number(a.applied) || a.name.localeCompare(b.name))
  const scope = JSON.stringify(labels.map(({ key, applied, name, color, description, archived }) => [key, applied, name, color, description, archived]))
  return { labels, scope, search, matches: catalog.labels.length, more: catalog.more || options.size === maxOptions }
}

function reviewedLabels(scope: string) {
  if (scope.startsWith('[')) {
    if (scope.length > 950_000) return null
    let rows: unknown
    try { rows = JSON.parse(scope) }
    catch { return null }
    if (!Array.isArray(rows) || rows.length > maxOptions) return null
    const result = new Map<string, ReviewedLabel>()
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 6) return null
      const [key, applied, name, color, description, archived] = row
      if (!validNodeKey(key) || result.has(key) || typeof applied !== 'boolean' || !validLabelName(name)
        || typeof color !== 'string' || (color !== '' && !labelColor.test(color)) || typeof description !== 'string' || description.length > 512
        || typeof archived !== 'boolean' || (archived && !applied)) return null
      result.set(key, { id: key, applied, nameHash: nameHash(name), label: { key, name, color, description, archived } })
    }
    return result
  }
  // Preserve open forms and partially confirmed receipts created before catalog search was available.
  if (scope.length > 44_000) return null
  const result = new Map<string, ReviewedLabel>()
  for (const entry of scope.split(',')) {
    if (!/^[1-9]\d{0,15}:[01]:[0-9a-f]{24}$/u.test(entry) || result.size >= maxOptions) return null
    const [id, applied, hash] = entry.split(':') as [string, string, string]
    if (!Number.isSafeInteger(Number(id)) || result.has(id)) return null
    result.set(id, { id, applied: applied === '1', nameHash: hash })
  }
  return result
}

export function parseLabelSelection(scope: string, checked: string[]) {
  if (checked.length > maxOptions) return null
  const reviewed = reviewedLabels(scope)
  if (!reviewed) return null
  const selected = new Set(checked)
  if (selected.size !== checked.length || checked.some(id => !reviewed.has(id))) return null
  const legacy = !scope.startsWith('[')
  const choices = [...reviewed.values()]
  const byId = legacy ? (a: string, b: string) => Number(a) - Number(b) : (a: string, b: string) => a.localeCompare(b)
  return {
    checked: [...selected].sort(byId), legacy,
    labels: choices.flatMap(row => row.label ? [{ ...row.label, applied: row.applied, checked: selected.has(row.id) }] : []),
    changes: choices.filter(row => selected.has(row.id) !== row.applied)
      .map(row => ({ ...row, apply: selected.has(row.id) })).sort((a, b) => Number(b.apply) - Number(a.apply) || byId(a.id, b.id)),
  }
}

function labelsByIdentity(labels: PullRequestLabel[]) {
  const result = new Map<string, PullRequestLabel>()
  for (const label of labels) {
    result.set(label.key, label)
    if (label.id !== undefined) result.set(String(label.id), label)
  }
  return result
}

async function readLabelsForAddition(context: LabelContext, remaining: LabelChange[]) {
  const { path, repository, credential, signal } = context
  const endpoint = 'repos/' + repository + '/labels'
  const result = new Map<string, PullRequestLabel>()
  if (remaining.some(row => !row.label)) {
    const catalog = await readLabels(path, endpoint, credential, signal, 10)
    if (!catalog) return null
    for (const [key, label] of labelsByIdentity(catalog.labels)) result.set(key, label)
  }
  const named = remaining.flatMap(row => row.label ? [row.label] : [])
  for (let offset = 0; offset < named.length; offset += 4) {
    const found = await Promise.all(named.slice(offset, offset + 4).map(async (label) => {
      const response = await repositoryGitHubRequest(path, endpoint + '/' + encodeURIComponent(label.name), undefined, signal, credential)
      if (response.status === 404 || response.status === 410) return []
      const items = response.status === 200 && pullRequestLabels([response.body])
      if (!items) throw new RepositoryPullRequestError('Could not verify a reviewed label.')
      return items
    }))
    for (const [key, label] of labelsByIdentity(found.flat())) result.set(key, label)
  }
  return result
}

type LabelWriteContext = LabelContext & { receipts: PullRequestReplyReceipts, trusted: () => boolean }

export async function applyPullRequestLabelChanges(context: LabelWriteContext, changes: LabelChange[], token: string, fingerprint: string) {
  const { path, repository, number, credential, signal, receipts, trusted } = context
  const previous = receipts.inspect(token, fingerprint)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict') return 'changed'
  if (!changes.length) return 'updated'
  const readApplied = () => readAppliedPullRequestLabels(context)
  const targets = changes.map(change => {
    const key = createHash('sha256').update(JSON.stringify(['pr-label', token, change.label ? change.id : Number(change.id)])).digest('hex')
    return { ...change, key, receipt: receipts.inspect(key, fingerprint) }
  })
  if (targets.some(target => target.receipt === 'conflict')) return 'changed'
  const remaining = targets.filter(target => target.receipt !== 'confirmed')
  if (!remaining.length) {
    receipts.confirm(token, fingerprint)
    return 'updated'
  }
  const appliedStart = await readApplied().catch(() => null)
  if (!appliedStart) return previous ? 'pending' : 'unavailable'
  let applied = labelsByIdentity(appliedStart)
  const additions = remaining.filter(label => label.apply && !applied.has(label.id))
  const candidates = await readLabelsForAddition(context, additions).catch(() => null)
  if (!candidates) return previous ? 'pending' : 'unavailable'
  for (const target of remaining) {
    if (applied.has(target.id) === target.apply) continue
    const label = target.apply ? candidates.get(target.id) : applied.get(target.id)
    if (!label || nameHash(label.name) !== target.nameHash || (target.apply && label.archived)) return 'changed'
  }
  signal.throwIfAborted()
  const batch = receipts.claim(token, fingerprint, trusted())
  if (batch === 'confirmed') return 'confirmed'
  if (batch === 'conflict' || batch === 'denied') return 'changed'
  try {
    for (const target of remaining) {
      if (!trusted()) return 'changed'
      const inDesiredState = applied.has(target.id) === target.apply
      const claimed = receipts.claim(target.key, fingerprint, true)
      if (claimed === 'confirmed') continue
      if (claimed === 'conflict') return 'changed'
      if (inDesiredState) {
        receipts.confirm(target.key, fingerprint)
        continue
      }
      if (claimed !== 'claimed') return 'pending'
      const label = target.apply ? candidates.get(target.id) : applied.get(target.id)
      if (!label || nameHash(label.name) !== target.nameHash) {
        receipts.reject(target.key, fingerprint)
        return 'changed'
      }
      const write = await writePullRequestLabel(path, repository, number, label, target.apply, credential, signal)
        .catch((error: unknown) => error instanceof RepositoryPullRequestError && error.status ? { status: error.status } : null)
      if (write?.status === 401 || write?.status === 403) {
        receipts.reject(target.key, fingerprint)
        return 'denied'
      }
      const after = await readApplied()
      if (!after) return 'pending'
      applied = labelsByIdentity(after)
      if (applied.has(target.id) === target.apply) {
        receipts.confirm(target.key, fingerprint)
        continue
      }
      if (write?.status === 404 || write?.status === 410 || write?.status === 422) {
        receipts.reject(target.key, fingerprint)
        return 'refused'
      }
      return 'pending'
    }
    receipts.confirm(token, fingerprint)
    return 'updated'
  }
  catch { return 'pending' }
}
