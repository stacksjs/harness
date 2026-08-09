import type { Driver, ProviderEvent, ProviderInstance } from '@harness/drivers'
import type { HarnessServer } from '../src/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { decode, encode } from '@harness/contract'
import { derivedId } from '@harness/engine'
import { serve } from '../src/server'

/**
 * A recorded-transcript driver (PLAN.md §13): every driver ships one so its
 * behaviour is reproducible without the real CLI. This one also lets a test
 * hold a turn open, which is how the approval round-trip is exercised.
 */
function fakeDriver(script: ProviderEvent[], hooks: {
  onInterrupt?: () => void
  gate?: Promise<void>
} = {}): { driver: Driver, approvals: Array<{ requestId: string, allow: boolean }> } {
  const approvals: Array<{ requestId: string, allow: boolean }> = []

  const instance: ProviderInstance = {
    async *startTurn() {
      for (const event of script) {
        yield event
        // Park after an approval request so the turn is still open when the
        // client answers — the real shape of a blocked tool call.
        if (event.type === 'approval-request' && hooks.gate) await hooks.gate
      }
    },
    async interrupt() { hooks.onInterrupt?.() },
    async respondApproval(requestId, allow) { approvals.push({ requestId, allow }) },
    async stop() {},
  }

  return {
    approvals,
    driver: {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() { return instance },
    },
  }
}

let dir: string
let harness: HarnessServer
let port: number
let portCounter = 4300

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

class Client {
  private socket: WebSocket
  events: any[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onmessage = e => this.events.push(decode(new Uint8Array(e.data as ArrayBuffer)))
  }

  static async connect(url: string): Promise<Client> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('connect failed'))
    })
    return new Client(socket)
  }

  send(frame: unknown): void { this.socket.send(encode(frame)) }

  /** Every event payload of a given type seen so far. */
  payloads(type: string): any[] {
    return this.events.filter(f => f?.t === 'event' && f.event.payload.type === type).map(f => f.event.payload)
  }

  async waitFor(type: string, timeoutMs = 3000): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.payloads(type)
      if (found.length > 0) return found[0]
      await new Promise(r => setTimeout(r, 10))
    }
    return null
  }

  close(): void { this.socket.close() }
}

async function bootstrap(client: Client, workspace: string = dir): Promise<{ sessionId: number }> {
  client.send({ t: 'dispatch', envelope: { id: 'c_p', at: 1, command: { type: 'profile.create', name: 'P' } } })
  const profileId = derivedId('c_p')
  client.send({
    t: 'dispatch',
    envelope: { id: 'c_w', at: 2, command: { type: 'workspace.add', profileId, path: workspace } },
  })
  const workspaceId = derivedId('c_w')
  client.send({
    t: 'dispatch',
    envelope: { id: 'c_t', at: 3, command: { type: 'workspace.trust', workspaceId, trusted: true } },
  })
  client.send({
    t: 'dispatch',
    envelope: { id: 'c_s', at: 4, command: { type: 'session.create', workspaceId, driverKind: 'claude' } },
  })
  const sessionId = derivedId('c_s')
  await client.waitFor('session.created')
  client.send({ t: 'subscribe', sessionId })
  return { sessionId }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-runtime-'))
  prepareDatabase(join(dir, 'test.sqlite'))
  port = ++portCounter
})

afterEach(() => {
  try { harness.stop() }
  catch { /* already stopped */ }
  rmSync(dir, { recursive: true, force: true })
})

