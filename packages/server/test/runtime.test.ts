import type { Command, InputAnswer } from '@harness/contract'
import type { Driver, DriverConfig, ProviderEvent, ProviderInstance, StartTurnInput } from '@harness/drivers'
import type { HarnessServer } from '../src/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { decode, encode } from '@harness/contract'
import { ChatGptCredentialStore } from '@harness/drivers'
import { derivedId } from '@harness/engine'
import { addSavedProvider, removeSavedProvider } from '../src/provider-instances'
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

  static async connect(url: string, token?: string, origin?: string): Promise<Client> {
    const headers = {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    }
    const socket = new WebSocket(url, { headers })
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

  private async waitForFrame(predicate: (frame: any) => boolean, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.events.find(predicate)
      if (found) return found
      await Bun.sleep(10)
    }
    return null
  }

  async waitFor(type: string, timeoutMs = 3000, matches?: (payload: any) => boolean): Promise<any> {
    const frame = await this.waitForFrame(frame => frame?.t === 'event' && frame.event.payload.type === type
      && (!matches || matches(frame.event.payload)), timeoutMs)
    return frame?.event.payload ?? null
  }

  waitForDispatch(id: string): Promise<{ t: 'dispatched' | 'rejected', replayed?: boolean } | null> {
    return this.waitForFrame(frame => (frame?.t === 'dispatched' || frame?.t === 'rejected') && frame.id === id, 3000)
  }

  waitForRejection(id: string): Promise<unknown> {
    return this.waitForFrame(frame => frame?.t === 'rejected' && frame.id === id, 3000)
  }

  async subscribeCreatedSession(id: string): Promise<number> {
    const receipt = await this.waitForFrame(frame => (frame?.t === 'dispatched' || frame?.t === 'rejected') && frame.id === id, 5000)
    if (receipt?.t !== 'dispatched') throw new Error(receipt?.message ?? 'Session creation was not acknowledged')
    const sessionId = derivedId(id)
    this.send({ t: 'subscribe', sessionId })
    const subscribed = await this.waitForFrame(frame => frame?.t === 'subscribed' && frame.sessionId === sessionId, 5000)
    if (!subscribed) throw new Error('Session subscription was not acknowledged')
    return sessionId
  }

  close(): void { this.socket.close() }
}

async function bootstrap(client: Client, workspace: string = dir, isolate = false): Promise<{ sessionId: number }> {
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
    envelope: { id: 'c_s', at: 4, command: { type: 'session.create', workspaceId, driverKind: 'claude', isolate } },
  })
  return { sessionId: await client.subscribeCreatedSession('c_s') }
}

/** Bootstrap, but asking for a checkout of its own. */
function bootstrapIsolated(client: Client, workspace: string): Promise<{ sessionId: number }> {
  return bootstrap(client, workspace, true)
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

describe('composer attachments', () => {
  it('delivers a project-scoped first attachment and a queued attachment exactly once', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const delivered: StartTurnInput[] = []
    const firstTurn = Promise.withResolvers<void>()
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn(input) {
            delivered.push(input)
            if (delivered.length === 1) await firstTurn.promise
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async interrupt() { firstTurn.resolve() },
          async respondApproval() {},
          async stop() { firstTurn.resolve() },
        }
      },
    }
    const start = () => serve({ port, databasePath, resolveDriver: () => driver })
    harness = await start()
    const wsUrl = `ws://127.0.0.1:${port}/ws`
    const client = await Client.connect(wsUrl)
    const { sessionId } = await bootstrap(client)
    const root = `http://127.0.0.1:${port}/composer-attachments`
    const draft = 'a'.repeat(32)
    const projectScope = `project:${derivedId('c_w')}`
    const sessionScope = `session:${sessionId}`
    const params = (scope: string) => new URLSearchParams({ scope, draft, name: 'fixture.txt' })
    const upload = async (scope: string, body: string) => {
      const response = await fetch(`${root}?${params(scope)}`, { method: 'POST', body })
      expect(response.status).toBe(201)
      return await response.json() as { id: string, name: string }
    }
    const send = (id: string, command: Command) => {
      client.events = client.events.filter(frame => frame.id !== id)

      client.send({ t: 'dispatch', envelope: { id, at: Date.now(), command } })
      return client.waitForDispatch(id)
    }

    try {
      const first = await upload(projectScope, 'first attachment contents')
      const firstInput = { scope: projectScope, draft, ids: [first.id] }
      const direct = { type: 'session.turn.start', sessionId, text: '', uploads: firstInput } as const
      expect((await fetch(`${root}/${first.id}?session=${sessionId}`)).status).toBe(404)
      expect(await send('duplicated-refs', { ...direct, uploads: { ...firstInput, ids: [first.id, first.id] } })).toMatchObject({ t: 'rejected' })
      expect(await send('wrong-bucket', { ...direct, uploads: { ...firstInput, scope: sessionScope } })).toMatchObject({ t: 'rejected' })
      expect(await send('first-message', direct)).toMatchObject({ t: 'dispatched', replayed: false })
      expect(await send('first-message-retry', direct)).toMatchObject({ t: 'rejected' })

      const second = await upload(sessionScope, 'second attachment contents')
      const queue = {
        type: 'session.queue.add', sessionId, text: '',
        uploads: { scope: sessionScope, draft, ids: [second.id] },
      } as const
      expect(await send('queue-files', queue)).toMatchObject({ t: 'dispatched', replayed: false })
      expect(await send('queue-files', queue)).toMatchObject({ t: 'dispatched', replayed: true })
      expect((await fetch(`${root}/${second.id}?${params(sessionScope)}`, { method: 'DELETE' })).status).toBe(409)
      firstTurn.resolve()
      expect(await client.waitFor('turn.completed', 3000, turn => turn.turnId === 2)).not.toBeNull()
      expect(delivered).toHaveLength(2)
      for (const [index, contents] of ['first attachment contents', 'second attachment contents'].entries()) {
        const path = JSON.parse(delivered[index]!.text.split('- ')[1]!) as string
        expect(await Bun.file(path).text()).toBe(contents)
      }
      expect(harness.engine.current.sessions.get(sessionId)?.turns.map(turn => turn.prompt)).toEqual(['', ''])
      expect(await send('first-message', direct)).toMatchObject({ t: 'dispatched', replayed: true })
      client.close()
      harness.stop()
      harness = await start()
      expect(harness.engine.current.sessions.get(sessionId)?.turns.map(turn => turn.attachments?.[0]?.id)).toEqual([first.id, second.id])
      const download = await fetch(`${root}/${first.id}?session=${sessionId}`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('application/octet-stream')
      expect(await download.text()).toBe('first attachment contents')
      expect((await fetch(`${root}/${first.id}?session=${sessionId + 1}`)).status).toBe(404)
    }
    finally {
      firstTurn.resolve()
      client.close()
    }
  })
})

describe('fork recovery', () => {
  it.each([true, false])('continues a historical Claude fork with native history available = %s', async (available) => {
    const databasePath = join(dir, 'test.sqlite')
    const forkCalls: string[] = []
    const delivered: StartTurnInput[] = []
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn(input) {
            delivered.push(input)
            if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: `claude-${delivered.length}` }
            yield { type: 'assistant-delta', text: 'Fixture response.' }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, providerTurnId: `response-${delivered.length}` }
          },
          async fork(input) {
            forkCalls.push(`${input.providerSessionId}:${input.providerTurnId}`)
            if (!available) return null
            const copied = `copy-${forkCalls.length}`
            return { providerSessionId: `fork-${forkCalls.length}`, copiedProviderTurnIds: { [input.providerTurnId!]: copied } }
          },
          async interrupt() {},
          async respondApproval() {},
          async stop() {},
        }
      },
    }
    const start = () => serve({ port, databasePath, resolveDriver: () => driver })
    const connect = () => Client.connect(`ws://127.0.0.1:${port}/ws`)
    harness = await start()
    const client = await connect()
    const dispatch = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 1, command } })
    try {
      const { sessionId } = await bootstrap(client)
      dispatch('claude-source-first', { type: 'session.turn.start', sessionId, text: 'Original first prompt' })
      expect(await client.waitFor('turn.completed')).toMatchObject({ providerTurnId: 'response-1' })
      dispatch('claude-source-later', { type: 'session.turn.start', sessionId, text: 'Later parent prompt' })
      expect(await client.waitFor('turn.completed', 3000, p => p.turnId === 2)).toMatchObject({ providerTurnId: 'response-2' })
      const command = { type: 'session.fork' as const, sessionId, turnId: 1 }
      dispatch('claude-source-fork', command)
      const forkId = await client.subscribeCreatedSession('claude-source-fork')
      expect(await client.waitFor(available ? 'session.fork-finished' : 'session.fork-portable')).toBeTruthy()
      expect(forkCalls).toEqual(['claude-1:response-1'])
      expect(harness.engine.current.sessions.get(forkId)?.turns).toHaveLength(1)
      expect(harness.engine.current.sessions.get(sessionId)?.turns[0]?.providerTurnId).toBe('response-1')
      dispatch('claude-fork-follow-up', { type: 'session.turn.start', sessionId: forkId, text: 'Continue in the fork' })
      expect(await client.waitFor('turn.completed', 3000, p => p.providerTurnId === 'response-3')).toBeTruthy()
      if (available) expect(delivered[2]).toMatchObject({ text: 'Continue in the fork', providerSessionId: 'fork-1', requireResume: true })
      else {
        expect(delivered[2]?.providerSessionId).toBeUndefined()
        expect(delivered[2]?.text).toContain('Original first prompt')
        expect(delivered[2]?.text).not.toContain('Later parent prompt')
      }

      harness.stop()
      harness = await start()
      const resumed = await connect()
      try {
        resumed.send({ t: 'dispatch', envelope: { id: 'claude-source-fork', at: 1, command } })
        expect(await resumed.waitForDispatch('claude-source-fork')).toMatchObject({ replayed: true })
        expect(harness.engine.current.sessions.get(forkId)?.turns[0]?.nativeFork?.providerSessionId).toBe(available ? 'fork-1' : undefined)
        expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe('claude-1')
        resumed.send({ t: 'dispatch', envelope: { id: 'claude-nested-fork', at: 1, command: { type: 'session.fork', sessionId: forkId, turnId: 1 } } })
        const nestedId = await resumed.subscribeCreatedSession('claude-nested-fork')
        if (available) expect(await resumed.waitFor('session.fork-finished')).toMatchObject({ providerSessionId: 'fork-2' })
        expect(harness.engine.current.sessions.get(nestedId)?.fork?.state).toBe('ready')
        expect(forkCalls).toEqual(available ? ['claude-1:response-1', 'fork-1:copy-1'] : ['claude-1:response-1'])
      }
      finally { resumed.close() }
    }
    finally { client.close() }
  })

  it('marks an interrupted fork and refuses to start a fresh provider conversation after restart', async () => {
    const databasePath = join(dir, 'test.sqlite')
    let providerResolutions = 0
    const resolveDriver = () => {
      providerResolutions++
      return null
    }
    harness = await serve({ port, databasePath, resolveDriver })
    const append = (id: string, command: Command) => harness.engine.dispatch({ id, at: 1, command })
    const internal = (id: string, command: Command) => harness.engine.dispatchInternal({ id, at: 1, command })
    const profileId = derivedId('fork-profile')
    const workspaceId = derivedId('fork-workspace')
    const sessionId = derivedId('fork-source')
    await append('fork-profile', { type: 'profile.create', name: 'Local' })
    await append('fork-workspace', { type: 'workspace.add', profileId, path: dir })
    await append('fork-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    await append('fork-source', { type: 'session.create', workspaceId, driverKind: 'codex' })
    await internal('fork-source-bound', { type: 'thread.session.set', sessionId, providerSessionId: 'native-source' })
    await append('fork-prompt', { type: 'session.turn.start', sessionId, text: 'First message' })
    await internal('fork-answer', { type: 'thread.message.assistant.delta', sessionId, turnId: 1, text: 'First answer' })
    await internal('fork-complete', { type: 'thread.turn.complete', sessionId, turnId: 1, tokensIn: 1, tokensOut: 1, cost: 0 })
    await append('fork-pending', { type: 'session.fork', sessionId, turnId: 1 })
    const targetId = derivedId('fork-pending')
    expect(harness.engine.current.sessions.get(targetId)?.fork?.state).toBe('pending')

    harness.stop()
    harness = await serve({ port, databasePath, resolveDriver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    try {
      client.send({ t: 'dispatch', envelope: { id: 'fork-pending', at: 1, command: { type: 'session.fork', sessionId, turnId: 1 } } })
      expect(await client.waitForDispatch('fork-pending')).toMatchObject({ t: 'dispatched', replayed: true })
      expect(harness.engine.current.sessions.get(targetId)).toMatchObject({
        providerSessionId: '', fork: { state: 'failed', error: expect.stringContaining('host restarted') },
      })
      client.send({ t: 'dispatch', envelope: { id: 'fork-rejected-turn', at: 2, command: { type: 'session.turn.start', sessionId: targetId, text: 'Do not create a provider session' } } })
      expect(await client.waitForDispatch('fork-rejected-turn')).toMatchObject({ t: 'rejected' })
      expect(harness.engine.current.sessions.get(sessionId)?.turns[0]?.response).toBe('First answer')
      expect(providerResolutions).toBe(0)
    }
    finally {
      client.close()
    }
  })
})

describe('manual compaction', () => {
  it('queues the provider operation, preserves the native conversation, and replays confirmation', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const prompts: StartTurnInput[] = []
    const compactions: string[] = []
    const first = Promise.withResolvers<void>()
    const { driver } = fakeDriver([])
    const resolveDriver = () => ({
      ...driver,
      async create(config: DriverConfig) {
        return {
          ...await driver.create(config),
          async steer() { return 'delivered' as const },
          async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
            prompts.push(input)
            if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'saved-conversation' }
            if (prompts.length === 1) {
              yield { type: 'steering-ready' }
              await first.promise
            }
            yield { type: 'assistant-delta', text: 'An existing answer.' }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async *compact(providerSessionId: string): AsyncIterable<ProviderEvent> {
            compactions.push(providerSessionId)
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, contextCompacted: true }
          },
        }
      },
    })
    harness = await serve({ port, databasePath, resolveDriver })
    let client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })
    try {
      send('compact-without-conversation', { type: 'session.turn.start', sessionId, text: '/compact' })
      expect(await client.waitFor('session.failed')).toMatchObject({ message: expect.stringContaining('start this provider conversation') })
      expect(prompts).toHaveLength(0)
      expect(compactions).toHaveLength(0)

      send('pre-compact', { type: 'session.turn.start', sessionId, text: 'The first request.' })
      expect(await client.waitFor('turn.steering-ready')).toMatchObject({ turnId: 2 })
      const queued = { type: 'session.queue.add', sessionId, text: '/compact' } as const
      send('queued-compact', queued)
      expect(await client.waitFor('queue.added')).toMatchObject({ entry: { text: '/compact' } })
      send('compact-as-steer', { type: 'session.turn.steer', sessionId, turnId: 2, id: 'queued-compact' })
      expect(await client.waitForRejection('compact-as-steer')).toMatchObject({ message: expect.stringContaining('wait for the current turn') })
      expect(compactions).toHaveLength(0)
      first.resolve()

      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 3)).toMatchObject({ turnId: 3, contextCompacted: true })
      expect(compactions).toEqual(['saved-conversation'])
      expect(prompts.map(prompt => prompt.text)).toEqual(['The first request.'])
      client.close()
      harness.stop()
      harness = await serve({ port, databasePath, resolveDriver })
      client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
      client.send({ t: 'subscribe', sessionId })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 3)).toMatchObject({ contextCompacted: true })
      send('queued-compact', queued)
      expect(await client.waitForDispatch('queued-compact')).toMatchObject({ replayed: true })
      send('after-compact', { type: 'session.turn.start', sessionId, text: 'The next request.' })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 4)).toMatchObject({ turnId: 4 })
      expect(prompts[1]).toMatchObject({ text: 'The next request.', providerSessionId: 'saved-conversation' })
      expect(compactions).toHaveLength(1)
      expect(harness.engine.current.sessions.get(sessionId)?.turns[2]).toMatchObject({ prompt: '/compact', contextCompacted: true })
    }
    finally {
      first.resolve()
      client.close()
    }
  })
})

