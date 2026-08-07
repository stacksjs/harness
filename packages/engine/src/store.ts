/**
 * What the engine needs from storage, and nothing more.
 *
 * The engine is written against this rather than against the ORM so its
 * ordering and idempotency rules can be tested without a database, and so the
 * durable implementation can change without touching the rules. Production
 * binds the Stacks ORM; tests bind the in-memory store below.
 */

import type { EventPayload, HarnessEvent } from '@harness/contract'

export interface AppendableEvent {
  sessionId: number
  commandId: string
  at: number
  payload: EventPayload
}

export interface CommandReceipt {
  commandId: string
  /** Sequence numbers this command produced, so a retry can return them. */
  seqs: number[]
  at: number
}

export interface EngineStore {
  /**
   * Append events and return them with their assigned sequence numbers.
   *
   * Called only from inside the queue, so it may assume it is the sole writer
   * — but it still assigns `seq` itself, because the sequence is per session
   * and the engine handles many sessions.
   */
  append: (events: AppendableEvent[]) => Promise<HarnessEvent[]>

  /** All events for a session, ascending by seq. */
  read: (sessionId: number, sinceSeq?: number) => Promise<HarnessEvent[]>

  /** Every session id that has at least one event. Used by replay. */
  sessionIds: () => Promise<number[]>

  receipt: (commandId: string) => Promise<CommandReceipt | null>
  putReceipt: (receipt: CommandReceipt) => Promise<void>
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
  private receipts = new Map<string, CommandReceipt>()

  async append(events: AppendableEvent[]): Promise<HarnessEvent[]> {
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
      out.push(stored)
    }
    return out
  }

  async read(sessionId: number, sinceSeq = 0): Promise<HarnessEvent[]> {
    return (this.events.get(sessionId) ?? []).filter(event => event.seq > sinceSeq)
  }

  async sessionIds(): Promise<number[]> {
    return [...this.events.keys()].sort((a, b) => a - b)
  }

  async receipt(commandId: string): Promise<CommandReceipt | null> {
    return this.receipts.get(commandId) ?? null
  }

  async putReceipt(receipt: CommandReceipt): Promise<void> {
    this.receipts.set(receipt.commandId, receipt)
  }
}
