/**
 * What the engine needs from storage, and nothing more.
 *
 * The engine is written against this rather than against the ORM so its
 * ordering and idempotency rules can be tested without a database, and so the
 * durable implementation can change without touching the rules. Production
 * uses SQLite; tests can use the in-memory store below.
 */

import type { EventPayload, HarnessEvent } from '@harness/contract'

export interface AppendableEvent {
  sessionId: number
  commandId: string
  at: number
  payload: EventPayload
}

export interface CommandIdentity {
  commandId: string
  at: number
}

export interface CommandReceipt extends CommandIdentity {
  seqs: number[]
}

export interface EngineStore {
  /** Commit the assigned events and the receipt together, including for a no-op. */
  commitCommand: (command: CommandIdentity, events: AppendableEvent[]) => Promise<HarnessEvent[]>

  /** Return the events in append order, or null if the command has not committed. */
  readCommand: (commandId: string) => Promise<HarnessEvent[] | null>

  /** Restore receipts for events from before command commits were atomic. */
  recoverReceipts: () => Promise<void>

  /** All events for a session, ascending by seq. */
  read: (sessionId: number, sinceSeq?: number) => Promise<HarnessEvent[]>

  /** Every session id that has at least one event. */
  sessionIds: () => Promise<number[]>

  /**
   * Every event, in the order it was appended.
   *
   * `seq` is per session, so reading session by session and concatenating does
   * not reconstruct the log — it reconstructs a *reordering* of it, in which a
   * global event that removes a session can land before the `session.created`
   * that brings it back. Replay needs the one true order, which is the order
   * things were written.
   */
  readAll: () => Promise<HarnessEvent[]>
}

/**
 * An in-memory store, used by tests and by replay verification.
 *
 * Deliberately the same code path as production for ordering and sequencing —
 * only durability differs — so a test that passes here is testing the real
 * rules rather than a simplified stand-in.
 */
export class MemoryStore implements EngineStore {
  private events = new Map<number, HarnessEvent[]>()
  /** Append order, which is the log's only total order. */
  private appended: HarnessEvent[] = []
  private receipts = new Map<string, HarnessEvent[]>()

  append(events: AppendableEvent[]): HarnessEvent[] {
    const out: HarnessEvent[] = []
    for (const event of events) {
      const log = this.events.get(event.sessionId) ?? []
      const seq = log.length + 1
      const stored: HarnessEvent = {
        seq,
        sessionId: event.sessionId,
        commandId: event.commandId,
        at: event.at,
        payload: event.payload,
      }
      log.push(stored)
      this.events.set(event.sessionId, log)
      this.appended.push(stored)
      out.push(stored)
    }
    return out
  }

  async commitCommand(command: CommandIdentity, events: AppendableEvent[]): Promise<HarnessEvent[]> {
    if (this.receipts.has(command.commandId))
      throw new Error(`Command already committed: ${command.commandId}`)
    const committed = this.append(events)
    this.receipts.set(command.commandId, committed)
    return committed
  }

  async readCommand(commandId: string): Promise<HarnessEvent[] | null> {
    return this.receipts.get(commandId)?.slice() ?? null
  }

  async recoverReceipts(): Promise<void> {
    const missing = new Map<string, HarnessEvent[]>()
    for (const event of this.appended) {
      if (this.receipts.has(event.commandId)) continue
      const events = missing.get(event.commandId) ?? []
      events.push(event)
      missing.set(event.commandId, events)
    }
    for (const [commandId, events] of missing)
      this.receipts.set(commandId, events)
  }

  async read(sessionId: number, sinceSeq = 0): Promise<HarnessEvent[]> {
    return (this.events.get(sessionId) ?? []).filter(event => event.seq > sinceSeq)
  }

  async sessionIds(): Promise<number[]> {
    return [...this.events.keys()].sort((a, b) => a - b)
  }

  async readAll(): Promise<HarnessEvent[]> {
    return [...this.appended]
  }
}