describe('Claude idle compaction', () => {
  it.each(['keep', 'compact', 'off', 'failure', 'restart', 'scheduled', 'disabled-before-timer'] as const)(
    'preserves one native conversation and prompt when the outcome is %s', async (scenario) => {
      const databasePath = join(dir, 'test.sqlite')
      const scheduled = scenario === 'scheduled' || scenario === 'disabled-before-timer'
      const order: Array<[string, string | undefined]> = []
      const gate = Promise.withResolvers<void>()
      const { driver } = fakeDriver([])
      const resolveDriver = () => ({
        ...driver,
        async create(config: DriverConfig) {
          return {
            ...await driver.create(config),
            async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
              order.push([input.text, input.providerSessionId])
              if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'claude-context' }
              yield { type: 'assistant-delta', text: 'The fixture acknowledged the request.' }
              yield {
                type: 'turn-complete', tokensIn: 5, tokensOut: 3, costMicros: 0,
                ...(input.text === 'Seed context' ? { contextUsage: {
                  usedTokens: 220_000, maxTokens: 1_000_000,
                  promptCacheExpiresAt: Date.now() + (scheduled ? 120_000 + 700 : -1000),
                } } : {}),
              }
            },
            async *compact(providerSessionId: string): AsyncIterable<ProviderEvent> {
              order.push(['/compact', providerSessionId])
              if (scenario === 'restart') await gate.promise
              if (scenario === 'failure') yield { type: 'error', message: 'Compaction was unavailable.' }
              else yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, contextCompacted: true }
            },
          }
        },
      })
      harness = await serve({ port, databasePath, resolveDriver })
      let client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
      const { sessionId } = await bootstrap(client)
      const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })

      try {
        if (scheduled || scenario === 'off') {
          send('idle-settings', { type: 'settings.update', changes: { claudeIdleCompaction: scheduled ? 'beforeCacheExpires' : 'off' } })
          expect(await client.waitForDispatch('idle-settings')).toMatchObject({ t: 'dispatched' })
        }
        send('idle-seed', { type: 'session.turn.start', sessionId, text: 'Seed context' })
        expect(await client.waitFor('turn.completed')).toMatchObject({ turnId: 1, contextUsage: { usedTokens: 220_000 } })

        if (scenario === 'scheduled') {
          expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 2)).toMatchObject({ contextCompacted: true })
          expect(client.payloads('turn.started').at(-1)).toMatchObject({ automaticCompaction: true })
          expect(order).toEqual([['Seed context', undefined], ['/compact', 'claude-context']])
          return
        }
        if (scenario === 'disabled-before-timer') {
          send('turn-off', { type: 'settings.update', changes: { claudeIdleCompaction: 'off' } })
          expect(await client.waitForDispatch('turn-off')).toMatchObject({ t: 'dispatched' })
          await Bun.sleep(900)
          expect(order).toEqual([['Seed context', undefined]])
          return
        }

        const command: Command = {
          type: 'session.turn.start', sessionId, text: 'Deliver the real follow-up.',
          ...(scenario === 'keep' ? {} : { compactAfterTurnId: 1 }),
        }
        send('idle-return', command)
        const needsRecovery = scenario === 'failure' || scenario === 'restart'
        if (needsRecovery) {
          expect(await client.waitFor('queue.added')).toMatchObject({ entry: { id: 'idle-return', text: command.text } })
          if (scenario === 'restart') {
            client.close()
            harness.stop()
            gate.resolve()
            harness = await serve({ port, databasePath, resolveDriver })
            client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
            client.send({ t: 'subscribe', sessionId })
            expect(await client.waitFor('turn.interrupted')).toMatchObject({ turnId: 2 })
          }
          else expect(await client.waitFor('session.failed')).toMatchObject({ message: 'Compaction was unavailable.' })
          expect(harness.engine.current.sessions.get(sessionId)?.followUps).toMatchObject({ held: true, entries: [{ text: command.text }] })
          expect(order.map(([text]) => text)).not.toContain(command.text)
          send('idle-recover', { type: 'session.queue.send', sessionId, id: 'idle-return' })
        }

        const shouldCompact = scenario !== 'keep' && scenario !== 'off'
        expect(await client.waitFor('turn.completed', 3000, event => event.turnId === (shouldCompact ? 3 : 2))).toBeTruthy()
        send('idle-return', command)
        expect(await client.waitForDispatch('idle-return')).toMatchObject({ t: 'dispatched' })
        expect(order).toEqual([
          ['Seed context', undefined],
          ...(shouldCompact ? [['/compact', 'claude-context']] : []),
          [command.text, 'claude-context'],
        ])
        expect(harness.engine.current.sessions.get(sessionId)?.followUps.entries).toHaveLength(0)
      }
      finally {
        gate.resolve()
        client.close()
      }
    },
  )
})

describe('Claude automatic compaction threshold', () => {
  it('applies a changed window on the next turn without replacing the native conversation', async () => {
    const launches: Array<number | undefined> = []
    const bindings: Array<string | undefined> = []
    const { driver } = fakeDriver([])
    harness = await serve({
      port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => ({
        ...driver,
        async create(config) {
          launches.push(config.claudeAutoCompactAfter)
          return {
            ...await driver.create(config),
            async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
              bindings.push(input.providerSessionId)
              if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'threshold-conversation' }
              yield { type: 'assistant-delta', text: 'The selected Claude runtime handled this turn.' }
              yield { type: 'turn-complete', tokensIn: 5, tokensOut: 3, costMicros: 0 }
            },
          }
        },
      }),
    })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })
    try {
      send('threshold-original', { type: 'session.turn.start', sessionId, text: 'Start with the default window.' })
      expect(await client.waitFor('turn.completed')).toMatchObject({ turnId: 1 })
      send('threshold-invalid', { type: 'settings.update', changes: { claudeAutoCompactAfter: 99_999 } })
      expect(await client.waitForDispatch('threshold-invalid')).toMatchObject({ t: 'rejected' })
      send('threshold-set', { type: 'settings.update', changes: { claudeAutoCompactAfter: 300_000 } })
      expect(await client.waitForDispatch('threshold-set')).toMatchObject({ t: 'dispatched' })
      send('threshold-custom', { type: 'session.turn.start', sessionId, text: 'Continue with the selected window.' })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 2)).toBeTruthy()
      send('threshold-clear', { type: 'settings.update', changes: { claudeAutoCompactAfter: null } })
      expect(await client.waitForDispatch('threshold-clear')).toMatchObject({ t: 'dispatched' })
      send('threshold-default', { type: 'session.turn.start', sessionId, text: 'Continue with the default again.' })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 3)).toBeTruthy()
      expect(launches).toEqual([undefined, 300_000, undefined])
      expect(bindings).toEqual([undefined, 'threshold-conversation', 'threshold-conversation'])
    }
    finally { client.close() }
  })
})

