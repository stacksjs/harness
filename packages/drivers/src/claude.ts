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

import type { AccountInfo, CanUseTool, ElicitationRequest, ElicitationResult, Options, PermissionResult, Query, query as sdkQuery, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalChoice, InputAnswer } from '@harness/contract'
import type { ConversationRewindInput, ConversationRewindResult, Driver, DriverConfig, ForkInput, ForkResult, ProbeResult, ProviderEvent, ProviderInstance, StartTurnInput } from './types'
import { lstat, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ClaudeHistoryRequest, ClaudeHistoryResult } from './claude-history-worker'
import { claudeEnvironment } from './account-environment'
import { generateClaudeCommitMessage } from './commit-message'
import { PREVIEW_THREAD_ENV } from './preview-owner'
import { EventQueue } from './event-queue'
import { toolInputQuestions } from './input-questions'
import { prepareMcpConsent } from './mcp-consent'

// Adapted from apps/server/src/provider/ClaudeProvider.ts at T3 Code
// 902d369808c5c30ae9b178c6c6f86587b8f4f336. See T3CODE-LICENSE.md.
function hasApiKey(apiKeySource: string | undefined): boolean {
  return Boolean(apiKeySource) && apiKeySource !== 'none'
}

export function claudeAuthStatus(account: AccountInfo): 'authenticated' | 'unauthenticated' {
  if (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') {
    return 'authenticated'
  }
  if (account.tokenSource !== 'none') return 'authenticated'
  return hasApiKey(account.apiKeySource) || account.email || account.subscriptionType
    ? 'authenticated'
    : 'unauthenticated'
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function forkTranscript(sessionId: string, env: NodeJS.ProcessEnv | undefined): Promise<string> {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu.test(sessionId))
    throw new Error('Claude Code returned an invalid saved conversation ID.')

  const projects = resolve(env?.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')
  let transcript: string | undefined
  const projectDirectories = await readdir(projects, { withFileTypes: true }).catch(() => {
    throw new Error('Claude Code could not read the selected account’s saved conversations.')
  })
  for (const project of projectDirectories) {
    if (!project.isDirectory()) continue
    const candidate = join(projects, project.name, `${sessionId}.jsonl`)
    const file = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw new Error('Claude Code could not read a saved conversation in the selected account.')
    })
    if (!file?.isFile()) continue
    if (transcript) throw new Error('Claude Code found more than one file for the fork. Choose a different response to fork.')
    transcript = candidate
  }
  if (!transcript) throw new Error('Claude Code could not find the fork in the selected account. Try again from the source response.')
  return transcript
}

/** USD per token → integer micro-USD, so summing turns can't drift on floats. */
function toMicros(usd: number): number {
  return Math.round(usd * 1_000_000)
}

interface PendingPermission {
  kind: 'approval' | 'input'
  queue: EventQueue
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
  toolUseID?: string
}

export class ClaudeInstance implements ProviderInstance {
  private running: Query | null = null
  private historyAbort?: AbortController
  private activeQueue: EventQueue | null = null
  private pending = new Map<string, PendingPermission>()
  private readonly mcpConsents = new Map<string, { queue: EventQueue, acceptance: ElicitationResult, resolve: (result: ElicitationResult) => void }>()
  private nextRequestId = 0

  constructor(private config: DriverConfig, private readonly queryFactory?: typeof sdkQuery) {}

  /**
   * The SDK asks permission through a callback, but the engine expects an
   * event plus a later response. Bridging the two means parking the callback's
   * promise and resolving it when `respondApproval` arrives.
   */
  private async canUseTool(queue: EventQueue, toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    if (options.signal.aborted || queue.closed)
      return { behavior: 'deny', message: 'The turn ended.' }
    const asksQuestion = toolName === 'AskUserQuestion'
    if (!asksQuestion && this.config.autoApprove)
      return { behavior: 'allow', updatedInput: input }

    const requestId = `req_${++this.nextRequestId}`
    let event: ProviderEvent
    if (asksQuestion) {
      const questions = toolInputQuestions(input.questions, 'claude')
      if (!questions) return { behavior: 'deny', message: 'Could not display these questions.' }
      event = { type: 'input-request', requestId, questions }
    }
    else {
      event = { type: 'approval-request', requestId, toolName, args: input }
    }

    return new Promise<PermissionResult>((resolve) => {
      const onAbort = () => {
        this.pending.get(requestId)?.resolve({ behavior: 'deny', message: 'The request was cancelled.' })
        if (asksQuestion) queue.push({ type: 'input-cancelled', requestId })
      }
      this.pending.set(requestId, {
        kind: asksQuestion ? 'input' : 'approval',
        queue,
        input,
        toolUseID: options.toolUseID,
        resolve: (result) => {
          options.signal.removeEventListener('abort', onAbort)
          this.pending.delete(requestId)
          resolve(result)
        },
      })
      options.signal.addEventListener('abort', onAbort, { once: true })
      queue.push(event)
    })
  }

