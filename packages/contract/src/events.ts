/**
 * The event surface — what actually happened, in order.
 *
 * Events are facts in the past tense. Nothing here is a request, nothing is
 * conditional, and nothing is ever updated or deleted: a fact that turns out to
 * be wrong is corrected by a later fact. That is what makes replay meaningful.
 */

import type { ApprovalDecision, ApprovalScope, DriverKind } from './commands'

export interface EventBase {
  /** Monotonic per session, starting at 1. Assigned inside the command queue. */
  seq: number
  sessionId: number
  /** The command this event came from, for idempotency and for tracing. */
  commandId: string
  at: number
}

export type EventPayload =
  | { type: 'session.created', workspaceId: number, driverKind: DriverKind, model?: string }
  | { type: 'session.stopped' }
  | { type: 'session.failed', message: string }
  | { type: 'session.provider-bound', providerSessionId: string }
  | { type: 'turn.started', turnId: number, role: 'user' | 'assistant', text?: string }
  | { type: 'turn.completed', turnId: number, tokensIn: number, tokensOut: number, cost: number }
  | { type: 'turn.interrupted', turnId: number }
  | { type: 'turn.failed', turnId: number, message: string }
  | { type: 'assistant.delta', turnId: number, text: string }
  | { type: 'tool.call.began', turnId: number, callId: string, toolName: string }
  | { type: 'tool.call.ended', turnId: number, callId: string, ok: boolean }
  | { type: 'approval.requested', approvalId: number, requestId: string, toolName: string }
  | { type: 'approval.resolved', approvalId: number, decision: ApprovalDecision, scope: ApprovalScope }
  | { type: 'checkpoint.captured', checkpointId: number, turnId: number, kind: 'turn-start' | 'turn-end' | 'manual' }
  | { type: 'checkpoint.reverted', checkpointId: number }
  | { type: 'profile.created', profileId: number, name: string }
  | { type: 'profile.updated', profileId: number }
  | { type: 'profile.deleted', profileId: number }
  | { type: 'workspace.added', workspaceId: number, profileId: number, path: string }
  | { type: 'workspace.trust-changed', workspaceId: number, trusted: boolean }

export type HarnessEvent = EventBase & { payload: EventPayload }

export type EventType = EventPayload['type']

/**
 * Events that carry no session, because they happened before or outside one.
 *
 * They still get a sequence number and still live in the log; they just use the
 * reserved session id 0 rather than inventing a second log with its own
 * ordering rules.
 */
export const GLOBAL_SESSION_ID = 0

const GLOBAL_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  'profile.created',
  'profile.updated',
  'profile.deleted',
  'workspace.added',
  'workspace.trust-changed',
])

export function isGlobalEvent(type: string): boolean {
  return GLOBAL_EVENT_TYPES.has(type)
}
