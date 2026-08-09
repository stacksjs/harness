/**
 * The Claude driver, over `@anthropic-ai/claude-agent-sdk`.
 *
 * The Agent SDK is Claude Code packaged as a library — it brings the harness
 * (agent loop, built-in Read/Write/Edit/Bash/Glob/Grep tools, context
 * management) and we host it. That is deliberately *not* the Messages API or
 * its Tool Runner: harness is a control surface over the coding agents people
 * already have installed, so the driver's job is to drive Claude Code, not to
 * reimplement one.
 *
 * Everything here narrows the SDK's wide message union down to the seven
 * `ProviderEvent` shapes the engine understands. Anything the union carries
 * that does not map — hook progress, plugin installs, task notifications —
 * stops at this boundary on purpose.
 */

import type { CanUseTool, Options, PermissionResult, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Driver, DriverConfig, ProbeResult, ProviderEvent, ProviderInstance, StartTurnInput } from './types'
import { query } from '@anthropic-ai/claude-agent-sdk'

/** USD per token → integer micro-USD, so summing turns can't drift on floats. */
function toMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

interface PendingApproval {
  resolve: (result: PermissionResult) => void
  /**
   * The tool's own input, kept so an allow can hand it back.
   *
   * `{ behavior: 'allow' }` alone is rejected by the SDK — `updatedInput` is
   * how a permission callback returns the arguments the tool should run with,
   * and omitting it fails the call. Auto-approve passed it and manual approval
   * did not, so *every* tool a human allowed failed while every
   * auto-approved one worked.
   */
  input: Record<string, unknown>
}

class ClaudeInstance implements ProviderInstance {
  private running: Query | null = null
  private pending = new Map<string, PendingApproval>()
  /** Queue of approval requests raised between `startTurn` yields. */
  private approvalQueue: ProviderEvent[] = []
  private nextApprovalId = 0

  constructor(private config: DriverConfig) {}

  /**
   * The SDK asks permission through a callback, but the engine expects an
   * event plus a later response. Bridging the two means parking the callback's
   * promise and resolving it when `respondApproval` arrives.
   */
  private canUseTool: CanUseTool = async (toolName, input) => {
    if (this.config.autoApprove)
      return { behavior: 'allow', updatedInput: input }

    const requestId = `apr_${++this.nextApprovalId}`
    this.approvalQueue.push({ type: 'approval-request', requestId, toolName, args: input })

    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, input })
    })
  }

  private options(providerSessionId?: string): Options {
    const options: Options = {
      cwd: this.config.workspacePath,
      canUseTool: this.canUseTool,
      // Deltas are the whole point of a streaming transcript: without this the
      // SDK only reports complete assistant messages and the UI shows nothing
      // until the turn ends.
      includePartialMessages: true,
    }
    // Keyed by name, which is how the provider addresses a server's tools.
    if (this.config.mcpServers?.length) {
      options.mcpServers = Object.fromEntries(this.config.mcpServers.map(server => [
        server.name,
        server.type === 'stdio'
          ? { type: 'stdio' as const, command: server.command, args: server.args, env: server.env }
          : { type: server.type, url: server.url, headers: server.headers },
      ]))
    }
    if (this.config.model) options.model = this.config.model
    if (this.config.binaryPath) options.pathToClaudeCodeExecutable = this.config.binaryPath
    // `resume` continues the provider's own conversation. Without it every turn
    // starts a fresh Claude Code session and the agent forgets the last one.
    if (providerSessionId) options.resume = providerSessionId
    if (this.config.home) options.env = { ...process.env, HOME: this.config.home }
    return options
  }

  async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
    const run = query({ prompt: input.text, options: this.options(input.providerSessionId) })
    this.running = run

    // Bound to the session, so the next turn can resume rather than restart.
    let bound = input.providerSessionId ?? null
    // Whether this turn has already reported how it ended. The SDK reports a
    // failed turn twice — once as a `result` message, then again by throwing
    // as the iterator finishes — and two terminal events would settle the
    // turn twice.
    let terminal = false

    try {
      for await (const message of run as AsyncIterable<SDKMessage>) {
        // Drain anything `canUseTool` parked while we were awaiting the SDK.
        while (this.approvalQueue.length > 0)
          yield this.approvalQueue.shift()!

        if (!bound && 'session_id' in message && message.session_id) {
          bound = message.session_id
          yield { type: 'session-bound', providerSessionId: message.session_id }
        }

        for (const event of translate(message)) {
          if (event.type === 'turn-complete' || event.type === 'error') terminal = true
          yield event
        }
      }
    }
    catch (error) {
      // Only report a throw we have not already described. Rethrowing a
      // failure the `result` message just delivered would surface the same
      // problem to the user twice.
      if (terminal) return
      yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
      terminal = true
    }
    finally {
      // Clear the queue so a cancelled turn's approvals do not surface on the
      // next one, where their ids mean nothing.
      this.approvalQueue = []
      this.running = null
    }
  }

  async interrupt(): Promise<void> {
    // Interrupting when nothing runs is a no-op, not an error: the user pressed
    // stop just as the turn finished.
    if (!this.running) return
    try {
      await this.running.interrupt()
    }
    catch {
      // The turn ended between the check and the call. Nothing to stop.
    }
  }

  async respondApproval(requestId: string, allow: boolean, reason?: string): Promise<void> {
    const waiter = this.pending.get(requestId)
    // An unknown id is a late or duplicate answer — drop it rather than throw.
    if (!waiter) return
    this.pending.delete(requestId)
    waiter.resolve(allow
      // Unmodified: the user approved *this* call, so the tool runs with the
      // arguments they were shown, not with anything rewritten in between.
      ? { behavior: 'allow', updatedInput: waiter.input }
      : { behavior: 'deny', message: reason ?? 'denied by the user' })
  }

  async stop(): Promise<void> {
    await this.interrupt()
    // Release anything still parked on an approval, or those promises never
    // settle and the process will not exit.
    for (const [, waiter] of this.pending)
      waiter.resolve({ behavior: 'deny', message: 'session stopped' })
    this.pending.clear()
  }
}