describe('Claude account compaction preferences', () => {
  it('isolates account overrides from the host defaults and from paired devices after restart', async () => {
    const databasePath = join(dir, 'test.sqlite')
    {
      using db = new Database(databasePath)
      db.exec('CREATE TABLE provider_instances (id INTEGER PRIMARY KEY, profile_id INTEGER, driver_kind TEXT, binary_path TEXT, resolved_home TEXT, config TEXT)')
    }
    const launches = new Map<string | undefined, Array<number | undefined>>()
    const compactions: string[] = []
    const { driver } = fakeDriver([])
    const options = {
      port, databasePath, remote: true, localTokenPath: join(dir, 'host-token'),
      resolveDriver: (): Driver => ({
        ...driver,
        async create(config) {
          const windows = launches.get(config.binaryPath) ?? []
          windows.push(config.claudeAutoCompactAfter)
          launches.set(config.binaryPath, windows)
          return {
            ...await driver.create(config),
            async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
              yield { type: 'session-bound', providerSessionId: input.providerSessionId ?? config.binaryPath ?? 'default' }
              yield { type: 'assistant-delta', text: 'Fixture context recorded.' }
              yield { type: 'turn-complete', tokensIn: 2, tokensOut: 1, costMicros: 0, contextUsage: {
                usedTokens: 220_000, promptCacheExpiresAt: Date.now() + (input.text === 'Refresh the beta account cache' ? 120_700 : -1000),
              } }
            },
            async *compact(providerSessionId: string): AsyncIterable<ProviderEvent> {
              compactions.push(providerSessionId)
              yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, contextCompacted: true }
            },
          }
        },
      }),
    }
    harness = await serve(options)
    const access = harness.access!
    const { code } = access.openPairing()
    const paired = await access.redeem(code, 'Compaction fixture')
    if (!paired.ok) throw new Error('Fixture pairing failed')
    const socketUrl = `ws://127.0.0.1:${port}/ws`
    let host = await Client.connect(socketUrl, access.localToken)
    const device = await Client.connect(socketUrl, paired.token)
    const profileId = derivedId('compaction-project')
    const otherProfileId = derivedId('another-compaction-profile')
    await harness.engine.dispatch({ id: 'compaction-project', at: 1, command: { type: 'workspace.register', path: dir, trusted: true } })
    await harness.engine.dispatch({ id: 'another-compaction-profile', at: 1, command: { type: 'profile.create', name: 'Other' } })
    {
      using db = new Database(databasePath)
      const insert = db.query('INSERT INTO provider_instances (id, profile_id, driver_kind, binary_path) VALUES (?, ?, ?, ?)')
      insert.run(1, profileId, 'claude', 'claude-work-fixture')
      insert.run(2, profileId, 'claude', 'claude-personal-fixture')
      insert.run(3, profileId, 'codex', 'codex-fixture')
    }
    const send = (id: string, command: Command, client = host) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })
    const localEdit = { type: 'profile.claude-compaction.update', profileId, providerInstanceId: 1,
      changes: { idleCompaction: 'whenReturning', autoCompactAfter: 300_000 } } as const

    try {
      send('paired-account-compaction', localEdit, device)
      expect(await device.waitForRejection('paired-account-compaction')).toMatchObject({ message: expect.stringContaining('Harness host') })
      const fromPaired = await fetch(`http://127.0.0.1:${port}/drivers?workspace=${profileId}`, {
        headers: { authorization: `Bearer ${paired.token}` },
      }).then(response => response.json())
      expect(fromPaired.canEditProviderAccounts).toBe(false)
      send('foreign-account-compaction', { ...localEdit, profileId: otherProfileId })
      expect(await host.waitForRejection('foreign-account-compaction')).toBeTruthy()
      send('wrong-driver-compaction', { ...localEdit, providerInstanceId: 3 })
      expect(await host.waitForRejection('wrong-driver-compaction')).toBeTruthy()
      send('compaction-host-defaults', { type: 'settings.update', changes: { claudeIdleCompaction: 'off', claudeAutoCompactAfter: 400_000 } })
      expect(await host.waitForDispatch('compaction-host-defaults')).toMatchObject({ t: 'dispatched' })
      send('compaction-work', localEdit)
      expect(await host.waitForDispatch('compaction-work')).toMatchObject({ t: 'dispatched' })
      send('compaction-personal', { ...localEdit, providerInstanceId: 2, changes: { autoCompactAfter: 'default' } })
      expect(await host.waitForDispatch('compaction-personal')).toMatchObject({ t: 'dispatched' })

      host.close()
      device.close()
      harness.stop()
      harness = await serve(options)
      host = await Client.connect(socketUrl, harness.access!.localToken)
      send('compaction-work', localEdit)
      expect(await host.waitForDispatch('compaction-work')).toMatchObject({ replayed: true })

      for (const providerInstanceId of [1, 2]) {
        const label = `account-compaction-${providerInstanceId}`
        send(label, { type: 'session.create', workspaceId: profileId, driverKind: 'claude', providerInstanceId })
        const sessionId = await host.subscribeCreatedSession(label)
        send(`${label}-seed`, { type: 'session.turn.start', sessionId, text: 'Seed the account context' })
        expect(await host.waitFor('turn.completed', 3000, event => event.turnId === 1)).toBeTruthy()
        host.events = []
        send(`${label}-continue`, { type: 'session.turn.start', sessionId, text: 'Continue the account thread', compactAfterTurnId: 1 })
        expect(await host.waitFor('turn.completed', 3000, event => event.turnId === (providerInstanceId === 1 ? 3 : 2))).toBeTruthy()
        host.events = []
        if (providerInstanceId === 2) {
          send('compaction-personal-inherit', { ...localEdit, providerInstanceId, changes: { autoCompactAfter: null } })
          expect(await host.waitForDispatch('compaction-personal-inherit')).toMatchObject({ t: 'dispatched' })
          send(`${label}-inherit`, { type: 'session.turn.start', sessionId, text: 'Continue with the host window' })
          expect(await host.waitFor('turn.completed', 3000, event => event.turnId === 3)).toBeTruthy()
        }
      }
      expect(compactions).toEqual(['claude-work-fixture'])
      const workSessionId = derivedId('account-compaction-1')
      send('compaction-work-beta', { ...localEdit, changes: { idleCompaction: 'beforeCacheExpires' } })
      expect(await host.waitForDispatch('compaction-work-beta')).toMatchObject({ t: 'dispatched' })
      send('compaction-work-refresh', { type: 'session.turn.start', sessionId: workSessionId, text: 'Refresh the beta account cache' })
      expect(await host.waitFor('turn.completed', 3000, event => event.turnId === 5 && event.contextCompacted)).toBeTruthy()
      expect(compactions).toEqual(['claude-work-fixture', 'claude-work-fixture'])
      expect(Object.fromEntries(launches)).toEqual({ 'claude-work-fixture': [300_000], 'claude-personal-fixture': [undefined, 400_000] })
    }
    finally {
      host.close()
      device.close()
    }
  })
})

describe('fresh provider session', () => {
  it.each(['direct', 'switch-provider'] as const)('preserves the thread and starts the %s provider without earlier context', async mode => {
    const databasePath = join(dir, 'test.sqlite')
    const calls: Array<{ driver: string, input: StartTurnInput, nativeId: string }> = []
    let launches = 0
    const { driver } = fakeDriver([])
    const options = {
      port, databasePath, resolveDriver: (kind: Driver['kind']): Driver => ({
        ...driver,
        kind,
        async create(config) {
          const createdId = `native-${kind}-${++launches}`
          return {
            ...await driver.create(config),
            async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
              const nativeId = input.providerSessionId ?? createdId
              calls.push({ driver: kind, input, nativeId })
              if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: nativeId }
              yield { type: 'assistant-delta', text: `Reply to ${input.text}` }
              yield { type: 'turn-complete', tokensIn: 5, tokensOut: 3, costMicros: 0 }
            },
          }
        },
      }),
    }
    harness = await serve(options)
    const url = `ws://127.0.0.1:${port}/ws`
    let client = await Client.connect(url)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 20, command } })
    const oldPrompt = 'Remember the earlier draft.'
    const freshPrompt = 'Take an independent look.'
    try {
      send('fresh-source', { type: 'session.turn.start', sessionId, text: oldPrompt })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 1)).toBeTruthy()
      send('fresh-slash', { type: 'session.turn.start', sessionId, text: '/clear' })
      expect(await client.waitForRejection('fresh-slash')).toBeTruthy()
      const fresh: Command = mode === 'direct'
        ? { type: 'session.turn.start', sessionId, text: freshPrompt, freshContext: true }
        : { type: 'session.handoff', sessionId, driverKind: 'codex', afterTurnId: 1, text: freshPrompt, freshContext: true }
      send('fresh-entry', fresh)
      expect(await client.waitFor('turn.started', 3000, event => event.turnId === 2)).toMatchObject({ freshContext: true })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 2)).toBeTruthy()
      expect(calls).toHaveLength(2)
      expect(calls[1]?.input.text).toBe(freshPrompt)
      expect(calls[1]?.input.historicalContext).toBeUndefined()
      expect(calls[1]?.input.providerSessionId).toBeUndefined()
      expect(calls[1]?.nativeId).not.toBe(calls[0]?.nativeId)
      const originalNativeId = calls[0]!.nativeId
      const freshNativeId = calls[1]!.nativeId

      client.close()
      harness.stop()
      harness = await serve(options)
      client = await Client.connect(url)
      client.send({ t: 'subscribe', sessionId })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 2)).toBeTruthy()
      send('fresh-entry', fresh)
      expect(await client.waitForDispatch('fresh-entry')).toMatchObject({ replayed: true })
      expect(harness.engine.current.sessions.get(sessionId)?.turns.map(turn => turn.prompt)).toEqual([oldPrompt, freshPrompt])
      expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe(freshNativeId)

      send('fresh-switch', {
        type: 'session.handoff', sessionId, driverKind: mode === 'direct' ? 'codex' : 'claude',
        afterTurnId: 2, text: 'Continue across providers.',
      })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 3)).toBeTruthy()
      expect(calls[2]?.input.text).toContain(freshPrompt)
      expect(calls[2]?.input.text).not.toContain(oldPrompt)
      expect(calls[2]?.input.providerSessionId).toBeUndefined()
      expect(calls[2]?.nativeId).not.toBe(originalNativeId)

      send('fresh-return', {
        type: 'session.handoff', sessionId, driverKind: mode === 'direct' ? 'claude' : 'codex',
        afterTurnId: 3, text: 'Return to the fresh conversation.',
      })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 4)).toBeTruthy()
      expect(calls[3]?.nativeId).toBe(freshNativeId)
      expect(calls[3]?.input.text).not.toContain(oldPrompt)
    }
    finally { client.close() }
  })

  it('keeps the fresh-context flag on a queued message through a restart', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const gate = Promise.withResolvers<void>()
    const bindings: Array<string | undefined> = []
    let launches = 0
    const { driver } = fakeDriver([])
    const options = {
      port, databasePath, resolveDriver: () => ({
        ...driver,
        async create(config: DriverConfig) {
          const id = `native-queued-${++launches}`
          return {
            ...await driver.create(config),
            async steer() { return 'delivered' as const },
            async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
              bindings.push(input.providerSessionId)
              if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: id }
              if (input.text === 'Keep this turn running.') {
                yield { type: 'steering-ready' }
                await gate.promise
              }
              yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
            },
          }
        },
      }),
    }
    harness = await serve(options)
    const url = `ws://127.0.0.1:${port}/ws`
    let client = await Client.connect(url)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 20, command } })
    try {
      send('fresh-hold', { type: 'session.turn.start', sessionId, text: 'Keep this turn running.' })
      expect(await client.waitFor('turn.steering-ready')).toBeTruthy()
      send('fresh-queued', { type: 'session.queue.add', sessionId, text: 'Start fresh when ready.', freshContext: true })
      expect(await client.waitFor('queue.added')).toMatchObject({ entry: { freshContext: true } })
      send('fresh-steer', { type: 'session.turn.steer', sessionId, turnId: 1, id: 'fresh-queued' })
      expect(await client.waitForRejection('fresh-steer')).toMatchObject({ message: expect.stringContaining('wait') })
      client.close()
      harness.stop()
      gate.resolve()
      harness = await serve(options)
      client = await Client.connect(url)
      client.send({ t: 'subscribe', sessionId })
      expect(await client.waitFor('turn.interrupted')).toBeTruthy()
      expect(harness.engine.current.sessions.get(sessionId)?.followUps).toMatchObject({ held: true, entries: [{ freshContext: true }] })
      send('fresh-resume', { type: 'session.queue.send', sessionId, id: 'fresh-queued' })
      expect(await client.waitFor('turn.started', 3000, event => event.turnId === 2)).toMatchObject({ freshContext: true })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 2)).toBeTruthy()
      expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe('native-queued-2')
      expect(bindings).toEqual([undefined, undefined])
    }
    finally {
      gate.resolve()
      client.close()
    }
  })
})

