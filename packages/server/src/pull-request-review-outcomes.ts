import { repositoryGitHubRequest } from './repository-pull-request'

const sha = /^[0-9a-f]{40}$/iu
const login = /^[\w-]{1,100}(?:\[bot\])?$/u
const verdicts = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', DISMISSED: 'Dismissed' } as const
const decisions = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' } as const

type Verdict = keyof typeof verdicts
export type PendingReviewer = { name: string, team: boolean }
type SubmittedReview = { id: number, actor: string | null, at: number, state: Verdict, commit: string | null }
export type ReviewOutcome = { name: string, state: 'approved' | 'changes-requested', label: string, commit: string }

export function pullRequestReviewDecision(value: unknown) {
  return typeof value === 'string' && Object.hasOwn(decisions, value) ? decisions[value as keyof typeof decisions] : ''
}

function submittedReview(value: unknown): SubmittedReview | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as { id?: number, state?: string, user?: { login?: string } | null, submitted_at?: string, commit_id?: string | null }
  const state = typeof raw.state === 'string' ? raw.state.toUpperCase() : ''
  if (!state || !Object.hasOwn(verdicts, state) || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null
  const at = typeof raw.submitted_at === 'string' ? Date.parse(raw.submitted_at) : NaN
  if (!Number.isFinite(at)) return null
  const actor = typeof raw.user?.login === 'string' && login.test(raw.user.login) ? raw.user.login : null
  const commit = typeof raw.commit_id === 'string' && sha.test(raw.commit_id) ? raw.commit_id.toLowerCase() : null
  return { id: raw.id, actor, at, state: state as Verdict, commit }
}

export async function readPullRequestReviewOutcomes(path: string, repository: string, number: number, head: string, signal: AbortSignal, credential?: string) {
  const latest = new Map<string, SubmittedReview>()
  const endpoint = `repos/${repository}/pulls/${number}/reviews?per_page=100&page=`
  for (let page = 1; page <= 10; page++) {
    const response = await repositoryGitHubRequest(path, endpoint + page, undefined, signal, credential)
    if (response.status !== 200 || !Array.isArray(response.body)) return null
    for (const raw of response.body) {
      const review = submittedReview(raw)
      if (!review) continue
      const key = review.actor?.toLowerCase() ?? `deleted:${review.id}`
      const previous = latest.get(key)
      if (!previous || review.at > previous.at || (review.at === previous.at && review.id > previous.id)) latest.set(key, review)
    }
    if (!response.hasNextPage) {
      const currentHead = sha.test(head) ? head.toLowerCase() : null
      const outcomes: ReviewOutcome[] = []
      for (const review of latest.values()) {
        if (review.state === 'DISMISSED') continue
        const stale = review.commit && currentHead && review.commit !== currentHead
        const state = review.state === 'APPROVED' ? 'approved' : 'changes-requested'
        const label = verdicts[review.state] + (stale ? ' on an earlier commit' : !review.commit || !currentHead ? ' · Commit unavailable' : '')
        outcomes.push({ name: review.actor ? '@' + review.actor : 'Unknown reviewer', state, label, commit: review.commit ?? '' })
      }
      return { outcomes, truncated: false }
    }
  }
  // The API lists reviews oldest first. An unseen page can replace or dismiss an earlier verdict.
  return { outcomes: [], truncated: true }
}

type ReviewParticipation = { name: string, label: 'Commented' | 'Review dismissed' | 'Reviewed' }

export function pullRequestReviewParticipation(value: unknown): ReviewParticipation[] {
  if (!Array.isArray(value)) return []
  const participants = new Map<string, ReviewParticipation>()
  for (const raw of value as ({ state?: string, isMinimized?: boolean, author?: { login?: string, __typename?: string } } | null)[]) {
    const actor = raw?.author?.login
    if (!raw || raw.isMinimized || typeof actor !== 'string' || !login.test(actor) || raw.state === 'PENDING') continue
    const name = '@' + actor + (raw.author?.__typename === 'Bot' && !actor.endsWith('[bot]') ? '[bot]' : '')
    participants.set(name.toLowerCase(), { name, label: raw.state === 'COMMENTED' ? 'Commented' : raw.state === 'DISMISSED' ? 'Review dismissed' : 'Reviewed' })
  }
  return [...participants.values()]
}

export function mergePullRequestReviewers(pending: PendingReviewer[], submitted: ReviewParticipation[], outcomes: ReviewOutcome[]) {
  const remaining = new Map(outcomes.filter(row => row.name.startsWith('@')).map(row => [row.name.toLowerCase(), row]))
  const participation = new Map(submitted.map(row => [row.name.toLowerCase(), row]))
  const rows = pending.map((row) => {
    const key = row.name.toLowerCase()
    const outcome = row.team ? undefined : remaining.get(key)
    const participationLabel = row.team ? undefined : participation.get(key)?.label
    if (outcome) remaining.delete(key)
    if (participationLabel) participation.delete(key)
    return { ...row, outcome, submitted: participationLabel, requested: true }
  })
  for (const [key, review] of participation) {
    rows.push({ name: review.name, team: false, outcome: remaining.get(key), submitted: review.label, requested: false })
    remaining.delete(key)
  }
  for (const outcome of outcomes) {
    if (!outcome.name.startsWith('@') || remaining.has(outcome.name.toLowerCase()))
      rows.push({ name: outcome.name, team: false, outcome, submitted: undefined, requested: false })
  }
  return rows
}
