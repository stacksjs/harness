export interface ThreadNavigation {
  title?: string
  pinnedOrder?: number | null
  activeOrder?: number | null
  settledAt?: number | null
  settledAutomatically?: boolean
  autoSettle?: 'never' | null
  archivedAt?: number | null
  snoozedUntil?: number | null
}

export type ThreadDrop = {
  destination: 'pinned' | 'active' | 'settled'
  anchor?: { sessionId: number, placement: 'before' | 'after' }
}

export type ThreadOrganizationAction =
  | { action: 'rename', title: string }
  | { action: 'snooze', until: number }
  | { action: 'auto-settle', mode: 'never' | 'follow-settings' }
  | { action: 'move-pin', direction: 'up' | 'down' }
  | { action: 'reorder-pin', targetSessionId: number, placement: 'before' | 'after' }
  | ({ action: 'drop' } & ThreadDrop)
  | { action: 'undo', sourceCommandId: string }
  | { action: 'pin' | 'unpin' | 'settle' | 'unsettle' | 'archive' | 'restore' | 'wake' }

export type ThreadPlacement = Pick<ThreadNavigation, typeof threadPlacementKeys[number]>

export const threadPlacementKeys = ['pinnedOrder', 'activeOrder', 'settledAt', 'archivedAt', 'snoozedUntil'] as const

export interface ThreadUndoRecord {
  sourceCommandId: string
  sessionId: number
  action: 'unpinned' | 'settled' | 'snoozed' | 'archived'
  batch?: string
  expiresAt: number
  entries: Array<{ sessionId: number, before: ThreadPlacement, after: ThreadPlacement }>
}

export interface ThreadUndoResult {
  restored: number
  skipped: number
  sessionId?: number
}

export interface ThreadUndoScopeUpdate {
  key: string
  consumed?: string[]
  result?: ThreadUndoResult
}

export type ThreadUndoOffer = Pick<ThreadUndoRecord, 'sourceCommandId' | 'sessionId' | 'action'> & { remainingMs: number, count: number, ageMs?: number }

export const threadUndoDuration = 5000
export const maximumThreadSnooze = 366 * 24 * 60 * 60 * 1000

export function pinOrder(first: { id: number, navigation?: ThreadNavigation }, second: { id: number, navigation?: ThreadNavigation }): number {
  return (first.navigation?.pinnedOrder ?? Infinity) - (second.navigation?.pinnedOrder ?? Infinity)
    || first.id - second.id
}

export function threadDisplayTitle(title?: string, firstPrompt?: string): string {
  return title || firstPrompt?.trim().slice(0, 60) || 'New session'
}
