/**
 * The durable `EngineStore`, over the `events` and `command_receipts` tables.
 *
 * Talks to SQLite directly rather than through the ORM: the engine's hot path
 * is "append N rows and assign each a per-session sequence", which wants one
 * transaction and one prepared statement, not a model round-trip per row. The
 * rules it implements are identical to `MemoryStore`'s — only durability
 * differs — so the engine tests exercise the same behaviour.
 */

import type { EventPayload, HarnessEvent } from '@harness/contract'
import { Database } from 'bun:sqlite'
import { GLOBAL_SESSION_ID } from '@harness/contract'
import type { AppendableEvent, CommandReceipt, EngineStore } from './store'

interface EventRow {
  session_id: number | null
  seq: number
  type: string
  payload: string
  command_id: string
  created_at: string | null
}

/**
 * The engine uses the sentinel 0 for facts that belong to no session, because
 * a number keys a Map and reads cleanly in the reducer. A table with a foreign
 * key to `sessions` cannot store 0 — that is what NULL is for. Translate at the
 * boundary rather than weakening the constraint: the schema should keep
 * catching a real dangling session reference.
 */
function toColumn(sessionId: number): number | null {
  return sessionId === GLOBAL_SESSION_ID ? null : sessionId
}

function fromColumn(sessionId: number | null): number {
  return sessionId ?? GLOBAL_SESSION_ID
}

export class SqliteStore implements EngineStore {
  private db: Database

  constructor(path: string) {
    this.db = new Database(path)
    // WAL keeps readers from blocking the single writer. The engine serialises
    // writes itself, so the only contention is projections reading while a
    // command appends.
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
  }

  close(): void {
    this.db.close()
  }

  async append(events: AppendableEvent[]): Promise<HarnessEvent[]> {
    if (events.length === 0) return []

    // `IS` rather than `=` so the global stream (session_id NULL) gets its own
    // running sequence instead of matching nothing and restarting at 1 forever.
    const nextSeq = this.db.prepare<{ next: number }, [number | null]>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id IS ?',
    )
    const insert = this.db.prepare(
      `INSERT INTO events (session_id, turn_id, seq, type, payload, command_id, created_at, updated_at, uuid)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), lower(hex(randomblob(16))))`,
    )

    const out: HarnessEvent[] = []

    // One transaction for the whole batch. A command's events are all-or-nothing
    // — half a command in the log is a state no projection knows how to fold.
    this.db.transaction(() => {
      for (const event of events) {
        const column = toColumn(event.sessionId)
        const seq = nextSeq.get(column)?.next ?? 1
        // `turnId` is denormalised out of the payload so the column can be
        // filtered on without parsing every row's JSON.
        const turnId = (event.payload as { turnId?: number }).turnId ?? null
        insert.run(
          column,
          turnId,
          seq,
          event.payload.type,
          JSON.stringify(event.payload),
          event.commandId,
        )
        out.push({
          seq,
          sessionId: event.sessionId,
          commandId: event.commandId,
          at: event.at,
          payload: event.payload,
        })
      }
    })()

    return out
  }

  async read(sessionId: number, sinceSeq = 0): Promise<HarnessEvent[]> {
    const rows = this.db
      .prepare<EventRow, [number | null, number]>(
        'SELECT session_id, seq, type, payload, command_id, created_at FROM events WHERE session_id IS ? AND seq > ? ORDER BY seq ASC',
      )
      .all(toColumn(sessionId), sinceSeq)

    return rows.map(row => ({
      seq: row.seq,
      sessionId: fromColumn(row.session_id),
      commandId: row.command_id,
      at: row.created_at ? Date.parse(`${row.created_at}Z`) : 0,
      payload: JSON.parse(row.payload) as EventPayload,
    }))
  }

  async sessionIds(): Promise<number[]> {
    const rows = this.db
      .prepare<{ session_id: number | null }, []>(
        'SELECT DISTINCT session_id FROM events ORDER BY session_id ASC',
      )
      .all()
    return rows.map(row => fromColumn(row.session_id))
  }

  async receipt(commandId: string): Promise<CommandReceipt | null> {
    const row = this.db
      .prepare<{ command_id: string, seqs: string, at: number }, [string]>(
        'SELECT command_id, seqs, at FROM command_receipts WHERE command_id = ?',
      )
      .get(commandId)
    if (!row) return null
    return { commandId: row.command_id, seqs: JSON.parse(row.seqs) as number[], at: row.at }
  }

  async putReceipt(receipt: CommandReceipt): Promise<void> {
    // `OR IGNORE` rather than `OR REPLACE`: two racing retries of the same
    // command must leave the first receipt intact. Replacing would rewrite the
    // recorded sequence numbers, and a client comparing them would see its
    // command's result change under it.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO command_receipts (command_id, seqs, at, created_at, updated_at, uuid)
         VALUES (?, ?, ?, datetime('now'), datetime('now'), lower(hex(randomblob(16))))`,
      )
      .run(receipt.commandId, JSON.stringify(receipt.seqs), receipt.at)
  }
}
