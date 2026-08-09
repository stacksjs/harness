/**
 * The client half of the harness protocol.
 *
 * Every surface — the CLI, the web app, the desktop shell — talks to the server
 * through this. It owns the socket, the reconnect policy and the local
 * projection; views never construct a transport. Keeping that in one place is
 * why the desktop and the web app can differ only in what they render.
 *
 * The reconnect policy is the whole point. A dropped connection mid-turn must
 * not lose events: the client remembers the last sequence it saw per session
 * and resubscribes from there, so the server replays exactly the gap.
 */

import type { ClientCommand, HarnessEvent } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import { decode, encode, GLOBAL_SESSION_ID } from '@harness/contract'
import { apply, emptyState } from '@harness/engine'

export interface ClientOptions {
  url: string
  /** Backoff floor and ceiling, milliseconds. */
  minBackoffMs?: number
  maxBackoffMs?: number
  /**
   * Bearer token, for a server running with remote access on.
   *
   * Sent as a header, which Bun's WebSocket accepts and a browser's does not —
   * a browser pairs instead and carries a cookie the upgrade sends for it.
   */
  token?: string
  /** Injectable for tests; defaults to the global WebSocket. */
  socketFactory?: (url: string) => WebSocket
  /** Injectable so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface DispatchAck {
  id: string
  replayed: boolean
  seqs: number[]
}

interface Pending {
  resolve: (ack: DispatchAck) => void
  reject: (error: Error) => void
}

export class HarnessClient {
  private socket: WebSocket | null = null
  private pending = new Map<string, Pending>()
  /** Last sequence applied per session, so a resubscribe asks for the gap. */
  private cursors = new Map<number, number>()
  private subscriptions = new Set<number>()
  private closed = false
  private attempt = 0

  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private eventListeners = new Set<(event: HarnessEvent) => void>()
  private stateListeners = new Set<(state: HarnessState) => void>()
  /** Resolved once the global log has been replayed into `state`. */
  private globalReady: (() => void) | null = null

  status: ConnectionStatus = 'idle'
  state: HarnessState = emptyState()

  constructor(private options: ClientOptions) {}

  private get sleep(): (ms: number) => Promise<void> {
    return this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: (event: HarnessEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  onState(listener: (state: HarnessState) => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    for (const listener of this.statusListeners) listener(status)
  }

  /**
   * Exponential backoff with full jitter.
   *
   * Jitter is not decoration: when a server restarts, every client that was
   * connected to it retries on the same schedule and stampedes it back down.
   * Randomising across the whole interval spreads the herd.
   */
  private backoffFor(attempt: number): number {
    const min = this.options.minBackoffMs ?? 100
    const max = this.options.maxBackoffMs ?? 10_000
    const ceiling = Math.min(max, min * 2 ** Math.max(0, attempt - 1))
    return min + Math.random() * Math.max(0, ceiling - min)
  }

  async connect(): Promise<void> {
    this.closed = false
    await this.openOnce()
    // `state` is built by applying events, and events only arrive for sessions
    // this client subscribed to — so a fresh client's projection was empty and
    // stayed that way. Anything that read it to decide (`harness:run` looking
    // for an existing workspace by path) always concluded "not there" and made
    // a second one, which is where the duplicate profiles came from.
    await this.hydrate()
  }

  /**
   * Replay the global log, so `state` means what it says.
   *
   * The global session carries profiles, workspaces and MCP servers — the
   * things a client reasons about before it has picked a session. Subscribing
   * to it is the same gap-filling path a reconnect uses, so there is no second
   * mechanism to keep correct.
   */
  private hydrate(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.globalReady = resolve
      this.subscribe(GLOBAL_SESSION_ID)
      // A server that never acknowledges must not hang a CLI command. The
      // projection is then merely empty, which is the behaviour that existed
      // before this.
      setTimeout(resolve, 2000)
    })
  }

  private openOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting')

