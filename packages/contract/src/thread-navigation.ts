export interface ThreadNavigation {
  title?: string
  pinnedOrder?: number | null
  settledAt?: number | null
  archivedAt?: number | null
  snoozedUntil?: number | null
}

export type ThreadOrganizationAction =
  | { action: 'rename', title: string }
  | { action: 'snooze', until: number }
  | { action: 'move-pin', direction: 'up' | 'down' }
  | { action: 'pin' | 'unpin' | 'settle' | 'unsettle' | 'archive' | 'restore' | 'wake' }

export const maximumThreadSnooze = 366 * 24 * 60 * 60 * 1000

export function pinOrder(first: { id: number, navigation?: ThreadNavigation }, second: { id: number, navigation?: ThreadNavigation }): number {
  return (first.navigation?.pinnedOrder ?? Infinity) - (second.navigation?.pinnedOrder ?? Infinity)
    || first.id - second.id
}

export function threadDisplayTitle(title?: string, firstPrompt?: string): string {
  return title || firstPrompt?.trim().slice(0, 60) || 'New session'
}
