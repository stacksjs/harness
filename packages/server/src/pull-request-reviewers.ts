import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { RepositoryPullRequestError, repositoryGitHubRequest } from './repository-pull-request'

type Candidate = { id: string, kind: 'user' | 'team' | 'bot', login: string, name: string, requested: boolean }
type ReviewerChange = Candidate & { request: boolean }
type ReviewerContext = { path: string, repository: string, number: number, pullId: string, credential: string, signal: AbortSignal }
type GitHubReviewer = { id?: unknown, __typename?: unknown, login?: unknown, name?: unknown, slug?: unknown }

const identity = /^[A-Za-z0-9_=/+:-]{1,128}$/u
const userLogin = /^[\w-]{1,100}(?:\[bot\])?$/u
const teamSlug = /^[\w-]{1,100}$/u
const maxOptions = 500

function candidate(value: GitHubReviewer | null, requested: boolean): Candidate | null {
  if (!value || typeof value.id !== 'string' || !identity.test(value.id)) return null
  const kind = value.__typename === 'Team' ? 'team' : value.__typename === 'User' ? 'user' : value.__typename === 'Bot' ? 'bot' : null
  const login = kind === 'team' ? value.slug : value.login
  if (!kind || typeof login !== 'string' || !(kind === 'team' ? teamSlug : userLogin).test(login)) return null
  const name = typeof value.name === 'string' ? value.name.slice(0, 160).replace(/\p{Cc}/gu, '') : ''
  return { id: value.id, kind, login, name, requested }
}

