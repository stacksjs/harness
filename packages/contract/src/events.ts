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
  | { type: 'session.created', workspaceId: number, driverKind: DriverKind, model?: string, isolate?: boolean }
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
  /** `vcsRef` is the dangling commit holding the snapshot; see server/checkpoint.ts. */
  | { type: 'checkpoint.captured', checkpointId: number, turnId: number, kind: 'turn-start' | 'turn-end' | 'manual', vcsRef: string }
  /**
   * A revert was accepted, in the same sense `turn.started` means a turn was
   * accepted: the checkpoint exists and the runtime has been told to put the
   * workspace back. A restore that then fails emits `thread.error` after this,
   * so the log carries both the intent and the outcome.
   */
  | { type: 'checkpoint.reverted', checkpointId: number }
  /**
   * The workspace is actually back.
   *
   * Separate from `checkpoint.reverted`, which only says the revert was
   * accepted. The git work happens after that, and a client that acted on
   * acceptance alone reloaded into a half-restored tree — files rewritten,
   * files the agent added not yet removed.
   */
  /** This session got its own checkout and branch. */
  | { type: 'session.isolated', worktreePath: string, branch: string }
  | { type: 'checkpoint.restored', checkpointId: number, restored: number, removed: number }
  | { type: 'profile.created', profileId: number, name: string, icon?: string, tint?: string }
  /**
   * Only the fields that changed. Absent means "leave it alone", which is what
   * lets a rename and a recolour be separate intents rather than one command
   * that has to restate everything.
   */
  | { type: 'profile.updated', profileId: number, name?: string, icon?: string, tint?: string, position?: number }
  /**
   * The workspaces and sessions removed along with it.
   *
   * Carried on the event rather than recomputed on replay, because the
   * projection at replay time is the one *before* this event and would have to
   * re-derive the cascade identically forever. Recording what was actually
   * removed also lets the log answer "where did that session go?".
   */
  | { type: 'profile.deleted', profileId: number, workspaceIds: number[], sessionIds: number[] }
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