describe('provider handoff', () => {
  it.each(['resumed', 'missing', 'ambiguous', 'over-capacity', 'changed-model', 'small-window'] as const)('continues a saved account after host restart when the return is %s', async (outcome) => {
    const databasePath = join(dir, 'test.sqlite')
    {
      using db = new Database(databasePath)
      db.exec('CREATE TABLE provider_instances (id INTEGER PRIMARY KEY, profile_id INTEGER, driver_kind TEXT, binary_path TEXT, resolved_home TEXT, config TEXT)')
      db.query("INSERT INTO provider_instances VALUES (7, ?, 'claude', NULL, '/fixture/alternate', NULL)").run(derivedId('c_p'))
    }
    const calls: Array<{ home?: string, input: StartTurnInput }> = []
    const { driver } = fakeDriver([])
    const resolveDriver = () => ({
      ...driver,
      async create(config: DriverConfig) {
        return {
          ...await driver.create(config),
          async *startTurn(input: StartTurnInput): AsyncIterable<ProviderEvent> {
            calls.push({ home: config.home, input })
            if (input.requireResume && (outcome === 'missing' || outcome === 'ambiguous')) {
              if (outcome === 'missing') yield { type: 'resume-unavailable' }
              else yield { type: 'error', message: 'The provider disconnected during the return.' }
              return
            }
            if (!input.providerSessionId) {
              const providerSessionId = config.home ? 'alternate-native' : calls.length === 1 ? 'original-native' : 'replacement-native'
              yield { type: 'session-bound', providerSessionId }
            }
            yield { type: 'assistant-delta', text: config.home ? 'The alternate response.' : 'The original response.' }
            const capped = outcome === 'over-capacity' || outcome === 'changed-model' || outcome === 'small-window'
            yield {
              type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0,
              ...(capped && calls.length === 1 ? { contextUsage: { usedTokens: 30_000, maxTokens: 32_000 } } : {}),
            }
          },
        }
      },
    })
    harness = await serve({ port, databasePath, resolveDriver })
    let client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })
    const tell = (id: string, text: string) => send(id, { type: 'session.turn.start', sessionId, text })
    const completed = (turnId: number) => client.waitFor('turn.completed', 3000, event => event.turnId === turnId)
    const restart = async () => {
      client.close()
      harness.stop()
      harness = await serve({ port, databasePath, resolveDriver })
      client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
      client.send({ t: 'subscribe', sessionId })
    }
    try {
      tell('return-original', 'The original request.')
      expect(await completed(1)).toMatchObject({ turnId: 1 })
      send('return-depart', { type: 'session.handoff', sessionId, afterTurnId: 1, driverKind: 'claude', providerInstanceId: 7, text: 'The alternate request.' })
      expect(await completed(2)).toMatchObject({ turnId: 2 })
      expect(calls[1]).toMatchObject({ home: '/fixture/alternate', input: { text: expect.stringContaining('The original response.') } })
      expect(calls[1]?.input.providerSessionId).toBeUndefined()

      await restart()
      const text = 'Return to the original account.' + (outcome === 'small-window' ? 'a'.repeat(22_000) : '')
      send('return-to-original', {
        type: 'session.handoff', sessionId, afterTurnId: 2, driverKind: 'claude', text,
        ...(outcome === 'changed-model' ? { model: 'different-model' } : {}),
      })
      if (outcome === 'small-window') {
        expect(await client.waitFor('session.failed')).toMatchObject({ message: expect.stringContaining('too little room') })
        expect(calls).toHaveLength(2)
        return
      }
      if (outcome === 'ambiguous') {
        expect(await client.waitFor('session.failed')).toMatchObject({ message: 'The provider disconnected during the return.' })
        expect(calls).toHaveLength(3)
        await restart()
        tell('return-retry', 'Retry on the original account.')
        expect(await completed(4)).toMatchObject({ turnId: 4 })
      }
      else {
        expect(await completed(3)).toMatchObject({ turnId: 3 })
      }

      expect(calls[2]?.home).toBeUndefined()
      if (outcome === 'over-capacity') {
        expect(calls).toHaveLength(3)
        expect(calls[2]?.input.providerSessionId).toBeUndefined()
        expect(calls[2]?.input.requireResume).toBeUndefined()
        expect(calls[2]?.input.text).toContain('The original response.')
        expect(calls[2]?.input.text).toContain('The alternate response.')
        expect(calls[2]?.input.text).toEndWith(text)
        expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe('replacement-native')
        return
      }
      expect(calls[2]?.input.providerSessionId).toBe('original-native')
      expect(calls[2]?.input.requireResume).toBe(true)
      expect(calls[2]?.input.text).toContain('The alternate response.')
      expect(calls[2]?.input.text).not.toContain('The original response.')
      if (outcome === 'resumed' || outcome === 'changed-model') {
        expect(calls).toHaveLength(3)
        expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe('original-native')
      }
      else {
        expect(calls).toHaveLength(4)
        expect(calls[3]?.input.providerSessionId).toBeUndefined()
        expect(calls[3]?.input.text).toContain('The original response.')
        expect(calls[3]?.input.text).toContain('The alternate response.')
        expect(harness.engine.current.sessions.get(sessionId)?.providerSessionId).toBe('replacement-native')
        expect(harness.engine.current.sessions.get(sessionId)?.turns).toHaveLength(outcome === 'missing' ? 3 : 4)
      }
    }
    finally {
      client.close()
    }
  })

  it('replays a switch once and retries uncertain delivery in a fresh conversation after restart', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const inputs: StartTurnInput[] = []
    const { driver } = fakeDriver([])
    const resolveDriver = (kind: Driver['kind']): Driver => ({
      ...driver,
      kind,
      async create(config) {
        return {
          ...await driver.create(config),
          acceptsHistoricalContext: kind === 'codex',
          async *startTurn(input) {
            const attempt = inputs.push(input)
            if (attempt === 1) {
              yield { type: 'session-bound', providerSessionId: 'source-account-native-id' }
              yield { type: 'assistant-delta', text: 'The original answer.' }
            }
            if (attempt === 2) {
              yield { type: 'session-bound', providerSessionId: 'ambiguous-target-native-id' }
              yield { type: 'error', message: 'The provider disconnected.' }
              return
            }
            if (attempt === 3) yield { type: 'session-bound', providerSessionId: 'replacement-native-id' }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
        }
      },
    })
    harness = await serve({ port, databasePath, resolveDriver })
    let client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    const send = (id: string, command: Command) => client.send({ t: 'dispatch', envelope: { id, at: 10, command } })
    try {
      send('original-message', { type: 'session.turn.start', sessionId, text: 'The original request.' })
      expect(await client.waitFor('turn.completed')).toMatchObject({ turnId: 1 })
      const switchProvider = { type: 'session.handoff', sessionId, afterTurnId: 1, driverKind: 'codex', text: 'Continue elsewhere.' } as const
      send('stale-switch', { ...switchProvider, afterTurnId: 0 })
      expect(await client.waitForRejection('stale-switch')).toMatchObject({ message: expect.stringContaining('another device') })
      send('handoff-switch', switchProvider)
      expect(await client.waitFor('session.provider-switched')).toMatchObject({ afterTurnId: 1, driverKind: 'codex' })
      expect(await client.waitFor('session.failed')).toMatchObject({ message: 'The provider disconnected.' })
      expect(inputs[1]?.providerSessionId).toBeUndefined()
      expect(inputs[1]?.text).toBe('Continue elsewhere.')
      expect(JSON.stringify(inputs[1]?.historicalContext?.items)).toContain('The original answer.')

      client.close()
      harness.stop()
      harness = await serve({ port, databasePath, resolveDriver })
      client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
      client.send({ t: 'subscribe', sessionId })
      send('handoff-switch', switchProvider)
      expect(await client.waitForDispatch('handoff-switch')).toMatchObject({ t: 'dispatched', replayed: true })
      expect(inputs).toHaveLength(2)
      send('handoff-retry', { type: 'session.turn.start', sessionId, text: 'Retry the continuation.' })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 3)).toMatchObject({ turnId: 3 })
      expect(inputs[2]?.providerSessionId).toBeUndefined()
      expect(inputs[2]?.text).toBe('Retry the continuation.')
      expect(JSON.stringify(inputs[2]?.historicalContext?.items)).toContain('The original request.')
      expect(JSON.stringify(inputs[2]?.historicalContext?.items)).not.toContain('Continue elsewhere.')
      send('handoff-follow-up', { type: 'session.turn.start', sessionId, text: 'Follow up without repeating context.' })
      expect(await client.waitFor('turn.completed', 3000, event => event.turnId === 4)).toMatchObject({ turnId: 4 })
      expect(inputs[3]).toMatchObject({ text: 'Follow up without repeating context.', providerSessionId: 'replacement-native-id' })
      expect(harness.engine.current.sessions.get(sessionId)?.turns.map(turn => turn.prompt)).toEqual([
        'The original request.', 'Continue elsewhere.', 'Retry the continuation.', 'Follow up without repeating context.',
      ])
    }
    finally {
      client.close()
    }
  })
})

