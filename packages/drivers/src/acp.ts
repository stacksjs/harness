/**
 * The ACP client, and Cursor as its first driver.
 *
 * ACP (Agent Client Protocol) is JSON-RPC v2 over stdio: the client sends
 * `initialize` → `session/new` → `session/prompt`, the agent streams
 * `session/update` notifications while the prompt runs, and the prompt's
 * *response* — not a separate notification — is what ends the turn. Permission
 * requests arrive as agent→client requests that block the agent until answered,
 * which is the same shape harness's approval model already speaks.
 *
 * This is the priority abstraction of PLAN.md §7: three of five providers
 * speak ACP, so the protocol lives here once and a provider is a
 * `createAcpDriver` call — cursor (`cursor-agent acp`, a hidden subcommand
 * found by handshaking it directly), opencode (`opencode acp`, documented),
 * and grok (`grok agent stdio`, per Zed's ACP registry for the official
 * Grok Build CLI).
 *
 * Wire facts below were recorded off the live binaries, not guessed: each
 * initialize result, each unauthenticated `session/new` error, and each
 * CLI's model flag and auth-state reporting.
 */

import type { DriverKind } from '@harness/contract'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Driver, DriverConfig, ProbeResult, ProviderEvent, ProviderInstance, ResolvedMcpServer, StartTurnInput } from './types'
import { spawn } from 'node:child_process'
import { probeBinary, runQuiet } from './cli-driver'
import { createLineReader } from './codex'
import { EventQueue } from './event-queue'

/** JSON-RPC frames, only as much of them as this driver reads. */
interface Frame {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code?: number, message?: string, data?: any }
}

/**
 * Parameters for `initialize`.
 *
 * `fs` and `terminal` are declared false deliberately: harness does not proxy
 * the agent's file IO or host its terminals — the agent does its own work in
 * the workspace and asks permission through `session/request_permission`.
 * Declaring a capability we do not serve would hang the agent on a request
 * nothing answers.
 */
export function initializeParams(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  }
}

/**
 * `ResolvedMcpServer[]` → ACP's wire shape.
 *
 * ACP spells env and headers as `{name, value}` lists, not records — a record
 * sent here is silently not an array and the agent sees no variables at all,
 * so the mapping is pinned by a test rather than trusted.
 */
export function mcpServersParam(servers: ResolvedMcpServer[] | undefined): unknown[] {
  if (!servers?.length) return []
  return servers.map(server => server.type === 'stdio'
    ? {
        name: server.name,
        command: server.command,
        args: server.args,
        env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
      }
    : {
        type: server.type,
        name: server.name,
        url: server.url,
        headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
      })
}

/**
 * Translate one `session/update` into provider events.
 *
 * Pure, and exported, so every branch is testable from a recorded frame without
 * a live CLI or a live account — the paths hardest to reach live (permission
 * flows, failed tool calls) are exactly the ones that must not be wrong.
 */
export function translateUpdate(update: any): ProviderEvent[] {
  switch (update?.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = update.content?.type === 'text' ? update.content.text : ''
      return typeof text === 'string' && text.length > 0
        ? [{ type: 'assistant-delta', text }]
        : []
    }

    case 'tool_call': {
      const callId = String(update.toolCallId)
      const begin: ProviderEvent = {
        type: 'tool-call-begin',
        callId,
        toolName: toolNameOf(update),
        args: update.rawInput ?? {},
      }
      // A call can arrive already settled — one frame, no later update. Emitting
      // only the begin would leave the transcript showing it running forever.
      return update.status === 'completed' || update.status === 'failed'
        ? [begin, { type: 'tool-call-end', callId, ok: update.status === 'completed' }]
        : [begin]
    }

    case 'tool_call_update': {
      if (update.status === 'completed' || update.status === 'failed')
        return [{ type: 'tool-call-end', callId: String(update.toolCallId), ok: update.status === 'completed' }]
      // `pending` and `in_progress` describe a call the begin already announced.
      return []
    }

    default:
      // agent_thought_chunk, user_message_chunk, plan, available_commands_update,
      // current_mode_update — agent-internal, or text the transcript already has.
      // Silence is the correct translation.
      return []
  }
}

