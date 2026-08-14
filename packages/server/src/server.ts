/**
 * The harness server: one HTTP surface, one WebSocket, one engine.
 *
 * The server is the execution boundary. Clients dispatch commands and subscribe
 * to events; they never spawn a process, touch git, or read the filesystem.
 * That is what makes "drive it from your phone" fall out of the architecture
 * rather than being a feature bolted on later.
 */

import type { CommandEnvelope, DriverKind } from '@harness/contract'
import type { Server, ServerWebSocket } from 'bun'
import type { Driver } from '@harness/drivers'
import type { DoomedWorktree } from './runtime'
import { CborError, decode, encode } from '@harness/contract'
import { Pty } from './pty'
import type { HarnessState } from '@harness/engine'
import { Engine, reduce, SqliteStore } from '@harness/engine'
import { AccessControl, isLoopbackHost, sessionCookie, writeLocalToken } from './access'
import { ASSET_PREFIX, AssetCache } from './assets'
import { workspaceDiff } from './diff'
import { buildClientCodec } from './client-bundle'
import { defaultWorkspacePath, ProviderRuntime, releaseWorktrees, worktreesOfProfile } from './runtime'
import { open as openTunnel } from './tunnel'
import { renderHarnessView, viewProps } from './views'

export interface ServeOptions {
  port?: number
  hostname?: string
  databasePath?: string
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
  /**
   * Live terminals owned by this socket, killed with it. Owned per-socket
   * rather than pooled because a PTY with no reader is a shell running
   * unwatched — exactly what a disconnect must not leave behind.
   */
  terminals: Map<number, Pty>
  /** Sessions this socket has subscribed to. Empty means "not subscribed". */
  subscriptions: Set<number>
  /**
   * Highest sequence delivered per session. Provider events arrive outside the
   * request path, so the drain pass needs to know what each socket already has
   * rather than re-sending a session's whole log.
   */
  cursors: Map<number, number>
}

type HarnessSocket = ServerWebSocket<SocketData>

