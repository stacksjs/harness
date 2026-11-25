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

import type { ApprovalChoice, CommandEnvelope, ConnectorApproval, DriverKind, HarnessEvent, InputQuestion, InputResponse, SteeringOutcome } from '@harness/contract'
import type { ChatGptCredentialStore, Driver, ProviderInstance } from '@harness/drivers'
import type { Engine, HarnessState } from '@harness/engine'
import { existsSync } from 'node:fs'
import { inputResponseValues } from '@harness/contract'
import { resolveDriver } from '@harness/drivers'
import { capture, restore } from './checkpoint'
import { missingReferences, resolveForDriver } from './mcp'
import type { SavedProviderInstances, SavedProviderLaunch } from './provider-instances'
import { providerLaunchConfig } from './provider-instances'
import { openScratchWorkspace } from './scratch-workspace'
import * as worktree from './worktree'

export interface RuntimeOptions {
  engine: Engine
  /** Injectable so tests bind a fake driver instead of spawning an agent. */
  resolve?: (kind: DriverKind) => Driver | null
  savedProviders?: Pick<SavedProviderInstances, 'find'>
  chatGptCredentials?: ChatGptCredentialStore
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
  savedLaunch?: SavedProviderLaunch
  /** Provider's own session id, so the next turn resumes rather than restarts. */
  providerSessionId?: string
  /** Approval request id → the id the engine assigned, for routing responses. */
  approvals: Map<number, string>
  inputs: Map<string, { providerId: string, questions: InputQuestion[] }>
  turnId?: number
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

  private async record(command: CommandEnvelope['command']): Promise<void> {
    const result = await this.options.engine.dispatchInternal(this.envelope(command))
    if (result.events.length > 0) this.options.onEvents?.(result.events)
  }

  /** Dispatch a provider-originated command, swallowing rejections. */
  private async emit(command: CommandEnvelope['command']): Promise<void> {
    try {
      await this.record(command)
    }
    catch {
      // A reducer that refuses a provider event (a late completion on an
      // interrupted turn, say) is a normal outcome, not a runtime failure.
      // Tearing down a live agent over it would be worse than ignoring it.
    }
  }

