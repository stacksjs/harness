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
import type { AppendableEvent, CommandIdentity, EngineStore } from './store'

interface EventRow {
  session_id: number | null
  seq: number
  payload: string
  command_id: string
  at: number | null
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

function fromRow(row: EventRow): HarnessEvent {
  return {
    seq: row.seq,
    sessionId: fromColumn(row.session_id),
    commandId: row.command_id,
    at: row.at ?? 0,
    payload: JSON.parse(row.payload) as EventPayload,
  }
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

  private appendEvents(events: AppendableEvent[]): HarnessEvent[] {
    // `IS` rather than `=` so the global stream (session_id NULL) gets its own
    // running sequence instead of matching nothing and restarting at 1 forever.
    const nextSeq = this.db.query<{ next: number }, [number | null]>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id IS ?',
    )
    const insert = this.db.query(
      `INSERT INTO events (session_id, turn_id, seq, type, payload, command_id, at, created_at, updated_at, uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), lower(hex(randomblob(16))))`,
    )

    const out: HarnessEvent[] = []

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
        event.at,
      )
      out.push({
        seq,
        sessionId: event.sessionId,
        commandId: event.commandId,
        at: event.at,
        payload: event.payload,
      })
    }

    return out
  }

  async read(sessionId: number, sinceSeq = 0): Promise<HarnessEvent[]> {
    const rows = this.db
      .query<EventRow, [number | null, number]>(
        'SELECT session_id, seq, payload, command_id, at FROM events WHERE session_id IS ? AND seq > ? ORDER BY seq ASC',
      )
      .all(toColumn(sessionId), sinceSeq)

    return rows.map(fromRow)
  }

  /**
   * Every event in append order.
   *
   * Ordered by the rowid, not by `seq`: `seq` restarts per session, so it
   * cannot order two events from different sessions against each other. The
   * insertion id is the log's only total order.
   */
  async readAll(): Promise<HarnessEvent[]> {
    const rows = this.db
      .query<EventRow, []>(
        'SELECT session_id, seq, payload, command_id, at FROM events ORDER BY id ASC',
      )
      .all()

    return rows.map(fromRow)
  }

  async sessionIds(): Promise<number[]> {
    const rows = this.db
      .query<{ session_id: number | null }, []>(
        'SELECT DISTINCT session_id FROM events ORDER BY session_id ASC',
      )
      .all()
    return rows.map(row => fromColumn(row.session_id))
  }

  async commitCommand(command: CommandIdentity, events: AppendableEvent[]): Promise<HarnessEvent[]> {
    return this.db.transaction(() => {
      const committed = events.length > 0 ? this.appendEvents(events) : []
      this.db.query(
        `INSERT INTO command_receipts (command_id, seqs, at, created_at, updated_at, uuid)
         VALUES (?, ?, ?, datetime('now'), datetime('now'), lower(hex(randomblob(16))))`,
      ).run(command.commandId, JSON.stringify(committed.map(event => event.seq)), command.at)
      return committed
    }).immediate()
  }

  async readCommand(commandId: string): Promise<HarnessEvent[] | null> {
    const receipt = this.db.query('SELECT 1 FROM command_receipts WHERE command_id = ?').get(commandId)
    if (!receipt) return null

    return this.db.query<EventRow, [string]>(
      'SELECT session_id, seq, payload, command_id, at FROM events WHERE command_id = ? ORDER BY id ASC',
    ).all(commandId).map(fromRow)
  }

  async recoverReceipts(): Promise<void> {
    // Older servers could stop after appending a batch and before recording
    // its receipt. The committed events are still authoritative.
    this.db.exec(`
      INSERT INTO command_receipts (command_id, seqs, at, created_at, updated_at, uuid)
      SELECT command_id, json_group_array(seq ORDER BY id), COALESCE(MIN(at), 0),
        datetime('now'), datetime('now'), lower(hex(randomblob(16)))
      FROM events
      WHERE command_id IS NOT NULL AND command_id != ''
        AND NOT EXISTS (SELECT 1 FROM command_receipts WHERE command_receipts.command_id = events.command_id)
      GROUP BY command_id
    `)
  }
}