describe('a turn drives the provider', () => {
  it('streams deltas into the log as they arrive', async () => {
    const { driver } = fakeDriver([
      { type: 'session-bound', providerSessionId: 'prov_1' },
      { type: 'assistant-delta', text: 'Hello ' },
      { type: 'assistant-delta', text: 'world' },
      { type: 'turn-complete', tokensIn: 5, tokensOut: 9, costMicros: 1200 },
    ])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    await client.waitFor('turn.completed')

    const session = harness.engine.current.sessions.get(sessionId)!
    expect(session.turns[0]!.response).toBe('Hello world')
    expect(session.turns[0]!.status).toBe('complete')
    expect(session.providerSessionId).toBe('prov_1')
    client.close()
  })

  it('pushes each delta as its own event rather than one lump at the end', async () => {
    const { driver } = fakeDriver([
      { type: 'assistant-delta', text: 'a' },
      { type: 'assistant-delta', text: 'b' },
      { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 },
    ])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('turn.completed')

    // Two separate delta events. A single concatenated one would mean the
    // client only sees the transcript once the turn is over.
    expect(client.payloads('assistant.delta').map(p => p.text)).toEqual(['a', 'b'])
    client.close()
  })

  it('records tool calls and their results', async () => {
    const { driver } = fakeDriver([
      { type: 'tool-call-begin', callId: 'tc1', toolName: 'Bash', args: { command: 'ls' } },
      { type: 'tool-call-end', callId: 'tc1', ok: true },
      { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 },
    ])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('turn.completed')

    expect((await client.waitFor('tool.call.began')).toolName).toBe('Bash')
    expect((await client.waitFor('tool.call.ended')).ok).toBe(true)
    client.close()
  })

  it('surfaces a provider error without wedging the session', async () => {
    const { driver } = fakeDriver([{ type: 'error', message: 'the agent fell over' }])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    expect(await client.waitFor('session.failed')).toBeTruthy()
    client.close()
  })

  it('reports a session whose driver this build does not ship', async () => {
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => null })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    // An unavailable provider is a reported failure, not a crash.
    expect(await client.waitFor('session.failed')).toBeTruthy()
    client.close()
  })

  it('names a workspace that has gone missing', async () => {
    // Agents run with the workspace as their cwd, and a missing cwd surfaces
    // from deep inside the provider as something unrelated — the Claude SDK
    // calls it "native binary exists but failed to launch", which sends you to
    // inspect a binary that is fine. Caught here, it names the actual problem.
    let created = false
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() { created = true; throw new Error('should never be created') },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    // Registered at a path that does not exist, which is what a workspace looks
    // like after a rename, an unmounted volume, or /tmp being swept.
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client, join(dir, 'gone-away'))
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    const failed = await client.waitFor('session.failed')
    expect(failed.message).toContain('no longer exists')
    expect(created).toBe(false)
    client.close()
  })

  it('reports the remedy when the CLI is present but signed out', async () => {
    // The gate is a probe before create. Without it the session would open,
    // the user would send a prompt, and the failure would arrive mid-turn with
    // no indication that the fix is one command.
    let created = false
    const driver: Driver = {
      kind: 'codex',
      async probe() { return { status: 'unauthenticated', message: 'run `codex login`' } },
      async create() {
        created = true
        throw new Error('should never be created')
      },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    const failed = await client.waitFor('session.failed')
    expect(failed.message).toContain('codex login')
    expect(created).toBe(false)
    client.close()
  })
})

describe('checkpoint and revert', () => {
  /** A workspace that is a real repository, since checkpoints are git. */
  function repoWorkspace(): string {
    const path = join(dir, 'work')
    mkdirSync(path)
    const run = (...args: string[]) => spawnSync('git', args, { cwd: path })
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    writeFileSync(join(path, 'tracked.txt'), 'original\n')
    run('add', '.')
    run('commit', '-qm', 'first')
    return path
  }

  it('captures a checkpoint before the agent runs, and reverts to it', async () => {
    // The point of the whole feature: an agent edits a file, and the edit can
    // be taken back without hand-reverting anything.
    const workspace = repoWorkspace()

    const instance: ProviderInstance = {
      async *startTurn() {
        // Stand in for the agent's edits.
        writeFileSync(join(workspace, 'tracked.txt'), 'the agent changed this\n')
        writeFileSync(join(workspace, 'agent-made-this.ts'), 'export const x = 1\n')
        yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      },
      async interrupt() {},
      async respondApproval() {},
      async stop() {},
    }
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() { return instance },
    }
    harness = await serve({
      port,
      databasePath: join(dir, 'test.sqlite'),
      resolveDriver: () => driver,
      workspacePath: () => workspace,
    })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client, workspace)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'edit it' } } })
    await client.waitFor('turn.completed')

    // The snapshot was taken before the edits, not after.
    const captured = await client.waitFor('checkpoint.captured')
    expect(captured.kind).toBe('turn-start')
    expect(captured.vcsRef).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('the agent changed this\n')

    client.send({
      t: 'dispatch',
      envelope: { id: 'c_rev', at: 6, command: { type: 'session.checkpoint.revert', sessionId, checkpointId: captured.checkpointId } },
    })
    expect(await client.waitFor('checkpoint.reverted')).toBeTruthy()

    // `checkpoint.reverted` only means the revert was accepted; the git work
    // happens after it. Waiting on the completion event rather than on a delay
    // or on one file — polling `tracked.txt` passed as soon as the rewrite
    // half finished, while the removal half was still running.
    const restored = await client.waitFor('checkpoint.restored', 8000)
    expect(restored).toBeTruthy()

    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('original\n')
    // And the file the agent created is gone, not left behind.
    expect(existsSync(join(workspace, 'agent-made-this.ts'))).toBe(false)
    client.close()
  })

  it('runs a turn in a workspace that is not a repository', async () => {
    // Checkpointing is best-effort. A plain directory must not stop a turn.
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    expect(await client.waitFor('turn.completed')).toBeTruthy()
    expect(client.payloads('checkpoint.captured')).toEqual([])
    client.close()
  })
})

