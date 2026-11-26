/**
 * The driver boundary.
 *
 * This is the only place in harness that knows which agent is behind a session.
 * Everything above it names a session and speaks the contract's events, which is
 * what makes adding a provider one file plus one registry entry rather than a
 * change that ripples through the engine, the socket and the views.
 *
 * It is also the seam a first-party runtime slots into later (PLAN.md §17) —
 * `driverKind: 'harness'` beside `'claude'`, with nothing above it changing.
 */

import type { ApprovalChoice, CodexTurnOptions, CodexTurnSelection, ProviderContextUsage, ConnectorApproval, DriverKind, InputAnswer, InputQuestion, SteeringOutcome } from '@harness/contract'

/**
 * What a driver emits while a turn runs.
 *
 * Deliberately narrow: it is the union every provider must normalise into, so
 * it carries only what the engine can actually act on. Provider-specific detail
 * that does not map here belongs in the driver, not leaked upward.
 */
export type ProviderEvent =
  /** The provider refused to resume before receiving history or the user request. */
  | { type: 'resume-unavailable' }
  | { type: 'session-bound', providerSessionId: string }
  | { type: 'steering-ready' }
  | { type: 'assistant-delta', text: string }
  | { type: 'tool-call-begin', callId: string, toolName: string, args: unknown }
  | { type: 'tool-call-end', callId: string, ok: boolean }
  | { type: 'approval-request', requestId: string, toolName: string, args: unknown, connector?: ConnectorApproval }
  | { type: 'approval-cancelled', requestId: string }
  | { type: 'input-request', requestId: string, questions: InputQuestion[] }
  | { type: 'input-cancelled', requestId: string }
  | { type: 'turn-complete', tokensIn: number, tokensOut: number, costMicros: number, providerTurnId?: string, contextCompacted?: true, contextUsage?: ProviderContextUsage }
  | { type: 'error', message: string }

export interface ProviderModel {
  id: string
  name: string
  isDefault: boolean
  reasoningEfforts: string[]
  defaultReasoningEffort?: string
  speedTiers: Array<{ id: string, name: string }>
  defaultSpeedTier?: string
}

export interface ProbeResult {
  /**
   * `unavailable` is a first-class state, not a failure. A driver whose binary
   * is absent must surface as something the UI can explain, rather than
   * crashing the registry at startup.
   */
  status: 'ready' | 'unauthenticated' | 'unavailable' | 'failed'
  version?: string
  binaryPath?: string
  message?: string
  models?: ProviderModel[]
}

export interface HistoricalContext {
  items: Array<{
    type: 'message'
    role: 'user' | 'assistant'
    content: Array<{ type: 'input_text' | 'output_text', text: string }>
  }>
  inlinePrompt: string
}

export interface StartTurnInput {
  text: string
  /** Host-resolved raster images for the Codex app-server. */
  localImages?: string[]
  codexSelection?: CodexTurnSelection
  /** Attributed history for a native conversation. */
  historicalContext?: HistoricalContext
  /** Provider's own session id, when resuming rather than starting fresh. */
  providerSessionId?: string
  /** A failed resume must settle before any prompt is sent to a different conversation. */
  requireResume?: boolean
  /** The native fork transcript can still be stored under the source worktree. */
  forkAcrossWorktrees?: true
}

export interface ForkInput {
  providerSessionId: string
  providerTurnId?: string
  /** Native boundaries of earlier turns that will also appear in the new thread. */
  inheritedProviderTurnIds?: string[]
  prompt: string
  response: string
}

export interface ForkResult {
  providerSessionId: string
  /** When the provider gives copied messages new IDs, map the old IDs to their copies. */
  copiedProviderTurnIds?: Record<string, string>
}

export interface ConversationRewindInput {
  providerSessionId: string
  beforeTurnId: string
  newestTurnId: string
  retainedTurnId?: string
  verifyOnly?: boolean
}

export type ConversationRewindResult =
  | { outcome: 'rewound' }
  | { outcome: 'unchanged' | 'uncertain', message: string }

export interface ProviderInstance {
  /** Accepts structured history and can fall back to the attributed prompt. */
  acceptsHistoricalContext?: boolean
  /** Stream one turn. Ends when the provider says the turn is over. */
  startTurn: (input: StartTurnInput) => AsyncIterable<ProviderEvent>
  /** Compact an existing provider conversation without a new user prompt. */
  compact?: (providerSessionId: string, resume?: Pick<StartTurnInput, 'forkAcrossWorktrees'>) => AsyncIterable<ProviderEvent>
  /** Create a separate conversation through the selected response. Null means the saved boundary is unavailable. */
  fork?: (input: ForkInput) => Promise<ForkResult | null>
  /** Restore the existing native conversation to just before a recorded provider turn. */
  rewind?: (input: ConversationRewindInput) => Promise<ConversationRewindResult>
  /** Stop the running turn. Safe to call when nothing is running. */
  interrupt: () => Promise<void>
  /** Send a follow-up to the currently streaming provider turn. */
  steer?: (text: string) => Promise<SteeringOutcome>
  /** Answer a pending approval request. */
  respondApproval: (requestId: string, allow: boolean, reason?: string, choice?: Pick<ApprovalChoice, 'decision' | 'scope'>) => Promise<void>
  /** Deliver an answer or decline to an agent waiting for input. */
  respondInput?: (requestId: string, answers: InputAnswer[] | null) => Promise<void>
  /** Tear down the process and release resources. */
  stop: () => Promise<void>
}

/**
 * An MCP server with its references already resolved.
 *
 * Structurally the union a provider expects, so a driver maps rather than
 * translates. Declared here rather than imported from the server package
 * because drivers must not depend on it.
 */
export type ResolvedMcpServer =
  | { name: string, type: 'stdio', command: string, args: string[], env: Record<string, string> }
  | { name: string, type: 'sse' | 'http', url: string, headers: Record<string, string> }

export interface DriverConfig {
  /** Absolute path the agent runs against. */
  workspacePath: string
  /** Provider account directory. Claude uses CLAUDE_CONFIG_DIR and keeps the host HOME. */
  home?: string
  binaryPath?: string
  model?: string
  claudeAutoCompactAfter?: number
  codexTurnOptions?: CodexTurnOptions
  /** Host-only credentials for a managed Codex connection. */
  chatGptPlan?: {
    accessToken: () => Promise<string>
    connected: () => Promise<boolean>
  }
  /**
   * MCP servers this session should have, already resolved.
   *
   * Every `${VAR}` reference is substituted before it gets here, so a driver
   * never has to know that harness stores references rather than secrets.
   */
  mcpServers?: ResolvedMcpServer[]
  /**
   * When false, every tool call raises an approval request the client must
   * answer. Defaults to false — an agent harness is a code-execution surface,
   * and unattended execution should be opted into, not defaulted into.
   */
  autoApprove?: boolean
}

export interface Driver {
  kind: DriverKind
  /** Is the CLI installed, authenticated, and what version? */
  probe: (config: DriverConfig, options?: { includeModels?: boolean }) => Promise<ProbeResult>
  create: (config: DriverConfig) => Promise<ProviderInstance>
}
