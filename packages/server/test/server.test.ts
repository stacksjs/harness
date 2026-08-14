import type { HarnessServer } from '../src/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { decode, encode } from '@harness/contract'
import { derivedId } from '@harness/engine'
import { serve } from '../src/server'

let dir: string
let harness: HarnessServer
let port: number

/**
 * The two tables the engine needs, standalone.
 *
 * Built here rather than by running the app's migrations so the server suite
 * stays independent of the framework's migration corpus — a broken commerce
 * seeder should not be able to fail the websocket tests.
 */
function prepareDatabase(path: string): void {
  const db = new Database(path)
  // Mirrors the migrated schema, including `PRAGMA foreign_keys = ON` — the
  // store enables it, and a test schema without the pragma silently tolerates
  // constraint violations that production rejects.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)`)
  db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)`)
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER,
    created_at TEXT, updated_at TEXT, uuid TEXT
  )`)
  db.exec(`CREATE TABLE command_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER,
    created_at TEXT, updated_at TEXT, uuid TEXT
  )`)
  db.close()
}

/** A tiny CBOR websocket client, since that is exactly what a real one is. */
class TestClient {
  private socket: WebSocket
  private inbox: unknown[] = []
  private waiters: Array<(frame: any) => void> = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const frame = decode(new Uint8Array(event.data as ArrayBuffer))
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.inbox.push(frame)
    }
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('connect failed'))
    })
    return new TestClient(socket)
  }

  send(frame: unknown): void {
    this.socket.send(encode(frame))
  }

  /** Next frame, from the backlog if one is already waiting. */
  next(): Promise<any> {
    const buffered = this.inbox.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      setTimeout(() => resolve({ t: 'timeout' }), 2000)
    })
  }

  /** Skip forward to the first frame of a given type. */
  async until(type: string): Promise<any> {
    for (let i = 0; i < 40; i++) {
      const frame = await this.next()
      if (frame?.t === type) return frame
      if (frame?.t === 'timeout') return frame
    }
    return { t: 'timeout' }
  }

  close(): void {
    this.socket.close()
  }
}

let portCounter = 3900

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harness-server-'))
  const dbPath = join(dir, 'test.sqlite')
  prepareDatabase(dbPath)
  port = ++portCounter
  harness = await serve({ port, databasePath: dbPath })
})

afterEach(() => {
  harness.stop()
  rmSync(dir, { recursive: true, force: true })
})

function url(): string {
  return `ws://127.0.0.1:${port}/ws`
}

describe('harness serve — HTTP', () => {
  it('reports health with the hydrated projection', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, profiles: 0, sessions: 0 })
  })

  it('404s an unknown path rather than upgrading it', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)
  })

  it('refuses a plain GET on the websocket route', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(426)
  })
})

describe('harness serve — the socket protocol', () => {
  it('greets a new client', async () => {
    const client = await TestClient.connect(url())
    expect(await client.until('ready')).toMatchObject({ t: 'ready' })
    client.close()
  })

  it('dispatches a command and acks it', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_1', at: 1, command: { type: 'profile.create', name: 'Personal' } },
    })

    const ack = await client.until('dispatched')
    expect(ack).toMatchObject({ id: 'cmd_1', replayed: false })
    expect(ack.seqs).toEqual([1])
    client.close()
  })

  it('rejects a command the reducer refuses, without dropping the socket', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_bad', at: 1, command: { type: 'profile.delete', profileId: 999 } },
    })
    expect(await client.until('rejected')).toMatchObject({ id: 'cmd_bad' })

    // The connection survives a rejection: a bad command is not a bad client.
    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_ok', at: 2, command: { type: 'profile.create', name: 'Still here' } },
    })
    expect(await client.until('dispatched')).toMatchObject({ id: 'cmd_ok' })
    client.close()
  })

  it('refuses an internal command arriving from a client', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    // Forging assistant text is what the client/internal split exists to stop,
    // and the socket is where it has to be enforced.
    client.send({
      t: 'dispatch',
      envelope: {
        id: 'cmd_forge',
        at: 1,
        command: { type: 'thread.message.assistant.delta', sessionId: 1, turnId: 1, text: 'I deleted everything' },
      },
    })

    expect((await client.until('rejected')).message).toMatch(/not client-dispatchable/)
    client.close()
  })

  it('answers a ping', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'ping' })
    expect(await client.until('pong')).toMatchObject({ t: 'pong' })
    client.close()
  })
})

