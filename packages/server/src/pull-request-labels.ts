import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

export type PullRequestLabel = { id: number, name: string, color: string, description: string, archived: boolean }
type GitHubLabel = { id?: number, name?: string, color?: string, description?: string | null, archived_at?: string | null }
type ReviewedLabel = { id: number, applied: boolean, nameHash: string }

function nameHash(name: string) {
  return createHash('sha256').update(name).digest('hex').slice(0, 24)
}

export function pullRequestLabels(value: unknown): PullRequestLabel[] | null {
  if (!Array.isArray(value)) return null
  const labels = new Map<number, PullRequestLabel>()
  for (const item of value as (GitHubLabel | null)[]) {
    if (!item || typeof item.id !== 'number' || !Number.isSafeInteger(item.id) || item.id <= 0
      || typeof item.name !== 'string' || !item.name || item.name.length > 256 || /\p{Cc}/u.test(item.name)
      || labels.has(item.id)) return null
    const color = typeof item.color === 'string' && /^[a-f0-9]{6}$/iu.test(item.color) ? '#' + item.color : ''
    labels.set(item.id, { id: item.id, name: item.name, color, description: typeof item.description === 'string' ? item.description.slice(0, 512) : '',
      archived: typeof item.archived_at === 'string' && Boolean(item.archived_at) })
  }
  return [...labels.values()]
}

async function readLabels(path: string, endpoint: string, credential: string, signal: AbortSignal) {
  const labels = new Map<number, PullRequestLabel>()
  for (let page = 1; page <= 10; page++) {
    const response = await repositoryGitHubRequest(path, endpoint + '?per_page=100&page=' + page, undefined, signal, credential)
    const items = response.status === 200 ? pullRequestLabels(response.body) : null
    if (!items) return null
    for (const item of items) {
      if (labels.has(item.id)) return null
      labels.set(item.id, item)
    }
    if (!response.hasNextPage) return [...labels.values()]
  }
  return null
}

function readRepositoryPullRequestLabelCatalog(path: string, repository: string, credential: string, signal: AbortSignal) {
  return readLabels(path, 'repos/' + repository + '/labels', credential, signal)
}

function readAppliedPullRequestLabels(path: string, repository: string, number: number, credential: string, signal: AbortSignal) {
  return readLabels(path, 'repos/' + repository + '/issues/' + number + '/labels', credential, signal)
}

function writePullRequestLabel(path: string, repository: string, number: number, label: PullRequestLabel, apply: boolean,
  credential: string, signal: AbortSignal) {
  const endpoint = 'repos/' + repository + '/issues/' + number + '/labels'
  return apply
    ? repositoryGitHubRequest(path, endpoint, { labels: [label.name] }, signal, credential)
    : repositoryGitHubRequest(path, endpoint + '/' + encodeURIComponent(label.name), undefined, signal, credential, 'DELETE')
}

type LabelContext = { path: string, repository: string, number: number, credential: string, signal: AbortSignal }

export async function readPullRequestLabelEditor({ path, repository, number, credential, signal }: LabelContext) {
  const [catalog, applied] = await Promise.all([
    readRepositoryPullRequestLabelCatalog(path, repository, credential, signal),
    readAppliedPullRequestLabels(path, repository, number, credential, signal),
  ])
  if (!catalog || !applied) return null
  const appliedIds = new Set(applied.map(label => label.id))
  const options = new Map(applied.map(label => [label.id, label]))
  for (const label of catalog) {
    if (!label.archived || appliedIds.has(label.id)) options.set(label.id, label)
  }
  if (options.size > 1_000) return null
  const labels = [...options.values()].map(label => ({ ...label, applied: appliedIds.has(label.id) }))
  const scope = labels.map(label => label.id + ':' + Number(label.applied) + ':' + nameHash(label.name)).join(',')
  labels.sort((a, b) => Number(b.applied) - Number(a.applied) || a.name.localeCompare(b.name))
  return { labels, scope }
}

export function parseLabelSelection(scope: string, checked: string[]) {
  if (scope.length > 44_000 || checked.length > 1_000) return null
  const reviewed = new Map<number, ReviewedLabel>()
  for (const entry of scope.split(',')) {
    if (!/^[1-9]\d{0,15}:[01]:[0-9a-f]{24}$/u.test(entry) || reviewed.size >= 1_000) return null
    const [idText, applied, hash] = entry.split(':') as [string, string, string]
    const id = Number(idText)
    if (!Number.isSafeInteger(id) || reviewed.has(id)) return null
    reviewed.set(id, { id, applied: applied === '1', nameHash: hash })
  }
  const selected = new Set<number>()
  for (const value of checked) {
    const id = Number(value)
    if (String(id) !== value || !reviewed.has(id) || selected.has(id)) return null
    selected.add(id)
  }
  return {
    checked: [...selected].sort((a, b) => a - b).map(String),
    changes: [...reviewed.values()].filter(label => selected.has(label.id) !== label.applied)
      .map(label => ({ ...label, apply: selected.has(label.id) })).sort((a, b) => Number(b.apply) - Number(a.apply) || a.id - b.id),
  }
}

type LabelChange = ReviewedLabel & { apply: boolean }
type LabelWriteContext = LabelContext & { receipts: PullRequestReplyReceipts, trusted: () => boolean }

export async function applyPullRequestLabelChanges(context: LabelWriteContext, changes: LabelChange[], token: string, fingerprint: string) {
  const { path, repository, number, credential, signal, receipts, trusted } = context
  const previous = receipts.inspect(token, fingerprint)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict') return 'changed'
  if (!changes.length) return 'updated'
  const readApplied = () => readAppliedPullRequestLabels(path, repository, number, credential, signal)
  const targets = changes.map(change => {
    const key = createHash('sha256').update(JSON.stringify(['pr-label', token, change.id])).digest('hex')
    return { ...change, key, receipt: receipts.inspect(key, fingerprint) }
  })
  if (targets.some(target => target.receipt === 'conflict')) return 'changed'
  const remaining = targets.filter(target => target.receipt !== 'confirmed')
  if (!remaining.length) {
    receipts.confirm(token, fingerprint)
    return 'updated'
  }
  const [appliedStart, catalog] = await Promise.all([
    readApplied(),
    remaining.some(label => label.apply) ? readRepositoryPullRequestLabelCatalog(path, repository, credential, signal) : [],
  ]).catch(() => [null, null] as const)
  if (!appliedStart || !catalog) return previous ? 'pending' : 'unavailable'

  const candidates = new Map(catalog.map(label => [label.id, label]))
  let applied = new Map(appliedStart.map(label => [label.id, label]))
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
      applied = new Map(after.map(item => [item.id, item]))
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
