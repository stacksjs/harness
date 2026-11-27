/**
 * The harness server: one HTTP surface, one WebSocket, one engine.
 *
 * The server is the execution boundary. Clients dispatch commands and subscribe
 * to events; they never spawn a process, touch git, or read the filesystem.
 * That is what makes "drive it from your phone" fall out of the architecture
 * rather than being a feature bolted on later.
 */

import type { CommandEnvelope, DriverKind, HarnessEvent } from '@harness/contract'
import type { Server, ServerWebSocket } from 'bun'
import type { Driver, DriverConfig, ProbeResult } from '@harness/drivers'
import { createHash } from 'node:crypto'
import { access as checkAccess, constants, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ChatGptCredentialStore, driverKinds, resolveDriver as resolveRegisteredDriver } from '@harness/drivers'
import type { DoomedWorktree } from './runtime'
import { CborError, decode, encode, inputResponseValues, questionAllowsAttachments, validInputAnswers } from '@harness/contract'
import { findDenShell } from './pty'
import type { HarnessState, SessionState } from '@harness/engine'
import { checkpointReviewRepositories, claudeIdleCompaction, effectiveClaudeCompaction, Engine, forkResponsePoint, inactivityDeadline, isTurnActive, isVisiblePin, profilePinnedThreads, reduce, SqliteStore, threadUndoOffer, workspaceSettings } from '@harness/engine'
import { AccessControl, isLoopbackHost, sessionCookie, writeLocalToken } from './access'
import { ASSET_PREFIX, AssetCache, respondStxAsset } from './assets'
import type { WorkspaceReviewTurn } from './diff'
import { isWorkspaceGitRoot, reviewWorkspaceDiff, summarizeTurnFiles, workspaceDiff, workspaceDiffContext, workspaceDiffRevision, workspaceReviewOptions } from './diff'
import { AttachmentError, QuestionAttachments } from './question-attachments'
import { openCombinedRepository } from './combined-worktree'
import { ComposerAttachments } from './composer-attachments'
import { buildClientCodec } from './client-bundle'
import { readPreviewServers } from './preview-servers'
import { ProjectClones } from './project-clones'
import type { ProjectScript } from './project-scripts'
import { ProjectScripts, respondProjectScripts, scriptIdPattern } from './project-scripts'
import type { ProjectSetupScope, SettlementReceipt } from './project-setup'
import { ProjectSetup } from './project-setup'
import { respondTranscriptHighlightWorker, TRANSCRIPT_HIGHLIGHT_WORKER } from './transcript-highlight-asset'
import { projectWorktreeLayout, resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { findPromptLinkProject, linkedProject, promptLinkProjects } from './prompt-link-projects'
import { parsePullRequest, promptLinkKeys } from './prompt-links'
import { fetchPullRequest, findPullRequestThread } from './pull-request-links'
import { createStagedCommit, readRepositorySubmission, stagedCommitPreview } from './repository-commit'
import { readRepositoryStatus } from './repository-status'
import { openRepositoryPullRequest, prepareRepositoryPullRequest, readPullRequestSubmission, RepositoryPullRequestError } from './repository-pull-request'
import { readRepositoryPullRequestChecks } from './repository-pull-request-checks'
import { RepositorySyncError, repositorySyncPreview, syncRepository } from './repository-sync'
import type { RepositorySyncAction } from './repository-sync'
import { chatGptCredentialDirectory, providerLaunchConfig, SavedProviderInstances } from './provider-instances'
import { defaultWorkspacePath, ProviderRuntime, releaseWorktrees, worktreesOfProfile } from './runtime'
import { openScratchWorkspace, scratchWorkspacePath } from './scratch-workspace'
import { settingsSection, workspaceReturn } from './settings-location'
import { searchThreads } from './thread-search'
import { respondWorkspaceEditor } from './workspace-editors'
import { createWorkspaceFileSearch } from './workspace-file-search'
import { respondWorkspaceFile } from './workspace-files'
import { threadSidebarLayout } from './thread-sidebar'
import { escapeTranscriptText } from './transcript-markdown'
import { open as openTunnel } from './tunnel'
import { renderHarnessTemplate, renderHarnessView, viewProps } from './views'
import { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { loadWorkspaceReviewComments, pullRequestWorkspace, renderPullRequestMarkdown, submitWorkspaceInlineReview, submitWorkspaceReviewReply, updateWorkspaceFileViewed, updateWorkspacePullRequestLabels, updateWorkspacePullRequestLifecycle, updateWorkspacePullRequestReviewers, updateWorkspaceReviewConversation } from './pull-request-workspace'
import type { PullRequestLabelDraft, PullRequestLifecycleDraft, PullRequestReplyDraft, PullRequestReviewerDraft, PullRequestReviewerEditor } from './pull-request-workspace'
import { TerminalHistoryStore } from './terminal-history'
import { WorkspaceTerminals } from './workspace-terminals'
import type { TerminalScope } from './workspace-terminals'

export interface ServeOptions {
  port?: number
  hostname?: string
  databasePath?: string
  /** Host-owned storage for projectless sessions. */
  scratchDirectory?: string
  chatGptCredentialDirectory?: string
  /** Injectable so tests bind a fake driver instead of spawning a real agent. */
  resolveDriver?: (kind: DriverKind) => Driver | null
  /**
   * Resolve a session's workspace path. Defaults to the projection.
   *
   * The runtime has always accepted this and `serve` never passed it on, so
   * the option existed and did nothing.
   */
  workspacePath?: (state: HarnessState, sessionId: number) => string | null
  /** Auto-approve tool calls. Off by default; see PLAN.md §12. */
  autoApprove?: boolean
  /**
   * Expose this server through a public relay.
   *
   * Requires `remote`. A tunnel in front of an unauthenticated harness is a
   * public shell, and the peer-address check cannot catch it because the tunnel
   * forwards from loopback.
   */
  tunnel?: boolean | { server?: string, subdomain?: string }
  /**
   * Accept connections from devices that are not this machine.
   *
   * Turns on authentication for *every* connection, loopback included — see
   * `access.ts` for why a tunnel makes the peer address meaningless.
   */
  remote?: boolean
  /** Where a local client reads the authenticated host token in remote mode. */
  localTokenPath?: string
}

interface SocketData {
  /**
   * The device that authenticated this socket, when remote access is on.
   *
   * Kept so a revoke can find the sockets it has to close. Authentication
   * happens at upgrade, and a WebSocket then stays open for as long as it
   * likes — so without this, revoking a lost phone would stop it reconnecting
   * while leaving the connection it already had free to keep dispatching.
   */
  deviceId: string | null
  canUseHostPrivileges: boolean
  /** Sessions this socket has subscribed to. Empty means "not subscribed". */
  subscriptions: Set<number>
  catchingUp: Map<number, HarnessEvent[]>
  /**
   * Highest sequence delivered per session. Provider events arrive outside the
   * request path, so the drain pass needs to know what each socket already has
   * rather than re-sending a session's whole log.
   */
  cursors: Map<number, number>
  sidebarWatch?: { profileId: number, pinsOnly: boolean }
}

type HarnessSocket = ServerWebSocket<SocketData>

/** Frames a client may send. */
type ClientFrame =
  | { t: 'dispatch', envelope: CommandEnvelope }
  | { t: 'subscribe', sessionId: number, sinceSeq?: number }
  | { t: 'unsubscribe', sessionId: number }
  | { t: 'watch-pins', profileId: number }
  | { t: 'watch-sidebar', profileId: number }
  | { t: 'read-settings', workspaceId?: number }
  | { t: 'ping' }
  | { t: 'term-open', workspaceId: number, sessionId?: number, resumeKey?: string, resumeOnly?: true, cols?: number, rows?: number, projectScriptId?: string }
  | { t: 'term-input', termId: number, data: string }
  | { t: 'term-resize', termId: number, cols: number, rows: number }
  | { t: 'term-detach', termId: number }
  | { t: 'term-close', termId: number }

export interface HarnessServer {
  server: Server<SocketData>
  engine: Engine
  runtime: ProviderRuntime
  /** Null unless remote access is on. */
  access: AccessControl | null
  /** The public URL, when a tunnel was opened. */
  tunnelUrl: string | null
  /**
   * Tell the server a native window has just been launched, so it can report
   * cold start when that window's page checks in.
   */
  markWindowSpawned: () => void
  stop: () => void
}

async function projectDirectory(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    throw new Error('Enter an absolute folder path on the host.')
  try {
    const resolved = await realpath(path)
    if ((await stat(resolved)).isDirectory()) {
      await checkAccess(resolved, constants.R_OK | constants.X_OK)
      return resolved
    }
  }
  catch { /* Missing and unreadable paths get the same actionable message. */ }
  throw new Error('The host could not open that folder.')
}

export async function serve(options: ServeOptions = {}): Promise<HarnessServer> {
  const port = options.port ?? 3789
  const hostname = options.hostname ?? '127.0.0.1'
  const remote = options.remote === true

  // Fail closed. Binding a socket that starts agents to a public interface with
  // no authentication is not a configuration to warn about and continue past —
  // by the time a warning is read, the port is open.
  if (!remote && !isLoopbackHost(hostname)) {
    throw new Error(
      `refusing to bind ${hostname} without authentication: pass remote: true (\`--remote\`) to accept devices, `
      + 'or bind 127.0.0.1 to stay local',
    )
  }

  // Checked here rather than where the tunnel is opened, which happens after
  // the socket is listening: refusing there would leave a bound port and an
  // open database behind for a mistake we can see before binding anything.
  if (options.tunnel && !remote) {
    throw new Error(
      'refusing to open a tunnel on a server without authentication: a public URL in front of '
      + 'harness is a public shell. Pass remote: true (`--remote`) and pair your devices first.',
    )
  }

  // After the bind check, so a refused start leaves no database behind.
  const databasePath = options.databasePath ?? 'database/stacks.sqlite'
  const attachments = new QuestionAttachments(resolve(databasePath + '.harness-attachments'))
  const composerAttachments = new ComposerAttachments(resolve(databasePath + '.harness-composer-files'), () => engine.current)
  const attachmentOwners = new WeakMap<CommandEnvelope, string>()
  const hostSettlements = new WeakSet<CommandEnvelope>()
  const deletionWorktrees = new WeakMap<CommandEnvelope, DoomedWorktree[]>()
  const scratchDirectory = resolve(options.scratchDirectory ?? join(homedir(), '.harness', 'scratch'))
  const store = new SqliteStore(databasePath)
  const reviewReplies = new PullRequestReplyReceipts(databasePath)
  const previewDatabase = await realpath(databasePath).catch(() => resolve(databasePath))
  const previewOwner = (sessionId: number) => createHash('sha256').update(previewDatabase).update('\0').update(String(sessionId)).digest('hex')
  const savedProviders = new SavedProviderInstances(databasePath)
  const projectScripts = new ProjectScripts(databasePath)
  const projectSetup = new ProjectSetup(databasePath)
  const settlementAbort = new AbortController()
  const chatGptCredentials = new ChatGptCredentialStore(options.chatGptCredentialDirectory ?? chatGptCredentialDirectory())
  const engine = new Engine({
    store,
    reducer: reduce,
    commitCommand(envelope, events) {
      const identity = { commandId: envelope.id, at: envelope.at }
      if (!hostSettlements.has(envelope) && envelope.command.type !== 'thread.settle.inactive')
        return store.commitCommand(identity, events)
      return store.commitCommand(identity, events, (writer, committed) => {
        for (const event of committed) {
          if (event.payload.type !== 'session.navigation-changed' || typeof event.payload.changes.settledAt !== 'number') continue
          const session = engine.current.sessions.get(event.sessionId)
          if (!session?.isolate || !session.worktreePath) continue
          const workspace = engine.current.workspaces.get(session.workspaceId)
          if (!workspace?.trusted || workspace.scratch) continue
          const script = projectScripts.list(workspace.id).find(script => script.runOnSettle)
          if (!script) continue
          projectSetup.reserveSettlement(writer, { workspaceId: workspace.id, sessionId: session.id, checkout: session.worktreePath },
            event.seq, event.payload.changes.settledAt, script, settlementFingerprint(script))
        }
      })
    },
    async prepareClientCommand(command, envelope) {
      if (command.type === 'profile.delete')
        deletionWorktrees.set(envelope, worktreesOfProfile(engine.current, command.profileId))
      if (command.type === 'profile.claude-compaction.update'
        && !savedProviders.find(command.providerInstanceId, command.profileId, 'claude', tmpdir()))
        throw new Error('This Claude account is unavailable in the selected profile.')
      if (command.type === 'session.input.respond') {
        const pending = engine.current.sessions.get(command.sessionId)?.pendingInputs.find(input => input.requestId === command.requestId)
        const answers = pending && inputResponseValues(command, pending.questions)
        if (pending && validInputAnswers(pending.questions, answers) && answers.some(answer => answer.attachmentIds?.length)) {
          const stored = await attachments.resolve(command.sessionId, command.requestId, answers, attachmentOwners.get(envelope) ?? 'local')
          return { ...command, type: 'thread.input.answer', answers, attachments: stored }
        }
      }
      if (command.type === 'session.scratch.create') {
        if (!driverKinds().includes(command.driverKind)) throw new Error('Choose an available agent to start this session.')
        return {
          type: 'thread.scratch.create',
          profileId: command.profileId,
          driverKind: command.driverKind,
          path: scratchWorkspacePath(scratchDirectory, envelope.id, command.label),
          ...(command.model ? { model: command.model } : {}),
          ...(command.codexTurnOptions === undefined ? {} : { codexTurnOptions: command.codexTurnOptions }),
        }
      }
      if (command.type === 'session.handoff' && !driverKinds().includes(command.driverKind))
        throw new Error('Choose an available provider.')
      if ((command.type === 'session.create' || command.type === 'session.handoff') && command.providerInstanceId !== undefined) {
        const workspaceId = command.type === 'session.create' ? command.workspaceId : engine.current.sessions.get(command.sessionId)?.workspaceId
        const workspace = workspaceId === undefined ? undefined : engine.current.workspaces.get(workspaceId)
        if (!workspace || !savedProviders.find(command.providerInstanceId, workspace.profileId, command.driverKind, workspace.path))
          throw new Error('The selected provider account is unavailable for this project.')
      }
      if (command.type === 'session.fork') {
        const source = engine.current.sessions.get(command.sessionId)
        if (source?.providerInstanceId !== undefined) {
          const workspace = engine.current.workspaces.get(source.workspaceId)
          if (!workspace || !savedProviders.find(source.providerInstanceId, workspace.profileId, source.driverKind, workspace.path))
            throw new Error('The provider account selected for this fork is unavailable.')
        }
      }
      if (command.type === 'workspace.promote') {
        const workspace = engine.current.workspaces.get(command.workspaceId)
        if (workspace?.scratch) await openScratchWorkspace(workspace.path)
      }
      if ((command.type === 'session.turn.start' || command.type === 'session.queue.add' || command.type === 'session.handoff') && command.uploads !== undefined) {
        const files = await composerAttachments.resolve(command.uploads, command.sessionId, attachmentOwners.get(envelope) ?? 'local')
        return { type: 'thread.composer.submit', intent: command, attachments: files }
      }
      if (command.type !== 'workspace.register') return command
      if (typeof command.trusted !== 'boolean')
        throw new Error('Choose whether to trust the folder.')
      const path = await projectDirectory(command.path)
      return { ...command, path }
    },
  })
  const runtime = new ProviderRuntime({
    engine,
    resolve: options.resolveDriver,
    savedProviders,
    chatGptCredentials,
    composerAttachmentPath: attachment => composerAttachments.path(attachment),
    workspacePath: options.workspacePath,
    previewOwner,
    combinedWorktreesDirectory: resolve(databasePath + '.harness-worktrees'),
    reserveWorktreeSetup(scope, reason) {
      const script = projectScripts.list(scope.workspaceId).find(script => script.runOnWorktreeCreate)
      if (reason === 'restored') {
        const previous = projectSetup.reserveRestored(scope, script)
        if (previous?.status === 'running') terminals.stopProjectJob({ ...scope, resumeKey: previous.resumeKey })
      }
      else if (script) projectSetup.reserve(scope, script)
    },
    runWorktreeSetup(scope, signal) {
      return projectSetup.run(scope, signal, async (receipt) => {
        const script = projectScripts.get(scope.workspaceId, receipt.scriptId)
        return script?.runOnWorktreeCreate
          ? openProjectWorktreeTerminal(scope, receipt.resumeKey, script, signal)
          : null
      })
    },
    autoApprove: options.autoApprove,
    // Push provider output the moment it lands, so a transcript streams rather
    // than appearing all at once when the turn ends.
    onEvents(events) {
      broadcast(events)
      for (const event of events) {
        if (event.payload.type === 'turn.steer.resolved') advanceFollowUps(event.sessionId)
        if (event.payload.type === 'input.resolved' || event.payload.type === 'turn.interrupted'
          || event.payload.type === 'turn.failed' || event.payload.type === 'turn.completed') pruneQuestionAttachments(event.sessionId)
      }
    },
  })

  function settlementFingerprint(script: ProjectScript): string {
    return createHash('sha256').update(JSON.stringify(script)).digest('hex')
  }

  function projectWorktreeIsTrusted(scope: ProjectSetupScope): boolean {
    const session = engine.current.sessions.get(scope.sessionId)
    const workspace = engine.current.workspaces.get(scope.workspaceId)
    return !closing && session?.workspaceId === scope.workspaceId && session.worktreePath === scope.checkout
      && !session.navigation?.archivedAt && workspace?.trusted === true && !workspace.scratch
  }

  function openProjectWorktreeTerminal(scope: ProjectSetupScope, resumeKey: string, script: ProjectScript, signal: AbortSignal,
    settlement?: SettlementReceipt,
  ): Promise<number | null> {
    const authorized = () => !signal.aborted && projectWorktreeIsTrusted(scope)
      && (!settlement || Boolean(activeSettlementScript(settlement)))
    const workspace = engine.current.workspaces.get(scope.workspaceId)
    const shellKind = workspaceSettings(engine.current, scope.workspaceId).terminalShell
    const shell = shellKind === 'den' ? findDenShell() : undefined
    if (!workspace || shell === null || !authorized()) return Promise.resolve(null)
    const env = { T3CODE_PROJECT_ROOT: workspace.path, T3CODE_WORKTREE_PATH: scope.checkout }
    return terminals.runProjectJob({ workspaceId: scope.workspaceId, sessionId: scope.sessionId, resumeKey }, shellKind, {
      cwd: scope.checkout, cols: 80, rows: 24, shell, command: script.command, env, authorized, denIntegration: shellKind === 'den',
    }, script, signal, settlement !== undefined)
  }

  function activeSettlementScript(receipt: SettlementReceipt): ProjectScript | undefined {
    if (!projectWorktreeIsTrusted(receipt) || engine.current.sessions.get(receipt.sessionId)?.settledSeq !== receipt.seq) return
    const script = projectScripts.get(receipt.workspaceId, receipt.scriptId)
    if (script?.runOnSettle && settlementFingerprint(script) === receipt.fingerprint) return script
  }

  function runPendingSettlements(sessionId?: number): void {
    if (closing) return
    try {
      for (const receipt of projectSetup.pendingSettlements(sessionId)) {
        projectSetup.runSettlement(receipt, async () => {
          if (!activeSettlementScript(receipt) || !await runtime.checkProjectWorktree(receipt)) return 'skipped'
          const script = activeSettlementScript(receipt)
          if (!script) return 'skipped'
          return openProjectWorktreeTerminal(receipt, receipt.resumeKey, script, settlementAbort.signal, receipt)
        })
      }
    }
    catch {
      // The settlement was already accepted. A busy writer cannot un-settle it.
      settlementRetry ??= setTimeout(() => {
        settlementRetry = undefined
        runPendingSettlements()
      }, 1000)
    }
  }

  function runSettlementEffects(events: readonly HarnessEvent[]): void {
    for (const event of events) {
      if (event.payload.type !== 'session.navigation-changed' || typeof event.payload.changes.settledAt !== 'number') continue
      terminals.stopScriptJobs(event.sessionId)
      runPendingSettlements(event.sessionId)
    }
  }

  function pruneQuestionAttachments(sessionId: number): void {
    void attachments.prune(sessionId, () => {
      const session = engine.current.sessions.get(sessionId)
      const keep = new Map<string, ReadonlySet<string> | null>()
      for (const turn of session?.turns ?? []) {
        for (const request of turn.inputRequests ?? []) {
          if (request.outcome === 'pending') keep.set(request.requestId, null)
          else if (request.attachments?.length) keep.set(request.requestId, new Set(request.attachments.map(file => file.id)))
        }
      }
      return keep
    }).catch(() => {})
  }
  const resolveDriver = options.resolveDriver ?? resolveRegisteredDriver
  type PublicProbe = Pick<ProbeResult, 'status' | 'version' | 'models'>
  const driverProbes = new Map<string, { at: number, result: Promise<PublicProbe> }>()

  function probeDriver(kind: DriverKind, config: DriverConfig, includeModels = false): Promise<PublicProbe> {
    const key = JSON.stringify([kind, config.workspacePath, config.binaryPath, config.home, includeModels])
    const now = Date.now()
    for (const [key, value] of driverProbes) {
      if (now - value.at >= 30_000) driverProbes.delete(key)
    }
    const cached = config.chatGptPlan ? undefined : driverProbes.get(key)
    if (cached) return cached.result

    const result = (async (): Promise<PublicProbe> => {
      const driver = resolveDriver(kind)
      if (!driver) return { status: 'unavailable' }
      try {
        const { status, version, models } = await driver.probe(config, { includeModels })
        return { status, version, ...(includeModels && models ? { models } : {}) }
      }
      catch {
        return { status: 'failed' }
      }
    })()
    if (!config.chatGptPlan) driverProbes.set(key, { at: now, result })
    return result
  }

  // Hydrate before listening, not after. A socket that connects into a
  // half-built read model would be served a projection missing everything the
  // log has not replayed yet, and it has no way to tell.
  await engine.hydrate()
  const projectClones = new ProjectClones(databasePath, async (id, path, profileId) => {
    const result = await engine.dispatch({
      id, at: Date.now(),
      command: { type: 'workspace.register', path, trusted: false, ...(profileId === null ? {} : { profileId }) },
    })
    const added = result.events.find(event => event.payload.type === 'workspace.added')?.payload
    if (added?.type !== 'workspace.added' || added.path !== path || (profileId !== null && added.profileId !== profileId))
      throw new Error('The cloned folder could not be registered.')
    if (!result.replayed) broadcast(result.events)
    return { workspace: added.workspaceId, profile: added.profileId }
  })

  // Close out turns that were in flight when the process last stopped.
  //
  // A turn only runs because a provider instance is running it, and those die
  // with the process. Replay faithfully restores the running or waiting
  // session, but nothing is going to finish it. Left alone it will not accept a new
  // turn ("a turn is already running") and it will not accept a revert, so the
  // only recovery is for someone to notice and press stop.
  //
  // Recorded as an interruption rather than quietly rewritten, so the log says
  // what happened.
  for (const session of engine.current.sessions.values()) {
    if (session.worktreeIntent) await runtime.recoverWorktree(session.id)
    if (session.pendingRewind) await runtime.recoverRewind(session.id)
    if (session.conversationRewind) await runtime.recoverConversationRewind(session.id)
    if (session.fork?.state === 'pending') {
      await engine.dispatchInternal({
        id: `boot_fork_${session.id}`,
        at: Date.now(),
        command: { type: 'thread.fork.failed', sessionId: session.id, message: 'The host restarted while creating this fork. Return to the source response to try again.' },
      })
    }
    for (const entry of session.followUps.entries) {
      if (!entry.steering) continue
      await engine.dispatchInternal({
        id: `boot_steer_${crypto.randomUUID()}`,
        at: Date.now(),
        command: { type: 'thread.steer.settle', sessionId: session.id, id: entry.id, requestId: entry.steering.requestId, outcome: 'uncertain' },
      })
    }
    const turn = session.turns.at(-1)
    if (isTurnActive(session.state) && turn?.status === 'running') {
      await engine.dispatchInternal({
        id: `boot_interrupt_${session.id}_${turn.id}`,
        at: Date.now(),
        command: { type: 'session.turn.interrupt', sessionId: session.id },
      })
    }
    else if (session.followUps.entries.length && !session.followUps.held) {
      await engine.dispatchInternal({
        id: `boot_queue_hold_${session.id}_${session.lastSeq}`,
        at: Date.now(),
        command: { type: 'thread.queue.hold', sessionId: session.id },
      })
    }
  }
  for (const id of await attachments.sessionIds().catch(() => [])) pruneQuestionAttachments(id)

  // Built after hydrate so the paired-device list it reads is the real one.
  const access = remote
    ? new AccessControl({
        remote: true,
        devices: () => engine.current.devices.values(),
        onPair: async (device) => {
          await engine.dispatchInternal({
            id: `pair_${device.id}`,
            at: Date.now(),
            command: { type: 'device.pair', deviceId: device.id, name: device.name, tokenHash: device.tokenHash },
          })
        },
      })
    : null

  // Written before listening: a desktop app that autostarts alongside the
  // server would otherwise race the file and fail its first connection.
  if (access) await writeLocalToken(access.localToken, options.localTokenPath)

  function canUseHostPrivileges(request: Request, url: URL): boolean {
    const origin = request.headers.get('origin')
    return isLoopbackHost(url.hostname)
      && (origin === null || origin === url.origin)
      && (!access || access.authenticate(request).deviceId === 'local')
  }

  function workspaceFileRoot(params: URLSearchParams): string | null {
    const sessionId = params.get('session')
    const session = sessionId === null ? undefined : engine.current.sessions.get(Number(sessionId))
    const workspaceId = sessionId === null ? Number(params.get('workspace')) : session?.workspaceId
    const workspace = workspaceId === undefined ? undefined : engine.current.workspaces.get(workspaceId)
    if (!workspace?.trusted || workspace.scratch) return null
    return session ? defaultWorkspacePath(engine.current, session.id) : workspace.path
  }

  async function reviewRepositoryPath(root: string, session: SessionState | undefined, repository: string): Promise<string | null> {
    const combined = session?.combinedWorktree
    if (!combined) return repository ? resolveProjectRepository(root, repository) : root
    const checkout = combined.checkouts.find(entry => entry.key === repository)
    return checkout ? openCombinedRepository(combined, checkout) : repository ? null : root
  }

  const repositoryActions = new Set<string>()
  type RepositoryAction = 'commit' | 'pull-request' | 'pull-request-checks' | RepositorySyncAction

  async function respondRepositoryAction(request: Request, url: URL, sessionId: number, action: RepositoryAction, extendTimeout: () => void): Promise<Response> {
    const headers = { 'cache-control': 'private, no-store' }
    const respond = (body: object, status = 200) => Response.json(body, { headers, status })
    const site = request.headers.get('sec-fetch-site')
    if (site === 'cross-site' || site === 'same-site' || !canUseHostPrivileges(request, url))
      return new Response(null, { status: 403, headers })
    const readingChecks = action === 'pull-request-checks'
    if (request.method !== 'GET' && (readingChecks || request.method !== 'POST'))
      return new Response(null, { status: 405, headers })
    const key = url.searchParams.get('repository') ?? ''
    const submitted = request.method === 'POST'
    const pullInput = submitted && action === 'pull-request' ? await readPullRequestSubmission(request) : null
    const input = submitted && action !== 'pull-request' ? await readRepositorySubmission(request) : null
    if (submitted && (!input && !pullInput || action === 'commit' && !input?.message))
      return respond({ error: action === 'commit' ? 'Enter a commit message and reopen the staged review if needed.' : 'Reopen the Git action to confirm it.' }, 400)

    const session = engine.current.sessions.get(sessionId)
    const workspace = session && engine.current.workspaces.get(session.workspaceId)
    if (!session || !workspace?.trusted || workspace.scratch || (!readingChecks && session.navigation?.archivedAt)
      || (session.isolate && !session.worktreePath))
      return respond({ error: 'This thread needs an available, trusted checkout.' }, 404)
    const worktree = session.worktreePath
    const root = worktree || workspace.path
    if (worktree && !await runtime.checkProjectWorktree({ workspaceId: workspace.id, sessionId, checkout: root }))
      return respond({ error: 'The thread’s worktree is unavailable.' }, 404)
    const repository = await reviewRepositoryPath(root, session, key).then(path => path && realpath(path)).catch(() => null)
    if (!repository || !await isWorkspaceGitRoot(repository))
      return respond({ error: 'This repository is unavailable in the thread’s checkout.' }, 404)
    if (!readingChecks && repositoryActions.has(repository)) return respond({ error: 'A Git action is already running in this repository.' }, 409)
    if (submitted) repositoryActions.add(repository)
    if (submitted || action === 'pull-request' || readingChecks) extendTimeout()

    const authorize = () => {
      const current = engine.current.sessions.get(sessionId)
      return !closing && current?.worktreePath === worktree && current.workspaceId === workspace.id
        && !current.navigation?.archivedAt && engine.current.workspaces.get(workspace.id)?.trusted === true
        && ![...engine.current.sessions.values()].some(thread => isTurnActive(thread.state)
          && (worktree ? thread.worktreePath === root : thread.workspaceId === workspace.id && !thread.worktreePath))
    }

    try {
      if (readingChecks) {
        const link = (thread: SessionState) => thread.linkedPullRequests?.findLast(pull => pull.repositoryKey === key)
          ?? (thread.pullRequest?.repositoryKey === key ? thread.pullRequest : undefined)
        const pull = link(session)
        if (!pull) return respond({ error: 'There is no pull request linked to this repository.' }, 404)
        const checks = await readRepositoryPullRequestChecks(repository, pull, request.signal)
        const current = engine.current.sessions.get(sessionId)
        if (closing || current?.worktreePath !== worktree || current.workspaceId !== workspace.id || link(current) !== pull
          || !engine.current.workspaces.get(workspace.id)?.trusted)
          return respond({ error: 'The linked checkout changed. Open its checks again.' }, 409)
        return respond(checks)
      }
      if (action === 'pull-request') {
        const base = pullInput?.baseRef ?? url.searchParams.get('base') ?? undefined
        if (base !== undefined && Buffer.byteLength(base) > 1024) return respond({ error: 'The base branch name is too long.' }, 400)
        const prepared = await prepareRepositoryPullRequest(repository, base)
        const { preview } = prepared
        if (!pullInput) return respond(preview)
        if (preview.revision !== pullInput.revision)
          return respond({ error: 'The branch, remote, or pull request changed. Refresh the review before continuing.' }, 409)
        if (preview.problem) return respond({ error: preview.problem }, 409)
        if (!preview.existing && !pullInput.title) return respond({ error: 'Enter a pull request title.' }, 400)
        const result = await openRepositoryPullRequest(repository, prepared, pullInput, authorize)
        const { repository: name, number } = result.pullRequest
        const linked = authorize() && await engine.dispatchInternal({
          id: 'pull_request_link_' + crypto.randomUUID(), at: Date.now(),
          command: { type: 'thread.pull-request.link', sessionId, pullRequest: { repository: name, number, repositoryKey: key } },
        }).then(() => true, () => false)
        return respond({ ...result, linked }, result.existing ? 200 : 201)
      }
      const preview = action === 'commit' ? await stagedCommitPreview(repository) : await repositorySyncPreview(repository, action)
      if (!input) return respond(preview)
      if (preview.problem) return respond({ error: preview.problem }, 409)
      if (preview.revision !== input.revision)
        return respond({ error: action === 'commit' ? 'The branch or staged files changed. Review the updated files before committing.'
          : 'The branch or remote changed. Review the Git action again.' }, 409)
      if (!authorize())
        return respond({ error: 'The checkout changed or a turn is still active. Wait for it to finish and try again.' }, 409)
      if ('files' in preview) return respond({ commit: await createStagedCommit(repository, input.message) }, 201)
      return respond(await syncRepository(repository, action as RepositorySyncAction, preview, authorize))
    }
    catch (error) {
      if (error instanceof RepositorySyncError || error instanceof RepositoryPullRequestError) return respond({ error: error.message }, 409)
      if (readingChecks) return respond({ error: 'Could not read checks from GitHub. Try again.' }, 503)
      return respond({ error: action === 'commit' ? (input
        ? 'Git could not confirm the commit. Check the repository, hooks, and signing before retrying.'
        : 'Git could not read the staged changes.')
        : 'Git could not complete this action. Check the remote, connection, and Git credentials, then review the branch.' }, 503)
    }
    finally { if (submitted) repositoryActions.delete(repository) }
  }

  async function renderWorkspaceReview(root: string | null, url: URL, operation: string | undefined,
    session: SessionState | undefined, trusted: boolean): Promise<Response> {
    const headers = { 'cache-control': 'private, no-store' }
    const errorDiff = (error: string) => ({ isRepository: false, scope: 'working-tree', files: [], patch: '', error })
    const repository = url.searchParams.get('repository')
    const mode = url.searchParams.get('comparison')
    const target = url.searchParams.get('target') || undefined
    if ((operation || mode || repository) && !trusted)
      return Response.json({ error: 'Git review is unavailable for this workspace.' }, { status: 404, headers })
    if (operation === 'turn-files') {
      const turn = session?.turns.find(entry => String(entry.id) === target && entry.status === 'complete')
      if (!root || !session || !turn) return Response.json({ error: 'This recorded turn is unavailable.' }, { status: 404, headers })
      const start = session.checkpoints.find(point => point.turnId === turn.id && point.kind === 'turn-start')
      const end = session.checkpoints.findLast(point => point.turnId === turn.id && point.kind === 'turn-end')
      const keys = checkpointReviewRepositories(start, end)
      const repositories = []
      for (let offset = 0; offset < keys.length; offset += 4) {
        repositories.push(...await Promise.all(keys.slice(offset, offset + 4).map(async (key) => {
          const label = session.combinedWorktree?.checkouts.find(checkout => checkout.key === key)?.label || key || 'Project root'
          const before = checkpointRef(start, key)
          const after = checkpointRef(end, key)
          const path = await reviewRepositoryPath(root, session, key).catch(() => null)
          const summary = path && before && after && await isWorkspaceGitRoot(path)
            ? await summarizeTurnFiles(path, { before, after }).catch(() => null) : null
          return { key, label, summary }
        })))
      }
      return Response.json({ repositories }, { headers })
    }
    if (!root) return Response.json(errorDiff('session has no workspace'), { headers })
    const combined = session?.combinedWorktree
    const path = await reviewRepositoryPath(root, session, repository || '')
    if (!path) return Response.json({ error: 'This project repository is unavailable.' }, { status: 404, headers })

    if (operation === 'status') {
      const status = await isWorkspaceGitRoot(path) ? await readRepositoryStatus(path) : null
      return Response.json({ status }, { headers })
    }
    const turns = reviewTurns(session, repository || '')
    try {
      if (operation === 'options') {
        const [options, repositories, rootIsGit] = await Promise.all([
          workspaceReviewOptions(path, turns, target),
          combined ? combined.checkouts.filter(entry => entry.key).map(({ key, label }) => ({ key, label }))
            : scanProjectRepositories(root),
          repository ? isWorkspaceGitRoot(root) : null,
        ])
        return Response.json({ ...options, repositories, hasProjectRepository: rootIsGit ?? options.isRepository }, { headers })
      }

      const baseline = checkpointRef(session?.checkpoints[0], repository || '')
      const context = operation === 'context'
      const readContext = (diff: NonNullable<Awaited<ReturnType<typeof reviewWorkspaceDiff>>>) =>
        workspaceDiffContext(path, diff, url.searchParams.get('file') ?? '', url.searchParams.get('object') ?? '')
      if (mode) {
        if (mode !== 'uncommitted' && mode !== 'branch' && mode !== 'commit' && mode !== 'turn')
          return Response.json({ error: 'Unknown Git comparison.' }, { status: 400, headers })
        if (repository && mode === 'turn' && !turns.length)
          return Response.json({ error: 'There are no recorded turns for this repository.' }, { status: 404, headers })
        const diff = await reviewWorkspaceDiff(path, mode, target, turns, context ? undefined : url.searchParams.get('knownRevision') ?? undefined)
        if (!diff) return new Response(null, { status: 204, headers })
        return context ? await readContext(diff) : Response.json(diff, { headers })
      }
      if (context) return await readContext(await workspaceDiff(path, baseline))

      // Preserve the first-checkpoint comparison for older clients.
      const revision = await workspaceDiffRevision(path, baseline)
      if (url.searchParams.get('knownRevision') === revision) return new Response(null, { status: 204, headers })
      return Response.json({ ...await workspaceDiff(path, baseline), revision }, { headers })
    }
    catch {
      if (operation) return Response.json({ error: operation === 'options' ? 'Could not load Git review options.' : 'Could not load unchanged lines.' }, { status: 503, headers })
      return Response.json(errorDiff('could not read the workspace'), { headers })
    }
  }

  function checkpointRef(point: SessionState['checkpoints'][number] | undefined, repository: string): string | undefined {
    if (point?.repositories) return point.repositories.find(entry => entry.key === repository)?.vcsRef
    return repository ? undefined : point?.vcsRef
  }

  function reviewTurns(session: SessionState | undefined, repository: string): WorkspaceReviewTurn[] {
    if (!session) return []
    const starts = new Map<number, string>()
    const ends = new Map<number, string>()
    for (const point of session.checkpoints) {
      const ref = checkpointRef(point, repository)
      if (!ref) continue
      if (point.kind === 'turn-start' && !starts.has(point.turnId)) starts.set(point.turnId, ref)
      if (point.kind === 'turn-end') ends.set(point.turnId, ref)
    }
    return session.turns.flatMap((turn, index) => {
      const before = starts.get(turn.id)
      const after = ends.get(turn.id)
      return before && after ? [{ id: turn.id, number: index + 1, before, after }] : []
    })
  }

  const searchWorkspaceFiles = createWorkspaceFileSearch()
  const sockets = new Set<HarnessSocket>()
  const terminals = new WorkspaceTerminals<HarnessSocket>(send, new TerminalHistoryStore(databasePath))
  const previewScans = new Map<string, ReturnType<typeof readPreviewServers>>()
  const terminalScopeExists = (scope: TerminalScope) => engine.current.workspaces.has(scope.workspaceId)
    && (scope.sessionId === undefined || engine.current.sessions.get(scope.sessionId)?.workspaceId === scope.workspaceId)
  terminals.prune(terminalScopeExists)
  projectSetup.prune(terminalScopeExists)
  const assetCache = new AssetCache()
  // Built once, before listening: the page references it by URL, so it must be
  // servable by the time the first render can hand that URL out.
  const codec = await buildClientCodec()
  if (codec) assetCache.remember([codec])
  const codecUrl = codec ? `${ASSET_PREFIX}/${codec.filename}` : ''
  // Set by a host that launches a native window, so cold start can be reported
  // against the budget in PLAN.md §11 rather than estimated from outside.
  let windowSpawnedAt: number | null = null
  let nativeProbe: Record<string, unknown> | null = null

  /**
   * The one page an unpaired device may see.
   *
   * Deliberately hand-written rather than rendered through stx: it has to work
   * before the client bundle, the asset cache or the projection are reachable,
   * and it is the only surface an unauthenticated caller can reach at all.
   */
  function pairingReturn(value: unknown): string {
    if (typeof value !== 'string' || value.length > 96_000 || !value.startsWith('/') || value.startsWith('//')) return '/'
    const link = new URL(value, 'http://harness.local')
    if (link.origin !== 'http://harness.local' || (!['/new', '/new/'].includes(link.pathname) && !/^\/s\/[1-9]\d*\/?$/u.test(link.pathname))) return '/'
    const params = new URLSearchParams()
    for (const key of promptLinkKeys) {
      const item = link.searchParams.get(key)
      if (item !== null) params.set(key, item)
    }
    const hash = /^#turn-[1-9]\d*$/u.test(link.hash) ? link.hash : ''
    return link.pathname + (params.size ? '?' + params : '') + hash
  }

  const pairingHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }

  function pairingPage(error: string | null, destination = '/'): string {
    const message = error
      ? `<p class="err">${error.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c))}</p>`
      : '<p class="hint">Enter the code shown in the terminal running harness.</p>'
    return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Pair with harness</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px }
  form { width: 100%; max-width: 320px; display: grid; gap: 12px }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600 }
  .hint, .err { font-size: 13px; margin: 0; opacity: .7 }
  .err { color: #d1453b; opacity: 1 }
  input { font: inherit; font-size: 17px; letter-spacing: .12em; text-align: center; text-transform: uppercase;
    padding: 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    background: transparent; color: inherit }
  button { font: inherit; font-weight: 560; padding: 12px; border: 0; border-radius: 10px;
    background: #3b6ef5; color: #fff }
</style>
<form method="post" action="/pair">
  <h1>Pair with harness</h1>
  ${message}
  <input name="code" autocomplete="one-time-code" autocapitalize="characters" autocorrect="off"
        spellcheck="false" placeholder="XXXX-XXXX" autofocus required>
  <input type="hidden" name="name" value="">
  <input type="hidden" name="next" value="${escapeTranscriptText(destination)}">
  <button type="submit">Pair this device</button>
</form>
<script>
  // Named after the device rather than "a device", without asking: the phone
  // already knows what it is, and one fewer field is one fewer reason to give up.
  document.querySelector('input[name=name]').value =
    (navigator.userAgentData?.platform || navigator.platform || 'a device') + ' browser'
  const next = document.querySelector('input[name=next]')
  if (next.value.startsWith('/s/') && /^#turn-[1-9][0-9]*$/.test(location.hash))
    next.value = next.value.split('#')[0] + location.hash
</script>`
  }

  async function pairingResponse(request: Request, url: URL): Promise<Response> {
    if (!access) return new Response('not found', { status: 404 })

    if (request.method !== 'POST') {
      return new Response(pairingPage(null), { headers: pairingHeaders })
    }

    const form = await request.formData().catch(() => null)
    if (!form) return new Response(pairingPage('that form did not arrive intact'), { status: 400, headers: pairingHeaders })

    const destination = pairingReturn(form.get('next'))
    const result = await access.redeem(String(form.get('code') ?? ''), String(form.get('name') ?? ''))
    if (!result.ok) {
      return new Response(pairingPage(result.reason, destination), { status: 401, headers: pairingHeaders })
    }

    console.warn(`[access] paired a new device from ${url.host}`)
    // 303 so the browser follows with GET; the cookie rides along and the
    // device lands on the app already authenticated.
    return new Response(null, {
      status: 303,
      headers: {
        'location': destination,
        'set-cookie': sessionCookie(result.token, url.protocol === 'https:'),
      },
    })
  }

  function send(socket: HarnessSocket, payload: unknown): void {
    try {
      socket.sendBinary(encode(payload))
    }
    catch {
      // A send to a socket that closed between the broadcast and here is
      // normal, not an error worth surfacing.
    }
  }

  /**
   * Rendered pages, keyed by URL and state revision.
   *
   * SSR of an unchanged projection re-does megabytes of allocator churn per
   * render for byte-identical output (issue #11) — a control surface polling
   * `/` should pay the render exactly once per state change. The revision
   * bumps in `broadcast`, the one path every applied event already takes, so
   * a stale page cannot outlive the event that invalidated it. Keys embed
   * the revision, which makes entries self-expiring; the cap only bounds the
   * window between events.
   */
  let stateRev = 0
  const renderCache = new Map<string, string>()
  const RENDER_CACHE_CAP = 16

  function sidebarSnapshot(profileId: number, pinsOnly: boolean) {
    if (pinsOnly)
      return { t: 'pin-order', profileId, sessionIds: profilePinnedThreads(engine.current, profileId).filter(isVisiblePin).map(session => session.id) }
    const profile = engine.current.profiles.get(profileId)
    const workspaces = (profile?.workspaceIds ?? []).flatMap((id) => {
      const workspace = engine.current.workspaces.get(id)
      return workspace ? [workspace] : []
    })
    const workspaceIds = new Set(workspaces.map(workspace => workspace.id))
    const sessions = [...engine.current.sessions.values()].filter(session => workspaceIds.has(session.workspaceId))
    return { t: 'sidebar-order', profileId, sections: threadSidebarLayout(profileId, workspaces, sessions) }
  }

  /**
   * Push events to everyone subscribed to their session.
   *
   * Global events (session id 0) go to every socket: a new profile is
   * relevant to every open client, and none of them subscribe to it.
   */
  function broadcast(events: Awaited<ReturnType<Engine['dispatch']>>['events']): void {
    if (events.length > 0) stateRev++
    const changedProfiles = new Set<number>()
    let reschedule = false
    for (const event of events) {
      if (event.payload.type === 'profile.deleted') {
        terminals.prune(terminalScopeExists)
        projectSetup.prune(terminalScopeExists)
        changedProfiles.add(event.payload.profileId)
      }
      if (event.payload.type === 'workspace.added' && !event.payload.scratch) changedProfiles.add(event.payload.profileId)
      if (event.payload.type === 'workspace.promoted') {
        const profile = engine.current.workspaces.get(event.payload.workspaceId)?.profileId
        if (profile !== undefined) changedProfiles.add(profile)
      }
      // A revoke has to reach the connection, not just the next handshake.
      // Closed before the event is delivered, so the socket being cut off does
      // not first get told why in a frame it could act on.
      if (event.payload.type === 'device.revoked') {
        const revoked = event.payload.deviceId
        for (const socket of sockets) {
          if (socket.data.deviceId !== revoked) continue
          // 4001: application-defined. The client treats it as terminal rather
          // than reconnecting into a rejection loop.
          try {
            socket.close(4001, 'access revoked')
          }
          catch {
            // Already gone, which is the outcome we wanted.
          }
        }
      }

      switch (event.payload.type) {
        case 'settings.updated':
          if ('autoSettleAfterDays' in event.payload.changes) reschedule = true
          break
        case 'profile.deleted':
        case 'session.navigation-changed':
        case 'session.created':
        case 'session.fork-finished':
        case 'session.fork-portable':
        case 'session.fork-failed':
        case 'session.failed':
        case 'session.stopped':
        case 'turn.started':
        case 'turn.completed':
        case 'turn.failed':
        case 'turn.interrupted':
        case 'turn.rewind-requested':
        case 'turn.rewind-settled':
        case 'checkpoint.reverted':
        case 'checkpoint.restored':
        case 'checkpoint.restore-failed':
        case 'queue.added':
        case 'queue.removed':
        case 'input.resolved':
        case 'approval.resolved':
          reschedule = true
      }
      if (event.payload.type === 'session.navigation-changed' || event.payload.type === 'session.created' || event.payload.type === 'turn.started'
        || event.payload.type === 'turn.completed' || event.payload.type === 'turn.failed' || event.payload.type === 'turn.interrupted'
        || event.payload.type === 'turn.rewind-requested' || event.payload.type === 'turn.rewind-settled'
        || event.payload.type === 'session.fork-finished' || event.payload.type === 'session.fork-portable' || event.payload.type === 'session.fork-failed'
        || event.payload.type === 'session.failed' || event.payload.type === 'session.stopped'
        || event.payload.type === 'approval.requested' || event.payload.type === 'approval.resolved'
        || event.payload.type === 'input.requested' || event.payload.type === 'input.resolved') {
        const session = engine.current.sessions.get(event.sessionId)
        const profile = session && engine.current.workspaces.get(session.workspaceId)?.profileId
        if (profile !== undefined) changedProfiles.add(profile)
      }

      for (const socket of sockets) {
        if (event.sessionId !== 0 && !socket.data.subscriptions.has(event.sessionId)) continue
        const buffered = socket.data.catchingUp.get(event.sessionId)
        if (buffered) {
          buffered.push(event)
          continue
        }
        const seen = socket.data.cursors.get(event.sessionId) ?? 0
        if (event.seq <= seen) continue
        send(socket, { t: 'event', event })
        socket.data.cursors.set(event.sessionId, event.seq)
      }
    }
    if (reschedule) scheduleThreadMaintenance()
    for (const profileId of changedProfiles) {
      let pins: ReturnType<typeof sidebarSnapshot> | undefined
      let sidebar: ReturnType<typeof sidebarSnapshot> | undefined
      for (const socket of sockets) {
        const watch = socket.data.sidebarWatch
        if (watch?.profileId !== profileId) continue
        send(socket, watch.pinsOnly ? pins ??= sidebarSnapshot(profileId, true) : sidebar ??= sidebarSnapshot(profileId, false))
      }
    }
  }

  let closing = false
  const pullRequestCheckouts = new Set<string>()
  let settlementRetry: ReturnType<typeof setTimeout> | undefined
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined
  let maintainingThreads = false

  function scheduleThreadMaintenance(minimumDelay = 0): void {
    if (maintainingThreads || closing) return
    clearTimeout(maintenanceTimer)
    let earliest = Infinity
    const { sessions, workspaces } = engine.current
    for (const session of sessions.values())
      earliest = Math.min(earliest, session.navigation?.snoozedUntil ?? Infinity,
        workspaces.has(session.workspaceId)
          ? inactivityDeadline(session, workspaceSettings(engine.current, session.workspaceId)) ?? Infinity
          : Infinity)
    if (!Number.isFinite(earliest)) return
    maintenanceTimer = setTimeout(() => void maintainThreads(), Math.max(minimumDelay, Math.min(2_147_483_647, earliest - Date.now())))
    maintenanceTimer.unref()
  }

  async function respondPullRequestLink(request: Request, url: URL, isLocalPeer: boolean, extendTimeout: () => void): Promise<Response> {
    const headers = { 'cache-control': 'no-store' }
    const respond = (value: object, status = 200) => Response.json(value, { headers, status })
    const site = request.headers.get('sec-fetch-site')
    const local = canUseHostPrivileges(request, url) && isLocalPeer
    if (site === 'cross-site' || site === 'same-site' || (!access && !local))
      return new Response(null, { status: 403, headers })
    const pull = parsePullRequest(url.searchParams.get('pr') ?? '')
    if (!pull) return respond({ error: 'Invalid GitHub pull request.' }, 400)
    const profileId = url.searchParams.has('profile') ? Number(url.searchParams.get('profile')) : undefined
    if (profileId !== undefined && !engine.current.profiles.has(profileId)) return respond({ error: 'This profile is unavailable.' }, 404)
    const existing = findPullRequestThread(engine.current, pull, profileId)
    if (request.method === 'GET') {
      if (existing) return respond({ sessionId: existing.id })
      const match = await findPromptLinkProject(engine.current, pull.repository, { pullRequest: true, profileId })
      return respond({ project: match ? linkedProject(match.workspace) : null, canCheckOut: local })
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers })
    if (!local || request.headers.get('content-type') !== 'application/json')
      return new Response(null, { status: 403, headers })
    const workspaceId = Number(url.searchParams.get('workspace'))
    if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0)
      return respond({ error: 'Select a trusted project for this checkout.' }, 400)
    const retry = url.searchParams.get('session')
    if (retry !== null) {
      if (!existing || String(existing.id) !== retry || existing.workspaceId !== workspaceId)
        return respond({ error: 'This pull request thread is no longer available for checkout.' }, 409)
    }
    if (existing) {
      if (existing.workspaceId === workspaceId && !existing.worktreePath)
        void runtime.preparePullRequestWorktree(existing.id).catch(() => {})
      return respond({ sessionId: existing.id })
    }

    const key = pull.repository.toLowerCase() + '#' + pull.number
    if (pullRequestCheckouts.has(key)) return respond({ error: 'This pull request checkout is already starting. Try again shortly.' }, 409)
    pullRequestCheckouts.add(key)
    extendTimeout()
    try {
      const match = await findPromptLinkProject(engine.current, pull.repository, { pullRequest: true, workspaceId, profileId })
      if (!match) return respond({ error: 'The matching project is unavailable or needs trust.' }, 409)
      const commit = await fetchPullRequest(match.path, match.remote, pull)
      if (!commit) return respond({ error: 'Git could not fetch this pull request. Check the number, network, and Git credentials.' }, 502)
      const workspace = engine.current.workspaces.get(workspaceId)
      if (closing || !workspace?.trusted || workspace.path !== match.workspace.path
        || (profileId !== undefined && workspace.profileId !== profileId))
        return respond({ error: 'The project changed during checkout. Check its trust settings and try again.' }, 409)
      const result = await engine.dispatchInternal({
        id: 'pull-request_' + crypto.randomUUID(),
        at: Date.now(),
        command: {
          type: 'thread.pull-request.create',
          workspaceId,
          pullRequest: { repository: pull.repository, number: pull.number, repositoryKey: match.repositoryKey, commit },
        },
      })
      const created = result.events.find(event => event.payload.type === 'session.created')
      if (!created) return respond({ error: 'Could not record the pull request thread.' }, 503)
      if (!closing) {
        broadcast(result.events)
        void runtime.preparePullRequestWorktree(created.sessionId).catch(() => {})
      }
      return respond({ sessionId: created.sessionId }, 201)
    }
    catch { return respond({ error: 'Could not start the pull request checkout. Try again.' }, 503) }
    finally { pullRequestCheckouts.delete(key) }
  }

  async function maintainThreads(): Promise<void> {
    if (closing) return
    maintainingThreads = true
    let retryDelay = 0
    try {
      const at = Date.now()
      for (const session of engine.current.sessions.values()) {
        const until = session.navigation?.snoozedUntil
        if (closing) break
        if (until != null && until <= at) {
          const result = await engine.dispatchInternal({
            id: `thread-wake_${crypto.randomUUID()}`, at,
            command: { type: 'thread.snooze.elapsed', sessionId: session.id, until },
          })
          if (!closing) broadcast(result.events)
        }
        const deadline = inactivityDeadline(session, workspaceSettings(engine.current, session.workspaceId))
        if (deadline === undefined || deadline > at || closing) continue
        const result = await engine.dispatchInternal({
          id: `thread-auto-settle_${crypto.randomUUID()}`, at,
          command: { type: 'thread.settle.inactive', sessionId: session.id },
        })
        if (!closing && !result.replayed) {
          broadcast(result.events)
          runSettlementEffects(result.events)
        }
      }
    }
    catch (error) {
      if (!closing) console.warn('[thread maintenance] Could not update scheduled threads.', error)
      retryDelay = 1000
    }
    finally {
      maintainingThreads = false
      scheduleThreadMaintenance(retryDelay)
    }
  }

  const turnExecutions = new Map<number, Promise<void>>()
  const compactTimers = new Map<number, ReturnType<typeof setTimeout>>()

  function cancelIdleCompaction(sessionId: number): void {
    clearTimeout(compactTimers.get(sessionId))
    compactTimers.delete(sessionId)
  }

  function scheduleIdleCompaction(sessionId: number): void {
    cancelIdleCompaction(sessionId)
    if (closing) return
    const session = engine.current.sessions.get(sessionId)
    if (!session || !engine.current.workspaces.get(session.workspaceId)?.trusted
      || effectiveClaudeCompaction(engine.current, session).idleCompaction !== 'beforeCacheExpires') return
    const now = Date.now()
    const eligible = claudeIdleCompaction(session, now)
    if (!eligible || eligible.startsAt === undefined || eligible.expiresAt === undefined || eligible.expiresAt <= now) return

    const startsAt = eligible.startsAt
    const timer = setTimeout(() => {
      compactTimers.delete(sessionId)
      if (closing) return
      const at = Date.now()
      if (at < startsAt) {
        scheduleIdleCompaction(sessionId)
        return
      }
      void engine.dispatchInternal({
        id: `idle_compact_${sessionId}_${eligible.afterTurnId}`, at,
        command: { type: 'thread.compact.idle', sessionId, afterTurnId: eligible.afterTurnId },
      }).then((result) => {
        if (closing || result.replayed) return
        broadcast(result.events)
        startAcceptedTurn(result.events)
      }).catch((error) => {
        if (!closing) console.warn('[idle compaction] Could not compact the thread.', error)
      })
    }, Math.max(0, startsAt - now))
    timer.unref()
    compactTimers.set(sessionId, timer)
  }

  function startAcceptedTurn(events: HarnessEvent[], allowProjectCommands = false): void {
    const event = events.find(item => item.payload.type === 'turn.started')
    const payload = event?.payload
    if (!event || payload?.type !== 'turn.started' || closing) return
    const { sessionId } = event
    cancelIdleCompaction(sessionId)
    const previous = turnExecutions.get(sessionId)

    const execution = Promise.resolve(previous).then(async () => {
      if (closing) return
      const turn = engine.current.sessions.get(sessionId)?.turns.at(-1)
      if (turn?.id !== payload.turnId || turn.status !== 'running') return
      await runtime.runTurn(sessionId, payload.turnId, payload.text ?? '', allowProjectCommands)
    }).catch(async () => {
      if (closing) return
      const result = await engine.dispatchInternal({
        id: `launch_failure_${event.commandId}`, at: Date.now(),
        command: { type: 'thread.error', sessionId, turnId: payload.turnId, message: 'The provider could not start. Check its connection before sending another message.' },
      })
      broadcast(result.events)
    }).finally(() => {
      if (turnExecutions.get(sessionId) !== execution) return
      turnExecutions.delete(sessionId)
      advanceFollowUps(sessionId)
      scheduleIdleCompaction(sessionId)
    })

    turnExecutions.set(sessionId, execution)
    void execution.catch(() => {})
  }

  function advanceFollowUps(sessionId: number): void {
    if (closing || turnExecutions.has(sessionId)) return
    const session = engine.current.sessions.get(sessionId)
    if (!session || session.state !== 'idle' || session.followUps.held || !session.followUps.entries.length
      || session.followUps.entries.some(entry => entry.steering)) return
    void engine.dispatchInternal({
      id: `queue_advance_${crypto.randomUUID()}`, at: Date.now(),
      command: { type: 'thread.queue.advance', sessionId },
    }).then((result) => {
      if (result.replayed || closing) return
      broadcast(result.events)
      startAcceptedTurn(result.events)
    }).catch(() => {})
  }

  /**
   * Drive the provider in response to a command the engine accepted.
   *
   * Deliberately fire-and-forget for a turn: an agent run takes minutes, and
   * awaiting it here would block the socket handler and every command queued
   * behind it. Its output reaches clients through the same broadcast path as
   * everything else, so nothing is lost by not waiting.
   */
  async function react(
    envelope: CommandEnvelope,
    result: Awaited<ReturnType<Engine['dispatch']>>,
    doomed: DoomedWorktree[] | undefined,
    allowProjectCommands: boolean,
  ): Promise<void> {
    const command = envelope.command

    if (command.type === 'session.organize' && (command.action === 'settle' || command.action === 'drop')) {
      runSettlementEffects(result.events)
      return
    }

    // A worktree is a directory on disk and the log does not own it, so
    // deleting a profile used to leave a full checkout behind per isolated
    // session. The event carries the sessions it removed precisely so this can
    // find them after they are gone from the projection.
    if (command.type === 'profile.delete') {
      const deleted = result.events.find(event => event.payload.type === 'profile.deleted')
      if (!deleted) return
      if (deleted.payload.type === 'profile.deleted') {
        const removedSessions = deleted.payload.sessionIds ?? []
        await Promise.all(removedSessions.map(id => runtime.stopRemovedSession(id)))
        for (const id of removedSessions) pruneQuestionAttachments(id)
      }
      const released = await releaseWorktrees(doomed ?? [], allowProjectCommands)
      for (const entry of released) {
        console.warn(
          `[worktree] ${entry.removed ? 'released' : 'retained'} ${entry.path}`
          + (entry.committed ? ` (committed leftovers as ${entry.committed.slice(0, 8)})` : ''),
        )
      }
      return
    }

    if (command.type === 'session.fork') {
      const created = result.events.find(event => event.payload.type === 'session.created')
      if (created) void runtime.forkSession(created.sessionId, allowProjectCommands)
      return
    }
    if (command.type === 'session.turn.start' || command.type === 'session.handoff' || command.type === 'session.queue.send') {
      startAcceptedTurn(result.events, allowProjectCommands)
      return
    }
    if (command.type === 'session.turn.steer') {
      const requested = result.events.find(event => event.payload.type === 'turn.steer.requested')?.payload
      if (requested?.type === 'turn.steer.requested') await runtime.steer(command.sessionId, requested)
      return
    }
    if (command.type === 'session.queue.add') {
      advanceFollowUps(command.sessionId)
      return
    }

    if (command.type === 'session.turn.rewind') {
      await runtime.rewindConversation(command.sessionId, command.verifyOnly === true, allowProjectCommands)
      return
    }

    if (command.type === 'session.checkpoint.revert') {
      await runtime.revert(command.sessionId, command.checkpointId, envelope.id, allowProjectCommands)
      return
    }

    if (command.type === 'session.turn.interrupt') {
      if (result.events.some(event => event.payload.type === 'turn.interrupted')) await runtime.interrupt(command.sessionId)
      return
    }

    if (command.type === 'session.approval.respond') {
      await runtime.respondApproval(
        command.sessionId,
        command.approvalId,
        { decision: command.decision, scope: command.scope },
      )
      return
    }

    if (command.type === 'session.input.respond') {
      const resolution = result.events.find(event => event.payload.type === 'input.resolved')?.payload
      const submitted = resolution?.type === 'input.resolved' ? resolution.attachments : undefined
      const answers = 'answers' in command ? command.answers : null
      if (submitted?.length && answers) {
        await runtime.respondInput(command.sessionId, command.requestId, {
          answers: answers.map(({ questionId, values }) => {
            const files = submitted.filter(file => file.questionId === questionId)
            if (!files.length) return { questionId, values }
            const paths = files.map(file => JSON.stringify(attachments.path(command.sessionId, command.requestId, file)))
            return { questionId, values: [[...values, 'Attached files:', ...paths].join('\n')] }
          }),
        })
      }
      else await runtime.respondInput(command.sessionId, command.requestId, command)
      pruneQuestionAttachments(command.sessionId)
      return
    }

    if (command.type === 'session.stop')
      await runtime.stopSession(command.sessionId)
  }

  async function onFrame(socket: HarnessSocket, raw: Uint8Array): Promise<void> {
    let frame: ClientFrame
    try {
      frame = decode(raw) as ClientFrame
    }
    catch (error) {
      // A frame we cannot parse is a protocol error, not a command failure —
      // name it as such so a client bug is not mistaken for a rejected command.
      send(socket, {
        t: 'protocol-error',
        message: error instanceof CborError ? error.message : 'undecodable frame',
      })
      return
    }

    switch (frame?.t) {
      case 'ping':
        send(socket, { t: 'pong' })
        return

      case 'read-settings':
        // The host's own answers and the project's own answers travel apart,
        // as they do on first paint: a client that only had the effective
        // settings could not tell a pinned value from an inherited one.
        send(socket, {
          t: 'host-settings',
          settings: engine.current.settings,
          ...(frame.workspaceId === undefined ? {} : {
            workspaceId: frame.workspaceId,
            projectSettings: { ...engine.current.workspaces.get(frame.workspaceId)?.settings },
          }),
        })
        return

      case 'watch-pins':
      case 'watch-sidebar': {
        const pinsOnly = frame.t === 'watch-pins'
        socket.data.sidebarWatch = engine.current.profiles.has(frame.profileId) ? { profileId: frame.profileId, pinsOnly } : undefined
        if (socket.data.sidebarWatch) send(socket, sidebarSnapshot(frame.profileId, pinsOnly))
        return
      }

      case 'term-open': {
        // A terminal is arbitrary execution with no approval step in front of
        // it: the driver path asks before every tool call, a shell cannot
        // (§12). Until the security model has a story for that, terminals
        // belong to this machine only — the plain loopback case and the
        // host's own token, never a paired device.
        if (!socket.data.canUseHostPrivileges) {
          send(socket, { t: 'term-error', message: 'terminals are local-only' })
          return
        }
        const workspace = engine.current.workspaces.get(frame.workspaceId)
        if (!workspace) {
          send(socket, { t: 'term-error', message: `no workspace ${frame.workspaceId}` })
          return
        }
        const session = frame.sessionId === undefined ? undefined : engine.current.sessions.get(frame.sessionId)
        if ((frame.sessionId !== undefined && session?.workspaceId !== workspace.id)
          || (frame.resumeKey !== undefined && (typeof frame.resumeKey !== 'string' || !/^[\da-f-]{36}$/u.test(frame.resumeKey) || !session))) {
          send(socket, { t: 'term-error', message: 'This terminal does not belong to the thread.' })
          return
        }
        if (frame.projectScriptId !== undefined && (!session || !frame.resumeKey || frame.resumeOnly || !workspace.trusted || workspace.scratch
          || typeof frame.projectScriptId !== 'string' || !scriptIdPattern.test(frame.projectScriptId))) {
          send(socket, { t: 'term-error', message: 'Open a trusted project thread to run a saved script.' })
          return
        }
        const scope = { workspaceId: workspace.id, sessionId: session?.id, resumeKey: frame.resumeKey }
        const jobHistory = session && frame.resumeKey ? projectSetup.history(workspace.id, session.id, frame.resumeKey) : null
        if (jobHistory) {
          if (!workspace.trusted || frame.projectScriptId) {
            send(socket, { t: 'term-error', message: 'Open the worktree script terminal in its trusted project.' })
            return
          }
          if (!terminals.resume(socket, scope)) {
            try {
              const history = terminals.savedHistory(scope)
              if (history !== undefined) terminals.openProjectHistory(socket, scope, workspaceSettings(engine.current, scope.workspaceId).terminalShell, history, jobHistory.exitCode)
              else send(socket, { t: 'term-error', message: 'The worktree script has no saved terminal output.' })
            }
            catch { send(socket, { t: 'term-error', message: 'Could not load the worktree script output.' }) }
          }
          return
        }
        if (terminals.resume(socket, scope)) return
        const shellKind = workspaceSettings(engine.current, scope.workspaceId).terminalShell
        const shell = shellKind === 'den' ? findDenShell() : undefined
        if (shell === null) {
          send(socket, { t: 'term-error', message: 'Den was not found on this host. Install Den or choose System shell in Settings.' })
          return
        }
        if (workspace.scratch) {
          try {
            await openScratchWorkspace(workspace.path)
          }
          catch {
            send(socket, { t: 'term-error', message: 'Could not open the scratch folder.' })
            return
          }
        }
        if (!sockets.has(socket)) return
        if (!terminalScopeExists(scope)) {
          send(socket, { t: 'term-error', message: 'This terminal does not belong to the thread.' })
          return
        }
        if (terminals.resume(socket, scope)) return
        let saved: string | undefined
        try { saved = terminals.savedHistory(scope) }
        catch {
          send(socket, { t: 'term-error', message: 'Could not load this terminal’s saved output. Try again.' })
          return
        }
        if (frame.resumeOnly === true && saved === undefined) {
          send(socket, { t: 'term-error', message: 'This terminal session is no longer available.' })
          return
        }
        const launchScript = frame.projectScriptId !== undefined && saved === undefined
        const script = launchScript ? projectScripts.get(workspace.id, frame.projectScriptId!) : undefined
        if (launchScript && !script) {
          send(socket, { t: 'term-error', message: 'This project script is no longer available.' })
          return
        }
        const cwd = session ? defaultWorkspacePath(engine.current, session.id) : workspace.path
        if (script && !cwd) {
          send(socket, { t: 'term-error', message: 'The thread checkout is unavailable.' })
          return
        }
        const cols = Number.isFinite(frame.cols) ? Math.min(500, Math.max(20, Math.floor(frame.cols!))) : 80
        const rows = Number.isFinite(frame.rows) ? Math.min(200, Math.max(5, Math.floor(frame.rows!))) : 24
        try {
          terminals.open(socket, scope, shellKind, { cwd: cwd ?? workspace.path, cols, rows, shell,
            denIntegration: shellKind === 'den', command: script?.command }, saved, script)
        }
        catch {
          send(socket, { t: 'term-error', message: 'Could not record the terminal for this script. Try again.' })
        }
        return
      }

      case 'term-input':
        // An unknown id is a close racing input — dropped, like a late approval.
        if (typeof frame.data === 'string') terminals.input(socket, frame.termId, frame.data)
        return

      case 'term-resize': {
        // Clamped: the client computes these from layout, and a garbage
        // measurement must not become a 0-column or million-row winsize.
        if (!Number.isFinite(frame.cols) || !Number.isFinite(frame.rows)) return
        const cols = Math.min(500, Math.max(20, Math.floor(frame.cols)))
        const rows = Math.min(200, Math.max(5, Math.floor(frame.rows)))
        terminals.resize(socket, frame.termId, cols, rows)
        return
      }

      case 'term-close':
        terminals.close(socket, frame.termId)
        return

      case 'term-detach':
        terminals.detach(socket, frame.termId)
        return

      case 'subscribe': {
        const { sessionId } = frame
        const buffered: HarnessEvent[] = []
        socket.data.catchingUp.set(sessionId, buffered)
        socket.data.subscriptions.add(sessionId)
        // A live event can arrive while the database read is in flight. Keep it
        // behind replay and use the committed cursor to filter duplicates.
        const missed = await store.read(sessionId, frame.sinceSeq ?? 0)
        if (socket.data.catchingUp.get(sessionId) !== buffered) return
        let caughtUpTo = frame.sinceSeq ?? 0
        const events = buffered.length ? [...missed, ...buffered].sort((a, b) => a.seq - b.seq) : missed
        for (const event of events) {
          if (event.seq <= caughtUpTo) continue
          send(socket, { t: 'event', event })
          caughtUpTo = event.seq
        }
        socket.data.cursors.set(sessionId, caughtUpTo)
        socket.data.catchingUp.delete(sessionId)
        send(socket, { t: 'subscribed', sessionId, caughtUpTo })
        return
      }

      case 'unsubscribe':
        socket.data.subscriptions.delete(frame.sessionId)
        socket.data.catchingUp.delete(frame.sessionId)
        socket.data.cursors.delete(frame.sessionId)
        return

      case 'dispatch': {
        const received = frame.envelope
        if (!received?.id || !received.command?.type) {
          send(socket, { t: 'protocol-error', message: 'dispatch requires an envelope with id and command' })
          return
        }
        const useHostClock = received.command.type === 'session.organize'
          || (received.command.type === 'session.turn.start' && received.command.compactAfterTurnId !== undefined)
        let envelope = useHostClock ? { ...received, at: Date.now() } : received
        try {
          if (envelope.command.type === 'session.organize' && envelope.command.undoScope !== undefined) {
            const tab = envelope.command.undoScope
            if (typeof tab !== 'string' || !/^[a-z0-9-]{1,80}$/.test(tab)) throw new Error('Choose a valid thread Undo scope.')
            const undoScope = new Bun.CryptoHasher('sha256').update(JSON.stringify([socket.data.deviceId ?? 'local', tab])).digest('hex')
            envelope = { ...envelope, command: { ...envelope.command, undoScope } }
          }
          const command = envelope.command
          if (command.type === 'profile.claude-compaction.update' && !socket.data.canUseHostPrivileges)
            throw new Error('Change Claude account settings on the Harness host.')
          if (command.type === 'profile.model-favorite.set') {
            const favorite = command.favorite
            if (!favorite || !driverKinds().includes(favorite.driverKind)) throw new Error('Choose an available provider.')
            if (favorite.providerInstanceId !== undefined) {
              const launch = savedProviders.find(favorite.providerInstanceId, command.profileId, favorite.driverKind, tmpdir())
              if (!launch) throw new Error('This provider account is unavailable in the selected profile.')
              if (launch.chatGptClientId && !socket.data.canUseHostPrivileges) throw new Error('This ChatGPT plan is available only on the Harness host.')
            }
          }
          if (!socket.data.canUseHostPrivileges) {
            const session = 'sessionId' in command ? engine.current.sessions.get(command.sessionId) : undefined
            const workspaceId = command.type === 'session.create' ? command.workspaceId : session?.workspaceId
            const workspace = workspaceId === undefined ? undefined : engine.current.workspaces.get(workspaceId)
            const selections: Array<{ driverKind: DriverKind, providerInstanceId?: number }> = []
            if (session) selections.push(session)
            if (command.type === 'session.create' || command.type === 'session.handoff') selections.push(command)
            if (command.type === 'session.fork') {
              const target = forkResponsePoint(session, command.turnId)?.nativeFork
              if (target) selections.push(target)
            }
            for (const selection of selections) {
              if (!workspace || selection?.providerInstanceId === undefined) continue
              const launch = savedProviders.find(selection.providerInstanceId, workspace.profileId, selection.driverKind, workspace.path)
              if (launch?.chatGptClientId) throw new Error('This ChatGPT plan is available only on the Harness host.')
            }
          }
          attachmentOwners.set(envelope, socket.data.deviceId ?? 'local')
          if (socket.data.canUseHostPrivileges && command.type === 'session.organize'
            && (command.action === 'settle' || (command.action === 'drop' && command.destination === 'settled')))
            hostSettlements.add(envelope)
          const result = command.type === 'session.input.respond' && Number.isSafeInteger(command.sessionId) && typeof command.requestId === 'string'
            ? await attachments.serialize(command.sessionId, command.requestId, () => engine.dispatch(envelope))
            : (command.type === 'session.turn.start' || command.type === 'session.queue.add' || command.type === 'session.handoff') && command.uploads !== undefined
              ? await composerAttachments.serialize(command.uploads, () => engine.dispatch(envelope))
              : await engine.dispatch(envelope)
          const last = result.events.at(-1)?.payload
          const undo = last?.type === 'session.navigation-changed' ? last.undo : undefined
          const session = command.type === 'session.organize' && engine.current.sessions.get(command.sessionId)
          const workspace = session && engine.current.workspaces.get(session.workspaceId)
          const profile = workspace ? engine.current.profiles.get(workspace.profileId) : undefined
          const now = Date.now()
          const remainingMs = (undo?.expiresAt ?? 0) - now
          const offer = command.type === 'session.organize' && command.undoScope
            ? threadUndoOffer(profile, command.undoScope, now)
            : undo && remainingMs > 0 && undo.sourceCommandId === profile?.threadUndo?.sourceCommandId
              ? { sourceCommandId: undo.sourceCommandId, sessionId: undo.sessionId, action: undo.action, remainingMs, count: 1 }
              : undefined
          const undoResult = last?.type === 'session.navigation-changed' && command.type === 'session.organize'
            && last.undoScope?.key === command.undoScope ? last.undoScope?.result : undefined
          send(socket, {
            t: 'dispatched',
            id: envelope.id,
            replayed: result.replayed,
            seqs: result.events.map(event => event.seq),
            ...(offer && { threadUndo: offer }),
            ...(undoResult && { undoResult }),
          })
          // Broadcast after acking, so the dispatcher's own ack cannot arrive
          // after the events it caused.
          broadcast(result.events)
          // Then act on it. A retry (`replayed`) must not start a second agent
          // run — the receipt already accounted for the first.
          if (!result.replayed) await react(envelope, result, deletionWorktrees.get(envelope), socket.data.canUseHostPrivileges)
        }
        catch (error) {
          send(socket, {
            t: 'rejected',
            id: envelope.id,
            message: error instanceof Error ? error.message : String(error),
          })
        }
        return
      }

      default:
        send(socket, { t: 'protocol-error', message: `unknown frame type: ${String((frame as { t?: unknown })?.t)}` })
    }
  }

  // The second parameter is the route-path string union; this server routes in
  // `fetch`, so it has none.
  const server = Bun.serve<SocketData, never>({
    port,
    hostname,

    fetch(request, srv) {
      const url = new URL(request.url)

      // Everything below this line assumes the caller is allowed to be here.
      if (access) {
        // Liveness without disclosure: a tunnel or uptime check may ask whether
        // the process is up, but session and profile counts are not public.
        if (url.pathname === '/health' && !access.authenticate(request).ok)
          return Response.json({ ok: true })

        // Mint a fresh code. Authenticated, because handing out pairing codes
        // to anyone who asks would make the code itself pointless.
        if (url.pathname === '/pair/new' && request.method === 'POST') {
          if (!access.authenticate(request).ok)
            return Response.json({ error: 'not authorised to open pairing' }, { status: 401 })
          return Response.json(access.openPairing())
        }

        // A one-time handoff for a webview on this machine, which cannot set
        // a header on its first navigation the way the CLI can. Restricted to
        // *this host's* token, never a device's: a token in a URL ends up in
        // history and in whatever logs sit in front of the server, and the
        // local one is already readable by anything running as this user.
        const handoff = url.searchParams.get('token')
        if (handoff && access.authenticate(new Request(url, { headers: { authorization: `Bearer ${handoff}` } })).deviceId === 'local') {
          const clean = new URL(url)
          clean.searchParams.delete('token')
          // Redirected rather than served in place, so the token does not stay
          // in the address bar for the life of the window.
          return new Response(null, {
            status: 303,
            headers: { 'location': `${clean.pathname}${clean.search}`, 'set-cookie': sessionCookie(handoff, url.protocol === 'https:') },
          })
        }

        if (url.pathname === '/pair')
          return pairingResponse(request, url)

        const outcome = access.authenticate(request)
        if (!outcome.ok) {
          // A browser gets the pairing page rather than a bare 401, because the
          // person holding the phone needs somewhere to type the code.
          if (request.headers.get('accept')?.includes('text/html'))
            return new Response(pairingPage(null, pairingReturn(url.pathname + url.search)), { status: 401, headers: pairingHeaders })
          return Response.json({ error: 'this harness requires pairing' }, { status: 401 })
        }
      }

      if (url.pathname === '/ws') {
        const hostPrivileges = canUseHostPrivileges(request, url)
        if (!access && !hostPrivileges)
          return new Response('This Harness host accepts same-origin loopback clients only.', { status: 403 })
        const upgraded = srv.upgrade(request, {
          data: {
            deviceId: access?.authenticate(request).deviceId ?? null,
            canUseHostPrivileges: hostPrivileges,
            subscriptions: new Set<number>(),
            catchingUp: new Map<number, HarnessEvent[]>(),
            cursors: new Map<number, number>(),
          },
        })
        return upgraded ? undefined : new Response('expected a websocket upgrade', { status: 426 })
      }

      if (url.pathname === '/composer-attachments' || url.pathname.startsWith('/composer-attachments/')) {
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        return composerAttachments.respond(request, url, access?.authenticate(request).deviceId ?? 'local')
          .then(response => response ?? new Response(null, { status: 404 }))
      }

      const attachmentRoute = /^\/s\/([1-9]\d*)\/question-attachments(?:\/([a-f\d-]{36}))?$/u.exec(url.pathname)
      if (attachmentRoute) {
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        const sessionId = Number(attachmentRoute[1])
        const session = engine.current.sessions.get(sessionId)
        if (!session) return new Response(null, { status: 404 })
        const id = attachmentRoute[2]
        if (request.method === 'GET' && id) {
          for (const turn of session.turns) {
            for (const input of turn.inputRequests ?? []) {
              const attachment = input.attachments?.find(file => file.id === id)
              if (attachment) {
                const file = Bun.file(attachments.path(sessionId, input.requestId, attachment))
                return file.exists().then(exists => exists ? new Response(file, { headers: {
                  'Content-Type': 'application/octet-stream',
                  'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/gu, char => '%' + char.charCodeAt(0).toString(16))}`,
                  'Cache-Control': 'private, no-store',
                  'X-Content-Type-Options': 'nosniff',
                } }) : new Response(null, { status: 404 }))
              }
            }
          }
          return new Response(null, { status: 404 })
        }
        const origin = request.headers.get('origin')
        if (origin !== null && origin !== url.origin) return new Response(null, { status: 403 })
        const requestId = url.searchParams.get('request') ?? ''
        const owner = access?.authenticate(request).deviceId ?? 'local'
        if (request.method === 'GET' && !id) {
          const pending = session.pendingInputs.some(input => input.requestId === requestId)
          if (!pending) return Response.json([], { headers: { 'Cache-Control': 'private, no-store' } })
          return attachments.drafts(sessionId, requestId, owner)
            .then(files => Response.json(files, { headers: { 'Cache-Control': 'private, no-store' } }))
            .catch(() => Response.json([], { status: 500 }))
        }
        if (request.method === 'DELETE' && id) {
          return attachments.serialize(sessionId, requestId, async () => {
            if (session.pendingInputs.some(input => input.requestId === requestId))
              await attachments.removeDraft(sessionId, requestId, id, owner)
            return new Response(null, { status: 204 })
          }).catch(() => new Response(null, { status: 500 }))
        }
        if (request.method !== 'POST' || id) return new Response(null, { status: 405 })
        const questionId = url.searchParams.get('question') ?? ''
        const pending = session.pendingInputs.find(input => input.requestId === requestId)
        const question = pending?.questions.find(question => question.id === questionId)
        if (!question || !questionAllowsAttachments(question))
          return Response.json({ error: 'This question does not accept files.' }, { status: 409 })
        return attachments.upload(request, sessionId, requestId, questionId, owner, url.searchParams.get('name') ?? 'attachment')
          .then((attachment) => {
            if (!engine.current.sessions.get(sessionId)?.pendingInputs.some(input => input.requestId === requestId)) {
              pruneQuestionAttachments(sessionId)
              return Response.json({ error: 'This question is no longer pending.' }, { status: 409 })
            }
            return Response.json(attachment, { status: 201 })
          })
          .catch(cause => Response.json({ error: cause instanceof AttachmentError ? cause.message : 'Could not save this attachment.' }, {
            status: cause instanceof AttachmentError ? cause.status : 500,
          }))
      }

      const gitRoute = /^\/s\/([1-9]\d*)\/git\/(commit|pull|push|pull-request|pull-request-checks)$/u.exec(url.pathname)
      if (gitRoute) {
        if (!isLoopbackHost(srv.requestIP(request)?.address ?? '')) return new Response(null, { status: 403 })
        return respondRepositoryAction(request, url, Number(gitRoute[1]), gitRoute[2] as RepositoryAction, () => srv.timeout(request, 150))
      }

      const diffRoute = /^\/s\/(\d+)\/diff(?:\/(options|context|turn-files|status))?$/u.exec(url.pathname)
      if (request.method === 'GET' && diffRoute) {
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        const id = Number(diffRoute[1])
        const session = engine.current.sessions.get(id)
        const path = session?.worktreePath || (options.workspacePath
          ? options.workspacePath(engine.current, id)
          : defaultWorkspacePath(engine.current, id))
        const workspace = session && engine.current.workspaces.get(session.workspaceId)
        return renderWorkspaceReview(path, url, diffRoute[2], session, Boolean(workspace?.trusted && !workspace.scratch))
      }

      const projectScriptsRoute = /^\/s\/([1-9]\d*)\/(project-scripts|project-setup|project-settlement)$/u.exec(url.pathname)
      if (projectScriptsRoute) {
        const headers = { 'cache-control': 'private, no-store' }
        const fetchSite = request.headers.get('sec-fetch-site')
        if (!canUseHostPrivileges(request, url) || !isLoopbackHost(srv.requestIP(request)?.address ?? '')
          || fetchSite === 'cross-site' || fetchSite === 'same-site') return new Response(null, { status: 403, headers })
        const session = engine.current.sessions.get(Number(projectScriptsRoute[1]))
        if (!session) return new Response(null, { status: 404, headers })
        const params = new URLSearchParams({ session: String(session.id) })
        const scope: ProjectSetupScope | null = session.worktreePath
          ? { sessionId: session.id, workspaceId: session.workspaceId, checkout: session.worktreePath }
          : null
        if (projectScriptsRoute[2] === 'project-settlement') {
          if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } })
          const receipt = scope && workspaceFileRoot(params) ? projectSetup.latestSettlement(scope) : null
          if (!receipt) return Response.json(null, { headers })
          const output = terminals.projectJobTail(receipt)
          // Checkout verification can still be running before the PTY is attachable.
          const status = receipt.status === 'running' && output === undefined ? 'pending' : receipt.status
          return Response.json({
            name: receipt.name, resumeKey: receipt.resumeKey, status, exitCode: receipt.exitCode,
            output: output ?? '',
          }, { headers })
        }
        if (projectScriptsRoute[2] === 'project-setup') {
          if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } })
          const receipt = scope && workspaceFileRoot(params) ? projectSetup.read(scope) : null
          const script = receipt && projectScripts.get(session.workspaceId, receipt.scriptId)
          return Response.json(receipt && {
            name: receipt.name, resumeKey: receipt.resumeKey, status: receipt.status, exitCode: receipt.exitCode,
            blocking: Boolean(receipt.wait),
            output: scope ? terminals.projectJobTail({ ...scope, resumeKey: receipt.resumeKey }) ?? '' : '',
            retry: Boolean(script && script.runOnWorktreeCreate),
            previewUrl: script?.autoOpenPreview ? script.previewUrl : '',
          }, { headers })
        }
        return respondProjectScripts(request, projectScripts, session.workspaceId, () => workspaceFileRoot(params), (action) => {
          const active = engine.current.sessions.get(session.id)
          if (!scope || active?.worktreePath !== scope.checkout || active.navigation?.archivedAt || isTurnActive(active.state)) return false
          const receipt = projectSetup.read(scope)
          return Boolean(receipt && projectSetup.resolve(scope, action, projectScripts.get(scope.workspaceId, receipt.scriptId)))
        })
      }

      const previewServersRoute = /^\/s\/([1-9]\d*)\/preview-servers$/u.exec(url.pathname)
      if (previewServersRoute) {
        const headers = { 'cache-control': 'private, no-store' }
        const fetchSite = request.headers.get('sec-fetch-site')
        if (!canUseHostPrivileges(request, url) || !isLoopbackHost(srv.requestIP(request)?.address ?? '')
          || fetchSite === 'cross-site' || fetchSite === 'same-site') return new Response(null, { status: 403, headers })
        if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET' } })
        const session = engine.current.sessions.get(Number(previewServersRoute[1]))
        if (!session || !engine.current.workspaces.has(session.workspaceId)) return new Response(null, { status: 404, headers })
        const scope = { workspaceId: session.workspaceId, sessionId: session.id }
        const roots = terminals.processIds(scope)
        const rootKey = roots.join(',')
        const key = `${scope.sessionId}:${rootKey}`
        let scan = previewScans.get(key)
        if (!scan) {
          scan = readPreviewServers(roots, previewOwner(session.id)).finally(() => previewScans.delete(key))
          previewScans.set(key, scan)
        }
        return scan.then(result => {
          const current = engine.current.sessions.get(scope.sessionId)
          if (!current || current.workspaceId !== scope.workspaceId) return new Response(null, { status: 404, headers })
          const servers = rootKey === terminals.processIds(scope).join(',') ? result.servers : []
          return Response.json({ ...result, servers }, { headers })
        })
      }

      // Shared page assets. Checked before the page routes because their
      // paths are fixed and a render must never shadow them.
      if (url.pathname === TRANSCRIPT_HIGHLIGHT_WORKER) return respondTranscriptHighlightWorker(request)
      const asset = respondStxAsset(url.pathname) ?? assetCache.respond(url.pathname)
      if (asset) return asset

      if (url.pathname === '/workspace-editor') {
        const headers = { 'cache-control': 'private, no-store' }
        if (!canUseHostPrivileges(request, url) || !isLoopbackHost(srv?.requestIP(request)?.address ?? ''))
          return Response.json({ error: 'Open the workspace on the Harness host to launch an editor.' }, { status: 403, headers })
        if (request.method !== 'GET' && request.method !== 'POST')
          return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, POST' } })
        const root = workspaceFileRoot(url.searchParams)
        if (!root) return Response.json({ error: 'Open a trusted workspace to launch an editor.' }, { status: 404, headers })
        return respondWorkspaceEditor(root, url, request.method)
      }

      if (request.method === 'GET' && url.pathname === '/workspace-repositories') {
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        const headers = { 'cache-control': 'private, no-store' }
        const root = workspaceFileRoot(url.searchParams)
        if (!root) return Response.json({ error: 'Project repositories are unavailable.' }, { status: 404, headers })
        return Promise.all([isWorkspaceGitRoot(root), scanProjectRepositories(root), projectWorktreeLayout(root)])
          .then(([hasProjectRepository, repositories, layout]) => Response.json({
            hasProjectRepository, repositories, requiresProjectCommand: Boolean(layout),
            canStartWorktree: layout ? canUseHostPrivileges(request, url) : hasProjectRepository || repositories.length > 0,
          }, { headers }))
          .catch(() => Response.json({ error: 'Could not read project repositories.' }, { status: 503, headers }))
      }

      if (request.method === 'GET' && /^\/workspace-files\/(?:search|tree|preview|content|download)$/u.test(url.pathname)) {
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        const headers = { 'cache-control': 'private, no-store' }
        const root = workspaceFileRoot(url.searchParams)
        if (!root) return Response.json({ error: 'Workspace files are unavailable.' }, { status: 404, headers })
        const response = url.pathname === '/workspace-files/search'
          ? searchWorkspaceFiles(root, url.searchParams.get('q') ?? '', url.searchParams.get('refresh') === '1')
            .then(results => Response.json({ results }, { headers }))
          : respondWorkspaceFile(root, url, request)
        return response.catch(() => Response.json({ error: 'Could not read workspace files.' }, { status: 503, headers }))
      }

      if (url.pathname === '/threads/search' && request.method === 'GET') {
        const profileId = Number(url.searchParams.get('profile'))
        return Response.json({ results: searchThreads(engine.current, profileId, url.searchParams.get('q') ?? '') }, {
          headers: { 'cache-control': 'no-store' },
        })
      }

      // Driver availability, for the composer's agent picker. Probes spawn
      // provider CLIs, so results are held briefly — a dropdown opened twice
      // should not fork ten processes.
      if (url.pathname === '/drivers') {
        const workspace = engine.current.workspaces.get(Number(url.searchParams.get('workspace')))
        const profile = engine.current.profiles.get(workspace?.profileId ?? Number(url.searchParams.get('profile')))
        const workspacePath = workspace?.trusted && !workspace.scratch ? workspace.path : tmpdir()
        const includeModels = url.searchParams.get('models') === '1'
        const drivers = Promise.all(driverKinds().map(async kind => ({
          kind,
          ...await probeDriver(kind, { workspacePath }, includeModels),
        })))
        const hostPrivileges = canUseHostPrivileges(request, url)
        const accounts = workspace?.trusted && !workspace.scratch
          ? Promise.all(savedProviders.list(workspace.profileId, workspace.path)
              .filter(({ launch }) => !launch.chatGptClientId || hostPrivileges)
              .map(async ({ id, kind, name, launch }) => {
                const account = { id, kind, name, ...(launch.chatGptClientId ? { auth: 'chatgpt' } : {}) }
                try {
                  const config = await providerLaunchConfig(chatGptCredentials, launch)
                  return { ...account, ...await probeDriver(kind, { ...config, workspacePath }, includeModels) }
                }
                catch {
                  return { ...account, status: 'failed' }
                }
              }))
          : []
        return Promise.all([drivers, accounts]).then(([drivers, accounts]) => Response.json({
          drivers,
          accounts,
          canEditProviderAccounts: hostPrivileges,
          ...(includeModels ? {
            favorites: profile?.modelFavorites?.filter(favorite => favorite.providerInstanceId === undefined
              || accounts.some(account => account.id === favorite.providerInstanceId && account.kind === favorite.driverKind)) ?? [],
          } : {}),
        }, { headers: { 'cache-control': 'no-store' } }))
      }

      // The web surface. Rendered from the in-memory projection — no query
      // runs, so the shell paints immediately — and cached against the state
      // revision, so only the first request after a state change renders.
      if (url.pathname === '/projects/clone') {
        const site = request.headers.get('sec-fetch-site')
        if (!canUseHostPrivileges(request, url) || !isLoopbackHost(srv.requestIP(request)?.address ?? '')
          || site === 'cross-site' || site === 'same-site')
          return new Response(null, { status: 403, headers: { 'cache-control': 'no-store' } })
        return projectClones.handle(request, url, profile => engine.current.profiles.has(profile))
      }

      if (url.pathname === '/prompt-link/pull-request')
        return respondPullRequestLink(request, url, isLoopbackHost(srv.requestIP(request)?.address ?? ''), () => srv.timeout(request, 65))

      if (url.pathname === '/prompt-link/project') {
        if (request.method !== 'GET') return new Response(null, { status: 405 })
        if (!access && !canUseHostPrivileges(request, url)) return new Response(null, { status: 403 })
        return promptLinkProjects(engine.current, url.searchParams)
      }

      if (['/pull-requests', '/pull-requests/viewed', '/pull-requests/conversation', '/pull-requests/reply', '/pull-requests/comments', '/pull-requests/review', '/pull-requests/lifecycle', '/pull-requests/labels', '/pull-requests/reviewers'].includes(url.pathname)) {
        const headers = { 'cache-control': 'private, no-store', 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' }
        const site = request.headers.get('sec-fetch-site')
        if (!canUseHostPrivileges(request, url) || !isLoopbackHost(srv.requestIP(request)?.address ?? '')
          || site === 'cross-site' || site === 'same-site') return new Response(null, { status: 403, headers })
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120_000)])
        if (url.pathname === '/pull-requests/comments') {
          if (request.method !== 'GET') return new Response(null, { status: 405, headers })
          srv.timeout(request, 150)
          return loadWorkspaceReviewComments(engine.current, url.searchParams, signal).then(({ status, body }) =>
            Response.json(body, { status, headers: { ...headers, 'content-type': 'application/json' } }))
        }
        const render = async (query: URLSearchParams, status = 200, formState?: {
          replyDraft?: PullRequestReplyDraft
          lifecycleDraft?: PullRequestLifecycleDraft
          lifecycleError?: string
          labelDraft?: PullRequestLabelDraft
          labelError?: string
          reviewerDraft?: PullRequestReviewerDraft
          reviewerEditor?: PullRequestReviewerEditor
          reviewerError?: string
        }) => {
          try {
            const view = await pullRequestWorkspace(engine.current, query, signal)
            const html = await renderHarnessTemplate(join(process.cwd(), 'resources/views/harness-pull-requests.stx'), { ...view, ...formState })
            return new Response(renderPullRequestMarkdown(html, view), { status, headers })
          }
          catch { return new Response('Could not load the pull request workspace. Try again.', { status: 503, headers }) }
        }
        if (url.pathname !== '/pull-requests') {
          if (request.method !== 'POST') return new Response(null, { status: 405, headers })
          const referer = request.headers.get('referer')
          if (request.headers.get('origin') !== url.origin && site !== 'same-origin'
            && (!referer || URL.parse(referer)?.origin !== url.origin)) return new Response(null, { status: 403, headers })
          if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
            return new Response(null, { status: 415, headers })
          srv.timeout(request, 150)
          if (url.pathname === '/pull-requests/labels') {
            const acceptsJson = request.headers.get('accept') === 'application/json'
            const jsonHeaders = { ...headers, 'content-type': 'application/json' }
            return updateWorkspacePullRequestLabels(engine.current, url.searchParams, request, signal, reviewReplies).then((submission) => {
              if (!submission) {
                const message = 'Invalid label selection. Open Change labels and try again.'
                return acceptsJson ? Response.json({ message }, { status: 400, headers: jsonHeaders }) : new Response(message, { status: 400, headers })
              }
              const { result, message, location, params, fallback } = submission
              const statuses = { updated: 200, confirmed: 200, pending: 202, denied: 403, changed: 409, refused: 422, unavailable: 503 }
              if (acceptsJson) return Response.json({ result, message, location }, { status: statuses[result], headers: jsonHeaders })
              if (statuses[result] === 200) return new Response(null, { status: 303, headers: { ...headers, location } })
              return render(params, statuses[result], { labelDraft: fallback, labelError: message })
            })
          }
          if (url.pathname === '/pull-requests/reviewers') {
            const acceptsJson = request.headers.get('accept') === 'application/json'
            const jsonHeaders = { ...headers, 'content-type': 'application/json' }
            return updateWorkspacePullRequestReviewers(engine.current, url.searchParams, request, signal, reviewReplies).then((submission) => {
              if (!submission) {
                const message = 'Invalid reviewer selection. Open Change reviewers and try again.'
                return acceptsJson ? Response.json({ message }, { status: 400, headers: jsonHeaders }) : new Response(message, { status: 400, headers })
              }
              const { result, message, location, params, fallback, editor } = submission
              const statuses = { updated: 200, confirmed: 200, search: 200, pending: 202, denied: 403, changed: 409, refused: 422, unavailable: 503 }
              if (acceptsJson) return Response.json({ result, message, location, ...(editor && { editor }) }, { status: statuses[result], headers: jsonHeaders })
              if (result === 'updated' || result === 'confirmed') return new Response(null, { status: 303, headers: { ...headers, location } })
              return render(params, statuses[result], { reviewerDraft: fallback, reviewerEditor: editor, reviewerError: message })
            })
          }
          if (url.pathname === '/pull-requests/lifecycle') {
            const acceptsJson = request.headers.get('accept') === 'application/json'
            return updateWorkspacePullRequestLifecycle(engine.current, url.searchParams, request, signal, reviewReplies).then((submission) => {
              if (!submission) {
                const message = 'Invalid pull request update. Reopen the request and try again.'
                return acceptsJson ? Response.json({ message }, { status: 400, headers }) : new Response(message, { status: 400, headers })
              }
              const { result, message, location, params, fallback } = submission
              const statuses = { updated: 200, pending: 202, denied: 403, changed: 409, 'branch-changed': 409, 'approval-changed': 409, busy: 409, refused: 422, unavailable: 503 }
              if (acceptsJson) return Response.json({ result, message, location }, { status: statuses[result], headers })
              if (result === 'updated') return new Response(null, { status: 303, headers: { ...headers, location } })
              return render(params, statuses[result], { lifecycleDraft: fallback, lifecycleError: message })
            })
          }
          if (url.pathname === '/pull-requests/review') {
            return submitWorkspaceInlineReview(engine.current, url.searchParams, request, signal, reviewReplies).then((submission) => {
              if (!submission) return Response.json({ result: 'invalid', message: 'Check the review text and comments before submitting.' }, { status: 400, headers })
              const statuses = { posted: 200, pending: 202, invalid: 422, changed: 409, denied: 403, unavailable: 503 }
              return Response.json(submission, { status: statuses[submission.result], headers })
            })
          }
          if (url.pathname === '/pull-requests/reply') {
            const acceptsJson = request.headers.get('accept') === 'application/json'
            return submitWorkspaceReviewReply(engine.current, url.searchParams, request, signal, reviewReplies)
              .then((submission) => {
                const jsonHeaders = { ...headers, 'content-type': 'application/json' }
                if (!submission) {
                  const message = 'Invalid reply request. Reopen the Code view and try again.'
                  return acceptsJson ? Response.json({ message }, { status: 400, headers: jsonHeaders }) : new Response(message, { status: 400, headers })
                }
                const { result, message, comment } = submission
                const statuses = { posted: 200, pending: 202, invalid: 422, changed: 409, denied: 403, unavailable: 503 }
                if (acceptsJson) return Response.json({ result, message, comment }, { status: statuses[result], headers: jsonHeaders })
                if (result === 'posted') return new Response(null, { status: 303, headers: { ...headers, location: submission.location } })
                return render(submission.params, statuses[result], { replyDraft: submission.fallback })
              })
          }
          const action = url.pathname === '/pull-requests/viewed' ? updateWorkspaceFileViewed : updateWorkspaceReviewConversation
          return action(engine.current, url.searchParams, request, signal)
            .then((update) => {
              const acceptsJson = request.headers.get('accept') === 'application/json'
              if (!update) {
                const message = 'Invalid file review request. Reopen the Code view and try again.'
                return acceptsJson ? Response.json({ message }, { status: 400, headers: { ...headers, 'content-type': 'application/json' } }) : new Response(message, { status: 400, headers })
              }
              if (!acceptsJson) return new Response(null, { status: 303, headers: { ...headers, location: update.location } })
              const status = update.result === 'unavailable' ? 503 : update.result === 'denied' ? 403
                : update.result === 'changed' || update.result === 'busy' ? 409 : 200
              const conversation = 'conversation' in update ? update.conversation : undefined
              return Response.json({ result: update.result, message: update.message, conversation }, { status, headers: { ...headers, 'content-type': 'application/json' } })
            })
        }
        if (request.method !== 'GET') return new Response(null, { status: 405, headers })
        srv.timeout(request, 150)
        return render(url.searchParams)
      }

      const settings = settingsSection(url.pathname)
      if (settings === 'general' && url.pathname !== '/settings/general')
        return new Response(null, { status: 307, headers: { location: '/settings/general' + url.search } })
      const sharedDraft = url.pathname === '/new' || url.pathname === '/new/'
      if (url.pathname === '/' || url.pathname.startsWith('/s/') || sharedDraft || settings) {
        const workspaceUrl = settings ? new URL(workspaceReturn(url.searchParams.get('from')), url.origin) : url
        const pageHeaders: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }
        const sessionId = /^\/s\/([1-9]\d*)\/?$/u.exec(workspaceUrl.pathname)
        const id = sessionId ? Number(sessionId[1]) : undefined
        const missingThread = workspaceUrl.pathname.startsWith('/s/') && !engine.current.sessions.has(id ?? 0)
        const shared = sharedDraft || workspaceUrl.searchParams.has('prompt') || workspaceUrl.searchParams.has('pr')
        if (shared) {
          pageHeaders['cache-control'] = 'no-store'
          pageHeaders['referrer-policy'] = 'no-referrer'
        }
        const canLaunchWorkspaceEditor = canUseHostPrivileges(request, url)
          && (!remote || isLoopbackHost(srv?.requestIP(request)?.address ?? ''))
        // The socket URL embedded in the page depends on both host and scheme.
        const cacheKey = `${url.pathname}${url.search}|${url.origin}|${stateRev}|${canLaunchWorkspaceEditor}`
        const cached = shared ? undefined : renderCache.get(cacheKey)
        if (cached !== undefined) {
          return new Response(cached, {
            status: missingThread ? 404 : 200,
            headers: { ...pageHeaders, 'x-render-cache': 'hit' },
          })
        }
        return renderHarnessView(viewProps(engine.current, {
          sessionId: id,
          missingThread,
          // `?profile=` opens the sidebar on a given space. Swiping past the
          // active space's neighbours lands here, so the server renders that
          // space's rows rather than the client rebuilding them.
          profileId: Number(workspaceUrl.searchParams.get('profile')) || undefined,
          workspaceId: Number(workspaceUrl.searchParams.get('workspace')) || undefined,
          withoutProject: sharedDraft || workspaceUrl.searchParams.get('project') === 'none',
          freshDraftId: workspaceUrl.searchParams.get('draft'),
          pullRequestProfile: sharedDraft ? Number(workspaceUrl.searchParams.get('profile')) || undefined : undefined,
          settingsSection: settings ?? undefined,
          serverUrl: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws`,
          codecUrl,
          remoteEnabled: access !== null,
          canLaunchWorkspaceEditor,
        })).then((html) => {
          if (html === null) return new Response('view not found', { status: 404 })

          // Stored under the key captured at request time: if an event landed
          // mid-render, the new revision's requests miss this entry and
          // render fresh, which is the consistency renders had all along.
          if (!shared) renderCache.set(cacheKey, html)
          if (renderCache.size > RENDER_CACHE_CAP) {
            const oldest = renderCache.keys().next().value
            if (oldest !== undefined) renderCache.delete(oldest)
          }

          return new Response(html, {
            status: missingThread ? 404 : 200,
            headers: { ...pageHeaders, 'x-render-cache': 'miss' },
          })
        }).catch((error: unknown) => {
          // A template error must not take the socket down with it.
          const message = error instanceof Error ? error.message : String(error)
          return new Response(`view failed to render: ${message}`, { status: 500 })
        })
      }

      // What the page can actually see of the native host.
      //
      // Craft's JS is injected by the host, so whether `window.craft` and its
      // gesture surface exist in a given window type is a property of the
      // build, not of our code — and the only honest way to know is to ask the
      // page. Reported here rather than console-logged so a headless check can
      // read it.
      if (url.pathname === '/native-probe' && request.method === 'POST') {
        return request.json().then((body) => {
          nativeProbe = body as Record<string, unknown>
          // Cold start, measured in one process so the two clocks are the same
          // one: from the moment the window was spawned to the moment its page
          // ran its own JS. Timing it from the outside would fold in the CLI's
          // own boot and the server's hydrate, which the user pays once and
          // which have nothing to do with the page.
          if (windowSpawnedAt !== null && nativeProbe.phase === undefined) {
            nativeProbe.coldStartMs = Date.now() - windowSpawnedAt
            console.warn(`[native] cold start: ${nativeProbe.coldStartMs}ms (window spawn → page JS)`)
          }
          console.warn('[native] probe:', JSON.stringify(nativeProbe))
          return new Response('ok')
        }).catch(() => new Response('bad probe', { status: 400 }))
      }

      if (url.pathname === '/native-probe')
        return Response.json(nativeProbe ?? { seen: false })

      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          sessions: engine.current.sessions.size,
          profiles: engine.current.profiles.size,
          clients: sockets.size,
        })
      }

      return new Response('not found', { status: 404 })
    },

    websocket: {
      open(socket) {
        sockets.add(socket)
        send(socket, { t: 'ready', profiles: engine.current.profiles.size })
      },
      close(socket) {
        sockets.delete(socket)
        terminals.disconnect(socket)
      },
      message(socket, message) {
        // Text frames are not part of the protocol: the contract is CBOR, and
        // silently accepting JSON would let two encodings drift apart.
        if (typeof message === 'string') {
          send(socket, { t: 'protocol-error', message: 'binary CBOR frames only' })
          return
        }
        void onFrame(socket, new Uint8Array(message))
      },
    },
  })

  // Opened last: a relay that starts advertising a URL before the socket is
  // listening would hand out an address that 502s for its first requests.
  let tunnel: Awaited<ReturnType<typeof openTunnel>> | null = null
  if (options.tunnel) {
    const settings = typeof options.tunnel === 'object' ? options.tunnel : {}
    try {
      tunnel = await openTunnel({
        port,
        authenticated: access !== null,
        ...(settings.server ? { server: settings.server } : {}),
        ...(settings.subdomain ? { subdomain: settings.subdomain } : {}),
      })
    }
    catch (error) {
      // An unreachable relay must not leave the port bound and the database
      // open. A caller that catches this and retries would otherwise find its
      // own port in use, by itself.
      server.stop(true)
      savedProviders.close()
      projectScripts.close()
      projectSetup.close()
      projectClones.close()
      store.close()
      throw error
    }
  }

  const reapComposerStashes = () => void composerAttachments.reapStashes().catch(() => {})
  reapComposerStashes()
  const composerStashTimer = setInterval(reapComposerStashes, 60 * 60 * 1000)
  composerStashTimer.unref()
  scheduleThreadMaintenance()
  runPendingSettlements()
  projectClones.recover()
  return {
    server,
    engine,
    runtime,
    access,
    tunnelUrl: tunnel?.url ?? null,
    markWindowSpawned: () => { windowSpawnedAt = Date.now() },
    stop: () => {
      if (closing) return
      closing = true
      clearTimeout(maintenanceTimer)
      clearTimeout(settlementRetry)
      clearInterval(composerStashTimer)
      for (const timer of compactTimers.values()) clearTimeout(timer)
      compactTimers.clear()
      void tunnel?.close()
      void runtime.stopAll()
      settlementAbort.abort()
      terminals.shutdown()
      server.stop(true)
      savedProviders.close()
      projectScripts.close()
      projectSetup.close()
      projectClones.close()
      store.close()
    },
  }
}
