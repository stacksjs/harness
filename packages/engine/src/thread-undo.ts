import type { CommandEnvelope, EventPayload, ThreadPlacement, ThreadUndoOffer, ThreadUndoRecord } from '@harness/contract'
import { threadPlacementKeys, threadUndoDuration } from '@harness/contract'
import type { HarnessState, ProfileState } from './projections'
import type { AppendableEvent } from './store'

interface ScopedRecord extends ThreadUndoRecord {
  invalidated?: boolean
}

export interface ThreadUndoStack {
  expiresAt: number
  records: ScopedRecord[]
}

type NavigationChange = Extract<EventPayload, { type: 'session.navigation-changed' }>

export function projectThreadUndo(profile: ProfileState, sessionId: number, at: number, payload: NavigationChange): void {
  const changedPlacement = threadPlacementKeys.filter(key => key in payload.changes)
  if (changedPlacement.length) profile.threadUndo = payload.undoScope ? undefined : payload.undo

  const update = payload.undoScope
  if (!changedPlacement.length && !update) return
  if (update && !profile.threadUndoStacks) profile.threadUndoStacks = new Map()
  const stacks = profile.threadUndoStacks
  if (!stacks) return

  for (const [key, stack] of stacks) {
    if (stack.expiresAt <= at) {
      stacks.delete(key)
      continue
    }
    if (key === update?.key) continue
    for (const record of stack.records) {
      if (changedPlacement.length && (record.sessionId === sessionId || record.entries.some(entry =>
        entry.sessionId === sessionId && changedPlacement.some(field => field in entry.after)))) record.invalidated = true
    }
  }
  if (!update) return

  const stack = stacks.get(update.key)
  const added = payload.undo
  if (added) {
    // A later placement on the same thread supersedes its earlier claim.
    const records = stack?.records.filter(record => record.sessionId !== added.sessionId) ?? []
    stacks.set(update.key, { expiresAt: added.expiresAt, records: [...records, { ...added }] })
  }
  else if (stack && update.consumed) {
    const consumed = new Set(update.consumed)
    stack.records = stack.records.filter(record => !consumed.has(record.sourceCommandId))
    if (!stack.records.length) stacks.delete(update.key)
  }
}

function latestGroup(stack: ThreadUndoStack | undefined, at: number): ScopedRecord[] {
  const latest = stack?.records.at(-1)
  if (!stack || !latest || stack.expiresAt <= at) return []

  const group: ScopedRecord[] = []
  for (let index = stack.records.length - 1; index >= 0; index--) {
    const record = stack.records[index]!
    if (record.action !== latest.action || record.batch !== latest.batch) break
    group.push(record)
  }
  return group
}

export function threadUndoOffer(profile: ProfileState | undefined, key: string, at: number): ThreadUndoOffer | undefined {
  const stack = profile?.threadUndoStacks?.get(key)
  const group = latestGroup(stack, at)
  const head = group[0]
  if (!head || !stack) return undefined
  const count = group.filter(record => !record.invalidated).length
  if (!count) return undefined
  const { sourceCommandId, sessionId, action } = head
  return { sourceCommandId, sessionId, action, count, remainingMs: stack.expiresAt - at, ageMs: Math.max(0, at - (head.expiresAt - threadUndoDuration)) }
}

export function restoreThreadUndoGroup(
  state: HarnessState,
  profileId: number | undefined,
  key: string,
  sessionId: number,
  sourceCommandId: string,
  envelope: CommandEnvelope,
): AppendableEvent[] {
  if (profileId === undefined) return []
  const group = latestGroup(state.profiles.get(profileId)?.threadUndoStacks?.get(key), envelope.at)
  if (!group.some(record => record.sessionId === sessionId && record.sourceCommandId === sourceCommandId)) return []

  let changes = new Map<number, ThreadPlacement>()
  const restored: number[] = []
  // A drag can renumber peers. Reversing the newest operation first lets an
  // older inverse see the exact ranks that were present when it was recorded.
  for (const record of group) {
    if (record.invalidated || record.entries.some(entry => {
      const session = state.sessions.get(entry.sessionId)
      const navigation = { ...session?.navigation, ...changes.get(entry.sessionId) }
      return !session || state.workspaces.get(session.workspaceId)?.profileId !== profileId
        || threadPlacementKeys.some(field => field in entry.after && (navigation[field] ?? null) !== entry.after[field])
    })) continue

    const next = new Map(changes)
    for (const entry of record.entries) {
      const before = { ...entry.before }
      if (before.snoozedUntil != null && before.snoozedUntil <= envelope.at) before.snoozedUntil = null
      next.set(entry.sessionId, { ...next.get(entry.sessionId), ...before })
    }
    if (record.entries.some(entry => rankOccupied(state, entry.sessionId, next))) continue
    changes = next
    restored.push(record.sessionId)
  }

  const events: AppendableEvent[] = [...changes].map(([id, fields]) => ({
    sessionId: id, commandId: envelope.id, at: envelope.at,
    payload: { type: 'session.navigation-changed', changes: fields, undoScope: { key } },
  }))
  const update = {
    key,
    consumed: group.map(record => record.sourceCommandId),
    result: {
      restored: restored.length, skipped: group.length - restored.length,
      ...(restored[0] === undefined ? {} : { sessionId: restored[0] }),
    },
  }
  const last = events.at(-1)?.payload
  if (last?.type === 'session.navigation-changed') last.undoScope = update
  else events.push({
    sessionId, commandId: envelope.id, at: envelope.at,
    payload: { type: 'session.navigation-changed', changes: {}, undoScope: update },
  })
  return events
}

function rankOccupied(state: HarnessState, sessionId: number, changes: Map<number, ThreadPlacement>): boolean {
  const workspace = state.workspaces.get(state.sessions.get(sessionId)!.workspaceId)!
  const changed = changes.get(sessionId)
  return [...state.sessions.values()].some(peer => {
    if (peer.id === sessionId) return false
    const group = state.workspaces.get(peer.workspaceId)
    if (group?.profileId !== workspace.profileId) return false
    const navigation = { ...peer.navigation, ...changes.get(peer.id) }
    if (changed?.pinnedOrder != null && navigation.pinnedOrder === changed.pinnedOrder) return true
    const sameProject = workspace.scratch ? group.scratch : group.id === workspace.id
    return sameProject && peer.state !== 'stopped' && !navigation.settledAt
      && changed?.activeOrder != null && navigation.activeOrder === changed.activeOrder
  })
}