/**
 * SDK message → provider events.
 *
 * Pure and exported so the mapping is testable without spawning Claude Code —
 * which is the difference between a driver bug being reproducible and not.
 */
export function translate(message: SDKMessage): ProviderEvent[] {
  switch (message.type) {
    case 'stream_event': {
      // The delta stream. `text_delta` is the only part the transcript needs;
      // thinking and tool-input deltas are surfaced through their own events.
      const event = message.event
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
        return [{ type: 'assistant-delta', text: event.delta.text }]
      return []
    }

    case 'assistant': {
      const out: ProviderEvent[] = []
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          out.push({
            type: 'tool-call-begin',
            callId: block.id,
            toolName: block.name,
            args: block.input,
          })
        }
      }
      // Assistant *text* is deliberately not emitted here: with
      // `includePartialMessages` the same text already arrived as deltas, and
      // emitting both would duplicate every sentence in the transcript.
      return out
    }

    case 'user': {
      const out: ProviderEvent[] = []
      const content = message.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
            const result = block as { tool_use_id?: string, is_error?: boolean }
            if (result.tool_use_id) {
              out.push({
                type: 'tool-call-end',
                callId: result.tool_use_id,
                ok: result.is_error !== true,
              })
            }
          }
        }
      }
      return out
    }

    case 'result': {
      // `subtype` is not the verdict. A model that does not exist returns
      // `subtype: 'success'` with `is_error: true` and a 404 — reading only the
      // subtype recorded that turn as a completion with zero tokens, so the
      // transcript showed a turn that finished and said nothing.
      const failed = (message as { is_error?: boolean }).is_error === true
      if (message.subtype === 'success' && !failed) {
        return [{
          type: 'turn-complete',
          tokensIn: message.usage.input_tokens ?? 0,
          tokensOut: message.usage.output_tokens ?? 0,
          costMicros: toMicros(message.total_cost_usd ?? 0),
        }]
      }
      // `result` carries the sentence a user can act on ("it may not exist or
      // you may not have access to it"); the subtype is only a category.
      const detail = typeof (message as { result?: unknown }).result === 'string'
        ? (message as { result: string }).result
        : `turn failed: ${message.subtype}`
      return [{ type: 'error', message: detail }]
    }

    default:
      // The union is wide and grows; anything without a contract event is not
      // an error, it is simply not something the engine models.
      return []
  }
}

export const ClaudeDriver: Driver = {
  kind: 'claude',

  /**
   * Probe by running one trivial turn.
   *
   * More expensive than reading `--version`, but it is the only check that
   * distinguishes installed-and-authenticated from installed-but-logged-out —
   * and that distinction is exactly what the UI has to show.
   */
  async probe(config: DriverConfig): Promise<ProbeResult> {
    try {
      const run = query({
        prompt: 'Reply with the single word: ok',
        options: {
          cwd: config.workspacePath,
          maxTurns: 1,
          ...(config.binaryPath ? { pathToClaudeCodeExecutable: config.binaryPath } : {}),
          ...(config.home ? { env: { ...process.env, HOME: config.home } } : {}),
        },
      })

      for await (const message of run as AsyncIterable<SDKMessage>) {
        if (message.type === 'assistant' && message.error) {
          const status = message.error === 'authentication_failed' || message.error === 'oauth_org_not_allowed'
            ? 'unauthenticated'
            : 'failed'
          return { status, message: message.error }
        }
        if (message.type === 'result')
          return { status: 'success' === message.subtype ? 'ready' : 'failed' }
      }
      return { status: 'failed', message: 'the probe produced no result' }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A missing binary is `unavailable`, not `failed`: nothing is broken,
      // the CLI simply is not installed, and the UI should say so.
      const missing = /ENOENT|not found|no such file/i.test(message)
      return { status: missing ? 'unavailable' : 'failed', message }
    }
  },

  async create(config: DriverConfig): Promise<ProviderInstance> {
    return new ClaudeInstance(config)
  },
}
