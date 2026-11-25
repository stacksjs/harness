/**
 * The event surface — what actually happened, in order.
 *
 * Events are facts in the past tense. Nothing here is a request, nothing is
 * conditional, and nothing is ever updated or deleted: a fact that turns out to
 * be wrong is corrected by a later fact. That is what makes replay meaningful.
 */

import type { ApprovalDecision, ApprovalScope, CodexTurnOptions, CodexTurnSelection, ConnectorApproval, DriverKind, ModelFavorite } from './commands'
import type { QueuedFollowUp, SteeringOutcome } from './follow-ups'
import type { InputQuestion, QuestionAttachment } from './input'
import type { ClaudeAccountCompaction, HostSettings } from './settings'
import type { ThreadNavigation } from './thread-navigation'

export interface EventBase {
  /** Monotonic per session, starting at 1. Assigned inside the command queue. */
  seq: number
  sessionId: number
  /** The command this event came from, for idempotency and for tracing. */
  commandId: string
  at: number
}

export interface ProviderContextUsage {
  usedTokens: number
  maxTokens?: number
  /** Date.now() timestamp for the provider's confirmed prompt-cache expiry, when known. */
  promptCacheExpiresAt?: number
}

export interface ForkSource {
  sessionId: number
  turnId: number
  /** A missing native ID creates a portable fork with the selected history. */
  providerSessionId?: string
}

export type EventPayload =
  | { type: 'session.created', workspaceId: number, driverKind: DriverKind, providerInstanceId?: number, model?: string, codexTurnOptions?: CodexTurnOptions, isolate?: boolean, forkFrom?: ForkSource }
  | { type: 'session.stopped' }
  | { type: 'session.navigation-changed', changes: Partial<ThreadNavigation> }
  | { type: 'session.failed', message: string }
  | { type: 'session.provider-bound', providerSessionId: string }
  | { type: 'session.fork-finished', providerSessionId: string }
  | { type: 'session.fork-failed', message: string }
  | { type: 'session.provider-switched', afterTurnId: number, driverKind: DriverKind, providerInstanceId?: number, model?: string, codexTurnOptions?: CodexTurnOptions }
  | { type: 'turn.started', turnId: number, role: 'user' | 'assistant', text?: string, queuedId?: string, codexSelection?: CodexTurnSelection, modelChanged?: boolean, switchedProvider?: DriverKind, compaction?: true, automaticCompaction?: true, freshContext?: true }
  | { type: 'queue.added', entry: QueuedFollowUp }
  | { type: 'queue.edited', id: string, text: string }
  | { type: 'queue.removed', id: string }
  | { type: 'queue.moved', id: string, toIndex: number }
  | { type: 'queue.held' }
  | { type: 'turn.steering-ready', turnId: number }
  | { type: 'turn.steer.requested', turnId: number, id: string, requestId: string, text: string }
  | { type: 'turn.steer.resolved', turnId: number, id: string, outcome: SteeringOutcome, text: string }
  | { type: 'turn.completed', turnId: number, tokensIn: number, tokensOut: number, cost: number, providerTurnId?: string, responseForkable?: true, contextCompacted?: true, contextUsage?: ProviderContextUsage }
  | { type: 'turn.interrupted', turnId: number }
  | { type: 'turn.failed', turnId: number, message: string }
  | { type: 'assistant.delta', turnId: number, text: string }
  | { type: 'tool.call.began', turnId: number, callId: string, toolName: string }
  | { type: 'tool.call.ended', turnId: number, callId: string, ok: boolean }
  | { type: 'approval.requested', approvalId: number, requestId: string, toolName: string, connector?: ConnectorApproval }
  | { type: 'approval.resolved', approvalId: number, decision: ApprovalDecision, scope: ApprovalScope }
  | { type: 'input.requested', requestId: string, turnId: number, questions: InputQuestion[] }
  | { type: 'input.resolved', requestId: string, turnId: number, outcome: 'answered' | 'declined' | 'interrupted', attachments?: QuestionAttachment[] }
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
  /** Only the settings that actually changed, for the same reason as below. */
  | { type: 'settings.updated', changes: Partial<HostSettings> }
  | { type: 'profile.created', profileId: number, name: string, icon?: string, tint?: string }
  /**
   * Only the fields that changed. Absent means "leave it alone", which is what
   * lets a rename and a recolour be separate intents rather than one command
   * that has to restate everything.
   */
  | { type: 'profile.updated', profileId: number, name?: string, icon?: string, tint?: string, position?: number }
  | { type: 'profile.claude-compaction.updated', profileId: number, providerInstanceId: number, changes: ClaudeAccountCompaction }
  | { type: 'profile.model-favorite.changed', profileId: number, favorite: ModelFavorite, selected: boolean }
  /**
   * The workspaces and sessions removed along with it.
   *
   * Carried on the event rather than recomputed on replay, because the
   * projection at replay time is the one *before* this event and would have to
   * re-derive the cascade identically forever. Recording what was actually
   * removed also lets the log answer "where did that session go?".
   */
  | { type: 'profile.deleted', profileId: number, workspaceIds: number[], sessionIds: number[] }
  | {
      type: 'mcp.added'
      profileId: number
      name: string
      transport: 'stdio' | 'sse' | 'http'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    }
  | { type: 'mcp.removed', profileId: number, name: string }
  | { type: 'mcp.enabledChanged', profileId: number, name: string, enabled: boolean }
  | { type: 'workspace.added', workspaceId: number, profileId: number, path: string, scratch?: boolean }
  | { type: 'workspace.promoted', workspaceId: number }
  | { type: 'workspace.trust-changed', workspaceId: number, trusted: boolean }
  | { type: 'device.paired', deviceId: string, name: string, tokenHash: string, at: number }
  | { type: 'device.revoked', deviceId: string }

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
  'settings.updated',
  'profile.created',
  'profile.updated',
  'profile.claude-compaction.updated',
  'profile.model-favorite.changed',
  'profile.deleted',
  'workspace.added',
  'workspace.promoted',
  'workspace.trust-changed',
])

export function isGlobalEvent(type: string): boolean {
  return GLOBAL_EVENT_TYPES.has(type)
}