describe('approvals round-trip through the socket', () => {
  it('raises an approval and routes the decision back to the provider', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { driver, approvals } = fakeDriver([
      { type: 'approval-request', requestId: 'req_a', toolName: 'Bash', args: { command: 'rm -rf /' } },
      { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 },
    ], { gate })

    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })

    const requested = await client.waitFor('approval.requested')
    expect(requested.toolName).toBe('Bash')
    expect(harness.engine.current.sessions.get(sessionId)!.state).toBe('awaiting-approval')

    client.send({
      t: 'dispatch',
      envelope: {
        id: 'c_appr',
        at: 6,
        command: {
          type: 'session.approval.respond',
          sessionId,
          approvalId: requested.approvalId,
          decision: 'denied',
          scope: 'once',
        },
      },
    })
    await client.waitFor('approval.resolved')
    release()

    // The decision reached the provider callback that was blocked on it.
    await new Promise(r => setTimeout(r, 100))
    expect(approvals).toEqual([{ requestId: 'req_a', allow: false }])
    client.close()
  })
})

describe('interrupt reaches the provider', () => {
  it('calls interrupt on the running instance', async () => {
    let interrupted = false
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { driver } = fakeDriver([
      { type: 'approval-request', requestId: 'req_b', toolName: 'Bash', args: {} },
      { type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 },
    ], { gate, onInterrupt: () => { interrupted = true } })

    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('approval.requested')

    client.send({ t: 'dispatch', envelope: { id: 'c_int', at: 6, command: { type: 'session.turn.interrupt', sessionId } } })
    await client.waitFor('turn.interrupted')
    release()

    expect(interrupted).toBe(true)
    client.close()
  })

  it('does not report a stopped turn as a failure', async () => {
    // Providers report an abort as an error — the Claude SDK ends an
    // interrupted turn with `error_during_execution`. Passing that through
    // would overwrite "you stopped this" with "this broke", and the session
    // would read as failed when it did exactly what it was told.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })

    const instance: ProviderInstance = {
      async *startTurn() {
        yield { type: 'assistant-delta', text: 'working' }
        await gate
        yield { type: 'error', message: 'turn failed: error_during_execution' }
      },
      async interrupt() { release() },
      async respondApproval() {},
      async stop() {},
    }
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() { return instance },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('assistant.delta')

    client.send({ t: 'dispatch', envelope: { id: 'c_int', at: 6, command: { type: 'session.turn.interrupt', sessionId } } })
    expect(await client.waitFor('turn.interrupted')).toBeTruthy()

    // Long enough for the provider's error to arrive and be dropped.
    await new Promise(r => setTimeout(r, 300))
    expect(client.payloads('session.failed')).toEqual([])
    client.close()
  })

  it('does not let a late completion resurrect an interrupted turn', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { driver } = fakeDriver([
      { type: 'approval-request', requestId: 'req_c', toolName: 'Bash', args: {} },
      // Arrives after the interrupt — the reducer must refuse it.
      { type: 'turn-complete', tokensIn: 9, tokensOut: 9, costMicros: 99 },
    ], { gate })

    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('approval.requested')

    client.send({ t: 'dispatch', envelope: { id: 'c_int', at: 6, command: { type: 'session.turn.interrupt', sessionId } } })
    await client.waitFor('turn.interrupted')
    release()
    await new Promise(r => setTimeout(r, 150))

    expect(harness.engine.current.sessions.get(sessionId)!.turns[0]!.status).toBe('interrupted')
    client.close()
  })
})

describe('retries do not start a second agent run', () => {
  it('ignores a replayed turn command', async () => {
    let runs = 0
    const instance: ProviderInstance = {
      async *startTurn() {
        runs++
        yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      },
      async interrupt() {},
      async respondApproval() {},
      async stop() {},
    }
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() { return instance },
    }

    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)

    const turn = { id: 'c_turn', at: 5, command: { type: 'session.turn.start' as const, sessionId, text: 'hi' } }
    client.send({ t: 'dispatch', envelope: turn })
    await client.waitFor('turn.completed')
    // The client never saw the ack and resent. One agent run, not two.
    client.send({ t: 'dispatch', envelope: turn })
    await new Promise(r => setTimeout(r, 150))

    expect(runs).toBe(1)
    client.close()
  })
})