/** A tool's display name, from whichever field carries one. */
function toolNameOf(update: any): string {
  if (typeof update?.title === 'string' && update.title.length > 0) return update.title
  if (typeof update?.kind === 'string' && update.kind.length > 0) return update.kind
  return 'tool'
}

/**
 * Pick the option that expresses a decision.
 *
 * ACP's permission response names an option the *agent* offered, not a bare
 * boolean — so an allow chooses the least-privileged allow on offer
 * (`allow_once` before `allow_always`: the user approved this call, not every
 * future one), and a decision with no matching option resolves to null, which
 * the caller answers as `cancelled`.
 */
export function permissionChoice(options: any[] | undefined, allow: boolean): string | null {
  const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const kind of kinds) {
    const hit = options?.find(option => option?.kind === kind)
    if (hit?.optionId !== undefined) return String(hit.optionId)
  }
  return null
}

/**
 * The prompt response's `stopReason` → the turn's terminal event.
 *
 * `cancelled` completes rather than errors: the user asked for the stop, and an
 * error would blame them for it. ACP carries no token usage in its core
 * protocol, so usage is zero rather than an invention — the same call Codex's
 * driver makes on cost.
 */
export function terminalOf(stopReason: unknown): ProviderEvent {
  switch (stopReason) {
    case 'end_turn':
    case 'cancelled':
      return { type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 }
    case 'max_tokens':
      return { type: 'error', message: 'the turn hit the model\'s token limit' }
    case 'max_turn_requests':
      return { type: 'error', message: 'the turn hit the agent\'s request limit' }
    case 'refusal':
      return { type: 'error', message: 'the agent refused to continue' }
    default:
      return { type: 'error', message: `the turn stopped (${String(stopReason)})` }
  }
}

/**
 * The sentence a user can act on, from whichever field carries it.
 *
 * Recorded live: an unauthenticated `session/new` puts "Authentication
 * required" in `error.message` and the actionable text — run `agent login`,
 * then authenticate — in `error.data.message`. Surfacing only the outer
 * message would tell the user what is wrong but not what to do.
 */
export function readableAcpError(error: { message?: string, data?: any } | undefined): string {
  const detail = error?.data?.message
  if (typeof detail === 'string' && detail.length > 0) return detail
  if (typeof error?.message === 'string' && error.message.length > 0) return error.message
  return 'the agent reported an error'
}

interface PendingPermission {
  /** The JSON-RPC request id the agent is blocking on. */
  rpcId: number | string
  /** The options the agent offered, because the answer must name one of them. */
  options: any[] | undefined
}

class AcpInstance implements ProviderInstance {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private readonly pending = new Map<number | string, (frame: Frame) => void>()
  private readonly permissions = new Map<string, PendingPermission>()
  private sessionId: string | null = null
  private queue: EventQueue | null = null
  /**
   * `session/load` replays the whole conversation as `session/update`
   * notifications before its response arrives. They are history the transcript
   * already has — emitting them would duplicate every prior turn on resume.
   */
  private replaying = false

  constructor(
    private readonly binary: string,
    private readonly args: string[],
    private readonly config: DriverConfig,
  ) {}

  private async ensureProcess(): Promise<void> {
    if (this.child) return

    const child = spawn(this.binary, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.workspacePath,
      env: this.config.home ? { ...process.env, HOME: this.config.home } : process.env,
    }) as ChildProcessWithoutNullStreams
    this.child = child

