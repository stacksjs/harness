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
import { CborError, decode, encode } from '@harness/contract'
import { Engine, reduce, SqliteStore } from '@harness/engine'

export interface ServeOptions {
  port?: number
  hostname?: string
  databasePath?: string
}

interface SocketData {
  /** Sessions this socket has subscribed to. Empty means "not subscribed". */
  subscriptions: Set<number>
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
  stop: () => void
}

export async function serve(options: ServeOptions = {}): Promise<HarnessServer> {
  const port = options.port ?? 3789
  const hostname = options.hostname ?? '127.0.0.1'
  const store = new SqliteStore(options.databasePath ?? 'database/stacks.sqlite')

  const engine = new Engine({ store, reducer: reduce })
  // Hydrate before listening, not after. A socket that connects into a
  // half-built read model would be served a projection missing everything the
  // log has not replayed yet, and it has no way to tell.
  await engine.hydrate()

  const sockets = new Set<HarnessSocket>()

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
        if (event.sessionId === 0 || socket.data.subscriptions.has(event.sessionId))
          send(socket, { t: 'event', event })
      }
    }
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
        const upgraded = srv.upgrade(request, { data: { subscriptions: new Set<number>() } })
        return upgraded ? undefined : new Response('expected a websocket upgrade', { status: 426 })
      }

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
    stop: () => {
      server.stop(true)
      store.close()
    },
  }
}
