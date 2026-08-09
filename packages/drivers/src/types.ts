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

import type { DriverKind } from '@harness/contract'

/**
 * What a driver emits while a turn runs.
 *
 * Deliberately narrow: it is the union every provider must normalise into, so
 * it carries only what the engine can actually act on. Provider-specific detail
 * that does not map here belongs in the driver, not leaked upward.
 */
export type ProviderEvent =
  | { type: 'session-bound', providerSessionId: string }
  | { type: 'assistant-delta', text: string }
  | { type: 'tool-call-begin', callId: string, toolName: string, args: unknown }
  | { type: 'tool-call-end', callId: string, ok: boolean }
  | { type: 'approval-request', requestId: string, toolName: string, args: unknown }
  | { type: 'turn-complete', tokensIn: number, tokensOut: number, costMicros: number }
  | { type: 'error', message: string }

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
}

export interface StartTurnInput {
  text: string
  /** Provider's own session id, when resuming rather than starting fresh. */
  providerSessionId?: string
}

export interface ProviderInstance {
  /** Stream one turn. Ends when the provider says the turn is over. */
  startTurn: (input: StartTurnInput) => AsyncIterable<ProviderEvent>
  /** Stop the running turn. Safe to call when nothing is running. */
  interrupt: () => Promise<void>
  /** Answer a pending approval request. */
  respondApproval: (requestId: string, allow: boolean, reason?: string) => Promise<void>
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
  /** HOME override, so two profiles can hold two accounts. */
  home?: string
  binaryPath?: string
  model?: string
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
  probe: (config: DriverConfig) => Promise<ProbeResult>
  create: (config: DriverConfig) => Promise<ProviderInstance>
}
