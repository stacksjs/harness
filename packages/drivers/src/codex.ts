/**
 * The Codex driver: `codex app-server`, JSON-RPC v2 over stdio.
 *
 * Written against the protocol the CLI generates for itself
 * (`codex app-server generate-json-schema`), not against guesswork — that
 * schema is the same artifact the Codex team ships their own clients from, so
 * a shape change here is a schema change there rather than a silent drift.
 *
 * The app-server is chosen over `codex exec --json` because it is the only
 * surface that carries approvals: `exec` decides tool permission from its
 * sandbox flags and never asks. Harness's whole approval model depends on the
 * agent being able to ask.
 *
 * One process per provider instance, spawned lazily on the first turn. A thread
 * is Codex's session; its id is what we bind as `providerSessionId` and resume
 * from, which is how a harness session survives a server restart.
 */

import type { DriverConfig, Driver, ProbeResult, ProviderEvent, ProviderInstance, StartTurnInput } from './types'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { probeBinary } from './cli-driver'

/** JSON-RPC frames, only as much of them as this driver reads. */
interface Frame {
  id?: number | string
  method?: string
  params?: any
  result?: any
  error?: { code?: number, message?: string }
}

/** A queue an async generator drains, so producer and consumer can run apart. */
class EventQueue {
  private readonly buffer: ProviderEvent[] = []
  private waiting: ((value: IteratorResult<ProviderEvent>) => void) | null = null
  private done = false

  push(event: ProviderEvent): void {
    if (this.done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: event, done: false })
      return
    }
    this.buffer.push(event)
  }

  /** Emit a final event and close, in one step, so no terminal can race a second. */
  finish(event?: ProviderEvent): void {
    if (this.done) return
    if (event) this.push(event)
    this.done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as never, done: true })
    }
  }

  get closed(): boolean {
    return this.done
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: (): Promise<IteratorResult<ProviderEvent>> => {
        const next = this.buffer.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      },
    }
  }
}

/**
 * Split a byte stream into JSON-RPC lines.
 *
 * Exported because line framing is the part most likely to be subtly wrong —
 * a large tool output arrives in several chunks and a split mid-line silently
 * drops a frame. Tested directly rather than only through a live process.
 */
export function createLineReader(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}

/** The approval methods Codex sends as server→client requests. */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
])

/** A short label for what is being approved, from whichever field carries it. */
export function approvalLabel(method: string, params: any): string {
  if (typeof params?.command === 'string') return params.command
  if (Array.isArray(params?.command)) return params.command.join(' ')
  if (params?.changes && typeof params.changes === 'object')
    return `edit ${Object.keys(params.changes).join(', ')}`
  return method.split('/').filter(p => p !== 'item' && p !== 'requestApproval').join('/')
}

/**
 * Translate one server notification into provider events.
 *
 * Pure, and exported, so every branch is testable from a recorded frame without
 * a live CLI or a live account — which matters here, because the paths hardest
 * to reach live (usage limits, approvals, mid-turn errors) are exactly the ones
 * that must not be wrong.
 */
export function translateNotification(frame: Frame): ProviderEvent[] {
  const { method, params } = frame
  switch (method) {
    case 'item/agentMessage/delta':
      return typeof params?.delta === 'string' && params.delta.length > 0
        ? [{ type: 'assistant-delta', text: params.delta }]
        : []

    case 'item/started': {
      const item = params?.item
      const call = toolCallOf(item)
      return call ? [{ type: 'tool-call-begin', callId: item.id, toolName: call.name, args: call.args }] : []
    }

    case 'item/completed': {
      const item = params?.item
      // `agentMessage` completing is the full text of a message we already
      // streamed as deltas. Re-emitting it here would double every reply.
      const call = toolCallOf(item)
      if (!call) return []
      return [{ type: 'tool-call-end', callId: item.id, ok: isOk(item) }]
    }

    default:
      // Everything else — thread lifecycle, MCP startup, rate limits, model
      // reroutes, warnings — is Codex-internal. Silence is the correct
      // translation; leaking it upward would put noise in the transcript.
      return []
  }
}