async function readReviewerCandidates({ path, repository, number, pullId, credential, signal }: ReviewerContext, search?: string) {
  const [owner, name] = repository.split('/')
  const includePeople = search !== undefined
  const response = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessReviewerCandidates($owner: String!, $name: String!, $number: Int!${includePeople ? ', $search: String' : ''}) {
      repository(owner: $owner, name: $name) {
        ${includePeople ? 'assignableUsers(first: 100, query: $search) { pageInfo { hasNextPage } nodes { __typename id login name } }' : ''}
        pullRequest(number: $number) {
          id author { login }
          reviewRequests(first: 100) {
            pageInfo { hasNextPage }
            nodes { requestedReviewer { __typename
              ... on User { id login name }
              ... on Team { id slug name }
              ... on Bot { id login }
            } }
          }
        }
      }
    }`,
    variables: { owner, name, number, ...(includePeople && { search: search || null }) },
  }, signal, credential)
  const result = response.body as { errors?: unknown[], data?: { repository?: {
    assignableUsers?: { nodes?: GitHubReviewer[], pageInfo?: { hasNextPage?: boolean } }
    pullRequest?: { id?: string, author?: { login?: string }, reviewRequests?: {
      nodes?: { requestedReviewer?: GitHubReviewer | null }[], pageInfo?: { hasNextPage?: boolean }
    } }
  } } } | null
  const repo = result?.data?.repository
  const pull = repo?.pullRequest
  if (response.status !== 200 || result?.errors?.length || pull?.id !== pullId
    || !Array.isArray(pull.reviewRequests?.nodes) || pull.reviewRequests.pageInfo?.hasNextPage !== false
    || (includePeople && !Array.isArray(repo?.assignableUsers?.nodes))) return null
  const requested = new Map<string, Candidate>()
  for (const node of pull.reviewRequests.nodes) {
    const raw = node?.requestedReviewer
    if (!raw || (raw.__typename !== 'User' && raw.__typename !== 'Bot' && raw.__typename !== 'Team')) continue
    const reviewer = candidate(raw, true)
    if (!reviewer) return null
    requested.set(reviewer.id, reviewer)
  }
  const people = new Map<string, Candidate>()
  for (const raw of repo?.assignableUsers?.nodes ?? []) {
    const reviewer = candidate(raw, false)
    if (reviewer?.kind === 'user' && reviewer.login.toLowerCase() !== pull.author?.login?.toLowerCase()) people.set(reviewer.id, reviewer)
  }
  return { requested, people, more: repo?.assignableUsers?.pageInfo?.hasNextPage === true, author: pull.author?.login?.toLowerCase() }
}

export function reviewerOptions(rows: Candidate[], repository: string, selected: ReadonlySet<string>) {
  const [owner] = repository.split('/')
  return rows.map(row => ({ ...row, display: row.kind === 'team' ? '@' + owner + '/' + row.login : '@' + row.login, checked: selected.has(row.id) }))
}

export async function readPullRequestReviewerEditor(context: ReviewerContext, search: string, staged: ReviewerChange[] = []) {
  const found = await readReviewerCandidates(context, search)
  if (!found) return null
  const options = new Map(found.requested)
  for (const row of staged) options.set(row.id, row)
  if (options.size >= maxOptions) return null
  for (const row of found.people.values()) {
    if (options.size >= maxOptions) break
    if (!options.has(row.id)) options.set(row.id, row)
  }
  const choices = [...options.values()].sort((a, b) => Number(b.requested) - Number(a.requested) || a.login.localeCompare(b.login))
  const scope = JSON.stringify(choices.map(({ id, kind, login, name, requested }) => [id, kind, login, name, requested]))
  const stagedById = new Map(staged.map(row => [row.id, row.request]))
  const selected = new Set(choices.filter(row => stagedById.get(row.id) ?? row.requested).map(row => row.id))
  return { scope, search, more: found.more || options.size === maxOptions, matches: found.people.size, options: reviewerOptions(choices, context.repository, selected) }
}

export function parseReviewerSelection(scope: string, checked: string[]) {
  if (scope.length > 210_000 || checked.length > maxOptions) return null
  let entries: unknown
  try { entries = JSON.parse(scope) }
  catch { return null }
  if (!Array.isArray(entries) || entries.length > maxOptions) return null
  const rows = new Map<string, Candidate>()
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 5) return null
    const [id, kind, login, name, requested] = entry
    if (typeof id !== 'string' || !identity.test(id) || rows.has(id) || !['user', 'team', 'bot'].includes(kind)
      || typeof login !== 'string' || !(kind === 'team' ? teamSlug : userLogin).test(login)
      || typeof name !== 'string' || name.length > 160 || /\p{Cc}/u.test(name) || typeof requested !== 'boolean') return null
    if (!requested && kind !== 'user') return null
    rows.set(id, { id, kind, login, name, requested })
  }
  const selected = new Set(checked)
  if (selected.size !== checked.length || checked.some(id => !rows.has(id))) return null
  const changes = [...rows.values()].filter(row => selected.has(row.id) !== row.requested)
    .map(row => ({ ...row, request: selected.has(row.id) })).sort((a, b) => Number(a.request) - Number(b.request) || a.id.localeCompare(b.id))
  return { checked: [...selected].sort(), changes, rows: [...rows.values()] }
}

async function readReviewerIdentities(context: ReviewerContext, ids: string[]) {
  const people = new Map<string, Candidate>()
  for (let offset = 0; offset < ids.length; offset += 50) {
    const response = await repositoryGitHubRequest(context.path, 'graphql', {
      query: `query HarnessReviewerIdentities($ids: [ID!]!) {
        nodes(ids: $ids) { __typename ... on User { id login } }
      }`, variables: { ids: ids.slice(offset, offset + 50) },
    }, context.signal, context.credential)
    const body = response.body as { errors?: unknown[], data?: { nodes?: (GitHubReviewer | null)[] } } | null
    if (response.status !== 200 || body?.errors?.length || !Array.isArray(body?.data?.nodes)) return null
    for (const raw of body.data.nodes) {
      const row = candidate(raw, false)
      if (row?.kind === 'user') people.set(row.id, row)
    }
  }
  return people
}

export async function applyPullRequestReviewerChanges(context: ReviewerContext & { receipts: PullRequestReplyReceipts, trusted: () => boolean },
  changes: ReviewerChange[], token: string, fingerprint: string) {
  const { path, repository, number, credential, signal, receipts, trusted } = context
  const previous = receipts.inspect(token, fingerprint)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict') return 'changed'
  if (!changes.length) return 'updated'
  const targets = changes.map(row => ({ ...row, key: createHash('sha256').update(JSON.stringify(['pr-reviewer', token, row.id])).digest('hex') }))
  const remaining = targets.filter(row => receipts.inspect(row.key, fingerprint) !== 'confirmed')
  if (!remaining.length) {
    receipts.confirm(token, fingerprint)
    return 'updated'
  }
  const [current, identities] = await Promise.all([
    readReviewerCandidates(context),
    readReviewerIdentities(context, remaining.filter(row => row.request).map(row => row.id)),
  ]).catch(() => [null, null] as const)
  if (!current || !identities) return previous ? 'pending' : 'unavailable'
  const applied = current.requested
  for (const row of remaining) {
    if (applied.has(row.id) === row.request) continue
    const live = row.request ? identities.get(row.id) : applied.get(row.id)
    if (!live || live.kind !== row.kind || live.login.toLowerCase() !== row.login.toLowerCase()
      || (row.request && live.login.toLowerCase() === current.author)) return 'changed'
  }
  signal.throwIfAborted()
  const batch = receipts.claim(token, fingerprint, trusted())
  if (batch === 'confirmed') return 'confirmed'
  if (batch === 'conflict' || batch === 'denied') return 'changed'
  try {
    for (const row of remaining) {
      if (!trusted()) return 'changed'
      const claim = receipts.claim(row.key, fingerprint, true)
      if (claim === 'confirmed') continue
      if (claim === 'conflict') return 'changed'
      if (applied.has(row.id) === row.request) {
        receipts.confirm(row.key, fingerprint)
        continue
      }
      if (claim !== 'claimed') return 'pending'
      const endpoint = `repos/${repository}/pulls/${number}/requested_reviewers`
      const slug = (row.request ? identities : applied).get(row.id)!.login
      const body = row.kind === 'team' ? { team_reviewers: [slug] } : { reviewers: [slug] }
      const reply = await repositoryGitHubRequest(path, endpoint, body, signal, credential, row.request ? 'POST' : 'DELETE')
        .catch((error: unknown) => error instanceof RepositoryPullRequestError && error.status ? { status: error.status } : null)
      if (reply && [200, 201, 204].includes(reply.status)) {
        receipts.confirm(row.key, fingerprint)
        continue
      }
      if (reply && [401, 403, 404, 410, 422].includes(reply.status)) {
        receipts.reject(row.key, fingerprint)
        return reply.status === 401 || reply.status === 403 ? 'denied' : 'refused'
      }
      const after = await readReviewerCandidates(context)
      if (after && after.requested.has(row.id) === row.request) {
        receipts.confirm(row.key, fingerprint)
        continue
      }
      return 'pending'
    }
    receipts.confirm(token, fingerprint)
    return 'updated'
  }
  catch { return 'pending' }
}
