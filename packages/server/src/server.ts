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
import { access as checkAccess, constants, realpath, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ChatGptCredentialStore, driverKinds, resolveDriver as resolveRegisteredDriver } from '@harness/drivers'
import type { DoomedWorktree } from './runtime'
import { CborError, decode, encode, inputResponseValues, questionAllowsAttachments, validInputAnswers } from '@harness/contract'
import { findDenShell } from './pty'
import type { HarnessState } from '@harness/engine'
import { claudeIdleCompaction, effectiveClaudeCompaction, Engine, forkResponsePoint, isTurnActive, isVisiblePin, profilePinnedThreads, reduce, SqliteStore } from '@harness/engine'
import { AccessControl, isLoopbackHost, sessionCookie, writeLocalToken } from './access'
import { ASSET_PREFIX, AssetCache, respondStxAsset } from './assets'
import { workspaceDiff, workspaceDiffRevision } from './diff'
import { AttachmentError, QuestionAttachments } from './question-attachments'
import { buildClientCodec } from './client-bundle'
import { respondTranscriptHighlightWorker, TRANSCRIPT_HIGHLIGHT_WORKER } from './transcript-highlight-asset'
import { chatGptCredentialDirectory, providerLaunchConfig, SavedProviderInstances } from './provider-instances'
import { defaultWorkspacePath, ProviderRuntime, releaseWorktrees, worktreesOfProfile } from './runtime'
import { openScratchWorkspace, scratchWorkspacePath } from './scratch-workspace'
import { settingsSection, workspaceReturn } from './settings-location'
import { searchThreads } from './thread-search'
import { threadSidebarLayout } from './thread-sidebar'
import { open as openTunnel } from './tunnel'
import { renderHarnessView, viewProps } from './views'
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
  | { t: 'ping' }
  | { t: 'term-open', workspaceId: number, sessionId?: number, resumeKey?: string, resumeOnly?: true, cols?: number, rows?: number }
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
  const attachmentOwners = new WeakMap<CommandEnvelope, string>()
  const scratchDirectory = resolve(options.scratchDirectory ?? join(homedir(), '.harness', 'scratch'))
  const store = new SqliteStore(databasePath)
  const savedProviders = new SavedProviderInstances(databasePath)
  const chatGptCredentials = new ChatGptCredentialStore(options.chatGptCredentialDirectory ?? chatGptCredentialDirectory())
  const engine = new Engine({
    store,
    reducer: reduce,
    async prepareClientCommand(command, envelope) {
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
    workspacePath: options.workspacePath,
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

  const sockets = new Set<HarnessSocket>()
  const terminals = new WorkspaceTerminals<HarnessSocket>(send, new TerminalHistoryStore(databasePath))
  const terminalScopeExists = (scope: TerminalScope) => engine.current.workspaces.has(scope.workspaceId)
    && (scope.sessionId === undefined || engine.current.sessions.get(scope.sessionId)?.workspaceId === scope.workspaceId)
  terminals.prune(terminalScopeExists)
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
  function pairingPage(error: string | null): string {
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
  <button type="submit">Pair this device</button>
</form>
<script>
  // Named after the device rather than "a device", without asking: the phone
  // already knows what it is, and one fewer field is one fewer reason to give up.
  document.querySelector('input[name=name]').value =
    (navigator.userAgentData?.platform || navigator.platform || 'a device') + ' browser'
</script>`
  }

  async function pairingResponse(request: Request, url: URL): Promise<Response> {
    if (!access) return new Response('not found', { status: 404 })

    if (request.method !== 'POST') {
      return new Response(pairingPage(null), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    const form = await request.formData().catch(() => null)
    if (!form) return new Response(pairingPage('that form did not arrive intact'), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })

    const result = await access.redeem(String(form.get('code') ?? ''), String(form.get('name') ?? ''))
    if (!result.ok) {
      return new Response(pairingPage(result.reason), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    console.warn(`[access] paired a new device from ${url.host}`)
    // 303 so the browser follows with GET; the cookie rides along and the
    // device lands on the app already authenticated.
    return new Response(null, {
      status: 303,
      headers: {
        'location': '/',
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
    for (const event of events) {
      if (event.payload.type === 'profile.deleted')
        terminals.prune(terminalScopeExists)
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

      if (event.payload.type === 'session.navigation-changed') {
        const changes = event.payload.changes
        if ('snoozedUntil' in changes) scheduleThreadWake()
      }
      if (event.payload.type === 'session.navigation-changed' || event.payload.type === 'session.created' || event.payload.type === 'turn.started'
        || event.payload.type === 'turn.completed' || event.payload.type === 'turn.interrupted'
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
  let wakeTimer: ReturnType<typeof setTimeout> | undefined
  let wakingThreads = false

  function scheduleThreadWake(minimumDelay = 0): void {
    if (wakingThreads || closing) return
    clearTimeout(wakeTimer)
    let earliest = Infinity
    for (const session of engine.current.sessions.values())
      earliest = Math.min(earliest, session.navigation?.snoozedUntil ?? Infinity)
    if (!Number.isFinite(earliest)) return
    wakeTimer = setTimeout(() => void wakeThreads(), Math.max(minimumDelay, Math.min(2_147_483_647, earliest - Date.now())))
  }

  async function wakeThreads(): Promise<void> {
    if (closing) return
    wakingThreads = true
    let retryDelay = 0
    try {
      const at = Date.now()
      for (const session of engine.current.sessions.values()) {
        const until = session.navigation?.snoozedUntil
        if (until == null || until > at || closing) continue
        const result = await engine.dispatchInternal({
          id: `thread-wake_${crypto.randomUUID()}`, at,
          command: { type: 'thread.snooze.elapsed', sessionId: session.id, until },
        })
        if (!closing) broadcast(result.events)
      }
    }
    catch (error) {
      if (!closing) console.warn('[thread wake] Could not wake a snoozed thread.', error)
      retryDelay = 1000
    }
    finally {
      wakingThreads = false
      scheduleThreadWake(retryDelay)
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

  function startAcceptedTurn(events: HarnessEvent[]): void {
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
      await runtime.runTurn(sessionId, payload.turnId, payload.text ?? '')
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
    doomed: DoomedWorktree[] = [],
  ): Promise<void> {
    const command = envelope.command

    // A worktree is a directory on disk and the log does not own it, so
    // deleting a profile used to leave a full checkout behind per isolated
    // session. The event carries the sessions it removed precisely so this can
    // find them after they are gone from the projection.
    if (command.type === 'profile.delete') {
      const deleted = result.events.find(event => event.payload.type === 'profile.deleted')
      if (!deleted) return
      if (deleted.payload.type === 'profile.deleted')
        for (const id of deleted.payload.sessionIds ?? []) pruneQuestionAttachments(id)
      const released = await releaseWorktrees(doomed)
      for (const entry of released) {
        console.warn(
          `[worktree] released ${entry.path}`
          + (entry.committed ? ` (committed leftovers as ${entry.committed.slice(0, 8)})` : ''),
        )
      }
      return
    }

    if (command.type === 'session.fork') {
      const created = result.events.find(event => event.payload.type === 'session.created')
      if (created) void runtime.forkSession(created.sessionId)
      return
    }
    if (command.type === 'session.turn.start' || command.type === 'session.handoff' || command.type === 'session.queue.send') {
      startAcceptedTurn(result.events)
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

    if (command.type === 'session.checkpoint.revert') {
      await runtime.revert(command.sessionId, command.checkpointId)
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
        const scope = { workspaceId: workspace.id, sessionId: session?.id, resumeKey: frame.resumeKey }
        if (terminals.resume(socket, scope)) return
        const shellKind = engine.current.settings.terminalShell
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
        const cwd = session ? defaultWorkspacePath(engine.current, session.id) ?? workspace.path : workspace.path
        const cols = Number.isFinite(frame.cols) ? Math.min(500, Math.max(20, Math.floor(frame.cols!))) : 80
        const rows = Number.isFinite(frame.rows) ? Math.min(200, Math.max(5, Math.floor(frame.rows!))) : 24
        terminals.open(socket, scope, shellKind, { cwd, cols, rows, shell, denIntegration: shellKind === 'den' }, saved)
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
        const envelope = useHostClock ? { ...received, at: Date.now() } : received
        // Read before dispatching: a deleted profile takes its sessions with
        // it, and their worktree paths go with them.
        const doomed = envelope.command.type === 'profile.delete'
          ? worktreesOfProfile(engine.current, envelope.command.profileId)
          : []

        try {
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
          const result = command.type === 'session.input.respond' && Number.isSafeInteger(command.sessionId) && typeof command.requestId === 'string'
            ? await attachments.serialize(command.sessionId, command.requestId, () => engine.dispatch(envelope))
            : await engine.dispatch(envelope)
          send(socket, {
            t: 'dispatched',
            id: envelope.id,
            replayed: result.replayed,
            seqs: result.events.map(event => event.seq),
          })
          // Broadcast after acking, so the dispatcher's own ack cannot arrive
          // after the events it caused.
          broadcast(result.events)
          // Then act on it. A retry (`replayed`) must not start a second agent
          // run — the receipt already accounted for the first.
          if (!result.replayed) await react(envelope, result, doomed)
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
            return new Response(pairingPage(null), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } })
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

      // Rebuild a visible diff when its comparison changes. A client that
      // already has this Git revision needs only the cheap HEAD check.
      if (url.pathname.startsWith('/s/') && url.pathname.endsWith('/diff')) {
        const id = Number(url.pathname.slice(3, -'/diff'.length)) || 0
        const path = options.workspacePath
          ? options.workspacePath(engine.current, id)
          : defaultWorkspacePath(engine.current, id)
        const headers = { 'cache-control': 'private, no-store' }
        if (!path) return Response.json({ isRepository: false, scope: 'working-tree', files: [], patch: '', error: 'session has no workspace' }, { headers })
        // The session's earliest checkpoint is its baseline: taken before the
        // first turn ran, so diffing against it answers "what did this session
        // change" rather than "what is uncommitted here".
        const baseline = engine.current.sessions.get(id)?.checkpoints[0]?.vcsRef
        return workspaceDiffRevision(path, baseline)
          .then(async (revision) => {
            if (url.searchParams.get('knownRevision') === revision)
              return new Response(null, { status: 204, headers })
            const diff = await workspaceDiff(path, baseline)
            return Response.json({ ...diff, revision }, { headers })
          })
          // A diff that cannot be read must not take the page down with it.
          .catch(() => Response.json({ isRepository: false, scope: 'working-tree', files: [], patch: '', error: 'could not read the workspace' }, { headers }))
      }

      // Shared page assets. Checked before the page routes because their
      // paths are fixed and a render must never shadow them.
      if (url.pathname === TRANSCRIPT_HIGHLIGHT_WORKER) return respondTranscriptHighlightWorker(request)
      const asset = respondStxAsset(url.pathname) ?? assetCache.respond(url.pathname)
      if (asset) return asset

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
      const settings = settingsSection(url.pathname)
      if (settings === 'general' && url.pathname !== '/settings/general')
        return new Response(null, { status: 307, headers: { location: '/settings/general' + url.search } })
      if (url.pathname === '/' || url.pathname.startsWith('/s/') || settings) {
        const workspaceUrl = settings ? new URL(workspaceReturn(url.searchParams.get('from')), url.origin) : url
        // The socket URL embedded in the page depends on both host and scheme.
        const cacheKey = `${url.pathname}${url.search}|${url.origin}|${stateRev}`
        const cached = renderCache.get(cacheKey)
        if (cached !== undefined) {
          return new Response(cached, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'x-render-cache': 'hit' },
          })
        }
        const sessionId = workspaceUrl.pathname.startsWith('/s/')
          ? Number(workspaceUrl.pathname.slice(3)) || undefined
          : undefined
        return renderHarnessView(viewProps(engine.current, {
          sessionId,
          // `?profile=` opens the sidebar on a given space. Swiping past the
          // active space's neighbours lands here, so the server renders that
          // space's rows rather than the client rebuilding them.
          profileId: Number(workspaceUrl.searchParams.get('profile')) || undefined,
          workspaceId: Number(workspaceUrl.searchParams.get('workspace')) || undefined,
          withoutProject: workspaceUrl.searchParams.get('project') === 'none',
          settingsSection: settings ?? undefined,
          serverUrl: `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/ws`,
          codecUrl,
          remoteEnabled: access !== null,
        })).then((html) => {
          if (html === null) return new Response('view not found', { status: 404 })

          // Stored under the key captured at request time: if an event landed
          // mid-render, the new revision's requests miss this entry and
          // render fresh, which is the consistency renders had all along.
          renderCache.set(cacheKey, html)
          if (renderCache.size > RENDER_CACHE_CAP) {
            const oldest = renderCache.keys().next().value
            if (oldest !== undefined) renderCache.delete(oldest)
          }

          return new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'x-render-cache': 'miss' },
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
      store.close()
      throw error
    }
  }

  scheduleThreadWake()
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
      clearTimeout(wakeTimer)
      for (const timer of compactTimers.values()) clearTimeout(timer)
      compactTimers.clear()
      void tunnel?.close()
      void runtime.stopAll()
      terminals.shutdown()
      server.stop(true)
      savedProviders.close()
      store.close()
    },
  }
}