describe('a turn drives the provider', () => {
  it('creates projectless threads on an empty profile and keeps separate host folders', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const scratchDirectory = join(dir, 'scratch')
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
    harness = await serve({
      port,
      databasePath,
      scratchDirectory,
      resolveDriver: () => ({
        ...driver,
        create(config) {
          writeFileSync(join(config.workspacePath, 'kept.txt'), 'fixture')
          return driver.create(config)
        },
      }),
    })
    const envelope = {
      id: 'scratch-first', at: 1,
      command: { type: 'session.scratch.create', driverKind: 'claude', label: '../write scratch file' },
    } as const
    const first = await harness.engine.dispatch(envelope)
    const sessionId = derivedId(envelope.id)
    const workspace = harness.engine.current.workspaces.get(sessionId)!
    expect(workspace).toMatchObject({ id: sessionId, profileId: sessionId, scratch: true, trusted: true })
    expect(workspace.path).toMatch(new RegExp(`^${RegExp.escape(scratchDirectory)}/[^/]*write-scratch-file-`))
    expect(existsSync(scratchDirectory)).toBe(false)
    const replayed = await harness.engine.dispatch({ ...envelope, command: { ...envelope.command, label: 'different' } })
    expect(replayed).toEqual({ ...first, replayed: true })

    const second = { ...envelope, id: 'scratch-second', command: { ...envelope.command, profileId: sessionId } }
    await harness.engine.dispatch(second)
    expect(harness.engine.current.workspaces.get(derivedId(second.id))?.path).not.toBe(workspace.path)
    expect(harness.engine.current.profiles.size).toBe(1)
    await expect(harness.engine.dispatch({
      ...envelope,
      id: 'client-cannot-set-host-path',
      command: { type: 'thread.scratch.create', driverKind: 'claude', path: dir },
    })).rejects.toThrow('not client-dispatchable')

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    try {
      client.send({ t: 'subscribe', sessionId })
      client.send({ t: 'dispatch', envelope: {
        id: 'scratch-turn', at: 2, command: { type: 'session.turn.start', sessionId, text: 'write the fixture' },
      } })
      expect(await client.waitFor('turn.completed')).toBeTruthy()
      expect(readFileSync(join(workspace.path, 'kept.txt'), 'utf8')).toBe('fixture')
    }
    finally {
      client.close()
    }
    harness.stop()
    harness = await serve({ port, databasePath, scratchDirectory, resolveDriver: () => driver })
    expect(harness.engine.current.workspaces.get(sessionId)).toEqual(workspace)
    expect(readFileSync(join(workspace.path, 'kept.txt'), 'utf8')).toBe('fixture')
    await harness.engine.dispatch({
      id: 'scratch-promote', at: 3, command: { type: 'workspace.promote', workspaceId: sessionId },
    })
    const promoted = harness.engine.current.workspaces.get(sessionId)
    expect(promoted).toEqual({ id: sessionId, profileId: sessionId, path: workspace.path, trusted: true })
    expect(harness.engine.current.sessions.get(sessionId)?.workspaceId).toBe(sessionId)
    expect(readFileSync(join(workspace.path, 'kept.txt'), 'utf8')).toBe('fixture')
  })

  it('uses only the selected project account for provider status and launch', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const profileId = derivedId('configured-profile')
    const otherProfileId = derivedId('other-profile')
    const workspaceId = derivedId('configured-workspace')
    const db = new Database(databasePath)
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE provider_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id), driver_kind TEXT,
        binary_path TEXT, resolved_home TEXT, config TEXT, status TEXT
      );
    `)
    db.close()

    const launched: DriverConfig[] = []
    const probed: DriverConfig[] = []
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
    harness = await serve({
      port,
      databasePath,
      resolveDriver: () => ({
        ...driver,
        async probe(config, options) {
          probed.push(config)
          const result = await driver.probe(config)
          return options?.includeModels && config.home?.endsWith('/work-account')
            ? { ...result, models: [{ id: 'fixture-work', name: 'Fixture Work', isDefault: true, reasoningEfforts: [], speedTiers: [] }] }
            : result
        },
        create(config) {
          launched.push(config)
          return driver.create(config)
        },
      }),
    })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    try {
      await harness.engine.dispatch({ id: 'configured-profile', at: 1, command: { type: 'profile.create', name: 'P' } })
      await harness.engine.dispatch({ id: 'other-profile', at: 1, command: { type: 'profile.create', name: 'Other' } })
      const work = { kind: 'claude', name: 'Work', binaryPath: './bin/claude', home: './work-account' } as const
      expect(addSavedProvider(databasePath, profileId, work)).toBe(1)
      expect(addSavedProvider(databasePath, profileId, work)).toBe(1)
      expect(() => addSavedProvider(databasePath, profileId, { ...work, home: './different' })).toThrow('already has different launch settings')
      expect(() => addSavedProvider(databasePath, otherProfileId + 1, work)).toThrow('No Harness profile')
      expect(addSavedProvider(databasePath, profileId, { kind: 'claude', name: 'Personal', binaryPath: '/fixture/personal/claude', home: '/fixture/personal/account' })).toBe(2)
      expect(addSavedProvider(databasePath, otherProfileId, { kind: 'claude', name: 'Other' })).toBe(3)
      expect(addSavedProvider(databasePath, profileId, { kind: 'codex', name: 'Codex' })).toBe(4)
      expect(removeSavedProvider(databasePath, otherProfileId, 2)).toBe(false)
      await harness.engine.dispatch({ id: 'configured-workspace', at: 2, command: { type: 'workspace.add', profileId, path: dir } })
      const catalog = (includeModels = false) => fetch(`http://127.0.0.1:${port}/drivers?workspace=${workspaceId}${includeModels ? '&models=1' : ''}`)
        .then(response => response.json())
      expect(await catalog(true)).toMatchObject({ accounts: [] })
      await harness.engine.dispatch({ id: 'trust-configured-workspace', at: 3, command: { type: 'workspace.trust', workspaceId, trusted: true } })
      const profileCatalog = await catalog()
      expect(profileCatalog.accounts).toEqual([
        { id: 1, kind: 'claude', name: 'Work', status: 'ready' },
        { id: 2, kind: 'claude', name: 'Personal', status: 'ready' },
        { id: 4, kind: 'codex', name: 'Codex', status: 'ready' },
      ])
      expect(JSON.stringify(profileCatalog)).not.toContain('/fixture/')
      expect(probed).toContainEqual({ workspacePath: dir, binaryPath: join(dir, 'bin/claude'), home: join(dir, 'work-account') })
      const withModels = await catalog(true)
      expect(withModels.accounts.map((account: { id: number, models?: Array<{ id: string }> }) => [account.id, account.models?.map(model => model.id)]))
        .toEqual([[1, ['fixture-work']], [2, undefined], [4, undefined]])
      expect(JSON.stringify(withModels)).not.toContain('/fixture/')
      const favorite = { driverKind: 'claude', providerInstanceId: 1, model: 'fixture-work' }
      const favoriteCommand = { type: 'profile.model-favorite.set', profileId, favorite, selected: true }
      client.send({ t: 'dispatch', envelope: { id: 'save-work-favorite', at: 4, command: favoriteCommand } })
      expect(await client.waitFor('profile.model-favorite.changed')).toMatchObject({ profileId, favorite, selected: true })
      expect((await catalog(true)).favorites).toEqual([favorite])
      client.send({ t: 'dispatch', envelope: { id: 'other-profile-favorite', at: 4, command: { ...favoriteCommand, profileId: otherProfileId } } })
      expect(await client.waitForRejection('other-profile-favorite')).toMatchObject({ message: expect.stringContaining('unavailable in the selected profile') })
      probed.length = 0
      for (const id of [3, 4, 99]) {
        await expect(harness.engine.dispatch({
          id: `invalid-account-${id}`,
          at: 4,
          command: { type: 'session.create', workspaceId, driverKind: 'claude', providerInstanceId: id },
        })).rejects.toThrow('unavailable for this project')
      }
      expect(harness.engine.current.sessions.size).toBe(0)

      const id = 'use-personal-account'
      const sessionId = derivedId(id)
      const creation = await harness.engine.dispatch({
        id,
        at: 5,
        command: { type: 'session.create', workspaceId, driverKind: 'claude', providerInstanceId: 2, model: 'fixture-model' },
      })
      expect(creation.events[0]?.payload).toMatchObject({ providerInstanceId: 2 })
      expect(harness.engine.current.sessions.get(sessionId)?.providerInstanceId).toBe(2)

      client.send({ t: 'subscribe', sessionId })
      client.send({ t: 'dispatch', envelope: {
        id: 'configured-turn', at: 6, command: { type: 'session.turn.start', sessionId, text: 'hello' },
      } })
      expect(await client.waitFor('turn.completed')).toBeTruthy()
      const expected = { workspacePath: dir, binaryPath: '/fixture/personal/claude', home: '/fixture/personal/account', model: 'fixture-model' }
      expect(probed).toMatchObject([expected])
      expect(launched).toMatchObject([expected])
      expect(JSON.stringify(creation.events)).not.toContain('/fixture/personal')

      expect(removeSavedProvider(databasePath, profileId, 2)).toBe(true)
      client.send({ t: 'dispatch', envelope: {
        id: 'removed-account-turn', at: 7, command: { type: 'session.turn.start', sessionId, text: 'another turn' },
      } })
      expect(await client.waitFor('session.failed')).toMatchObject({
        message: expect.stringContaining('account is no longer available'),
      })
      expect(launched).toHaveLength(1)
    }
    finally {
      client.close()
    }
  })

  it('runs the selected ChatGPT plan on the host and excludes it from paired clients', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const credentialsPath = join(dir, 'credentials')
    using db = new Database(databasePath)
    db.exec(`
      CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE provider_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id INTEGER NOT NULL REFERENCES profiles(id), driver_kind TEXT,
        binary_path TEXT, resolved_home TEXT, config TEXT, status TEXT
      );
    `)
    const clientId = 'oaiapp_managed_fixture'
    const token = 'fixture-managed-access-token'
    const store = new ChatGptCredentialStore(credentialsPath, {
      fetch: Object.assign(async () => Response.json({}), { preconnect() {} }),
    })
    await store.saveSession({
      clientId,
      subject: 'fixture-managed-account',
      accessToken: token,
      refreshToken: 'fixture-managed-refresh',
      idToken: 'fixture-managed-id-token',
      scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      expiresAt: Date.now() + 3_600_000,
    })

    const launched: DriverConfig[] = []
    const { driver } = fakeDriver([
      { type: 'session-bound', providerSessionId: 'host-only-native' },
      { type: 'assistant-delta', text: 'Host-only account response.' },
      { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 },
    ])
    harness = await serve({
      port, databasePath, remote: true, localTokenPath: join(dir, 'host-token'), chatGptCredentialDirectory: credentialsPath,
      resolveDriver: kind => ({
        ...driver,
        kind,
        async probe(config) {
          const connected = await config.chatGptPlan?.connected()
          return { status: connected === false ? 'unauthenticated' : 'ready' }
        },
        create(config) {
          launched.push(config)
          return driver.create(config)
        },
      }),
    })
    const access = harness.access!
    const { code } = access.openPairing()
    const paired = await access.redeem(code, 'Test Device')
    if (!paired.ok) throw new Error('Fixture device pairing failed')
    const host = await Client.connect(`ws://127.0.0.1:${port}/ws`, access.localToken)
    const device = await Client.connect(`ws://127.0.0.1:${port}/ws`, paired.token)
    const crossSite = await Client.connect(`ws://127.0.0.1:${port}/ws`, access.localToken, 'https://outside.example')
    try {
      const key = 'managed-project'
      const workspaceId = derivedId(key)
      await harness.engine.dispatch({ id: key, at: 1, command: { type: 'workspace.register', path: dir, trusted: true } })
      const accountId = addSavedProvider(databasePath, workspaceId, { kind: 'codex', name: 'Fixture plan', chatGptClientId: clientId })
      const pick = { type: 'session.create', workspaceId, driverKind: 'codex', providerInstanceId: accountId } as const
      const catalog = (token: string, includeModels = false) => fetch(`http://127.0.0.1:${port}/drivers?workspace=${workspaceId}${includeModels ? '&models=1' : ''}`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(res => res.json())
      const listed = await catalog(access.localToken)
      expect(listed.accounts).toEqual([{ id: accountId, kind: 'codex', name: 'Fixture plan', status: 'ready', auth: 'chatgpt' }])
      expect(JSON.stringify(listed)).not.toContain(clientId)
      expect((await catalog(paired.token)).accounts).toEqual([])
      const favorite = { driverKind: 'codex', providerInstanceId: accountId, model: 'fixture-plan-model' }
      const favoriteCommand = { type: 'profile.model-favorite.set', profileId: workspaceId, favorite, selected: true }
      device.send({ t: 'dispatch', envelope: { id: 'device-save-favorite', at: 2, command: favoriteCommand } })
      expect(await device.waitForRejection('device-save-favorite')).toMatchObject({ message: expect.stringContaining('only on the Harness host') })
      host.send({ t: 'dispatch', envelope: { id: 'host-save-favorite', at: 2, command: favoriteCommand } })
      expect(await host.waitFor('profile.model-favorite.changed')).toMatchObject({ favorite })
      expect((await catalog(access.localToken, true)).favorites).toEqual([favorite])
      expect((await catalog(paired.token, true)).favorites).toEqual([])

      device.send({ t: 'dispatch', envelope: { id: 'device-create', at: 2, command: pick } })
      expect(await device.waitForRejection('device-create')).toMatchObject({ message: expect.stringContaining('only on the Harness host') })
      crossSite.send({ t: 'dispatch', envelope: { id: 'cross-site-create', at: 2, command: pick } })
      expect(await crossSite.waitForRejection('cross-site-create')).toMatchObject({ message: expect.stringContaining('only on the Harness host') })
      const creation = await harness.engine.dispatch({ id: 'host-create', at: 3, command: pick })
      const sessionId = derivedId('host-create')
      const command = { type: 'session.turn.start', sessionId, text: 'fixture prompt' }
      device.send({ t: 'dispatch', envelope: { id: 'device-turn', at: 4, command } })
      expect(await device.waitForRejection('device-turn')).toMatchObject({ message: expect.stringContaining('only on the Harness host') })
      expect(launched).toHaveLength(0)

      host.send({ t: 'subscribe', sessionId })
      host.send({ t: 'dispatch', envelope: { id: 'host-turn', at: 5, command } })
      expect(await host.waitFor('turn.completed')).toBeTruthy()
      expect(launched).toHaveLength(1)
      expect(await launched[0]?.chatGptPlan?.accessToken()).toBe(token)
      expect(launched[0]?.home).toStartWith(credentialsPath)
      const persisted = JSON.stringify([creation, db.query('SELECT payload FROM events').all(), db.query('SELECT config FROM provider_instances').all()])
      expect(persisted).not.toContain(token)
      expect(persisted).not.toContain('fixture-managed-refresh')
      expect(persisted).not.toContain('fixture-managed-account')

      await store.signOut(clientId)
      expect((await catalog(access.localToken)).accounts[0].status).toBe('unauthenticated')
      host.send({ t: 'dispatch', envelope: { id: 'host-after-disconnect', at: 6, command } })
      expect(await host.waitFor('session.failed')).toMatchObject({ message: expect.stringContaining('Reconnect the selected ChatGPT plan') })
      expect(launched).toHaveLength(1)

      await harness.engine.dispatch({ id: 'leave-managed-provider', at: 7, command: {
        type: 'session.handoff', sessionId, afterTurnId: 2, driverKind: 'claude', text: 'Continue elsewhere',
      } })
      const historicalFork = { type: 'session.fork', sessionId, turnId: 1 }
      device.send({ t: 'dispatch', envelope: { id: 'device-historical-fork', at: 8, command: historicalFork } })
      expect(await device.waitForRejection('device-historical-fork')).toMatchObject({ message: expect.stringContaining('only on the Harness host') })
      expect(harness.engine.current.sessions.has(derivedId('device-historical-fork'))).toBe(false)
      expect(removeSavedProvider(databasePath, workspaceId, accountId)).toBe(true)
      host.send({ t: 'dispatch', envelope: { id: 'portable-account-fork', at: 9, command: historicalFork } })
      expect(await host.waitForDispatch('portable-account-fork')).toMatchObject({ t: 'dispatched' })
      expect(harness.engine.current.sessions.get(derivedId('portable-account-fork'))).toMatchObject({
        driverKind: 'claude', providerSessionId: '', handoff: { pending: true, afterTurnId: 1 },
      })
      expect(launched).toHaveLength(1)
    }
    finally {
      host.close()
      device.close()
      crossSite.close()
    }
  })

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

