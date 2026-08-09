/**
 * The provider runtime: the reactor that turns intent into a running agent.
 *
 * The engine records that a turn *started*; this is what makes it happen. It
 * consumes the driver's event stream and feeds each event back through
 * `dispatchInternal`, so provider output takes the same ordered path as every
 * other command — one log, one sequence, one audit trail. Nothing here writes
 * state directly.
 *
 * It sits outside the engine on purpose. The engine's reducer must stay pure
 * and replayable; spawning processes is neither.
 */

import type { CommandEnvelope, DriverKind, HarnessEvent } from '@harness/contract'
import type { Driver, ProviderInstance } from '@harness/drivers'
import type { Engine, HarnessState } from '@harness/engine'
import { existsSync } from 'node:fs'
import { resolveDriver } from '@harness/drivers'

export interface RuntimeOptions {
  engine: Engine
  /** Injectable so tests bind a fake driver instead of spawning an agent. */
  resolve?: (kind: DriverKind) => Driver | null
  /** Resolve a session's workspace path. Defaults to the projection. */
  workspacePath?: (state: HarnessState, sessionId: number) => string | null
  now?: () => number
  /** Auto-approve tool calls. Off by default; see PLAN.md §12. */
  autoApprove?: boolean
  /**
   * Called with the events each provider dispatch produced.
   *
   * Provider output arrives outside the request path, so nothing in the socket
   * handler would otherwise push it. Without this the transcript only appears
   * once the whole turn ends, which defeats streaming entirely.
   */
  onEvents?: (events: HarnessEvent[]) => void
}

interface Running {
  instance: ProviderInstance
  /** Provider's own session id, so the next turn resumes rather than restarts. */
  providerSessionId?: string
  /** Approval request id → the id the engine assigned, for routing responses. */
  approvals: Map<number, string>
  abandoned: boolean
  /**
   * The user asked to stop the turn that is running.
   *
   * A provider reports an abort as a failure — the Claude SDK ends an
   * interrupted turn with `error_during_execution` — so without this a
   * deliberate stop lands in the log as `session.failed`, and the session reads
   * as broken when it did exactly what it was told.
   */
  interrupted: boolean
}

let counter = 0
function commandId(prefix: string): string {
  return `${prefix}_${++counter}_${Math.random().toString(36).slice(2, 10)}`
}

export class ProviderRuntime {
  private sessions = new Map<number, Running>()

  constructor(private options: RuntimeOptions) {}

  private get now(): () => number {
    return this.options.now ?? (() => Date.now())
  }

  private envelope(command: CommandEnvelope['command']): CommandEnvelope {
    return { id: commandId('prov'), at: this.now(), command }
  }

  /** Dispatch a provider-originated command, swallowing rejections. */
  private async emit(command: CommandEnvelope['command']): Promise<void> {
    try {
      const result = await this.options.engine.dispatchInternal(this.envelope(command))
      if (result.events.length > 0) this.options.onEvents?.(result.events)
    }
    catch {
      // A reducer that refuses a provider event (a late completion on an
      // interrupted turn, say) is a normal outcome, not a runtime failure.
      // Tearing down a live agent over it would be worse than ignoring it.
    }
  }

  private async instanceFor(sessionId: number, driverKind: DriverKind): Promise<Running | null> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const resolve = this.options.resolve ?? resolveDriver
    const driver = resolve(driverKind)
    if (!driver) {
      await this.emit({ type: 'thread.error', sessionId, message: `no driver for ${driverKind}` })
      return null
    }

    const state = this.options.engine.current
    const session = state.sessions.get(sessionId)
    const workspacePath = this.options.workspacePath
      ? this.options.workspacePath(state, sessionId)
      : defaultWorkspacePath(state, sessionId)

    if (!workspacePath) {
      await this.emit({ type: 'thread.error', sessionId, message: 'session has no workspace path' })
      return null
    }

