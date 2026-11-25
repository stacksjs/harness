import { claudeCompactionReturnAt } from '@harness/contract'
import type { HarnessState, SessionState } from './projections'
import { providerConversation } from './projections'

export function effectiveClaudeCompaction(state: HarnessState, session: SessionState) {
  const profileId = state.workspaces.get(session.workspaceId)?.profileId
  const account = profileId === undefined || session.providerInstanceId === undefined
    ? undefined
    : state.profiles.get(profileId)?.claudeCompactionByAccount?.[session.providerInstanceId]
  return {
    idleCompaction: account?.idleCompaction ?? state.settings.claudeIdleCompaction,
    autoCompactAfter: account?.autoCompactAfter === 'default' ? undefined
      : account?.autoCompactAfter ?? state.settings.claudeAutoCompactAfter ?? undefined,
  }
}

const cacheLeadMs = 2 * 60_000

/** Only the latest confirmed, idle Claude conversation is eligible. */
export function claudeIdleCompaction(session: SessionState, now: number) {
  const last = session.turns.at(-1)
  if (session.driverKind !== 'claude' || session.state !== 'idle' || !session.providerSessionId
    || session.handoff?.pending || (session.fork && session.fork.state !== 'ready')
    || session.navigation?.archivedAt || session.navigation?.settledAt || (session.navigation?.snoozedUntil ?? 0) > now
    || last?.status !== 'complete' || last.compaction || session.followUps.entries.length
    || session.pendingApprovals.length || session.pendingInputs.length) return undefined

  const conversation = providerConversation(session)
  const context = conversation?.context
  if (conversation?.providerSessionId !== session.providerSessionId || conversation.throughTurnId !== last.id
    || !context || context.model !== session.model) return undefined
  const availableAt = claudeCompactionReturnAt(context.usage, context.reportedAt)
  if (availableAt === undefined) return undefined

  const expiresAt = context.usage.promptCacheExpiresAt
  const knownExpiry = typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt) && expiresAt > 0
  return {
    afterTurnId: last.id,
    usedTokens: context.usage.usedTokens,
    availableAt,
    ...(knownExpiry ? { startsAt: expiresAt - cacheLeadMs, expiresAt } : {}),
  }
}