/** Frames a client may send. */
type ClientFrame =
  | { t: 'dispatch', envelope: CommandEnvelope }
  | { t: 'subscribe', sessionId: number, sinceSeq?: number }
  | { t: 'unsubscribe', sessionId: number }
  | { t: 'ping' }
  | { t: 'term-open', workspaceId: number, cols?: number, rows?: number }
  | { t: 'term-input', termId: number, data: string }
  | { t: 'term-resize', termId: number, cols: number, rows: number }
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
  const store = new SqliteStore(options.databasePath ?? 'database/stacks.sqlite')
  const engine = new Engine({ store, reducer: reduce })
  const runtime = new ProviderRuntime({
    engine,
    resolve: options.resolveDriver,
    workspacePath: options.workspacePath,
    autoApprove: options.autoApprove,
    // Push provider output the moment it lands, so a transcript streams rather
    // than appearing all at once when the turn ends.
    onEvents: events => broadcast(events),
  })
  // Hydrate before listening, not after. A socket that connects into a
  // half-built read model would be served a projection missing everything the
  // log has not replayed yet, and it has no way to tell.
  await engine.hydrate()

  // Close out turns that were in flight when the process last stopped.
  //
  // A turn only runs because a provider instance is running it, and those die
  // with the process. Replay faithfully restores the session as `running` or
  // `awaiting-approval`, which is what the log says — but nothing is going to
  // finish it. Left alone the session waits forever: it will not accept a new
  // turn ("a turn is already running") and it will not accept a revert, so the
  // only recovery is for someone to notice and press stop.
  //
  // Recorded as an interruption rather than quietly rewritten, so the log says
  // what happened.
  for (const session of engine.current.sessions.values()) {
    if (session.state !== 'running' && session.state !== 'awaiting-approval') continue
    const turn = session.turns.at(-1)
    if (!turn || turn.status !== 'running') continue
    try {
      // The same command a person's stop button sends. It finds the running
      // turn itself and is a no-op when there is none.
      await engine.dispatchInternal({
        id: `boot_interrupt_${session.id}_${turn.id}`,
        at: Date.now(),
        command: { type: 'session.turn.interrupt', sessionId: session.id },
      })
    }
    catch {
      // A session the reducer refuses to interrupt is already in some terminal
      // state; nothing to recover.
    }
  }

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
  if (access) await writeLocalToken(access.localToken)

  const sockets = new Set<HarnessSocket>()
  let lastTermId = 0
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
   * Push events to everyone subscribed to their session.
   *
   * Global events (session id 0) go to every socket: a new profile is
   * relevant to every open client, and none of them subscribe to it.
   */
  function broadcast(events: Awaited<ReturnType<Engine['dispatch']>>['events']): void {
    for (const event of events) {
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

      for (const socket of sockets) {
        if (event.sessionId !== 0 && !socket.data.subscriptions.has(event.sessionId)) continue
        send(socket, { t: 'event', event })
        const seen = socket.data.cursors.get(event.sessionId) ?? 0
        if (event.seq > seen) socket.data.cursors.set(event.sessionId, event.seq)
      }
    }
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
      const released = await releaseWorktrees(doomed)
      for (const entry of released) {
        console.warn(
          `[worktree] released ${entry.path}`
          + (entry.committed ? ` (committed leftovers as ${entry.committed.slice(0, 8)})` : ''),
        )
      }
      return
    }

    if (command.type === 'session.turn.start') {
      const started = result.events.find(event => event.payload.type === 'turn.started')
      if (!started) return
      const turnId = (started.payload as { turnId: number }).turnId
      void runtime.runTurn(command.sessionId, turnId, command.text)
      return
    }

    if (command.type === 'session.checkpoint.revert') {
      await runtime.revert(command.sessionId, command.checkpointId)
      return
    }

    if (command.type === 'session.turn.interrupt') {
      await runtime.interrupt(command.sessionId)
      return
    }

    if (command.type === 'session.approval.respond') {
      await runtime.respondApproval(
        command.sessionId,
        command.approvalId,
        command.decision === 'allowed',
      )
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

      case 'term-open': {
        // A terminal is arbitrary execution with no approval step in front of
        // it: the driver path asks before every tool call, a shell cannot
        // (§12). Until the security model has a story for that, terminals
        // belong to this machine only — the plain loopback case and the
        // host's own token, never a paired device.
        if (socket.data.deviceId !== null && socket.data.deviceId !== 'local') {
          send(socket, { t: 'term-error', message: 'terminals are local-only' })
          return
        }
        const workspace = engine.current.workspaces.get(frame.workspaceId)
        if (!workspace) {
          send(socket, { t: 'term-error', message: `no workspace ${frame.workspaceId}` })
          return
        }
        const termId = ++lastTermId
        const cols = frame.cols ?? 80
        const rows = frame.rows ?? 24
        const pty = new Pty({ cwd: workspace.path, cols, rows })
        socket.data.terminals.set(termId, pty)
        pty.onData(chunk => send(socket, { t: 'term-data', termId, data: chunk }))
        pty.onExit((code) => {
          socket.data.terminals.delete(termId)
          send(socket, { t: 'term-exit', termId, code })
        })
        send(socket, { t: 'term-opened', termId, workspaceId: frame.workspaceId, cols, rows })
        return
      }

      case 'term-input':
        // An unknown id is a close racing input — dropped, like a late approval.
        socket.data.terminals.get(frame.termId)?.write(frame.data)
        return

      case 'term-resize': {
        // Clamped: the client computes these from layout, and a garbage
        // measurement must not become a 0-column or million-row winsize.
        const cols = Math.min(500, Math.max(20, Math.floor(frame.cols)))
        const rows = Math.min(200, Math.max(5, Math.floor(frame.rows)))
        socket.data.terminals.get(frame.termId)?.resize(cols, rows)
        return
      }

      case 'term-close': {
        const pty = socket.data.terminals.get(frame.termId)
        socket.data.terminals.delete(frame.termId)
        pty?.kill()
        return
      }

      case 'subscribe': {
        socket.data.subscriptions.add(frame.sessionId)
        // Replay from where the client left off. This is what makes a dropped
        // connection mid-turn lossless: the client sends the last seq it saw
        // and gets everything after it, in order, before any live event.
        const missed = await store.read(frame.sessionId, frame.sinceSeq ?? 0)
        for (const event of missed) send(socket, { t: 'event', event })
        socket.data.cursors.set(
          frame.sessionId,
          missed.at(-1)?.seq ?? frame.sinceSeq ?? 0,
        )
        send(socket, { t: 'subscribed', sessionId: frame.sessionId, caughtUpTo: missed.at(-1)?.seq ?? frame.sinceSeq ?? 0 })
        return
      }

      case 'unsubscribe':
        socket.data.subscriptions.delete(frame.sessionId)
        return

      case 'dispatch': {
        const envelope = frame.envelope
        if (!envelope?.id || !envelope.command?.type) {
          send(socket, { t: 'protocol-error', message: 'dispatch requires an envelope with id and command' })
          return
        }
        // Read before dispatching: a deleted profile takes its sessions with
        // it, and their worktree paths go with them.
        const doomed = envelope.command.type === 'profile.delete'
          ? worktreesOfProfile(engine.current, envelope.command.profileId)
          : []

        try {
          const result = await engine.dispatch(envelope)
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
        const upgraded = srv.upgrade(request, {
          data: {
            deviceId: access?.authenticate(request).deviceId ?? null,
            terminals: new Map<number, Pty>(),
            subscriptions: new Set<number>(),
            cursors: new Map<number, number>(),
          },
        })
        return upgraded ? undefined : new Response('expected a websocket upgrade', { status: 426 })
      }

      // What the agent changed on disk. Fetched on demand rather than rendered
      // into the page: reading a repository costs a subprocess, and most page
      // loads never open the diff.
      if (url.pathname.startsWith('/s/') && url.pathname.endsWith('/diff')) {
        const id = Number(url.pathname.slice(3, -'/diff'.length)) || 0
        const path = options.workspacePath
          ? options.workspacePath(engine.current, id)
          : defaultWorkspacePath(engine.current, id)
        if (!path) return Response.json({ isRepository: false, scope: 'working-tree', files: [], patch: '', error: 'session has no workspace' })
        // The session's earliest checkpoint is its baseline: taken before the
        // first turn ran, so diffing against it answers "what did this session
        // change" rather than "what is uncommitted here".
        const baseline = engine.current.sessions.get(id)?.checkpoints[0]?.vcsRef
        return workspaceDiff(path, baseline)
          .then(diff => Response.json(diff))
          // A diff that cannot be read must not take the page down with it.
          .catch(() => Response.json({ isRepository: false, scope: 'working-tree', files: [], patch: '', error: 'could not read the workspace' }))
      }

      // Shared page assets. Checked before the page routes because their
      // paths are fixed and a render must never shadow them.
      const asset = assetCache.respond(url.pathname)
      if (asset) return asset

      // The web surface. Rendered per request from the in-memory projection —
      // no query runs, so the shell paints immediately.
      if (url.pathname === '/' || url.pathname.startsWith('/s/')) {
        const sessionId = url.pathname.startsWith('/s/')
          ? Number(url.pathname.slice(3)) || undefined
          : undefined
        return renderHarnessView(viewProps(engine.current, {
          sessionId,
          // `?profile=` opens the sidebar on a given space. Swiping past the
          // active space's neighbours lands here, so the server renders that
          // space's rows rather than the client rebuilding them.
          profileId: Number(url.searchParams.get('profile')) || undefined,
          serverUrl: `ws://${url.host}/ws`,
          codecUrl,
        })).then(async (rendered) => {
          if (rendered === null) return new Response('view not found', { status: 404 })

          // Lift the runtime, router and stylesheet out into cacheable assets.
          // They are byte-identical on every request, so inlining them means
          // re-sending ~190KB the browser already has.
          const { externalizeHtml } = await import('@stacksjs/stx')
          const { html, assets } = externalizeHtml(rendered, ASSET_PREFIX)
          // Remembered before responding, or the page would reference an asset
          // this process cannot yet serve.
          assetCache.remember(assets)

          return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
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
        // A PTY with no reader is a shell running unwatched.
        for (const pty of socket.data.terminals.values()) pty.kill()
        socket.data.terminals.clear()
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
      store.close()
      throw error
    }
  }

  return {
    server,
    engine,
    runtime,
    access,
    tunnelUrl: tunnel?.url ?? null,
    markWindowSpawned: () => { windowSpawnedAt = Date.now() },
    stop: () => {
      void tunnel?.close()
      void runtime.stopAll()
      server.stop(true)
      store.close()
    },
  }
}
