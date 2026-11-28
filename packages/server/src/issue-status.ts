import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const reasons = { COMPLETED: 'completed', NOT_PLANNED: 'not_planned', DUPLICATE: 'duplicate' } as const
type Reason = typeof reasons[keyof typeof reasons]
type State = 'open' | 'closed'
type Destination = { key: string, name: string, state: State, reason: Reason | null, statusId?: string }
type PlanningStatus = { id?: unknown, name?: unknown, category?: { state?: unknown, stateReason?: unknown } }
export type RawIssueStatus = {
  state?: unknown
  stateReason?: unknown
  viewerCanClose?: unknown
  viewerCanReopen?: unknown
  viewerCanSetStatus?: unknown
  status?: PlanningStatus | null
}
export type RawPlanningStatuses = { nodes?: (PlanningStatus | null)[], pageInfo?: { hasNextPage?: boolean } }

const classic: Destination[] = [
  { key: 'open', name: 'Open', state: 'open', reason: null },
  { key: 'completed', name: 'Completed', state: 'closed', reason: 'completed' },
  { key: 'not_planned', name: 'Not planned', state: 'closed', reason: 'not_planned' },
  { key: 'duplicate', name: 'Duplicate', state: 'closed', reason: 'duplicate' },
]

function stateValue(value: unknown): State | null {
  return value === 'OPEN' ? 'open' : value === 'CLOSED' ? 'closed' : null
}

function reasonValue(value: unknown): Reason | null {
  return typeof value === 'string' && Object.hasOwn(reasons, value) ? reasons[value as keyof typeof reasons] : null
}

function destination(status: PlanningStatus | null): Destination | null {
  const state = stateValue(status?.category?.state)
  if (!state || typeof status?.id !== 'string' || !/^[A-Za-z0-9_+\/=:.-]{1,256}$/u.test(status.id)
    || typeof status.name !== 'string' || !status.name.trim()) return null
  const reason = state === 'closed' ? reasonValue(status.category?.stateReason) : null
  if (state === 'closed' && !reason) return null
  return { key: status.id, name: status.name.trim().slice(0, 160), state, reason, statusId: status.id }
}

export function issueStatusPlan(issue: RawIssueStatus, planning: RawPlanningStatuses | undefined, active: boolean) {
  const state = stateValue(issue.state)
  if (!state) return null
  const reason = state === 'closed' ? reasonValue(issue.stateReason) : null
  const known = Array.isArray(planning?.nodes) ? planning.nodes.map(destination) : []
  const selected = issue.status ? destination(issue.status) : null
  const canTransition = (state === 'closed' ? issue.viewerCanReopen : issue.viewerCanClose) === true
  const planningValid = planning === undefined || (Array.isArray(planning.nodes)
    && planning.pageInfo?.hasNextPage === false && known.every(Boolean))
  const usesStatuses = known.length > 0
  const all = usesStatuses ? known.filter(item => item !== null) : classic
  const current = selected?.name ?? (state === 'open' ? 'Open' : classic.find(item => item.reason === reason && item.state === state)?.name ?? 'Closed')
  const allowed = active && planningValid && (!usesStatuses && !selected ? canTransition : issue.viewerCanSetStatus === true)
  const matches = (target: Destination) => state === target.state && reason === target.reason
    && (!target.statusId || target.statusId === selected?.statusId)
  const choices = allowed ? all.filter(target => {
    if (matches(target)) return false
    // The classic API only applies a close reason when the issue changes state.
    if (!usesStatuses || target.reason === 'duplicate') return target.state !== state && canTransition
    return true
  }) : []
  const scope = JSON.stringify([state, reason, selected?.statusId ?? null, choices])
  return { current, choices, all, matches, scope, allowed }
}

export type IssueStatusPlan = NonNullable<ReturnType<typeof issueStatusPlan>>
type Context = { path: string, name: string, number: number, issueId: string, credential: string, signal: AbortSignal }
type Result = 'updated' | 'confirmed' | 'pending' | 'changed' | 'denied' | 'refused'

const openAndClosed: Destination[] = [
  { key: 'open', name: 'Open', state: 'open', reason: null },
  { key: 'closed', name: 'Closed', state: 'closed', reason: null },
]

export function gitLabIssueStatusPlan(state: unknown, allowed: boolean): IssueStatusPlan | null {
  const current = openAndClosed.find(choice => state === (choice.state === 'open' ? 'opened' : 'closed'))
  if (!current) return null
  const choices = allowed ? openAndClosed.filter(choice => choice !== current) : []
  return { current: current.name, choices, all: openAndClosed, matches: target => current.state === target.state,
    scope: JSON.stringify([current.state, choices]), allowed }
}

export async function writeGitHubIssueStatus(context: Context, chosen: Destination, intent: string) {
  const { path, name, number, issueId, credential, signal } = context
  const reply = await (chosen.statusId && chosen.reason !== 'duplicate'
    ? repositoryGitHubRequest(path, 'graphql', {
        query: `mutation HarnessIssueStatus($input: SetIssueStatusInput!) {
          setIssueStatus(input: $input) { clientMutationId }
        }`, variables: { input: { issueId, statusId: chosen.statusId, clientMutationId: intent } },
      }, signal, credential)
    : repositoryGitHubRequest(path, `repos/${name}/issues/${number}`, {
        state: chosen.state, ...(chosen.reason && { state_reason: chosen.reason }),
      }, signal, credential, 'PATCH'))
    .catch((error: unknown) => error instanceof RepositoryPullRequestError && error.status ? { status: error.status, body: null } : null)
  if (reply?.status === 401 || reply?.status === 403) return 'denied' as const
  const errors = (reply?.body as { errors?: unknown[] } | null)?.errors
  if (reply?.status === 404 || reply?.status === 422 || errors?.length) return 'refused' as const
  return null
}

export async function saveIssueStatus(plan: IssueStatusPlan, target: string, scope: string, intent: string, fingerprint: string,
  receipts: PullRequestReplyReceipts, trusted: () => boolean, readUpdated: () => Promise<IssueStatusPlan | null>,
  write: (choice: Destination) => Promise<'denied' | 'refused' | null>): Promise<Result> {
  const previous = receipts.inspect(intent, fingerprint)
  if (previous === 'confirmed') return 'confirmed'
  if (previous === 'conflict' || !trusted()) return 'changed'
  if (previous === 'pending') {
    const applied = plan.all.find(choice => choice.key === target)
    if (!applied || !plan.matches(applied)) return 'pending'
    receipts.confirm(intent, fingerprint)
    return 'confirmed'
  }
  if (!plan.allowed) return 'denied'
  const chosen = plan.choices.find(choice => choice.key === target)
  if (plan.scope !== scope) return 'changed'
  if (!chosen) return 'denied'
  const claimed = receipts.claim(intent, fingerprint, trusted())
  if (claimed !== 'claimed') return claimed === 'conflict' ? 'changed' : claimed
  try {
    const result = await write(chosen)
    if (result === 'denied') {
      receipts.reject(intent, fingerprint)
      return 'denied'
    }
    const updated = await readUpdated()
    if (trusted() && updated?.matches(chosen)) {
      receipts.confirm(intent, fingerprint)
      return 'updated'
    }
    if (result === 'refused') {
      receipts.reject(intent, fingerprint)
      return 'refused'
    }
    return 'pending'
  }
  catch { return 'pending' }
}
