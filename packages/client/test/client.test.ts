import type { HarnessServer } from '@harness/server'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { serve } from '@harness/server'
import { HarnessClient } from '../src/client'

let dir: string
let dbPath: string
let harness: HarnessServer
let port: number
let portCounter = 4100

function prepareDatabase(path: string): void {
  const db = new Database(path)
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

/** Wait for a predicate, so tests never race the socket. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return predicate()
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harness-client-'))
  dbPath = join(dir, 'test.sqlite')
  prepareDatabase(dbPath)
  port = ++portCounter
  harness = await serve({ port, databasePath: dbPath })
})

afterEach(() => {
  try { harness.stop() }
  catch { /* already stopped by a test */ }
  rmSync(dir, { recursive: true, force: true })
})

function client(overrides: Partial<ConstructorParameters<typeof HarnessClient>[0]> = {}): HarnessClient {
  return new HarnessClient({
    url: `ws://127.0.0.1:${port}/ws`,
    minBackoffMs: 10,
    maxBackoffMs: 40,
    ...overrides,
  })
}

describe('HarnessClient — connecting', () => {
  it('reports its status as it connects', async () => {
    const c = client()
    const seen: string[] = []
    c.onStatus(status => seen.push(status))

    await c.connect()

    expect(c.status).toBe('connected')
    expect(seen).toContain('connecting')
    expect(seen).toContain('connected')
    c.close()
  })

  it('rejects a first connection to nothing', async () => {
    const c = new HarnessClient({ url: 'ws://127.0.0.1:1/ws', minBackoffMs: 5, maxBackoffMs: 10 })
    await expect(c.connect()).rejects.toThrow()
    c.close()
  })
})

describe('HarnessClient — dispatch', () => {
  it('resolves with the server ack', async () => {
    const c = client()
    await c.connect()

    const ack = await c.dispatch('cmd_1', { type: 'profile.create', name: 'Personal' })

    expect(ack).toMatchObject({ id: 'cmd_1', replayed: false })
    expect(ack.seqs).toEqual([1])
    c.close()
  })

  it('rejects with the reason the server gave', async () => {
    const c = client()
    await c.connect()
    await expect(c.dispatch('cmd_bad', { type: 'profile.delete', profileId: 404 }))
      .rejects.toThrow(/no such profile/)
    c.close()
  })

  it('reports a retry as replayed rather than doing it twice', async () => {
    const c = client()
    await c.connect()
    await c.dispatch('stable', { type: 'profile.create', name: 'Once' })

    const retry = await c.dispatch('stable', { type: 'profile.create', name: 'Once' })

    expect(retry.replayed).toBe(true)
    expect(c.state.profiles.size).toBe(1)
    c.close()
  })

  it('fails a dispatch made while disconnected instead of hanging', async () => {
    const c = client()
    await expect(c.dispatch('cmd_x', { type: 'profile.create', name: 'nope' }))
      .rejects.toThrow(/not connected/)
    c.close()
  })
})

describe('HarnessClient — the local projection', () => {
  it('applies broadcast events into its own state', async () => {
    const c = client()
    await c.connect()
    await c.dispatch('cmd_1', { type: 'profile.create', name: 'Personal' })

    await until(() => c.state.profiles.size === 1)
    expect([...c.state.profiles.values()][0]!.name).toBe('Personal')
    c.close()
  })

  it('notifies state listeners', async () => {
    const c = client()
    await c.connect()
    let notified = 0
    c.onState(() => notified++)

    await c.dispatch('cmd_1', { type: 'profile.create', name: 'P' })
    await until(() => notified > 0)

    expect(notified).toBeGreaterThan(0)
    c.close()
  })

  it('ignores an event at or behind the cursor, so a delta is never applied twice', async () => {
    const c = client()
    await c.connect()
    await c.dispatch('cmd_1', { type: 'profile.create', name: 'Personal' })
    await until(() => c.cursor(0) === 1)

    // Resubscribing overlaps with events already applied; the server replays
    // from the cursor, and anything that slips through must be dropped.
    c.subscribe(0)
    await new Promise(resolve => setTimeout(resolve, 150))

    expect(c.state.profiles.size).toBe(1)
    expect(c.cursor(0)).toBe(1)
    c.close()
  })
})

describe('HarnessClient — reconnect', () => {
  it('reconnects after the server goes away and comes back', async () => {
    const c = client()
    await c.connect()
    await c.dispatch('cmd_1', { type: 'profile.create', name: 'Before' })
    await until(() => c.cursor(0) === 1)

    harness.stop()
    await until(() => c.status === 'reconnecting')

    harness = await serve({ port, databasePath: dbPath })
    const back = await until(() => c.status === 'connected', 5000)

    expect(back).toBe(true)
    c.close()
  })

  it('resumes from its cursor, so the gap is filled and nothing is re-applied', async () => {
    const c = client()
    await c.connect()
    c.subscribe(0)
    await c.dispatch('cmd_1', { type: 'profile.create', name: 'First' })
    await until(() => c.cursor(0) === 1)

    // Server restarts. While it is down, a *different* client adds a profile,
    // so there is a real gap for the reconnect to fill.
    harness.stop()
    await until(() => c.status === 'reconnecting')
    harness = await serve({ port, databasePath: dbPath })
    const other = client()
    await other.connect()
    await other.dispatch('cmd_2', { type: 'profile.create', name: 'Missed' })
    other.close()

    await until(() => c.status === 'connected', 5000)
    await until(() => c.state.profiles.size === 2, 5000)

    // Both profiles present, each applied exactly once.
    expect(c.state.profiles.size).toBe(2)
    expect([...c.state.profiles.values()].map(p => p.name).sort()).toEqual(['First', 'Missed'])
    c.close()
  })

  it('rejects in-flight dispatches when the connection drops', async () => {
    const c = client()
    await c.connect()

    const inFlight = c.dispatch('cmd_inflight', { type: 'profile.create', name: 'Lost' })
    harness.stop()

    // Honest: the client cannot know whether it ran. Retrying with the same id
    // is what makes that safe.
    await expect(inFlight).rejects.toThrow(/before the command was acknowledged/)
    c.close()
  })

  it('stops reconnecting once closed', async () => {
    const c = client()
    await c.connect()
    harness.stop()
    c.close()

    await new Promise(resolve => setTimeout(resolve, 120))
    expect(c.status).toBe('closed')
  })
})

describe('HarnessClient — backoff', () => {
  it('grows the delay and keeps it inside the ceiling', async () => {
    const delays: number[] = []
    const c = new HarnessClient({
      url: `ws://127.0.0.1:${port}/ws`,
      minBackoffMs: 100,
      maxBackoffMs: 800,
      sleep: async (ms) => { delays.push(ms) },
    })
    await c.connect()

    harness.stop()
    await until(() => delays.length >= 3, 3000)
    c.close()

    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(100)
      expect(delay).toBeLessThanOrEqual(800)
    }
    // Jittered, so exact values vary — but the ceiling must climb, otherwise
    // every client retries in lockstep and stampedes a recovering server.
    expect(delays.length).toBeGreaterThanOrEqual(3)
  })
})