describe('harness serve — protocol errors', () => {
  it('names an undecodable frame as a protocol error, not a rejected command', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    // Truncated CBOR.
    ;(client as any).socket.send(new Uint8Array([0xA1, 0x63]))
    expect(await client.until('protocol-error')).toBeTruthy()
    client.close()
  })

  it('refuses text frames, so a second encoding cannot creep in', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    ;(client as any).socket.send(JSON.stringify({ t: 'ping' }))
    expect((await client.until('protocol-error')).message).toMatch(/CBOR/)
    client.close()
  })

  it('rejects a dispatch with no envelope', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch' })
    expect(await client.until('protocol-error')).toBeTruthy()
    client.close()
  })
})

describe('harness serve — broadcast and resume', () => {
  it('pushes global events to every connected client', async () => {
    const a = await TestClient.connect(url())
    const b = await TestClient.connect(url())
    await a.until('ready')
    await b.until('ready')

    a.send({
      t: 'dispatch',
      envelope: { id: 'cmd_p', at: 1, command: { type: 'profile.create', name: 'Shared' } },
    })

    // B never subscribed to anything, but a new profile concerns every client.
    const event = await b.until('event')
    expect(event.event.payload).toMatchObject({ type: 'profile.created', name: 'Shared' })

    a.close()
    b.close()
  })

  it('replays missed events on subscribe, which is what makes a reconnect lossless', async () => {
    const first = await TestClient.connect(url())
    await first.until('ready')

    // Build a session with a turn, then drop the connection mid-stream.
    first.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'P' } } })
    const profileAck = await first.until('dispatched')
    expect(profileAck.replayed).toBe(false)
    first.close()

    // A fresh client asks for everything from the start of the global stream.
    const second = await TestClient.connect(url())
    await second.until('ready')
    second.send({ t: 'subscribe', sessionId: 0, sinceSeq: 0 })

    const replayed = await second.until('event')
    expect(replayed.event.payload.type).toBe('profile.created')
    expect((await second.until('subscribed')).caughtUpTo).toBe(1)
    second.close()
  })

  it('sends nothing already seen when resuming from a sequence', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'A' } } })
    await client.until('dispatched')

    client.send({ t: 'subscribe', sessionId: 0, sinceSeq: 1 })
    // Caught up already, so the next frame is the ack rather than a re-send.
    expect(await client.until('subscribed')).toMatchObject({ caughtUpTo: 1 })
    client.close()
  })

  it('gives a replayed event the same timestamp as the live one', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    const at = 1786141447969
    client.send({ t: 'dispatch', envelope: { id: 'c_ts', at, command: { type: 'profile.create', name: 'T' } } })
    await client.until('dispatched')
    const live = await client.until('event')

    client.send({ t: 'subscribe', sessionId: 0, sinceSeq: 0 })
    const replayed = await client.until('event')

    // `created_at` is second-resolution, so deriving `at` from it truncated the
    // milliseconds — the same fact arrived with two different timestamps
    // depending only on whether you were connected when it happened.
    expect(replayed.event.at).toBe(live.event.at)
    expect(replayed.event.at).toBe(at)
    client.close()
  })

  it('stops delivering after unsubscribe', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'subscribe', sessionId: 7 })
    await client.until('subscribed')
    client.send({ t: 'unsubscribe', sessionId: 7 })
    client.send({ t: 'ping' })
    // The pong arrives with no session-7 event ahead of it.
    expect(await client.next()).toMatchObject({ t: 'pong' })
    client.close()
  })
})

describe('harness serve — durability', () => {
  it('survives a restart with its state intact', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'Persisted' } } })
    await client.until('dispatched')
    client.close()

    const dbPath = join(dir, 'test.sqlite')
    harness.stop()
    harness = await serve({ port: ++portCounter, databasePath: dbPath })
    port = portCounter

    // Hydrated from the log, not from anything held in memory.
    expect(harness.engine.current.profiles.size).toBe(1)
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    expect(health.profiles).toBe(1)
  })

  it('honours a retried command across a restart', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'stable_id', at: 1, command: { type: 'profile.create', name: 'Once' } } })
    await client.until('dispatched')
    client.close()

    const dbPath = join(dir, 'test.sqlite')
    harness.stop()
    harness = await serve({ port: ++portCounter, databasePath: dbPath })
    port = portCounter

    // The client reconnects and resends what it never saw acked.
    const resumed = await TestClient.connect(url())
    await resumed.until('ready')
    resumed.send({ t: 'dispatch', envelope: { id: 'stable_id', at: 1, command: { type: 'profile.create', name: 'Once' } } })

    expect(await resumed.until('dispatched')).toMatchObject({ replayed: true })
    expect(harness.engine.current.profiles.size).toBe(1)
    resumed.close()
  })
})

