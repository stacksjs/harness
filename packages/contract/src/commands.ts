/**
 * The command surface.
 *
 * Two populations, and the split is a security boundary rather than a naming
 * convention: `ClientCommand` is everything a connected client may dispatch,
 * `InternalCommand` is everything only the server may raise. Provider output
 * arrives as internal commands and goes through the same queue, so there is one
 * ordering and one audit trail rather than two.
 */

export type DriverKind = 'claude' | 'codex' | 'cursor' | 'opencode' | 'grok'

export type ApprovalDecision = 'allowed' | 'denied'
export type ApprovalScope = 'once' | 'session' | 'workspace' | 'always'

/** Commands a client is allowed to dispatch. */
export type ClientCommand =
  | {
      type: 'session.create'
      workspaceId: number
      driverKind: DriverKind
      model?: string
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
  | { type: 'session.turn.start', sessionId: number, text: string }
  | { type: 'session.turn.interrupt', sessionId: number }
  | { type: 'session.approval.respond', sessionId: number, approvalId: number, decision: ApprovalDecision, scope: ApprovalScope }
  | { type: 'session.input.respond', sessionId: number, requestId: string, value: string }
  | { type: 'session.checkpoint.revert', sessionId: number, checkpointId: number }
  | { type: 'session.stop', sessionId: number }
  | { type: 'profile.create', name: string, icon?: string, tint?: string }
  | { type: 'profile.update', profileId: number, name?: string, icon?: string, tint?: string, position?: number }
  | { type: 'profile.delete', profileId: number }
  | { type: 'workspace.add', profileId: number, path: string, name?: string }
  | { type: 'workspace.trust', workspaceId: number, trusted: boolean }

/**
 * Commands only the server raises, mostly from provider output.
 *
 * A client that sends one of these is rejected — holding a valid socket is not
 * authorisation to forge assistant text.
 */
export type InternalCommand =
  | { type: 'thread.message.assistant.delta', sessionId: number, turnId: number, text: string }
  | { type: 'thread.message.assistant.complete', sessionId: number, turnId: number }
  | { type: 'thread.tool.call.begin', sessionId: number, turnId: number, callId: string, toolName: string, args: unknown }
  | { type: 'thread.tool.call.end', sessionId: number, turnId: number, callId: string, ok: boolean }
  | { type: 'thread.approval.request', sessionId: number, requestId: string, toolName: string, args: unknown }
  | { type: 'thread.input.request', sessionId: number, requestId: string, prompt: string }
  | { type: 'thread.turn.complete', sessionId: number, turnId: number, tokensIn: number, tokensOut: number, cost: number }
  | { type: 'thread.worktree.set', sessionId: number, worktreePath: string, branch: string }
  | { type: 'thread.checkpoint.restored', sessionId: number, checkpointId: number, restored: number, removed: number }
  | { type: 'thread.checkpoint.capture', sessionId: number, turnId: number, kind: 'turn-start' | 'turn-end' | 'manual', vcsRef: string }
  | { type: 'thread.session.set', sessionId: number, providerSessionId: string }
  | { type: 'thread.error', sessionId: number, message: string }

export type Command = ClientCommand | InternalCommand

export type CommandType = Command['type']

const CLIENT_COMMAND_TYPES: ReadonlySet<string> = new Set<ClientCommand['type']>([
  'session.create',
  'session.turn.start',
  'session.turn.interrupt',
  'session.approval.respond',
  'session.input.respond',
  'session.checkpoint.revert',
  'session.stop',
  'profile.create',
  'profile.update',
  'profile.delete',
  'workspace.add',
  'workspace.trust',
])

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