  private async instanceFor(sessionId: number, driverKind: DriverKind): Promise<Running | null> {
    const session = this.options.engine.current.sessions.get(sessionId)
    const workspace = session ? this.options.engine.current.workspaces.get(session.workspaceId) : undefined
    const savedId = session?.providerInstanceId
    const savedLaunch = savedId !== undefined && workspace
      ? this.options.savedProviders?.find(savedId, workspace.profileId, driverKind, workspace.path)
      : undefined
    if (savedId !== undefined && !savedLaunch) {
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: 'The selected provider account is no longer available. Start a session with another account.',
      })
      return null
    }
    const store = this.options.chatGptCredentials
    const clientId = savedLaunch?.chatGptClientId
    if (clientId && (!store || !await store.connected(clientId).catch(() => false))) {
      await this.stopSession(sessionId)
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: 'Reconnect the selected ChatGPT plan on this host before sending another message.',
      })
      return null
    }

    const existing = this.sessions.get(sessionId)
    if (existing) {
      if (existing.savedLaunch?.binaryPath !== savedLaunch?.binaryPath
        || existing.savedLaunch?.home !== savedLaunch?.home
        || existing.savedLaunch?.chatGptClientId !== clientId) {
        await this.emit({
          type: 'thread.error',
          sessionId,
          message: 'The provider account settings changed. Start a new session to use the updated account.',
        })
        return null
      }
      return existing
    }

    const resolve = this.options.resolve ?? resolveDriver
    const driver = resolve(driverKind)
    if (!driver) {
      await this.emit({ type: 'thread.error', sessionId, message: `no driver for ${driverKind}` })
      return null
    }

    // Made now rather than at session creation, so a session nobody runs does
    // not leave a checkout behind.
    if (!await this.ensureWorktree(sessionId)) return null

    const state = this.options.engine.current
    const workspacePath = this.options.workspacePath
      ? this.options.workspacePath(state, sessionId)
      : defaultWorkspacePath(state, sessionId)

    if (!workspacePath) {
      await this.emit({ type: 'thread.error', sessionId, message: 'session has no workspace path' })
      return null
    }

    if (workspace?.scratch) {
      try {
        await openScratchWorkspace(workspacePath)
      }
      catch {
        await this.emit({ type: 'thread.error', sessionId, message: 'Could not open the scratch folder for this session.' })
        return null
      }
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
    let providerConfig
    try {
      providerConfig = store && savedLaunch ? await providerLaunchConfig(store, savedLaunch) : savedLaunch
    }
    catch {
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: 'Could not prepare the private Codex directory for the selected ChatGPT plan.',
      })
      return null
    }
    const launch = {
      ...providerConfig,
      workspacePath,
      autoApprove: this.options.autoApprove,
      model: session?.model || undefined,
      ...(session?.codexTurnOptions ? { codexTurnOptions: session.codexTurnOptions } : {}),
    }
    const probe = await driver.probe(launch)
    if (probe.status !== 'ready') {
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: probe.message ?? `${driverKind} is ${probe.status}`,
      })
      return null
    }

    // The profile's servers, not the session's: a project's tools belong to the
    // project, and every session in it should reach the same ones.
    const profile = workspace ? state.profiles.get(workspace.profileId) : undefined
    const mcpServers = resolveForDriver(profile?.mcpServers ?? [])

    // Said once, before the turn, rather than left to surface as an
    // authentication error from inside the server — which sends you to check a
    // token that was never passed rather than a variable that is not set.
    for (const server of profile?.mcpServers ?? []) {
      if (!server.enabled) continue
      const missing = missingReferences(server, process.env)
      if (missing.length > 0) {
        await this.emit({
          type: 'thread.error',
          sessionId,
          message: `MCP server "${server.name}" needs ${missing.join(', ')} in the environment`,
        })
      }
    }

    const instance = await driver.create({ ...launch, mcpServers })
    const running: Running = {
      instance,
      ...(savedLaunch ? { savedLaunch } : {}),
      approvals: new Map(),
      inputs: new Map(),
      abandoned: false,
      interrupted: false,
    }
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

    if (!this.options.engine.current.workspaces.get(session.workspaceId)?.trusted) {
      await this.emit({ type: 'thread.error', sessionId, turnId, message: 'Trust this workspace before sending a message.' })
      return
    }

    const running = await this.instanceFor(sessionId, session.driverKind)
    if (!running) return

    if (session.turns.at(-1)?.id !== turnId || session.turns.at(-1)?.status !== 'running') return
    running.turnId = turnId
    running.approvals.clear()
    running.inputs.clear()
    running.abandoned = false
    running.interrupted = false

    // Snapshot before the agent touches anything, so this turn can be undone.
    //
    // Awaited rather than fired off: a checkpoint taken *after* the first edit
    // is worse than none, because it looks like a safe point and is not. It
    // costs one `git add -A` against a temporary index, and it is skipped
    // silently for a workspace that is not a repository.
    await this.captureCheckpoint(sessionId, turnId, 'turn-start')
    if (running.abandoned || running.interrupted || running.turnId !== turnId) return

    if (!this.options.engine.current.workspaces.get(session.workspaceId)?.trusted) {
      delete running.turnId
      await this.emit({ type: 'thread.error', sessionId, turnId, message: 'Trust this workspace before sending a message.' })
      return
    }

    try {
      for await (const event of running.instance.startTurn({
        text,
        codexSelection: session.turns.at(-1)?.codexSelection,
        // The projection stores '' for "not bound yet"; the driver wants
        // undefined, so an empty string must not be passed through as a resume
        // target.
        providerSessionId: running.providerSessionId ?? (session.providerSessionId || undefined),
      })) {
        // A stopped session's remaining events are dropped rather than logged:
        // appending to a session the user has torn down writes history nobody
        // asked for, against a projection that has moved on.
        if (running.abandoned || running.turnId !== turnId) break

        switch (event.type) {
          case 'session-bound':
            running.providerSessionId = event.providerSessionId
            await this.emit({
              type: 'thread.session.set',
              sessionId,
              providerSessionId: event.providerSessionId,
            })
            break

          case 'steering-ready':
            if (running.instance.steer && !running.interrupted)
              await this.emit({ type: 'thread.steer.ready', sessionId, turnId })
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
            if (running.interrupted) break
            await this.dispatchApproval(sessionId, event.requestId, event.toolName, event.args, event.connector,
              approvalId => running.approvals.set(approvalId, event.requestId))
            break
          }

          case 'approval-cancelled': {
            const approval = [...running.approvals].find(([, requestId]) => requestId === event.requestId)
            if (!approval) break
            running.approvals.delete(approval[0])
            await this.emit({ type: 'thread.approval.cancel', sessionId, approvalId: approval[0] })
            break
          }

          case 'input-request': {
            if (!running.instance.respondInput || running.interrupted) break
            if ([...running.inputs.values()].some(request => request.providerId === event.requestId)) break
            const envelope = this.envelope({ type: 'thread.input.request', sessionId, turnId, questions: event.questions })
            const result = await this.options.engine.dispatchInternal(envelope)
            if (result.events.length === 0) break
            running.inputs.set(envelope.id, { providerId: event.requestId, questions: event.questions })
            this.options.onEvents?.(result.events)
            break
          }

          case 'input-cancelled': {
            const entry = [...running.inputs].find(([, request]) => request.providerId === event.requestId)
            if (!entry) break
            const [requestId] = entry
            running.inputs.delete(requestId)
            await this.emit({ type: 'thread.input.cancel', sessionId, requestId })
            break
          }

          case 'turn-complete':
            // An isolated session records each turn as a commit on its branch,
            // so the branch is something you can merge rather than an empty
            // pointer beside a dirty worktree.
            await this.commitIsolatedTurn(sessionId, turnId)
            await this.emit({
              type: 'thread.turn.complete',
              sessionId,
              turnId,
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
              cost: event.costMicros,
              ...(event.providerTurnId ? { providerTurnId: event.providerTurnId } : {}),
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
      if (running.interrupted || running.abandoned || running.turnId !== turnId) return
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    finally {
      if (running.turnId === turnId) {
        running.inputs.clear()
        running.approvals.clear()
        delete running.turnId
      }
    }
  }

  /** Make the provider callback reachable before broadcasting the request. */
  private async dispatchApproval(
    sessionId: number,
    requestId: string,
    toolName: string,
    args: unknown,
    connector: ConnectorApproval | undefined,
    remember: (approvalId: number) => void,
  ): Promise<void> {
    const envelope = this.envelope({ type: 'thread.approval.request', sessionId, requestId, toolName, args, connector })
    try {
      const result = await this.options.engine.dispatchInternal(envelope)
      const event = result.events.find(e => e.payload.type === 'approval.requested')
      if (event?.payload.type === 'approval.requested') remember(event.payload.approvalId)
      if (result.events.length > 0) this.options.onEvents?.(result.events)
    }
    catch {}
  }

  async forkSession(sessionId: number): Promise<void> {
    const session = this.options.engine.current.sessions.get(sessionId)
    const fork = session?.fork
    const turn = session?.turns.at(-1)
    if (!session || fork?.state !== 'pending' || !turn) return
    try {
      if (!this.options.engine.current.workspaces.get(session.workspaceId)?.trusted)
        throw new Error('Trust the workspace before creating this fork.')
      const running = await this.instanceFor(sessionId, session.driverKind)
      if (!running?.instance.fork)
        throw new Error('Start the fork again from the source response once its Codex account is available.')
      const current = this.options.engine.current.sessions.get(sessionId)
      if (current?.fork?.state !== 'pending' || current.navigation?.archivedAt
        || !this.options.engine.current.workspaces.get(current.workspaceId)?.trusted)
        throw new Error('The fork was interrupted. Return to the source response to try again.')
      const providerSessionId = await running.instance.fork({
        providerSessionId: fork.providerSessionId,
        providerTurnId: turn.providerTurnId,
        prompt: turn.prompt,
        response: turn.response,
      })
      if (!providerSessionId || providerSessionId === fork.providerSessionId)
        throw new Error('Codex returned the source conversation for this fork.')
      if (running.abandoned) throw new Error('The fork was interrupted. Return to the source response to try again.')
      // A fork is a saved provider conversation. Release the setup process
      // before publishing readiness, since another client can send at once.
      await this.stopSession(sessionId)
      await this.record({ type: 'thread.fork.finished', sessionId, providerSessionId })
    }
    catch (error) {
      await this.emit({
        type: 'thread.fork.failed', sessionId,
        message: error instanceof Error ? error.message : 'Codex could not finish the fork. Try again from the source response.',
      })
      await this.stopSession(sessionId).catch(() => {})
    }
  }

  /**
   * Give an isolated session its own checkout, once.
   *
   * Silent when it cannot: a workspace that is not a repository has nothing to
   * branch from, and a session must still run there. The alternative — refusing
   * the turn — would make `--isolate` a footgun on any directory that happens
   * not to be under version control.
   */
  private async ensureWorktree(sessionId: number): Promise<boolean> {
    const state = this.options.engine.current
    const session = state.sessions.get(sessionId)
    if (!session?.isolate || session.worktreePath) return true

    const forkCheckout = session.fork && state.sessions.get(session.fork.sessionId)?.worktreePath
    const repository = forkCheckout || (this.options.workspacePath
      ? this.options.workspacePath(state, sessionId)
      : repositoryPath(state, sessionId))
    if (!repository || !existsSync(repository)) return true

    // Clears a registration left by a crash, which is otherwise enough to make
    // `worktree add` refuse this session's name.
    await worktree.prune(repository)

    const created = await worktree.create(repository, sessionId)
    if (!created.path || !created.branch) {
      if (created.reason === 'not-a-repository' || created.reason === 'no-commits') return true
      await this.emit({
        type: 'thread.error',
        sessionId,
        message: `could not isolate this session: ${created.reason ?? 'unknown reason'}`,
      })
      return false
    }

    await this.emit({
      type: 'thread.worktree.set',
      sessionId,
      worktreePath: created.path,
      branch: created.branch,
    })
    return true
  }

  /**
   * Commit an isolated turn's work onto its branch.
   *
   * Best effort and silent: a session that is not isolated has no branch, and a
   * turn that changed nothing has nothing to record. Neither is a failure worth
   * interrupting a completed turn over.
   */
  private async commitIsolatedTurn(sessionId: number, turnId: number): Promise<void> {
    const session = this.options.engine.current.sessions.get(sessionId)
    if (!session?.worktreePath) return
    await worktree.commitTurn(session.worktreePath, `harness: turn ${turnId}`)
  }

  /**
   * Snapshot the workspace and record it.
   *
   * Failures are silent by design: a workspace that is not a repository, or a
   * repository with no commits, is an ordinary situation and must not stop a
   * turn from running.
   */
  private async captureCheckpoint(
    sessionId: number,
    turnId: number,
    kind: 'turn-start' | 'turn-end' | 'manual',
  ): Promise<void> {
    const state = this.options.engine.current
    const workspacePath = this.options.workspacePath
      ? this.options.workspacePath(state, sessionId)
      : defaultWorkspacePath(state, sessionId)
    if (!workspacePath || !existsSync(workspacePath)) return

    const result = await capture(workspacePath, `harness checkpoint · session ${sessionId} · turn ${turnId}`)
    if (!result.ref) return

    await this.emit({ type: 'thread.checkpoint.capture', sessionId, turnId, kind, vcsRef: result.ref })
  }

  /**
   * Put the workspace back to a checkpoint.
   *
   * The reducer has already accepted the revert and written `checkpoint.reverted`
   * — the same shape as `turn.started`, where the log records the intent and
   * then the outcome. A restore that fails reports through `thread.error`, so
   * the log never implies a revert that did not reach the disk.
   */
  async revert(sessionId: number, checkpointId: number): Promise<void> {
    const state = this.options.engine.current
    const session = state.sessions.get(sessionId)
    const checkpoint = session?.checkpoints.find(c => c.id === checkpointId)
    if (!checkpoint) return

    const workspacePath = this.options.workspacePath
      ? this.options.workspacePath(state, sessionId)
      : defaultWorkspacePath(state, sessionId)

    if (!workspacePath || !existsSync(workspacePath)) {
      await this.emit({ type: 'thread.error', sessionId, message: 'workspace is not available to revert' })
      return
    }

    const result = await restore(workspacePath, checkpoint.vcsRef)
    if (result.ok) {
      // Only now is the tree actually back. Clients wait for this rather than
      // for the acceptance event, which lands before any file has moved.
      await this.emit({
        type: 'thread.checkpoint.restored',
        sessionId,
        checkpointId,
        restored: result.restored,
        removed: result.removed,
      })
      return
    }

    await this.emit({
      type: 'thread.error',
      sessionId,
      // The ref is a dangling commit, so "unknown checkpoint" usually means
      // `git gc` collected it rather than that anything is broken.
      message: `could not revert: ${result.reason ?? 'unknown reason'}`,
    })
  }

  async steer(sessionId: number, requested: Extract<HarnessEvent['payload'], { type: 'turn.steer.requested' }>): Promise<void> {
    const running = this.sessions.get(sessionId)
    const session = this.options.engine.current.sessions.get(sessionId)
    let outcome: SteeringOutcome = 'rejected'
    if (running?.instance.steer && running.turnId === requested.turnId && !running.interrupted && !running.abandoned
      && session?.state === 'running' && this.options.engine.current.workspaces.get(session.workspaceId)?.trusted) {
      try {
        outcome = await running.instance.steer(requested.text)
      }
      catch {
        outcome = 'uncertain'
      }
    }
    await this.emit({
      type: 'thread.steer.settle', sessionId, id: requested.id, requestId: requested.requestId, outcome,
    })
  }

  async interrupt(sessionId: number): Promise<void> {
    const running = this.sessions.get(sessionId)
    if (!running) return
    // Marked before asking the provider: the abort can surface as an error on
    // the stream before `interrupt()` resolves.
    running.interrupted = true
    running.inputs.clear()
    await running.instance.interrupt()
  }

  /** Route a client's decision back to the provider callback that is blocked. */
  async respondApproval(sessionId: number, approvalId: number, choice: Pick<ApprovalChoice, 'decision' | 'scope'>): Promise<void> {
    const running = this.sessions.get(sessionId)
    if (!running) return
    const requestId = running.approvals.get(approvalId)
    if (!requestId) return
    running.approvals.delete(approvalId)
    await running.instance.respondApproval(requestId, choice.decision === 'allowed', undefined, choice)
  }

  async respondInput(sessionId: number, requestId: string, response: InputResponse): Promise<void> {
    const running = this.sessions.get(sessionId)
    const request = running?.inputs.get(requestId)
    if (!running?.instance.respondInput || !request) return
    const answers = inputResponseValues(response, request.questions)
    if (answers === undefined) return
    const turnId = running.turnId
    running.inputs.delete(requestId)
    try {
      await running.instance.respondInput(request.providerId, answers)
    }
    catch {
      if (running.turnId !== turnId || running.abandoned || running.interrupted) return
      running.interrupted = true
      running.inputs.clear()
      await this.emit({ type: 'thread.error', sessionId, message: 'Could not deliver the answer to the agent.' })
      await running.instance.interrupt().catch(() => {})
    }
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

export interface DoomedWorktree {
  sessionId: number
  path: string
  repository: string
}

/**
 * The worktrees a profile's sessions are holding.
 *
 * Read *before* the profile is deleted, because afterwards the sessions are
 * gone from the projection and their worktree paths with them. Collecting the
 * three fields that matter is cheaper and less fragile than snapshotting the
 * whole state to look at it later.
 */
export function worktreesOfProfile(state: HarnessState, profileId: number): DoomedWorktree[] {
  const doomed: DoomedWorktree[] = []
  for (const session of state.sessions.values()) {
    if (!session.worktreePath) continue
    const workspace = state.workspaces.get(session.workspaceId)
    if (!workspace || workspace.profileId !== profileId) continue
    doomed.push({ sessionId: session.id, path: session.worktreePath, repository: workspace.path })
  }
  return doomed
}

/** Hand those worktrees back, keeping whatever work they hold. */
export async function releaseWorktrees(
  doomed: DoomedWorktree[],
): Promise<Array<{ sessionId: number, path: string, committed: string | null, removed: boolean }>> {
  const released = []
  for (const entry of doomed) {
    const result = await worktree.release(entry.repository, entry.path)
    released.push({ sessionId: entry.sessionId, path: entry.path, committed: result.committed, removed: result.removed })
  }
  return released
}

/** A session's workspace path, or null when it has none. */
export function defaultWorkspacePath(state: HarnessState, sessionId: number): string | null {
  const session = state.sessions.get(sessionId)
  if (!session) return null
  // An isolated session runs in its own checkout, and everything that follows
  // the workspace path — the agent's cwd, checkpoints, the diff — follows it
  // there without knowing the difference.
  if (session.worktreePath) return session.worktreePath
  return state.workspaces.get(session.workspaceId)?.path ?? null
}

/** The workspace a session belongs to, ignoring any worktree. */
export function repositoryPath(state: HarnessState, sessionId: number): string | null {
  const session = state.sessions.get(sessionId)
  if (!session) return null
  return state.workspaces.get(session.workspaceId)?.path ?? null
}