    // A workspace can be renamed, unmounted, or cleaned up by the OS between
    // sessions. Agents are spawned with it as their cwd, and a missing cwd
    // surfaces from deep inside the provider as something else entirely — the
    // Claude SDK reports "native binary exists but failed to launch", which
    // sends you to inspect a binary that is perfectly fine.
    if (!existsSync(workspacePath)) {
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: `workspace path no longer exists: ${workspacePath}`,
      })
      return null
    }

    // Probe before creating, so a missing or signed-out CLI surfaces as the fix
    // ("run `codex login`") rather than as an opaque failure part-way through
    // the user's first turn. Probes run once per session, not once per turn.
    const probe = await driver.probe({ workspacePath, autoApprove: this.options.autoApprove })
    if (probe.status !== 'ready') {
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: probe.message ?? `${driverKind} is ${probe.status}`,
      })
      return null
    }

    const instance = await driver.create({
      workspacePath,
      autoApprove: this.options.autoApprove,
      // Empty means "no preference" — the driver must omit it so the provider
      // picks its own default, rather than being asked for a model named ''.
      model: session?.model || undefined,
    })
    const running: Running = { instance, approvals: new Map(), abandoned: false, interrupted: false }
    this.sessions.set(sessionId, running)
    return running
  }

  /**
   * Run one turn to completion, streaming its events into the log.
   *
   * Returns when the provider's stream ends. Callers that must not block on an
   * agent — the socket handler, notably — should not await this.
   */
  async runTurn(sessionId: number, turnId: number, text: string): Promise<void> {
    const session = this.options.engine.current.sessions.get(sessionId)
    if (!session) return

    const running = await this.instanceFor(sessionId, session.driverKind)
    if (!running) return

    running.abandoned = false
    running.interrupted = false

    try {
      for await (const event of running.instance.startTurn({
        text,
        // The projection stores '' for "not bound yet"; the driver wants
        // undefined, so an empty string must not be passed through as a resume
        // target.
        providerSessionId: running.providerSessionId ?? (session.providerSessionId || undefined),
      })) {
        // A stopped session's remaining events are dropped rather than logged:
        // appending to a session the user has torn down writes history nobody
        // asked for, against a projection that has moved on.
        if (running.abandoned) break

        switch (event.type) {
          case 'session-bound':
            running.providerSessionId = event.providerSessionId
            await this.emit({
              type: 'thread.session.set',
              sessionId,
              providerSessionId: event.providerSessionId,
            })
            break

          case 'assistant-delta':
            await this.emit({
              type: 'thread.message.assistant.delta',
              sessionId,
              turnId,
              text: event.text,
            })
            break

          case 'tool-call-begin':
            await this.emit({
              type: 'thread.tool.call.begin',
              sessionId,
              turnId,
              callId: event.callId,
              toolName: event.toolName,
              args: event.args,
            })
            break

          case 'tool-call-end':
            await this.emit({
              type: 'thread.tool.call.end',
              sessionId,
              turnId,
              callId: event.callId,
              ok: event.ok,
            })
            break

          case 'approval-request': {
            const result = await this.dispatchApproval(sessionId, event.requestId, event.toolName, event.args)
            // Map the engine's approval id back to the provider's request id,
            // so a client answering by approval id reaches the right callback.
            if (result !== null) running.approvals.set(result, event.requestId)
            break
          }

          case 'turn-complete':
            await this.emit({
              type: 'thread.turn.complete',
              sessionId,
              turnId,
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
              cost: event.costMicros,
            })
            break

          case 'error':
            // A provider error after an interrupt is the interrupt's own echo.
            // The turn is already settled as interrupted; reporting it again as
            // a failure would overwrite "you stopped this" with "this broke".
            if (running.interrupted) break
            await this.emit({ type: 'thread.error', sessionId, message: event.message })
            break
        }
      }
    }
    catch (error) {
      // Same reasoning as the `error` event: a stream that throws because it
      // was aborted is not a failure the user needs told about.
      if (running.interrupted) return
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Raise an approval and return the id the engine assigned, or null. */
  private async dispatchApproval(
    sessionId: number,
    requestId: string,
    toolName: string,
    args: unknown,
  ): Promise<number | null> {
    const envelope = this.envelope({ type: 'thread.approval.request', sessionId, requestId, toolName, args })
    try {
      const result = await this.options.engine.dispatchInternal(envelope)
      if (result.events.length > 0) this.options.onEvents?.(result.events)
      const event = result.events.find(e => e.payload.type === 'approval.requested')
      return event ? (event.payload as { approvalId: number }).approvalId : null
    }
    catch {
      return null
    }
  }

  async interrupt(sessionId: number): Promise<void> {
    const running = this.sessions.get(sessionId)
    if (!running) return
    // Marked before asking the provider: the abort can surface as an error on
    // the stream before `interrupt()` resolves.
    running.interrupted = true
    await running.instance.interrupt()
  }

  /** Route a client's decision back to the provider callback that is blocked. */
  async respondApproval(sessionId: number, approvalId: number, allow: boolean, reason?: string): Promise<void> {
    const running = this.sessions.get(sessionId)
    if (!running) return
    const requestId = running.approvals.get(approvalId)
    if (!requestId) return
    running.approvals.delete(approvalId)
    await running.instance.respondApproval(requestId, allow, reason)
  }

  async stopSession(sessionId: number): Promise<void> {
    const running = this.sessions.get(sessionId)
    if (!running) return
    running.abandoned = true
    this.sessions.delete(sessionId)
    await running.instance.stop()
  }

  /** Tear every provider down. Called when the server shuts down. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map(id => this.stopSession(id)))
  }
}

/** A session's workspace path, or null when it has none. */
export function defaultWorkspacePath(state: HarnessState, sessionId: number): string | null {
  const session = state.sessions.get(sessionId)
  if (!session) return null
  return state.workspaces.get(session.workspaceId)?.path ?? null
}