    const read = createLineReader(line => this.onLine(line))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => read(chunk))
    // stderr is the agent's own tracing, not part of the protocol; it must not
    // fail a turn, but it must be drained or the child blocks on a full pipe.
    child.stderr.resume()

    child.on('exit', (code) => {
      this.child = null
      this.queue?.finish({ type: 'error', message: `${this.binary} exited (${code})` })
    })

    const initialized = await this.request('initialize', initializeParams())
    if (initialized.error)
      throw new Error(readableAcpError(initialized.error))
  }

  private onLine(line: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(line)
    }
    catch {
      return
    }

    // A response to something we asked.
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const resolve = this.pending.get(frame.id)
      this.pending.delete(frame.id)
      resolve?.(frame)
      return
    }

    // A request *from* the agent — permissions arrive this way and block its
    // turn until answered.
    if (frame.id !== undefined && frame.method) {
      this.onServerRequest(frame)
      return
    }

    if (frame.method) this.onNotification(frame)
  }

  private onServerRequest(frame: Frame): void {
    if (frame.method !== 'session/request_permission') {
      // fs/* and terminal/* cannot arrive — initialize declared them
      // unsupported — so anything else is a method this client does not serve.
      // It still has to be answered, or the agent waits forever; a JSON-RPC
      // error says so honestly, where an empty result would claim it worked.
      this.send({ id: frame.id, error: { code: -32601, message: `harness does not serve ${frame.method}` } })
      return
    }

    const toolCall = frame.params?.toolCall
    const options = frame.params?.options
    const requestId = String(toolCall?.toolCallId ?? frame.id)

    if (this.config.autoApprove) {
      const optionId = permissionChoice(options, true)
      this.respond(frame.id!, { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } })
      return
    }

    this.permissions.set(requestId, { rpcId: frame.id!, options })
    this.queue?.push({
      type: 'approval-request',
      requestId,
      toolName: toolNameOf(toolCall),
      args: toolCall?.rawInput ?? toolCall ?? {},
    })
  }

  private onNotification(frame: Frame): void {
    if (frame.method !== 'session/update') return
    // Replayed history (during session/load) and frames for a session this
    // instance no longer owns must not land in the current turn.
    if (this.replaying) return
    if (this.sessionId && frame.params?.sessionId && frame.params.sessionId !== this.sessionId) return
    for (const event of translateUpdate(frame.params?.update)) this.queue?.push(event)
  }

  private send(frame: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }

  private notify(method: string, params: unknown): void {
    this.send({ method, params })
  }

  private respond(id: number | string, result: unknown): void {
    this.send({ id, result })
  }

  private request(method: string, params: unknown): Promise<Frame> {
    const id = ++this.nextId
    return new Promise<Frame>((resolve) => {
      this.pending.set(id, resolve)
      this.send({ id, method, params })
    })
  }

  startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
    const queue = new EventQueue()
    this.queue = queue

    void this.run(input, queue).catch((error: unknown) => {
      queue.finish({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    return queue
  }

  private async run(input: StartTurnInput, queue: EventQueue): Promise<void> {
    await this.ensureProcess()

    // Resume the provider's own session when we have one, so a restarted server
    // continues the conversation instead of starting a stranger.
    if (input.providerSessionId && !this.sessionId) {
      this.replaying = true
      const loaded = await this.request('session/load', {
        sessionId: input.providerSessionId,
        cwd: this.config.workspacePath,
        mcpServers: mcpServersParam(this.config.mcpServers),
      })
      this.replaying = false
      // A session the agent has forgotten (pruned, or another machine's) must
      // not take the turn down — falling through starts a fresh one.
      if (!loaded.error) this.sessionId = input.providerSessionId
    }

    if (!this.sessionId) {
      const created = await this.request('session/new', {
        cwd: this.config.workspacePath,
        mcpServers: mcpServersParam(this.config.mcpServers),
      })
      if (created.error) {
        queue.finish({ type: 'error', message: readableAcpError(created.error) })
        return
      }
      this.sessionId = created.result?.sessionId ?? null
      if (!this.sessionId) {
        queue.finish({ type: 'error', message: 'the agent created a session with no id' })
        return
      }
      queue.push({ type: 'session-bound', providerSessionId: this.sessionId })
    }

    const done = await this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text: input.text }],
    })
    if (done.error) {
      queue.finish({ type: 'error', message: readableAcpError(done.error) })
      return
    }
    queue.finish(terminalOf(done.result?.stopReason))
  }

  async interrupt(): Promise<void> {
    // No session, no process, nothing to stop — the user pressing stop just as
    // a turn lands is a race, not an error.
    if (!this.child || !this.sessionId) return
    // A notification, not a request: the answer is the running prompt resolving
    // with `stopReason: 'cancelled'`.
    this.notify('session/cancel', { sessionId: this.sessionId })
  }

  async respondApproval(requestId: string, allow: boolean): Promise<void> {
    const permission = this.permissions.get(requestId)
    // A decision for a request that is already gone — a reconnect replaying, or
    // a double-click. Dropping it is correct; throwing would surface a fault
    // the user did not cause.
    if (permission === undefined) return
    this.permissions.delete(requestId)
    const optionId = permissionChoice(permission.options, allow)
    this.respond(permission.rpcId, {
      outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
    })
  }

  async stop(): Promise<void> {
    // Unblock the agent on anything it is still waiting for, so it can exit
    // rather than sit on a pipe we are about to close.
    for (const permission of this.permissions.values())
      this.respond(permission.rpcId, { outcome: { outcome: 'cancelled' } })
    this.permissions.clear()
    this.queue?.finish()
    const child = this.child
    this.child = null
    this.sessionId = null
    child?.kill()
  }
}