  private async onElicitation(queue: EventQueue, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResult> {
    if (queue.closed || signal.aborted) return { action: 'cancel' }
    const consent = prepareMcpConsent({ ...request }, 'claude')
    const approved = consent?.accepted.get('once')
    if (!consent || approved?.action !== 'accept') return { action: 'cancel' }
    const values = Object.entries(approved.content).flatMap(([key, value]) => {
      if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return [[key, value] as const]
      return []
    })
    if (values.length !== Object.keys(approved.content).length) return { action: 'cancel' }
    const acceptance: ElicitationResult = { action: 'accept', content: Object.fromEntries(values) }
    if (this.config.autoApprove) return acceptance

    const requestId = `mcp_${++this.nextRequestId}`
    return new Promise<ElicitationResult>((resolve) => {
      const onAbort = () => {
        this.mcpConsents.get(requestId)?.resolve({ action: 'cancel' })
        queue.push({ type: 'approval-cancelled', requestId })
      }
      this.mcpConsents.set(requestId, {
        queue,
        acceptance,
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort)
          this.mcpConsents.delete(requestId)
          resolve(result)
        },
      })
      signal.addEventListener('abort', onAbort, { once: true })
      queue.push({ type: 'approval-request', requestId, toolName: consent.name, args: null, connector: consent.connector })
    })
  }

  private options(queue: EventQueue, providerSessionId?: string): Options {
    const options: Options = {
      cwd: this.config.workspacePath,
      canUseTool: (toolName, input, options) => this.canUseTool(queue, toolName, input, options),
      onElicitation: (request, { signal }) => this.onElicitation(queue, request, signal),
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
    options.env = {
      ...claudeEnvironment(this.config),
      ...(this.config.previewOwner ? { [PREVIEW_THREAD_ENV]: this.config.previewOwner } : {}),
    }
    const threshold = this.config.claudeAutoCompactAfter
    if (threshold !== undefined) {
      options.settings = {
        autoCompactWindow: threshold,
        env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(threshold) },
      }
    }
    return options
  }

  startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
    return this.beginTurn(input, false)
  }

  compact(providerSessionId: string, resume?: Pick<StartTurnInput, 'forkAcrossWorktrees' | 'resumeSessionAt'>): AsyncIterable<ProviderEvent> {
    return this.beginTurn({ text: '/compact', providerSessionId, requireResume: true, ...resume }, true)
  }

  async fork(input: ForkInput): Promise<ForkResult | null> {
    if (!input.providerTurnId) return null
    return this.history({ type: 'fork', input: {
      providerSessionId: input.providerSessionId, providerTurnId: input.providerTurnId,
      inheritedProviderTurnIds: input.inheritedProviderTurnIds,
    } })
  }

  async rewind(input: ConversationRewindInput): Promise<ConversationRewindResult> {
    if (this.activeQueue && !this.activeQueue.closed)
      return { outcome: 'unchanged', message: 'Wait for Claude Code to finish the active turn.' }
    // CLI history stays in place. The host persists the verified head and
    // Claude starts there when the edited prompt is sent.
    try {
      return await this.history({ type: 'rewind', input }) ? { outcome: 'rewound' }
        : { outcome: 'unchanged', message: 'Claude Code could not find the selected boundary in this account’s history.' }
    }
    catch {
      return { outcome: 'unchanged', message: 'Claude Code could not read the selected account’s history. Check the account and retry.' }
    }
  }

  private async history<T extends ClaudeHistoryRequest>(request: T): Promise<ClaudeHistoryResult<T>> {
    if (this.historyAbort) throw new Error('Claude Code is already reading conversation history for this thread.')
    const { CLAUDE_CONFIG_DIR, HOME, USERPROFILE } = claudeEnvironment(this.config)
    // SDK history APIs read their caller's environment. Each worker keeps its own account's configuration.
    const worker = new Worker(new URL('./claude-history-worker.ts', import.meta.url), {
      env: { CLAUDE_CONFIG_DIR, HOME, USERPROFILE },
    })
    const abort = new AbortController()
    this.historyAbort = abort
    const deadline = setTimeout(() => abort.abort(new Error('Claude Code timed out while reading conversation history.')), 20_000)
    try {
      return await new Promise<ClaudeHistoryResult<T>>((resolve, reject) => {
        const failed = () => reject(new Error('Claude Code could not read the selected account’s conversation history.'))
        abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })
        worker.once('error', failed)
        worker.once('exit', failed)
        worker.once('message', (message: { result?: ClaudeHistoryResult<T> }) => {
          if (message.result === undefined) failed()
          else resolve(message.result)
        })
        worker.postMessage(request)
      })
    }
    finally {
      clearTimeout(deadline)
      this.historyAbort = undefined
      await worker.terminate()
    }
  }

  private beginTurn(input: StartTurnInput, compacting: boolean): AsyncIterable<ProviderEvent> {
    const queue = new EventQueue()
    this.activeQueue = queue
    void this.run(input, queue, compacting)
    return queue
  }

  private async run(input: StartTurnInput, queue: EventQueue, compacting: boolean): Promise<void> {
    let run: Query | undefined
    let bound = input.providerSessionId ?? null
    let compacted = false
    let providerTurnId: string | undefined
    let occupancy: { model: string, usedTokens: number, promptCacheExpiresAt?: number } | undefined

    try {
      const query = this.queryFactory ?? (await import('@anthropic-ai/claude-agent-sdk')).query
      const options = this.options(queue, input.providerSessionId)
      if (input.forkAcrossWorktrees && input.providerSessionId) {
        // A UUID only reopens sessions recorded for this checkout. Claude
        // also accepts the transcript filename while keeping the new cwd.
        options.resume = await forkTranscript(input.providerSessionId, options.env)
      }
      if (input.resumeSessionAt) {
        if (!input.providerSessionId || !await this.history({ type: 'resume',
          providerSessionId: input.providerSessionId, resumeSessionAt: input.resumeSessionAt,
        })) throw new Error('Claude Code could not find the saved rewind point. Check the selected account before retrying.')
        options.resumeSessionAt = input.resumeSessionAt
      }
      if (queue.closed) return
      const requestedAt = Date.now()
      run = query({ prompt: input.text, options })
      this.running = run
      for await (const message of run as AsyncIterable<SDKMessage>) {
        if ((input.requireResume || input.resumeSessionAt) && 'session_id' in message && message.session_id !== bound) {
          const message = input.resumeSessionAt ? 'Claude Code opened a different conversation. Check the selected account before retrying the saved rewind point.'
            : 'Claude Code opened a different conversation. Send again to continue in a fresh conversation.'
          queue.finish({ type: 'error', message })
          return
        }
        if (!bound && 'session_id' in message && message.session_id) {
          bound = message.session_id
          queue.push({ type: 'session-bound', providerSessionId: message.session_id })
        }

        if (compacting && message.type === 'system' && message.subtype === 'compact_boundary') compacted = true
        if (!compacting && message.type === 'assistant' && message.session_id === bound
          && message.parent_tool_use_id === null && message.uuid && !message.error)
          providerTurnId = message.uuid
        if (!compacting && message.type === 'assistant' && message.parent_tool_use_id === null && message.message.usage) {
          const usage = message.message.usage
          const iterations = (usage as typeof usage & { iterations?: Array<typeof usage & { type: string }> }).iterations
          const sample = iterations?.findLast(iteration => iteration.type === 'message') ?? usage
          const { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens } = sample
          const inputTokens = (input_tokens ?? 0) + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)
          const usedTokens = inputTokens + (output_tokens ?? 0)
          if (Number.isSafeInteger(usedTokens) && inputTokens > 0) {
            // Cache hits alone do not identify the TTL. Only schedule from a reported cache write.
            const cacheCreation = usage.cache_creation
            const ttlMinutes = (cacheCreation?.ephemeral_1h_input_tokens ?? 0) > 0 ? 60
              : (cacheCreation?.ephemeral_5m_input_tokens ?? 0) > 0 ? 5 : 0
            occupancy = {
              model: message.message.model,
              usedTokens,
              ...(ttlMinutes ? { promptCacheExpiresAt: requestedAt + ttlMinutes * 60_000 } : {}),
            }
          }
        }
        for (const event of translate(message)) {
          if (event.type === 'turn-complete') {
            const maxTokens = occupancy && message.type === 'result' ? message.modelUsage?.[occupancy.model]?.contextWindow : undefined
            const contextUsage = occupancy ? {
              usedTokens: occupancy.usedTokens,
              ...(occupancy.promptCacheExpiresAt === undefined ? {} : { promptCacheExpiresAt: occupancy.promptCacheExpiresAt }),
              ...(maxTokens && Number.isSafeInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
            } : undefined
            queue.finish(!compacting ? { ...event, ...(providerTurnId ? { providerTurnId } : {}), ...(contextUsage ? { contextUsage } : {}) } : compacted
              ? { ...event, contextCompacted: true }
              : { type: 'error', message: 'Claude Code finished without confirming context compaction.' })
            return
          }
          if (event.type === 'error') {
            queue.finish(event)
            return
          }
          if (!compacting || event.type !== 'assistant-delta') queue.push(event)
        }
      }
      queue.finish({ type: 'error', message: 'Claude Code ended before reporting a turn result.' })
    }
    catch (error) {
      queue.finish({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
    finally {
      this.releasePending(queue)
      run?.close()
      if (this.running === run) this.running = null
      if (this.activeQueue === queue) this.activeQueue = null
    }
  }

  async interrupt(): Promise<void> {
    // Interrupting when nothing runs is a no-op, not an error: the user pressed
    // stop just as the turn finished.
    const queue = this.activeQueue
    if (!queue) return
    const run = this.running
    queue.finish()
    this.releasePending(queue)
    try {
      await run?.interrupt()
    }
    catch {
      // The turn ended between the check and the call. Nothing to stop.
    }
  }

  async respondApproval(requestId: string, allow: boolean, reason?: string, choice?: Pick<ApprovalChoice, 'decision' | 'scope'>): Promise<void> {
    const mcp = this.mcpConsents.get(requestId)
    if (mcp) {
      mcp.resolve(allow ? mcp.acceptance : { action: choice?.decision === 'cancelled' ? 'cancel' : 'decline' })
      return
    }
    const waiter = this.pending.get(requestId)
    // An unknown id is a late or duplicate answer — drop it rather than throw.
    if (waiter?.kind !== 'approval') return
    waiter.resolve(allow
      // Unmodified: the user approved *this* call, so the tool runs with the
      // arguments they were shown, not with anything rewritten in between.
      ? { behavior: 'allow', updatedInput: waiter.input }
      : { behavior: 'deny', message: reason ?? 'denied by the user' })
  }

  async respondInput(requestId: string, answers: InputAnswer[] | null): Promise<void> {
    const waiter = this.pending.get(requestId)
    if (waiter?.kind !== 'input') throw new Error('Claude Code is no longer waiting for this answer.')
    waiter.resolve(answers === null
      ? { behavior: 'deny', message: 'The user declined to answer.' }
      : {
          behavior: 'allow',
          updatedInput: {
            questions: waiter.input.questions,
            answers: Object.fromEntries(answers.map(({ questionId, values }) => [questionId, values.join(', ')])),
          },
          toolUseID: waiter.toolUseID,
        })
  }

  private releasePending(queue: EventQueue): void {
    for (const waiter of this.pending.values()) {
      if (waiter.queue === queue) waiter.resolve({ behavior: 'deny', message: 'The turn ended.' })
    }
    for (const waiter of this.mcpConsents.values()) {
      if (waiter.queue === queue) waiter.resolve({ action: 'cancel' })
    }
  }

  async stop(): Promise<void> {
    this.historyAbort?.abort(new Error('The conversation history request was stopped.'))
    const run = this.running
    await this.interrupt()
    run?.close()
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
  generateCommitMessage: generateClaudeCommitMessage,

  /** Read the same Claude account used by the SDK without sending a prompt. */
  async probe(config: DriverConfig): Promise<ProbeResult> {
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 25_000)
    let run: Query | undefined
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      run = query({
        // Keep IPC open for initialization without yielding a user message.
        // eslint-disable-next-line require-yield
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal)
        })(),
        options: {
          abortController: abort,
          cwd: config.workspacePath,
          pathToClaudeCodeExecutable: config.binaryPath,
          persistSession: false,
          settings: { disableAllHooks: true },
          allowedTools: [],
          strictMcpConfig: true,
          mcpServers: {},
          env: {
            ...claudeEnvironment(config),
            ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
            CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
            CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
          },
        },
      })

      const { account } = await run.initializationResult()
      if (claudeAuthStatus(account) === 'unauthenticated')
        return { status: 'unauthenticated', message: 'Run `claude auth login` on this machine.' }
      return { status: 'ready' }
    }
    catch (error) {
      if (abort.signal.aborted)
        return { status: 'failed', message: 'Claude Code did not report account status within 25 seconds.' }
      const message = error instanceof Error ? error.message : String(error)
      if (/ENOENT|not found|no such file/i.test(message))
        return { status: 'unavailable', message: 'Claude Code executable was not found.' }
      return { status: 'failed', message: 'Claude Code failed to initialize while checking account status.' }
    }
    finally {
      clearTimeout(deadline)
      abort.abort()
      run?.close()
    }
  },

  async create(config: DriverConfig): Promise<ProviderInstance> {
    return new ClaudeInstance(config)
  },
}