describe('a session can have a checkout of its own', () => {
  function repoWorkspace2(): string {
    const path = join(dir, 'repo')
    mkdirSync(path)
    const run = (...args: string[]) => spawnSync('git', args, { cwd: path })
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    writeFileSync(join(path, 'app.txt'), 'original\n')
    run('add', '.')
    run('commit', '-qm', 'first')
    return path
  }

  it('runs the agent in a worktree and leaves the workspace alone', async () => {
    // What isolation buys: the agent edits its own checkout, so a second
    // session — or the person at the keyboard — is not working in the same
    // files.
    const workspace = repoWorkspace2()
    let ranIn = ''

    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create(config) {
        ranIn = config.workspacePath
        return {
          async *startTurn() {
            writeFileSync(join(ranIn, 'app.txt'), 'agent edited this\n')
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async interrupt() {}, async respondApproval() {}, async stop() {},
        }
      },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrapIsolated(client, workspace)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'edit' } } })
    await client.waitFor('turn.completed')

    const session = harness.engine.current.sessions.get(sessionId)!
    expect(session.branch).toBe(`harness/session-${sessionId}`)
    expect(session.worktreePath).toBeTruthy()

    // The agent ran in the worktree, not the workspace.
    expect(ranIn).toBe(session.worktreePath)
    expect(readFileSync(join(session.worktreePath, 'app.txt'), 'utf8')).toBe('agent edited this\n')
    expect(readFileSync(join(workspace, 'app.txt'), 'utf8')).toBe('original\n')
    client.close()
  }, 30_000)

  it('runs in the workspace when not asked to isolate', async () => {
    // Unchanged behaviour for every existing session.
    const workspace = repoWorkspace2()
    let ranIn = ''
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create(config) {
        ranIn = config.workspacePath
        return { async *startTurn() { yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 } }, async interrupt() {}, async respondApproval() {}, async stop() {} }
      },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client, workspace)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'x' } } })
    await client.waitFor('turn.completed')

    expect(ranIn).toBe(workspace)
    expect(harness.engine.current.sessions.get(sessionId)!.worktreePath).toBe('')
    client.close()
  }, 30_000)

  it('still runs when the workspace is not a repository', async () => {
    // `--isolate` on a plain directory must not be a footgun: there is nothing
    // to branch from, and the turn should simply run where it is.
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrapIsolated(client, dir)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'x' } } })

    expect(await client.waitFor('turn.completed')).toBeTruthy()
    expect(harness.engine.current.sessions.get(sessionId)!.worktreePath).toBe('')
    client.close()
  }, 30_000)

  it('reuses the same worktree across turns', async () => {
    // A second checkout per turn would be absurd, and the branch would fork.
    const workspace = repoWorkspace2()
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })

    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrapIsolated(client, workspace)
    client.send({ t: 'dispatch', envelope: { id: 'c_t1', at: 5, command: { type: 'session.turn.start', sessionId, text: 'one' } } })
    await client.waitFor('turn.completed')
    const first = harness.engine.current.sessions.get(sessionId)!.worktreePath

    client.send({ t: 'dispatch', envelope: { id: 'c_t2', at: 6, command: { type: 'session.turn.start', sessionId, text: 'two' } } })
    await new Promise(r => setTimeout(r, 500))

    expect(harness.engine.current.sessions.get(sessionId)!.worktreePath).toBe(first)
    expect(client.payloads('session.isolated')).toHaveLength(1)
    client.close()
  }, 30_000)
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
  }, 15_000)

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

describe('queued follow-up delivery', () => {
  it('shares an editable order across clients and delivers each entry once after completion', async () => {
    const gate = Promise.withResolvers<void>()
    const delivered: string[] = []
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn({ text }) {
            delivered.push(text)
            if (text === 'First turn') {
              yield { type: 'assistant-delta', text: 'Waiting' }
              await gate.promise
            }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async respondApproval() {},
          async interrupt() { gate.resolve() },
          async stop() { gate.resolve() },
        }
      },
    }
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const url = `ws://127.0.0.1:${port}/ws`
    const first = await Client.connect(url)
    const second = await Client.connect(url)
    const { sessionId } = await bootstrap(first)
    second.send({ t: 'subscribe', sessionId })
    const dispatch = (client: Client, id: string, command: Record<string, unknown>) => {
      client.send({ t: 'dispatch', envelope: { id, at: Date.now(), command: { ...command, sessionId } } })
    }

    try {
      dispatch(first, 'first-turn', { type: 'session.turn.start', text: 'First turn' })
      expect(await first.waitFor('assistant.delta')).toMatchObject({ text: 'Waiting' })

      for (const [id, text] of [['one', 'First follow-up'], ['two', 'Second follow-up'], ['three', 'Remove me']]) {
        dispatch(first, id!, { type: 'session.queue.add', text })
        expect(await first.waitForDispatch(id!)).toMatchObject({ replayed: false })
      }
      dispatch(second, 'one', { type: 'session.queue.add', text: 'Duplicate retry' })
      expect(await second.waitForDispatch('one')).toMatchObject({ replayed: true })
      dispatch(second, 'move-two', { type: 'session.queue.move', id: 'two', direction: 'up' })
      dispatch(second, 'edit-two', { type: 'session.queue.edit', id: 'two', text: 'Edited follow-up', previousText: 'Second follow-up' })
      dispatch(second, 'remove-three', { type: 'session.queue.remove', id: 'three' })
      expect(await first.waitFor('queue.removed')).toMatchObject({ id: 'three' })
      dispatch(first, 'old-edit', { type: 'session.queue.edit', id: 'two', text: 'Overwritten', previousText: 'Second follow-up' })
      expect(await first.waitForRejection('old-edit')).toMatchObject({ message: expect.stringContaining('edited on another device') })
      dispatch(first, 'forged-advance', { type: 'thread.queue.advance' })
      expect(await first.waitForRejection('forged-advance')).toBeTruthy()
      expect(harness.engine.current.sessions.get(sessionId)?.followUps.entries.map(entry => entry.id)).toEqual(['two', 'one'])
      expect(delivered).toEqual(['First turn'])

      gate.resolve()
      expect(await second.waitFor('turn.completed', 5000, event => event.turnId === 3)).toBeTruthy()
      expect(delivered).toEqual(['First turn', 'Edited follow-up', 'First follow-up'])
      expect(second.payloads('turn.started').map(event => event.queuedId)).toEqual([undefined, 'two', 'one'])
      expect(harness.engine.current.sessions.get(sessionId)?.followUps.entries).toEqual([])
    }
    finally {
      gate.resolve()
      first.close()
      second.close()
    }
  })

  it('steers once across clients and holds ambiguous delivery across a host restart', async () => {
    const databasePath = join(dir, 'test.sqlite')
    const activeTurn = Promise.withResolvers<void>()
    const firstSteer = Promise.withResolvers<'delivered'>()
    const droppedSteer = Promise.withResolvers<'uncertain'>()
    const steeringCalls: string[] = []
    const started: string[] = []
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn({ text }) {
            started.push(text)
            if (text === 'Active turn') {
              yield { type: 'steering-ready' }
              await activeTurn.promise
            }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async steer(text) {
            steeringCalls.push(text)
            return text === 'Queued update' ? firstSteer.promise : droppedSteer.promise
          },
          async respondApproval() {},
          async interrupt() { activeTurn.resolve() },
          async stop() { activeTurn.resolve() },
        }
      },
    }
    const options = { port, databasePath, resolveDriver: () => driver }
    harness = await serve(options)
    const url = `ws://127.0.0.1:${port}/ws`
    const first = await Client.connect(url)
    const second = await Client.connect(url)
    const { sessionId } = await bootstrap(first)
    second.send({ t: 'subscribe', sessionId })
    const dispatch = (client: Client, id: string, command: Record<string, unknown>) => {
      client.send({ t: 'dispatch', envelope: { id, at: Date.now(), command: { ...command, sessionId } } })
    }
    try {
      dispatch(first, 'first-turn', { type: 'session.turn.start', text: 'Active turn' })
      expect(await first.waitFor('turn.steering-ready')).toMatchObject({ turnId: 1 })
      dispatch(first, 'queued', { type: 'session.queue.add', text: 'Queued update' })
      expect(await first.waitForDispatch('queued')).toMatchObject({ t: 'dispatched' })
      const steer = { type: 'session.turn.steer', id: 'queued', turnId: 1 }
      dispatch(first, 'steer-first', steer)
      expect(await second.waitFor('turn.steer.requested')).toMatchObject({ turnId: 1, id: 'queued' })
      dispatch(second, 'steer-first', steer)
      expect(await second.waitForDispatch('steer-first')).toMatchObject({ replayed: true })
      dispatch(second, 'steer-again', steer)
      expect(await second.waitForRejection('steer-again')).toBeTruthy()
      expect(steeringCalls).toEqual(['Queued update'])
      firstSteer.resolve('delivered')
      expect(await first.waitFor('turn.steer.resolved')).toMatchObject({ id: 'queued', outcome: 'delivered' })
      expect(harness.engine.current.sessions.get(sessionId)?.turns).toMatchObject([{
        id: 1, steered: [{ id: 'queued', text: 'Queued update' }],
      }])
      dispatch(first, 'ambiguous', { type: 'session.turn.steer', turnId: 1, text: 'Unconfirmed update' })
      expect(await second.waitFor('turn.steer.requested', 3000, event => event.id === 'ambiguous')).toBeTruthy()
      expect(steeringCalls).toEqual(['Queued update', 'Unconfirmed update'])
      expect(started).toEqual(['Active turn'])
    }
    finally {
      firstSteer.resolve('delivered')
      first.close()
      second.close()
      harness.stop()
      droppedSteer.resolve('uncertain')
    }

    harness = await serve(options)
    const restored = await Client.connect(url)
    try {
      restored.send({ t: 'subscribe', sessionId })
      expect(await restored.waitFor('turn.steer.resolved', 3000, event => event.id === 'ambiguous')).toMatchObject({ turnId: 1, outcome: 'uncertain' })
      expect(harness.engine.current.sessions.get(sessionId)?.followUps).toEqual({
        held: true, entries: [{ id: 'ambiguous', text: 'Unconfirmed update', steeringIssue: 'uncertain' }],
      })
      dispatch(restored, 'resume', { type: 'session.queue.send' })
      expect(await restored.waitForRejection('resume')).toBeTruthy()
      expect(started).toEqual(['Active turn'])
      dispatch(restored, 'confirm', { type: 'session.queue.send', id: 'ambiguous', confirmResend: true })
      expect(await restored.waitFor('turn.completed', 3000, event => event.turnId === 2)).toBeTruthy()
      expect(started).toEqual(['Active turn', 'Unconfirmed update'])
      expect(steeringCalls).toEqual(['Queued update', 'Unconfirmed update'])
    }
    finally {
      restored.close()
    }
  })

  it('holds an interrupted queue across restart and rejects a competing send of the same entry', async () => {
    const path = join(dir, 'test.sqlite')
    const gate = Promise.withResolvers<void>()
    const delivered: string[] = []
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn({ text }) {
            delivered.push(text)
            if (text === 'Interrupt me') {
              yield { type: 'assistant-delta', text: 'Working' }
              await gate.promise
            }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async respondApproval() {},
          async interrupt() { gate.resolve() },
          async stop() { gate.resolve() },
        }
      },
    }

    harness = await serve({ port, databasePath: path, resolveDriver: () => driver })
    const url = `ws://127.0.0.1:${port}/ws`
    const original = await Client.connect(url)
    const { sessionId } = await bootstrap(original)
    const dispatch = (client: Client, id: string, command: Record<string, unknown>) => {
      client.send({ t: 'dispatch', envelope: { id, at: Date.now(), command: { ...command, sessionId } } })
    }
    dispatch(original, 'interrupted-turn', { type: 'session.turn.start', text: 'Interrupt me' })
    expect(await original.waitFor('assistant.delta')).toBeTruthy()
    dispatch(original, 'held-entry', { type: 'session.queue.add', text: 'Resume once' })
    expect(await original.waitFor('queue.added')).toBeTruthy()
    original.close()
    harness.stop()

    harness = await serve({ port, databasePath: path, resolveDriver: () => driver })
    const first = await Client.connect(url)
    const second = await Client.connect(url)
    try {
      first.send({ t: 'subscribe', sessionId })
      second.send({ t: 'subscribe', sessionId })
      expect(await second.waitFor('turn.interrupted')).toMatchObject({ turnId: 1 })
      expect(harness.engine.current.sessions.get(sessionId)?.followUps).toEqual({
        held: true, entries: [{ id: 'held-entry', text: 'Resume once' }],
      })
      expect(delivered).toEqual(['Interrupt me'])
      const send = { type: 'session.queue.send', id: 'held-entry' }
      dispatch(first, 'send-first', send)
      dispatch(second, 'send-second', send)
      expect(await first.waitFor('turn.completed', 5000, event => event.turnId === 2)).toBeTruthy()
      expect(delivered).toEqual(['Interrupt me', 'Resume once'])
      expect(harness.engine.current.sessions.get(sessionId)?.followUps).toEqual({ held: false, entries: [] })
      const outcomes = await Promise.all([
        first.waitForDispatch('send-first'),
        second.waitForDispatch('send-second'),
      ])
      expect(outcomes.map(frame => frame?.t).sort()).toEqual(['dispatched', 'rejected'])
    }
    finally {
      first.close()
      second.close()
    }
  })
})

