/**
 * The command surface.
 *
 * Two populations, and the split is a security boundary rather than a naming
 * convention: `ClientCommand` is everything a connected client may dispatch,
 * `InternalCommand` is everything only the server may raise. Provider output
 * arrives as internal commands and goes through the same queue, so there is one
 * ordering and one audit trail rather than two.
 */

import type { ProviderContextUsage } from './events'
import type { SteeringOutcome } from './follow-ups'
import type { ClaudeAccountCompaction, HostSettings } from './settings'
import type { ComposerAttachment, ComposerUploads } from './composer-attachments'
import type { InputQuestion, InputResponse, QuestionAttachment } from './input'
import type { ThreadOrganizationAction } from './thread-navigation'

export type DriverKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'grok'

export interface CodexTurnOptions {
  effort?: string
  serviceTier?: string
}

export interface CodexTurnSelection extends CodexTurnOptions {
  model: string
}

export function codexSelectionLabel(selection: CodexTurnSelection): string {
  const { model, effort, serviceTier } = selection
  const display = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
  return [model, effort && (effort === 'xhigh' ? 'Extra high' : display(effort)), serviceTier && display(serviceTier)]
    .filter(Boolean).join(' · ')
}

export interface ModelFavorite {
  driverKind: DriverKind
  providerInstanceId?: number
  model: string
}

export type ApprovalDecision = 'allowed' | 'denied' | 'cancelled'
export type ApprovalScope = 'once' | 'session' | 'workspace' | 'always'

export interface ApprovalChoice {
  decision: ApprovalDecision
  scope: ApprovalScope
  label: string
}

export interface ConnectorApproval {
  prompt: string
  choices: ApprovalChoice[]
}