function toolCallOf(item: any): { name: string, args: unknown } | null {
  switch (item?.type) {
    case 'commandExecution':
      return { name: 'shell', args: { command: item.command, cwd: item.cwd } }
    case 'fileChange':
      return { name: 'edit', args: { changes: item.changes } }
    case 'mcpToolCall':
      return { name: `${item.server}/${item.tool}`, args: item.arguments }
    case 'dynamicToolCall':
      return { name: item.tool, args: item.arguments }
    case 'webSearch':
      return { name: 'web_search', args: { query: item.query } }
    default:
      return null
  }
}

function isOk(item: any): boolean {
  if (item?.type === 'commandExecution') return item.exitCode === 0
  if (item?.type === 'dynamicToolCall') return item.success !== false
  if (item?.type === 'mcpToolCall') return !item.error
  return item?.status !== 'failed'
}

/** Codex reports tokens but never cost, so cost is 0 rather than an invention. */
export function usageOf(tokenUsage: any): { tokensIn: number, tokensOut: number } {
  const last = tokenUsage?.last
  return {
    tokensIn: Math.max(0, Number(last?.inputTokens ?? 0)),
    tokensOut: Math.max(0, Number(last?.outputTokens ?? 0)),
  }
}

class CodexInstance implements ProviderInstance {
  private child: ChildProcessWithoutNullStreams | null = null
  private nextId = 0
  private readonly pending = new Map<number | string, (frame: Frame) => void>()
  /** Approval id → the JSON-RPC request id Codex is blocking on. */
  private readonly approvals = new Map<string, number | string>()
  private threadId: string | null = null
  private turnId: string | null = null
  private queue: EventQueue | null = null
  private usage = { tokensIn: 0, tokensOut: 0 }
  /**
   * Codex sends an `error` notification *and then* a failed `turn/completed`.
   * Holding the error until completion is what keeps the turn to exactly one
   * terminal event — emitting on arrival would produce two.
   */
  private turnError: string | null = null

  constructor(private readonly config: DriverConfig) {}