describe('thread wake scheduling', () => {
  it('replays a snooze and wakes it once after a host restart', async () => {
    const options = { port, databasePath: join(dir, 'test.sqlite') }
    harness = await serve(options)
    const endpoint = `ws://127.0.0.1:${port}/ws`
    const first = await Client.connect(endpoint)
    const { sessionId } = await bootstrap(first)
    const until = Date.now() + 800
    first.send({
      t: 'dispatch',
      envelope: { id: 'restart-snooze', at: 1, command: { type: 'session.organize', sessionId, action: 'snooze', until } },
    })
    expect(await first.waitForDispatch('restart-snooze')).toMatchObject({ t: 'dispatched', replayed: false })
    first.close()
    harness.stop()

    harness = await serve(options)
    const second = await Client.connect(endpoint)
    second.send({ t: 'subscribe', sessionId })
    expect(await second.waitFor('session.navigation-changed', 3000, payload => payload.changes.snoozedUntil === until)).toBeTruthy()
    expect(await second.waitFor('session.navigation-changed', 3000, payload => payload.changes.snoozedUntil === null)).toBeTruthy()
    expect(second.payloads('session.navigation-changed')).toHaveLength(2)
    expect(harness.engine.current.sessions.get(sessionId)?.navigation?.snoozedUntil).toBeNull()
    expect(harness.engine.current.sessions.get(sessionId)?.turns).toHaveLength(0)
    second.close()
  })
})