/** Commands a client is allowed to dispatch. */
export type ClientCommand =
  | {
      type: 'session.create'
      workspaceId: number
      driverKind: DriverKind
      model?: string
      codexTurnOptions?: CodexTurnOptions
      /**
       * Run this session in a git worktree of its own.
       *
       * Sessions otherwise share the workspace, which is fine until two run at
       * once and edit the same files. Ignored for a workspace that is not a
       * repository — there is nothing to branch from.
       */
      isolate?: boolean
      providerInstanceId?: number
    }
  | { type: 'session.scratch.create', profileId?: number, driverKind: DriverKind, label: string, model?: string, codexTurnOptions?: CodexTurnOptions }
  | { type: 'session.fork', sessionId: number, turnId: number }
  | { type: 'session.handoff', sessionId: number, afterTurnId: number, driverKind: DriverKind, providerInstanceId?: number, model?: string, codexTurnOptions?: CodexTurnOptions, text: string, freshContext?: true, uploads?: ComposerUploads }
  | { type: 'session.turn.start', sessionId: number, text: string, codexSelection?: CodexTurnSelection, compactAfterTurnId?: number, freshContext?: true, uploads?: ComposerUploads }
  | { type: 'session.turn.interrupt', sessionId: number }
  | { type: 'session.queue.add', sessionId: number, text: string, codexSelection?: CodexTurnSelection, freshContext?: true, uploads?: ComposerUploads }
  | { type: 'session.queue.edit', sessionId: number, id: string, text: string, previousText: string }
  | { type: 'session.queue.remove', sessionId: number, id: string }
  | { type: 'session.queue.move', sessionId: number, id: string, direction: 'up' | 'down' }
  | { type: 'session.queue.send', sessionId: number, id?: string, confirmResend?: boolean }
  | ({ type: 'session.turn.steer', sessionId: number, turnId: number } & ({ id: string } | { text: string }))
  | { type: 'session.approval.respond', sessionId: number, approvalId: number, decision: ApprovalDecision, scope: ApprovalScope }
  | ({ type: 'session.input.respond', sessionId: number, requestId: string } & InputResponse)
  | { type: 'session.checkpoint.revert', sessionId: number, checkpointId: number }
  | { type: 'session.stop', sessionId: number }
  | ({ type: 'session.organize', sessionId: number, undoScope?: string, undoBatch?: string } & ThreadOrganizationAction)
  /**
   * Change one or more host settings.
   *
   * Client-dispatchable, like every other preference in this list: a setting
   * that every client of the host shares still has to be changeable from any
   * of them. Unknown keys are dropped rather than refused, so a newer client
   * may send a setting this host has not heard of.
   */
  | { type: 'settings.update', changes: Partial<HostSettings> }
  | { type: 'profile.create', name: string, icon?: string, tint?: string }
  | { type: 'profile.update', profileId: number, name?: string, icon?: string, tint?: string, position?: number }
  | { type: 'profile.claude-compaction.update', profileId: number, providerInstanceId: number, changes: ClaudeAccountCompaction }
  | { type: 'profile.model-favorite.set', profileId: number, favorite: ModelFavorite, selected: boolean }
  | { type: 'profile.delete', profileId: number }
  /**
   * Attach an MCP server to a profile.
   *
   * Values in `env`, `headers`, `url` and `args` may be `${VAR}` references,
   * resolved from the server's environment when an agent starts. The log keeps
   * the reference; a literal secret written here would be recorded in plaintext
   * in a file designed never to forget.
   */
  | {
      type: 'mcp.add'
      profileId: number
      name: string
      transport: 'stdio' | 'sse' | 'http'
      command?: string
      args?: string[]
      env?: Record<string, string>
      url?: string
      headers?: Record<string, string>
    }
  | { type: 'mcp.remove', profileId: number, name: string }
  | { type: 'mcp.setEnabled', profileId: number, name: string, enabled: boolean }
  | { type: 'workspace.add', profileId: number, path: string, name?: string }
  | { type: 'workspace.register', profileId?: number, path: string, trusted: boolean }
  | { type: 'workspace.promote', workspaceId: number }
  | { type: 'workspace.trust', workspaceId: number, trusted: boolean }
  /**
   * Withdraw a paired device's access.
   *
   * Client-dispatchable where `device.pair` is not, and the asymmetry is the
   * point: pairing grants access and must prove possession of a code shown on
   * the host, so only the server may raise it. Revoking only ever removes
   * access, so anyone already holding a valid connection may do it — which is
   * exactly the person whose phone was just lost.
   */
  | { type: 'device.revoke', deviceId: string }

/**
 * Commands only the server raises, mostly from provider output.
 *
 * A client that sends one of these is rejected — holding a valid socket is not
 * authorisation to forge assistant text.
 */
