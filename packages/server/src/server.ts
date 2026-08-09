/**
 * The harness server: one HTTP surface, one WebSocket, one engine.
 *
 * The server is the execution boundary. Clients dispatch commands and subscribe
 * to events; they never spawn a process, touch git, or read the filesystem.
 * That is what makes "drive it from your phone" fall out of the architecture
 * rather than being a feature bolted on later.
 */

import type { CommandEnvelope } from '@harness/contract'
import type { Server, ServerWebSocket } from 'bun'
import type { Driver, DriverKind } from '@harness/drivers'
import { CborError, decode, encode } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import { Engine, reduce, SqliteStore } from '@harness/engine'
import { ASSET_PREFIX, AssetCache } from './assets'
import { workspaceDiff } from './diff'
import { buildClientCodec } from './client-bundle'
import { defaultWorkspacePath, ProviderRuntime } from './runtime'
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
}

interface SocketData {
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

export interface HarnessServer {
  server: Server
  engine: Engine
  runtime: ProviderRuntime
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

  const sockets = new Set<HarnessSocket>()
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
  async function react(envelope: CommandEnvelope, result: Awaited<ReturnType<Engine['dispatch']>>): Promise<void> {
    const command = envelope.command

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
          if (!result.replayed) await react(envelope, result)
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

  const server = Bun.serve<SocketData, Record<string, never>>({
    port,
    hostname,

    fetch(request, srv) {
      const url = new URL(request.url)

      if (url.pathname === '/ws') {
        const upgraded = srv.upgrade(request, {
          data: { subscriptions: new Set<number>(), cursors: new Map<number, number>() },
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
        if (!path) return Response.json({ isRepository: false, files: [], patch: '', error: 'session has no workspace' })
        return workspaceDiff(path)
          .then(diff => Response.json(diff))
          // A diff that cannot be read must not take the page down with it.
          .catch(() => Response.json({ isRepository: false, files: [], patch: '', error: 'could not read the workspace' }))
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

  return {
    server,
    engine,
    runtime,
    markWindowSpawned: () => { windowSpawnedAt = Date.now() },
    stop: () => {
      void runtime.stopAll()
      server.stop(true)
      store.close()
    },
  }
}