/**
 * An ACP driver for one provider.
 *
 * The protocol is the shared part; what varies per provider is the binary, how
 * to reach its ACP mode, and how its CLI reports auth. Grok, when its CLI is
 * installable, should be one more call to this.
 */
export function createAcpDriver(options: {
  kind: DriverKind
  binary: string
  /** argv that puts the binary in ACP mode, given the session's config. */
  acpArgs: (config: DriverConfig) => string[]
  /**
   * How the CLI reports auth, for providers where login is a precondition.
   * Omitted entirely for one where it is not (opencode runs on free-tier
   * models with zero credentials — verified live) — a probe must not claim a
   * login is required when a turn would succeed without one.
   */
  auth?: {
    /** argv whose output reveals auth state, tested against `loggedOutPattern`. */
    probeArgs: string[]
    loggedOutPattern: RegExp
    loginHint: string
  }
}): Driver {
  return {
    kind: options.kind,

    async probe(config: DriverConfig): Promise<ProbeResult> {
      const result = await probeBinary(config.binaryPath ?? options.binary, config.home)
      if (result.status !== 'ready' || !options.auth) return result

      // Installed is not the same as usable. The status subcommand exits 0
      // either way (verified live), so the *text* is the signal.
      const auth = await runQuiet(config.binaryPath ?? options.binary, options.auth.probeArgs, config.home)
      if (!auth.ok || options.auth.loggedOutPattern.test(auth.output))
        return { ...result, status: 'unauthenticated', message: options.auth.loginHint }
      return result
    },

    async create(config: DriverConfig): Promise<ProviderInstance> {
      return new AcpInstance(config.binaryPath ?? options.binary, options.acpArgs(config), config)
    },
  }
}

export const CursorDriver: Driver = createAcpDriver({
  kind: 'cursor',
  binary: 'cursor-agent',
  // `acp` is not in `--help`, but it is real: it answers the initialize
  // handshake (recorded in the module doc). `--model` is accepted alongside it.
  acpArgs: config => config.model ? ['acp', '--model', config.model] : ['acp'],
  auth: {
    probeArgs: ['status'],
    loggedOutPattern: /not logged in/i,
    loginHint: 'run `cursor-agent login`',
  },
})

export const OpenCodeDriver: Driver = createAcpDriver({
  kind: 'opencode',
  binary: 'opencode',
  // `opencode acp` is documented and takes no model flag — the agent applies
  // its own configured default, offered back as a `configOptions` entry on
  // `session/new`. No auth check either: a turn completes on the free tier
  // with `opencode auth list` reporting 0 credentials (verified live), so
  // credentials are optional and the probe must not claim otherwise.
  acpArgs: () => ['acp'],
})

export const GrokDriver: Driver = createAcpDriver({
  kind: 'grok',
  binary: 'grok',
  // The official Grok Build CLI: ACP lives under `agent stdio` (the shape
  // Zed's registry launches), with `-m` between them for the model.
  acpArgs: config => config.model ? ['agent', '-m', config.model, 'stdio'] : ['agent', 'stdio'],
  auth: {
    // There is no `auth status` subcommand; `models` exits 0 either way and
    // prints "You are not authenticated." when logged out (recorded live).
    probeArgs: ['models'],
    loggedOutPattern: /not authenticated/i,
    loginHint: 'run `grok login`',
  },
})