export type InternalCommand =
  | { type: 'thread.snooze.elapsed', sessionId: number, until: number }
  | { type: 'thread.steer.ready', sessionId: number, turnId: number }
  | { type: 'thread.steer.settle', sessionId: number, id: string, requestId: string, outcome: SteeringOutcome }
  | { type: 'thread.queue.advance', sessionId: number }
  | { type: 'thread.compact.idle', sessionId: number, afterTurnId: number }
  | { type: 'thread.queue.hold', sessionId: number }
  | { type: 'thread.scratch.create', profileId?: number, driverKind: DriverKind, path: string, model?: string, codexTurnOptions?: CodexTurnOptions }
  | { type: 'thread.message.assistant.delta', sessionId: number, turnId: number, text: string }
  | { type: 'thread.message.assistant.complete', sessionId: number, turnId: number }
  | { type: 'thread.tool.call.begin', sessionId: number, turnId: number, callId: string, toolName: string, args: unknown }
  | { type: 'thread.tool.call.end', sessionId: number, turnId: number, callId: string, ok: boolean }
  | { type: 'thread.approval.request', sessionId: number, requestId: string, toolName: string, args: unknown, connector?: ConnectorApproval }
  | { type: 'thread.approval.cancel', sessionId: number, approvalId: number }
  | { type: 'thread.input.request', sessionId: number, turnId: number, questions: InputQuestion[] }
  | { type: 'thread.input.cancel', sessionId: number, requestId: string }
  | { type: 'thread.composer.submit', intent: Extract<ClientCommand, { type: 'session.turn.start' | 'session.queue.add' | 'session.handoff' }>, attachments: ComposerAttachment[] }
  | ({ type: 'thread.input.answer', sessionId: number, requestId: string, attachments: QuestionAttachment[] } & InputResponse)
  | { type: 'thread.turn.complete', sessionId: number, turnId: number, tokensIn: number, tokensOut: number, cost: number, providerTurnId?: string, contextCompacted?: true, contextUsage?: ProviderContextUsage }
  | { type: 'thread.fork.finished', sessionId: number, providerSessionId: string, copiedProviderTurnIds?: Record<string, string> }
  | { type: 'thread.fork.portable', sessionId: number }
  | { type: 'thread.fork.failed', sessionId: number, message: string }
  | { type: 'thread.worktree.set', sessionId: number, worktreePath: string, branch: string }
  | { type: 'thread.checkpoint.restored', sessionId: number, checkpointId: number, restored: number, removed: number }
  | { type: 'thread.checkpoint.capture', sessionId: number, turnId: number, kind: 'turn-start' | 'turn-end' | 'manual', vcsRef: string }
  | { type: 'thread.session.set', sessionId: number, providerSessionId: string }
  | { type: 'thread.handoff.claim', sessionId: number, turnId: number, providerSessionId: string }
  | { type: 'thread.error', sessionId: number, message: string, turnId?: number }
  /**
   * Record a device that completed pairing.
   *
   * Internal because the server raises it only after verifying a pairing code
   * out of band. `tokenHash` is a SHA-256 of the bearer token: the log is
   * plaintext and permanent, so it stores something that can *check* a token
   * without being able to reproduce one.
   */
  | { type: 'device.pair', deviceId: string, name: string, tokenHash: string }

export type Command = ClientCommand | InternalCommand

export type CommandType = Command['type']

const CLIENT_COMMAND_TYPES: ReadonlySet<string> = new Set<ClientCommand['type']>([
  'session.create',
  'session.scratch.create',
  'session.turn.start',
  'session.fork',
  'session.handoff',
  'session.turn.interrupt',
  'session.turn.steer',
  'session.queue.add',
  'session.queue.edit',
  'session.queue.remove',
  'session.queue.move',
  'session.queue.send',
  'session.approval.respond',
  'session.input.respond',
  'session.checkpoint.revert',
  'mcp.add',
  'mcp.remove',
  'mcp.setEnabled',
  'session.stop',
  'session.organize',
  'settings.update',
  'profile.create',
  'profile.update',
  'profile.claude-compaction.update',
  'profile.model-favorite.set',
  'profile.delete',
  'workspace.add',
  'workspace.register',
  'workspace.promote',
  'workspace.trust',
  'device.revoke',
])

export function isClearCommand(text: unknown): boolean {
  return typeof text === 'string' && text.trim().toLowerCase() === '/clear'
}

export function isCompactCommand(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === '/compact'
}

/**
 * Whether a client may dispatch this command.
 *
 * Deliberately an allowlist. A denylist would mean every new internal command
 * is client-dispatchable until someone remembers to forbid it, and the failure
 * is silent.
 */
export function isClientCommand(type: string): boolean {
  return CLIENT_COMMAND_TYPES.has(type)
}

/**
 * An envelope carries the command plus what the engine needs to order it and
 * to recognise a retry.
 */
export interface CommandEnvelope {
  /**
   * Client-generated, unique per intent. Re-sending the same id after a
   * dropped connection must not run the command twice — the receipt is what
   * makes "did that go through?" answerable without guessing.
   */
  id: string
  command: Command
  /** Wall-clock at dispatch, milliseconds. Recorded, never used for ordering. */
  at: number
}