      const token = this.options.token
      const factory = this.options.socketFactory
        ?? ((url: string) => (token
          ? new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[])
          : new WebSocket(url)))
      const socket = factory(this.options.url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      socket.onopen = () => {
        this.attempt = 0
        this.setStatus('connected')
        // Resubscribe from the cursor, not from zero. This is what turns a
        // reconnect into a gap fill rather than a full replay — and what stops
        // a long session re-delivering thousands of events on every blip.
        for (const sessionId of this.subscriptions)
          this.send({ t: 'subscribe', sessionId, sinceSeq: this.cursors.get(sessionId) ?? 0 })
        resolve()
      }

      socket.onmessage = (message) => {
        try {
          this.onFrame(decode(new Uint8Array(message.data as ArrayBuffer)))
        }
        catch {
          // A frame we cannot decode is the server's problem to report; the
          // client should not tear down a working connection over it.
        }
      }

      socket.onerror = () => {
        if (this.status === 'connecting' && this.attempt === 0)
          reject(new Error(`could not connect to ${this.options.url}`))
      }

      socket.onclose = () => {
        // Every in-flight dispatch is now unanswerable. Rejecting them is
        // honest — but the command may well have run, which is exactly why the
        // caller should retry with the same id rather than a fresh one.
        for (const [, waiter] of this.pending)
          waiter.reject(new Error('connection closed before the command was acknowledged'))
        this.pending.clear()

        if (this.closed) {
          this.setStatus('closed')
          return
        }
        void this.reconnect()
      }
    })
  }

  private async reconnect(): Promise<void> {
    while (!this.closed) {
      this.attempt++
      this.setStatus('reconnecting')
      await this.sleep(this.backoffFor(this.attempt))
      if (this.closed) return
      try {
        await this.openOnce()
        return
      }
      catch {
        // Keep trying — a server that is down comes back.
      }
    }
  }

  private onFrame(frame: any): void {
    switch (frame?.t) {
      case 'event': {
        const event = frame.event as HarnessEvent
        const seen = this.cursors.get(event.sessionId) ?? 0
        // Drop anything at or behind the cursor. A resubscribe can overlap with
        // events still in flight, and applying a delta twice would duplicate
        // text in the transcript.
        if (event.seq <= seen) return
        this.cursors.set(event.sessionId, event.seq)
        apply(this.state, event)
        for (const listener of this.eventListeners) listener(event)
        for (const listener of this.stateListeners) listener(this.state)
        return
      }

      case 'subscribed': {
        // The global replay has landed, so `state` now holds the profiles and
        // workspaces the server knows about.
        if (frame.sessionId === GLOBAL_SESSION_ID && this.globalReady) {
          const done = this.globalReady
          this.globalReady = null
          done()
        }
        return
      }

      case 'dispatched': {
        const waiter = this.pending.get(frame.id)
        if (!waiter) return
        this.pending.delete(frame.id)
        waiter.resolve({ id: frame.id, replayed: Boolean(frame.replayed), seqs: frame.seqs ?? [] })
        return
      }

      case 'rejected': {
        const waiter = this.pending.get(frame.id)
        if (!waiter) return
        this.pending.delete(frame.id)
        waiter.reject(new Error(String(frame.message ?? 'command rejected')))
        return
      }

      default:
    }
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN)
      throw new Error('not connected')
    this.socket.send(encode(frame))
  }

  /**
   * Dispatch a command and wait for the server's answer.
   *
   * `id` is the idempotency key. Reusing it after a failed attempt is the
   * supported way to retry: the server returns the original result rather than
   * running the command again.
   */
  dispatch(id: string, command: ClientCommand, at: number = Date.now()): Promise<DispatchAck> {
    return new Promise<DispatchAck>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ t: 'dispatch', envelope: { id, at, command } })
      }
      catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  subscribe(sessionId: number): void {
    this.subscriptions.add(sessionId)
    if (this.status === 'connected')
      this.send({ t: 'subscribe', sessionId, sinceSeq: this.cursors.get(sessionId) ?? 0 })
  }

  unsubscribe(sessionId: number): void {
    this.subscriptions.delete(sessionId)
    if (this.status === 'connected')
      this.send({ t: 'unsubscribe', sessionId })
  }

  /** Highest sequence applied for a session. What a resubscribe resumes from. */
  cursor(sessionId: number): number {
    return this.cursors.get(sessionId) ?? 0
  }

  close(): void {
    this.closed = true
    this.socket?.close()
    this.setStatus('closed')
  }
}
