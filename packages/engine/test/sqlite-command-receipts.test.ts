import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine'
import { derivedId, reduce } from '../src/reducer'
import { SqliteStore } from '../src/sqlite-store'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'harness-command-receipts-'))
  const path = join(directory, 'harness.sqlite')
  const db = new Database(path)
  db.exec(`
    CREATE TABLE events (
      id INTEGER PRIMARY KEY, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL,
      type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER,
      created_at TEXT, updated_at TEXT, uuid TEXT
    );
    CREATE TABLE command_receipts (
      id INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER,
      created_at TEXT, updated_at TEXT, uuid TEXT
    );
  `)
  const store = new SqliteStore(path)
  return {
    db,
    store,
    path,
    close() {
      store.close()
      db.close()
      rmSync(directory, { recursive: true })
    },
  }
}

describe('durable command receipts', () => {
  it('rolls back the events if the receipt cannot commit, then accepts a retry', async () => {
    const { db, store, close } = fixture()
    try {
      const engine = new Engine({ store, reducer: reduce })
      await engine.hydrate()
      db.exec(`
        CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts
        BEGIN SELECT RAISE(ABORT, 'receipt write interrupted'); END;
      `)
      const command = { id: 'create-profile', at: 42, command: { type: 'profile.create', name: 'Work' } } as const

      await expect(engine.dispatch(command)).rejects.toThrow('receipt write interrupted')
      expect(await store.readAll()).toEqual([])
      expect(await store.readCommand(command.id)).toBeNull()
      expect(engine.current.profiles.size).toBe(0)

      db.exec('DROP TRIGGER fail_receipt')
      const first = await engine.dispatch(command)
      expect(first.replayed).toBe(false)
      expect(first.events.map(event => event.seq)).toEqual([1])
      expect(engine.current.profiles.get(derivedId(command.id))?.name).toBe('Work')
      expect(await store.readCommand(command.id)).toEqual(first.events)
    }
    finally {
      close()
    }
  })

  it('rebuilds a missing pre-upgrade receipt and replays the original event after restart', async () => {
    const { db, store, path, close } = fixture()
    const restartedStore = new SqliteStore(path)
    try {
      const command = { id: 'legacy-profile', at: 42, command: { type: 'profile.create', name: 'Work' } } as const
      const profileId = derivedId(command.id)
      db.prepare(
        'INSERT INTO events (seq, type, payload, command_id, at) VALUES (1, ?, ?, ?, ?)',
      ).run('profile.created', JSON.stringify({ type: 'profile.created', profileId, name: 'Work' }), command.id, command.at)

      const engine = new Engine({ store: restartedStore, reducer: reduce })
      await engine.hydrate()
      const replayed = await engine.dispatch(command)
      expect(replayed.replayed).toBe(true)
      expect(replayed.events).toEqual(await store.readAll())
      expect(engine.current.profiles.get(profileId)?.name).toBe('Work')
      expect(await store.readCommand(command.id)).toEqual(replayed.events)
    }
    finally {
      restartedStore.close()
      close()
    }
  })

  it('records a no-op and returns its empty result after reopening the database', async () => {
    const { store, path, close } = fixture()
    const restartedStore = new SqliteStore(path)
    try {
      await store.commitCommand({ commandId: 'no-change', at: 42 }, [])
      expect(await restartedStore.readCommand('no-change')).toEqual([])
      expect(await restartedStore.readCommand('unknown')).toBeNull()
    }
    finally {
      restartedStore.close()
      close()
    }
  })
})
