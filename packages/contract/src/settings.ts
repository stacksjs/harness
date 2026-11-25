/**
 * Settings that belong to the host, not to the browser looking at it.
 *
 * Harness kept every preference in `localStorage`, which made each of them a
 * property of one browser profile on one origin. That is right for a chord
 * bound to a keyboard and wrong for "which agent new threads start with": the
 * phone and the laptop pointed at the same host disagreed, and the setting was
 * lost with the browser store. These live in the event log instead, so every
 * client of a host reads the same answer and a second host keeps its own.
 *
 * Validation is part of the contract rather than the view's job. The values
 * arrive from a client this server does not control and are replayed from a
 * log older builds wrote, so both paths need the same answer to "is this
 * still a value we accept?".
 */

import type { DriverKind } from './commands'

export type FollowUpBehavior = 'queue' | 'steer'
export type TerminalShell = 'system' | 'den'
export type ClaudeIdleCompaction = 'whenReturning' | 'beforeCacheExpires' | 'off'

export interface HostSettings {
  /** The agent a new thread starts with, unless the composer overrides it. */
  defaultDriver: DriverKind
  /** Whether a message sent during a turn joins the queue or steers the turn. */
  followUpBehavior: FollowUpBehavior
  /** Shell for new local terminals. */
  terminalShell: TerminalShell
  /** When to compact an idle Claude conversation with a large context. */
  claudeIdleCompaction: ClaudeIdleCompaction
}

const DRIVER_KINDS: readonly DriverKind[] = ['claude', 'codex', 'cursor', 'opencode', 'grok']
const FOLLOW_UP_BEHAVIORS: readonly FollowUpBehavior[] = ['queue', 'steer']

export const defaultHostSettings: Readonly<HostSettings> = Object.freeze({
  defaultDriver: 'claude',
  followUpBehavior: 'queue',
  terminalShell: 'system',
  claudeIdleCompaction: 'whenReturning',
})

/** A fresh, mutable copy of the defaults. */
export function hostSettings(): HostSettings {
  return { ...defaultHostSettings }
}

/**
 * The subset of `changes` this build accepts.
 *
 * Unknown keys and unusable values are dropped rather than rejected wholesale,
 * so a client one release ahead can set two settings and have the one this
 * host understands take effect. The reducer decides what to do with an empty
 * result; replay uses the same filter so a value retired between builds falls
 * back to the default instead of poisoning the projection.
 */
export function acceptedSettings(changes: unknown): Partial<HostSettings> {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return {}
  const source = changes as Record<string, unknown>
  const accepted: Partial<HostSettings> = {}
  if (DRIVER_KINDS.includes(source.defaultDriver as DriverKind))
    accepted.defaultDriver = source.defaultDriver as DriverKind
  if (FOLLOW_UP_BEHAVIORS.includes(source.followUpBehavior as FollowUpBehavior))
    accepted.followUpBehavior = source.followUpBehavior as FollowUpBehavior
  if (source.terminalShell === 'system' || source.terminalShell === 'den')
    accepted.terminalShell = source.terminalShell
  if (source.claudeIdleCompaction === 'whenReturning' || source.claudeIdleCompaction === 'beforeCacheExpires' || source.claudeIdleCompaction === 'off')
    accepted.claudeIdleCompaction = source.claudeIdleCompaction
  return accepted
}

/** Only the accepted changes that differ from what is in force. */
export function settingsDelta(current: HostSettings, changes: unknown): Partial<HostSettings> {
  const accepted = acceptedSettings(changes)
  const delta: Partial<HostSettings> = {}
  for (const [key, value] of Object.entries(accepted) as Array<[keyof HostSettings, never]>) {
    if (current[key] !== value) delta[key] = value
  }
  return delta
}