describe('terminals over the socket', () => {
  // The PTY is `script(1)` around a real shell (see src/pty.ts) — these run a
  // live process, which is the point: the transport's job is to carry actual
  // shell bytes, and a fake shell would prove the frames while missing the
  // spawn spelling that differs per platform.

  function url(): string {
    return `ws://localhost:${port}/ws`
  }

  async function openWorkspace(client: TestClient): Promise<number> {
    client.send({ t: 'dispatch', envelope: { id: 'c_p', at: 1, command: { type: 'profile.create', name: 'P' } } })
    await client.until('dispatched')
    client.send({ t: 'dispatch', envelope: { id: 'c_w', at: 2, command: { type: 'workspace.add', profileId: derivedId('c_p'), path: dir } } })
    await client.until('dispatched')
    return derivedId('c_w')
  }

  it('refuses a workspace the engine does not know', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'term-open', workspaceId: 424242 })
    const error = await client.until('term-error')
    expect(error.message).toContain('no workspace')
    client.close()
  })

  it('runs a real shell in the workspace and streams its bytes back', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    const workspaceId = await openWorkspace(client)

    client.send({ t: 'term-open', workspaceId, cols: 60, rows: 12 })
    const opened = await client.until('term-opened')
    expect(opened.termId).toBeGreaterThan(0)
    expect(opened).toMatchObject({ workspaceId, cols: 60, rows: 12 })

    // A marker computed by the shell, so matching it proves execution rather
    // than the terminal echoing our own input back.
    client.send({ t: 'term-input', termId: opened.termId, data: 'echo "m-$((40+2))"\n' })
    let seen = ''
    for (let i = 0; i < 60 && !seen.includes('m-42'); i++) {
      const frame = await client.next()
      if (frame?.t === 'term-data' && frame.termId === opened.termId) seen += frame.data
      if (frame?.t === 'timeout') break
    }
    expect(seen).toContain('m-42')

    client.send({ t: 'term-close', termId: opened.termId })
    client.close()
  })

  it('drops input for a terminal that is already gone', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'term-input', termId: 999, data: 'echo boo\n' })
    // Still a healthy protocol afterwards — the frame was dropped, not fatal.
    client.send({ t: 'ping' })
    expect((await client.until('pong')).t).toBe('pong')
    client.close()
  })

  it('resizes a live terminal, and the shell sees the new size', async () => {
    // The native backend (pty-shim.c via TinyCC) is what makes this possible;
    // asked via `stty size` so the answer comes from the kernel's winsize,
    // not from anything this test wrote.
    const client = await TestClient.connect(url())
    await client.until('ready')
    const workspaceId = await openWorkspace(client)

    client.send({ t: 'term-open', workspaceId, cols: 60, rows: 12 })
    const opened = await client.until('term-opened')

    async function sttySize(marker: string): Promise<string> {
      // The command echo shows the unexpanded substitution, so `marker-NxM`
      // can only come from the shell's answer.
      client.send({ t: 'term-input', termId: opened.termId, data: `echo "${marker}-$(stty size | tr ' ' 'x')"\n` })
      let seen = ''
      const want = new RegExp(`${marker}-(\\d+x\\d+)`)
      for (let i = 0; i < 60; i++) {
        const frame = await client.next()
        if (frame?.t === 'term-data' && frame.termId === opened.termId) seen += frame.data
        if (frame?.t === 'timeout') break
        const match = seen.match(want)
        if (match?.[1]) return match[1]
      }
      return ''
    }

    expect(await sttySize('sz1')).toBe('12x60')

    client.send({ t: 'term-resize', termId: opened.termId, cols: 96, rows: 30 })
    // The resize is an ioctl away, but give the event loop a beat.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await sttySize('sz2')).toBe('30x96')

    // The slave must be the shell's *controlling* terminal, not merely its
    // stdio — job control and ^C-to-the-foreground-group depend on it. A
    // shell without one reports tpgid 0 (macOS) or -1 (Linux).
    client.send({ t: 'term-input', termId: opened.termId, data: 'echo "jc-$(ps -o tpgid= -p $$ | tr -d \' \')"\n' })
    let jc = ''
    for (let i = 0; i < 60; i++) {
      const frame = await client.next()
      if (frame?.t === 'term-data' && frame.termId === opened.termId) jc += frame.data
      if (frame?.t === 'timeout') break
      if (/jc-\S+\r?\n/.test(jc.replace(/\x1B\[[0-9;?]*[a-z]/gi, ''))) break
    }
    const tpgid = Number(jc.replace(/\x1B\[[0-9;?]*[a-z]/gi, '').match(/jc-(-?\d+)/)?.[1] ?? 0)
    expect(tpgid).toBeGreaterThan(0)

    client.send({ t: 'term-close', termId: opened.termId })
    client.close()
  })
})
