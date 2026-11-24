import type { InputAnswer } from '@harness/contract'
import type { Driver, DriverConfig, ProviderEvent, ProviderInstance } from '@harness/drivers'
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

  async waitFor(type: string, timeoutMs = 3000): Promise<any> {
    const frame = await this.waitForFrame(frame => frame?.t === 'event' && frame.event.payload.type === type, timeoutMs)
    return frame?.event.payload ?? null
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
        probe(config) {
          probed.push(config)
          return driver.probe(config)
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
      const catalog = () => fetch(`http://127.0.0.1:${port}/drivers?workspace=${workspaceId}`).then(response => response.json())
      expect(await catalog()).toMatchObject({ accounts: [] })
      await harness.engine.dispatch({ id: 'trust-configured-workspace', at: 3, command: { type: 'workspace.trust', workspaceId, trusted: true } })
      const profileCatalog = await catalog()
      expect(profileCatalog.accounts).toEqual([
        { id: 1, kind: 'claude', name: 'Work', status: 'ready' },
        { id: 2, kind: 'claude', name: 'Personal', status: 'ready' },
        { id: 4, kind: 'codex', name: 'Codex', status: 'ready' },
      ])
      expect(JSON.stringify(profileCatalog)).not.toContain('/fixture/')
      expect(probed).toContainEqual({ workspacePath: dir, binaryPath: join(dir, 'bin/claude'), home: join(dir, 'work-account') })
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
    const { driver } = fakeDriver([{ type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }])
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
      const catalog = (token: string) => fetch(`http://127.0.0.1:${port}/drivers?workspace=${workspaceId}`, {
        headers: { authorization: `Bearer ${token}` },
      }).then(res => res.json())
      const listed = await catalog(access.localToken)
      expect(listed.accounts).toEqual([{ id: accountId, kind: 'codex', name: 'Fixture plan', status: 'ready', auth: 'chatgpt' }])
      expect(JSON.stringify(listed)).not.toContain(clientId)
      expect((await catalog(paired.token)).accounts).toEqual([])

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

describe('structured input over the socket', () => {
  const questions: Extract<ProviderEvent, { type: 'input-request' }>['questions'] = [
    { id: 'private', kind: 'text', question: 'Private fixture answer', sensitive: true, options: [] },
    { id: 'choices', kind: 'multiple', question: 'Choose two', minSelections: 2, options: [
      { value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' },
    ] },
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

      const answers = [{ questionId: 'private', values: ['synthetic private marker A'] }, { questionId: 'choices', values: ['b', 'c'] }]
      const competingAnswers = [{ questionId: 'private', values: ['synthetic private marker B'] }, { questionId: 'choices', values: ['a', 'b'] }]
      first.send({ t: 'dispatch', envelope: { id: 'q_answer_a', at: 7, command: { ...command, answers } } })
      second.send({ t: 'dispatch', envelope: { id: 'q_answer_b', at: 7, command: { ...command, answers: competingAnswers } } })
      expect(await second.waitFor('input.resolved')).toMatchObject({ requestId: requested.requestId, outcome: 'answered' })
      expect(await second.waitFor('turn.completed')).toBeTruthy()
      expect(callbacks).toHaveLength(1)
      const firstWon = callbacks[0]?.[0]?.values[0] === 'synthetic private marker A'
      expect(callbacks[0]).toEqual(firstWon ? answers : competingAnswers)
      expect(await (firstWon ? second : first).waitForRejection(firstWon ? 'q_answer_b' : 'q_answer_a'))
        .toMatchObject({ message: 'This question is no longer pending.' })
      expect(second.payloads('input.resolved')).toHaveLength(1)
      expect(harness.engine.current.sessions.get(sessionId)?.pendingInputs).toEqual([])
      const db = new Database(dbPath, { readonly: true })
      try {
        const events = db.query('SELECT payload FROM events').all()
        expect(JSON.stringify(events)).not.toContain('synthetic private marker')
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