  private async ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) return this.child

    const child = spawn(this.config.binaryPath ?? 'codex', ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.workspacePath,
      env: this.config.home ? { ...process.env, HOME: this.config.home } : process.env,
    }) as ChildProcessWithoutNullStreams
    this.child = child

    const read = createLineReader(line => this.onLine(line))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => read(chunk))
    // stderr is Codex's own tracing. It is not part of the protocol and
    // routinely carries warnings on a healthy run, so it must not fail a turn.
    child.stderr.resume()

    child.on('exit', (code) => {
      this.child = null
      // A live turn dies with the process; without this it would await a frame
      // that can no longer arrive.
      this.queue?.finish({ type: 'error', message: `codex app-server exited (${code})` })
    })

    await this.request('initialize', {
      clientInfo: { name: 'harness', title: 'harness', version: '0.1.0' },
    })
    this.notify('initialized', {})
    return child
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

    // A request *from* Codex — approvals arrive this way and block its turn
    // until answered.
    if (frame.id !== undefined && frame.method) {
      this.onServerRequest(frame)
      return
    }

    if (frame.method) this.onNotification(frame)
  }

  private onServerRequest(frame: Frame): void {
    if (!APPROVAL_METHODS.has(frame.method!)) {
      // An unknown server request still has to be answered, or Codex waits
      // forever on a client that simply did not recognise it.
      this.respond(frame.id!, {})
      return
    }

    const requestId = String(frame.params?.approvalId ?? frame.params?.itemId ?? frame.id)
    this.approvals.set(requestId, frame.id!)

    if (this.config.autoApprove) {
      this.respond(frame.id!, { decision: 'accept' })
      this.approvals.delete(requestId)
      return
    }

    this.queue?.push({
      type: 'approval-request',
      requestId,
      toolName: approvalLabel(frame.method!, frame.params),
      args: frame.params,
    })
  }

  private onNotification(frame: Frame): void {
    // Notifications are per-thread and the process may outlive a thread, so
    // frames from a previous one must not land in this turn.
    if (frame.params?.threadId && this.threadId && frame.params.threadId !== this.threadId) return

    switch (frame.method) {
      case 'thread/tokenUsage/updated':
        this.usage = usageOf(frame.params?.tokenUsage)
        return

      case 'error':
        this.turnError = String(frame.params?.error?.message ?? 'codex reported an error')
        return

      case 'turn/completed': {
        const error = this.turnError ?? frame.params?.turn?.error?.message
        this.turnError = null
        this.turnId = null
        this.queue?.finish(error
          ? { type: 'error', message: String(error) }
          : { type: 'turn-complete', ...this.usage, costMicros: 0 })
        return
      }

      default:
        for (const event of translateNotification(frame)) this.queue?.push(event)
    }
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
    this.usage = { tokensIn: 0, tokensOut: 0 }
    this.turnError = null

    void this.run(input, queue).catch((error: unknown) => {
      queue.finish({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    })

    return queue
  }

  private async run(input: StartTurnInput, queue: EventQueue): Promise<void> {
    await this.ensureProcess()

    // Resume the provider's own thread when we have one, so a restarted server
    // continues the conversation instead of starting a stranger.
    if (input.providerSessionId && !this.threadId) {
      const resumed = await this.request('thread/resume', { threadId: input.providerSessionId })
      this.threadId = resumed.result?.thread?.id ?? null
      // A thread Codex has forgotten (pruned, or another machine's) must not
      // take the turn down — falling through starts a fresh one.
      if (resumed.error) this.threadId = null
    }

    if (!this.threadId) {
      const started = await this.request('thread/start', {
        cwd: this.config.workspacePath,
        // Codex enforces its own approval policy; `onRequest` is what makes it
        // ask rather than decide, which is the behaviour harness owns.
        approvalPolicy: this.config.autoApprove ? 'never' : 'onRequest',
        sandbox: this.config.autoApprove ? 'workspace-write' : 'read-only',
        ...(this.config.model ? { model: this.config.model } : {}),
      })
      if (started.error) {
        queue.finish({ type: 'error', message: started.error.message ?? 'thread/start failed' })
        return
      }
      this.threadId = started.result?.thread?.id ?? null
      if (!this.threadId) {
        queue.finish({ type: 'error', message: 'codex started a thread with no id' })
        return
      }
      queue.push({ type: 'session-bound', providerSessionId: this.threadId })
    }

    const turn = await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: input.text }],
    })
    if (turn.error) {
      queue.finish({ type: 'error', message: turn.error.message ?? 'turn/start failed' })
      return
    }
    this.turnId = turn.result?.turn?.id ?? null
  }

  async interrupt(): Promise<void> {
    // No turn, no process, nothing to stop — the user pressing stop just as a
    // turn lands is a race, not an error.
    if (!this.child || !this.threadId || !this.turnId) return
    await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
  }

  async respondApproval(requestId: string, allow: boolean): Promise<void> {
    const id = this.approvals.get(requestId)
    // A decision for a request that is already gone — a reconnect replaying, or
    // a double-click. Dropping it is correct; throwing would surface a fault
    // the user did not cause.
    if (id === undefined) return
    this.approvals.delete(requestId)
    this.respond(id, { decision: allow ? 'accept' : 'decline' })
  }

  async stop(): Promise<void> {
    // Unblock Codex on anything it is still waiting for, so it can exit rather
    // than sit on a pipe we are about to close.
    for (const id of this.approvals.values()) this.respond(id, { decision: 'cancel' })
    this.approvals.clear()
    this.queue?.finish()
    const child = this.child
    this.child = null
    this.threadId = null
    this.turnId = null
    child?.kill()
  }
}

export const CodexDriver: Driver = {
  kind: 'codex',

  async probe(config: DriverConfig): Promise<ProbeResult> {
    const result = await probeBinary(config.binaryPath ?? 'codex', config.home)
    if (result.status !== 'ready') return result

    // Installed is not the same as usable. `codex login status` distinguishes
    // "install the CLI" from "sign in", which are different fixes for the user.
    const auth = await runQuiet(config.binaryPath ?? 'codex', ['login', 'status'], config.home)
    if (!auth.ok || /not logged in/i.test(auth.output)) {
      return { ...result, status: 'unauthenticated', message: 'run `codex login`' }
    }
    return result
  },

  async create(config: DriverConfig): Promise<ProviderInstance> {
    return new CodexInstance(config)
  },
}

function runQuiet(binary: string, args: string[], home?: string): Promise<{ ok: boolean, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: home ? { ...process.env, HOME: home } : process.env,
    })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output }) }, 5000)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, output }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
  })
}