describe('host settings belong to the host', () => {
  it('reaches a second client and survives a restart, and a second host keeps its own', async () => {
    const database = join(dir, 'test.sqlite')
    const { driver } = fakeDriver([])
    harness = await serve({ port, databasePath: database, resolveDriver: () => driver })

    const first = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    first.send({ t: 'dispatch', envelope: { id: 'c_set', at: 1, command: { type: 'settings.update', changes: { defaultDriver: 'codex', followUpBehavior: 'steer', terminalShell: 'den' } } } })
    expect((await first.waitForDispatch('c_set'))?.t).toBe('dispatched')
    expect(harness.engine.current.settings).toEqual({ defaultDriver: 'codex', followUpBehavior: 'steer', terminalShell: 'den', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })

    // The page a second client is served carries the same answer. This is the
    // difference from a browser-stored preference: the phone and the laptop
    // pointed at one host no longer disagree.
    //
    // The template resolves from cwd and the resolution is memoized for the
    // process, so this renders from the repo root the way the render-cache
    // test does. Fetching `/` from the package directory would not merely
    // fail here, it would pin "no view" for every later test in the file set.
    const previousCwd = process.cwd()
    process.chdir(join(import.meta.dir, '../../..'))
    let page: string
    try {
      page = await fetch(`http://127.0.0.1:${port}/`).then(response => response.text())
    }
    finally {
      process.chdir(previousCwd)
    }
    expect(page).toMatch(/defaultDriver\\?["']\s*:\s*\\?["']codex/)
    expect(page).toMatch(/terminalShell\\?["']\s*:\s*\\?["']den/)
    first.close()
    harness.stop()

    // The setting is in the log, so a fresh process over the same database
    // still has it.
    harness = await serve({ port, databasePath: database, resolveDriver: () => driver })
    expect(harness.engine.current.settings).toEqual({ defaultDriver: 'codex', followUpBehavior: 'steer', terminalShell: 'den', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })
    harness.stop()

    // A different host, which is a different log: independent by construction
    // rather than by a rule someone has to remember.
    const otherDatabase = join(dir, 'other.sqlite')
    prepareDatabase(otherDatabase)
    harness = await serve({ port: ++portCounter, databasePath: otherDatabase, resolveDriver: () => driver })
    expect(harness.engine.current.settings).toEqual({ defaultDriver: 'claude', followUpBehavior: 'queue', terminalShell: 'system', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })
  })

  it('rejects a settings command that carries nothing this host accepts', async () => {
    const { driver } = fakeDriver([])
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)

    client.send({ t: 'dispatch', envelope: { id: 'c_bad', at: 1, command: { type: 'settings.update', changes: { defaultDriver: 'emacs' } } } })
    const receipt: any = await client.waitForDispatch('c_bad')
    expect(receipt?.t).toBe('rejected')
    // Recovery is the default, not a stored value no build understands.
    expect(harness.engine.current.settings.defaultDriver).toBe('claude')
    client.close()
  })
})

describe('a restart does not strand a turn', () => {
  it('interrupts a turn that was running when the process stopped', async () => {
    // A turn only runs because a provider instance is running it, and those die
    // with the process. Replay faithfully restores the session as `running`,
    // which is what the log says — but nothing is going to finish it. Left
    // alone the session refuses a new turn ("a turn is already running") and
    // refuses a revert, so the only recovery was for a person to press stop.
    const database = join(dir, 'test.sqlite')

    // A driver that parks forever, standing in for a process that then dies.
    const wedged: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn() {
            yield { type: 'approval-request', requestId: 'apr_1', toolName: 'Write', args: {} }
            await new Promise(() => {})
          },
          async interrupt() {},
          async respondApproval() {},
          async stop() {},
        }
      },
    }

    harness = await serve({ port, databasePath: database, resolveDriver: () => wedged })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('approval.requested')

    // Stranded, exactly as it would be after a crash.
    expect(harness.engine.current.sessions.get(sessionId)!.state).toBe('awaiting-approval')
    client.close()
    harness.stop()

    // A fresh process over the same log.
    port = ++portCounter
    harness = await serve({ port, databasePath: database, resolveDriver: () => wedged })

    const session = harness.engine.current.sessions.get(sessionId)!
    expect(session.state).toBe('idle')
    expect(session.turns.at(-1)!.status).toBe('interrupted')
    // And nothing is still waiting on a decision that can never be answered.
    expect(session.pendingApprovals).toEqual([])
  })

  it('leaves a session that was already idle alone', async () => {
    const database = join(dir, 'test.sqlite')
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])

    harness = await serve({ port, databasePath: database, resolveDriver: () => driver })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'hi' } } })
    await client.waitFor('turn.completed')
    client.close()
    harness.stop()

    port = ++portCounter
    harness = await serve({ port, databasePath: database, resolveDriver: () => driver })

    // A completed turn must not be rewritten as interrupted on every boot.
    const session = harness.engine.current.sessions.get(sessionId)!
    expect(session.turns.at(-1)!.status).toBe('complete')
    expect(session.state).toBe('idle')
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

  it('replays an outstanding approval to replacement clients and accepts one decision', async () => {
    const gate = Promise.withResolvers<void>()
    const { driver, approvals } = fakeDriver([
      { type: 'approval-request', requestId: 'req_race', toolName: 'Read', args: {} },
      { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 },
    ], { gate: gate.promise })
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), resolveDriver: () => driver })
    const url = `ws://127.0.0.1:${port}/ws`
    const starter = await Client.connect(url)
    const { sessionId } = await bootstrap(starter)
    starter.send({ t: 'dispatch', envelope: { id: 'c_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'start' } } })
    const { approvalId } = await starter.waitFor('approval.requested')
    starter.close()

    const [first, second] = await Promise.all([Client.connect(url), Client.connect(url)])
    try {
      first.send({ t: 'subscribe', sessionId })
      second.send({ t: 'subscribe', sessionId })
      for (const client of [first, second]) {
        expect(await client.waitFor('approval.requested')).toMatchObject({ approvalId })
      }
      first.send({ t: 'dispatch', envelope: { id: 'c_extra', at: 6, command: { type: 'session.turn.start', sessionId, text: 'extra' } } })
      expect(await first.waitForRejection('c_extra')).toMatchObject({ message: 'a turn is already running' })

      const command = { type: 'session.approval.respond', sessionId, approvalId, scope: 'once' }
      first.send({ t: 'dispatch', envelope: { id: 'c_allow', at: 7, command: { ...command, decision: 'allowed' } } })
      second.send({ t: 'dispatch', envelope: { id: 'c_deny', at: 7, command: { ...command, decision: 'denied' } } })
      const settled = await first.waitFor('approval.resolved')
      const allowed = settled.decision === 'allowed'
      expect(await (allowed ? second : first).waitForRejection(allowed ? 'c_deny' : 'c_allow'))
        .toMatchObject({ message: 'This approval is no longer pending.' })
      expect(await second.waitFor('approval.resolved')).toEqual(settled)

      gate.resolve()
      expect(await first.waitFor('turn.completed')).toBeTruthy()
      expect(await second.waitFor('turn.completed')).toBeTruthy()
      expect(approvals).toEqual([{ requestId: 'req_race', allow: allowed }])
      expect(first.payloads('approval.resolved')).toHaveLength(1)
      expect(second.payloads('approval.resolved')).toHaveLength(1)
      expect(harness.engine.current.sessions.get(sessionId)?.state).toBe('idle')
    }
    finally {
      gate.resolve()
      first.close()
      second.close()
    }
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

describe('connector consent over the socket', () => {
  it('rejects forged scopes, commits one choice, and clears a provider withdrawal', async () => {
    const decided = Promise.withResolvers<void>()
    const withdraw = Promise.withResolvers<void>()
    const replies: unknown[] = []
    const connector = {
      prompt: 'Allow the fixture connector to read the calendar?',
      choices: [
        { decision: 'cancelled', scope: 'once', label: 'Cancel' },
        { decision: 'denied', scope: 'once', label: 'Decline' },
        { decision: 'allowed', scope: 'session', label: 'Allow this session' },
        { decision: 'allowed', scope: 'once', label: 'Approve' },
      ],
    } satisfies NonNullable<Extract<ProviderEvent, { type: 'approval-request' }>['connector']>
    const driver: Driver = {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn() {
            yield { type: 'approval-request', requestId: 'consent', toolName: 'Fixture Calendar', args: { token: 'private fixture token' }, connector }
            await decided.promise
            yield { type: 'approval-request', requestId: 'withdrawn', toolName: 'Fixture Calendar', args: {}, connector }
            await withdraw.promise
            yield { type: 'approval-cancelled', requestId: 'withdrawn' }
            yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          },
          async respondApproval(requestId, allow, _reason, choice) {
            replies.push({ requestId, allow, choice })
            decided.resolve()
          },
          async interrupt() { decided.resolve(); withdraw.resolve() },
          async stop() { decided.resolve(); withdraw.resolve() },
        }
      },
    }
    const dbPath = join(dir, 'test.sqlite')
    harness = await serve({ port, databasePath: dbPath, resolveDriver: () => driver })
    const endpoint = `ws://127.0.0.1:${port}/ws`
    const first = await Client.connect(endpoint)
    const second = await Client.connect(endpoint)
    try {
      const { sessionId } = await bootstrap(first)
      second.send({ t: 'subscribe', sessionId })
      first.send({ t: 'dispatch', envelope: { id: 'consent_turn', at: 5, command: { type: 'session.turn.start', sessionId, text: 'request consent' } } })
      const request = await first.waitFor('approval.requested')
      expect(request).toMatchObject({ toolName: 'Fixture Calendar', connector })
      expect(JSON.stringify(request)).not.toContain('private fixture token')
      const base = { type: 'session.approval.respond', sessionId, approvalId: request.approvalId }
      first.send({ t: 'dispatch', envelope: { id: 'forged', at: 6, command: { ...base, decision: 'allowed', scope: 'always' } } })
      expect(await first.waitForRejection('forged')).toMatchObject({ message: 'This connector did not offer that approval choice.' })
      first.send({ t: 'dispatch', envelope: { id: 'selected', at: 7, command: { ...base, decision: 'allowed', scope: 'session' } } })
      second.send({ t: 'dispatch', envelope: { id: 'competing', at: 7, command: { ...base, decision: 'cancelled', scope: 'once' } } })
      const resolved = await first.waitFor('approval.resolved')
      const waiting = await first.waitFor('approval.requested', 3000, event => event.requestId === 'withdrawn')
      expect(replies).toEqual([{ requestId: 'consent', allow: resolved.decision === 'allowed', choice: { decision: resolved.decision, scope: resolved.scope } }])
      withdraw.resolve()
      const cancelled = await first.waitFor('approval.resolved', 3000, event => event.approvalId === waiting.approvalId)
      expect(cancelled).toMatchObject({ decision: 'cancelled', scope: 'once' })
      await first.waitFor('turn.completed')
      expect(harness.engine.current.sessions.get(sessionId)?.pendingApprovals).toEqual([])
      expect(replies).toHaveLength(1)
    }
    finally {
      first.close()
      second.close()
    }
  })
})

describe('structured input over the socket', () => {
  const questions: Extract<ProviderEvent, { type: 'input-request' }>['questions'] = [
    { id: 'private', kind: 'text', question: 'Private fixture answer', sensitive: true, options: [] },
    { id: 'choices', kind: 'multiple', question: 'Choose two', minSelections: 2, options: [
      { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' },
    ] },
    { id: 'support', kind: 'text', question: 'Supporting file', optional: true, options: [] },
  ]

  function inputDriver(onAnswer?: (answers: InputAnswer[] | null) => void): Driver {
    const gate = Promise.withResolvers<void>()
    return {
      kind: 'claude',
      async probe() { return { status: 'ready' } },
      async create() {
        return {
          async *startTurn() {
            yield { type: 'input-request', requestId: 'provider-question', questions }
            await gate.promise
            yield { type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 }
          },
          async interrupt() { gate.resolve() },
          async respondApproval() {},
          async respondInput(requestId, answers) {
            if (requestId !== 'provider-question') throw new Error('Incorrect provider request')
            onAnswer?.(answers)
            gate.resolve()
          },
          async stop() { gate.resolve() },
        }
      },
    }
  }

  it('replays questions and accepts one valid answer without storing its values', async () => {
    const callbacks: Array<InputAnswer[] | null> = []
    const dbPath = join(dir, 'test.sqlite')
    harness = await serve({ port, databasePath: dbPath, resolveDriver: () => inputDriver(answers => callbacks.push(answers)) })
    const url = `ws://127.0.0.1:${port}/ws`
    const first = await Client.connect(url)
    const { sessionId } = await bootstrap(first)
    first.send({ t: 'dispatch', envelope: { id: 'q_start', at: 5, command: { type: 'session.turn.start', sessionId, text: 'ask' } } })
    const requested = await first.waitFor('input.requested')
    expect(requested).toMatchObject({ questions })
    expect(harness.engine.current.sessions.get(sessionId)?.state).toBe('awaiting-input')
    const second = await Client.connect(url)
    try {
      second.send({ t: 'subscribe', sessionId })
      expect(await second.waitFor('input.requested')).toEqual(requested)
      const command = { type: 'session.input.respond', requestId: requested.requestId, sessionId }
      second.send({ t: 'dispatch', envelope: { id: 'q_invalid', at: 6, command: { ...command, answers: [] } } })
      expect(await second.waitForRejection('q_invalid')).toMatchObject({ message: 'Complete all required questions with valid answers.' })
      first.send({ t: 'dispatch', envelope: { id: 'q_extra', at: 6, command: { type: 'session.turn.start', sessionId, text: 'extra' } } })
      expect(await first.waitForRejection('q_extra')).toMatchObject({ message: 'a turn is already running' })

      const root = `http://127.0.0.1:${port}/s/${sessionId}/question-attachments`
      const query = new URLSearchParams({ request: requested.requestId, question: 'support', name: 'notes.txt' })
      expect((await fetch(`${root}?${query}`, { method: 'POST', body: 'upload', headers: { Origin: 'https://unrelated.test' } })).status).toBe(403)
      const upload = await fetch(`${root}?${query}`, { method: 'POST', body: 'synthetic attachment bytes' })
      expect(upload.status).toBe(201)
      const file = await upload.json() as { id: string, name: string }
      expect((await fetch(`${root}/${file.id}`)).status).toBe(404)
      const answerWithFile = { questionId: 'support', values: [], attachmentIds: [file.id] }
      const answers = [{ questionId: 'private', values: ['synthetic private marker A'] }, { questionId: 'choices', values: ['b', 'c'] }, answerWithFile]
      const competingAnswers = [{ questionId: 'private', values: ['synthetic private marker B'] }, { questionId: 'choices', values: ['a', 'b'] }, answerWithFile]
      first.send({ t: 'dispatch', envelope: { id: 'q_answer_a', at: 7, command: { ...command, answers } } })
      second.send({ t: 'dispatch', envelope: { id: 'q_answer_b', at: 7, command: { ...command, answers: competingAnswers } } })
      expect(await second.waitFor('input.resolved')).toMatchObject({ requestId: requested.requestId, outcome: 'answered', attachments: [{ id: file.id, name: 'notes.txt' }] })
      expect(await second.waitFor('turn.completed')).toBeTruthy()
      expect(callbacks).toHaveLength(1)
      const firstWon = callbacks[0]?.[0]?.values[0] === 'synthetic private marker A'
      expect(callbacks[0]?.slice(0, 2)).toEqual((firstWon ? answers : competingAnswers).slice(0, 2))
      const delivered = callbacks[0]?.[2]?.values[0]
      expect(delivered).toStartWith('Attached files:\n')
      expect(await Bun.file(JSON.parse(delivered!.split('\n')[1]!)).text()).toBe('synthetic attachment bytes')
      const download = await fetch(`${root}/${file.id}`)
      expect(download.status).toBe(200)
      expect(download.headers.get('content-type')).toBe('application/octet-stream')
      expect(await download.text()).toBe('synthetic attachment bytes')
      expect(await (firstWon ? second : first).waitForRejection(firstWon ? 'q_answer_b' : 'q_answer_a'))
        .toMatchObject({ message: 'This question is no longer pending.' })
      expect(second.payloads('input.resolved')).toHaveLength(1)
      expect(harness.engine.current.sessions.get(sessionId)?.pendingInputs).toEqual([])
      const db = new Database(dbPath, { readonly: true })
      try {
        const events = db.query('SELECT payload FROM events').all()
        expect(JSON.stringify(events)).not.toContain('synthetic private marker')
        expect(JSON.stringify(events)).not.toContain('synthetic attachment bytes')
      }
      finally { db.close() }
    }
    finally {
      first.close()
      second.close()
    }
  })

  it('marks an unanswered question interrupted when the host restarts', async () => {
    const dbPath = join(dir, 'test.sqlite')
    harness = await serve({ port, databasePath: dbPath, resolveDriver: () => inputDriver() })
    const client = await Client.connect(`ws://127.0.0.1:${port}/ws`)
    const { sessionId } = await bootstrap(client)
    client.send({ t: 'dispatch', envelope: { id: 'q_start', at: 5, command: { type: 'session.turn.start', sessionId, text: 'ask' } } })
    expect(await client.waitFor('input.requested')).toBeTruthy()
    client.close()
    harness.stop()
    port = ++portCounter
    harness = await serve({ port, databasePath: dbPath, resolveDriver: () => inputDriver() })
    const session = harness.engine.current.sessions.get(sessionId)
    expect(session?.state).toBe('idle')
    expect(session?.pendingInputs).toEqual([])
    expect(session?.turns.at(-1)?.inputRequests?.[0]?.outcome).toBe('interrupted')
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
