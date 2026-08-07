/**
 * The engine: commands in, events out, projections derived.
 *
 * Three properties everything else leans on:
 *
 *   **Total order.** One worker drains one queue. Commands do not interleave,
 *   so a sequence number means the same thing to every reader and two clients
 *   racing on the same session cannot produce a state neither asked for.
 *
 *   **Idempotency.** A command carries a client-generated id and leaves a
 *   durable receipt. Re-dispatching after a dropped connection returns the
 *   original result instead of running it twice — which for "start a turn" is
 *   the difference between one agent run and two.
 *
 *   **Derivation.** Nothing mutates the read model directly. State is a fold of
 *   the log, so replay reconstructs it exactly and a projection bug is fixable
 *   after the fact rather than baked into history.
 */

import type { Command, CommandEnvelope, HarnessEvent } from '@harness/contract'
import type { AppendableEvent, EngineStore } from './store'
import { isClientCommand } from '@harness/contract'
import { apply, emptyState, replay } from './projections'
import type { HarnessState } from './projections'

export interface DispatchResult {
  events: HarnessEvent[]
  /** True when a receipt already existed and nothing was re-run. */
  replayed: boolean
}

export class CommandRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandRejected'
  }
}

/**
 * Turns a command into the events it causes.
 *
 * Pure: given the same state and command it must produce the same events, with
 * no clock and no id generation of its own. Anything non-deterministic is
 * resolved before the reducer runs and passed in on the envelope, because a
 * reducer that reads `Date.now()` makes the log unreplayable.
 */
export type Reducer = (state: HarnessState, command: Command, envelope: CommandEnvelope) => AppendableEvent[]

export interface EngineOptions {
  store: EngineStore
  reducer: Reducer
  /** Rejects commands a client is not allowed to send. Defaults to the contract's allowlist. */
  isClientAllowed?: (type: string) => boolean
}

export class Engine {
  private state: HarnessState = emptyState()
  /**
   * The queue is a promise chain rather than an array plus a worker loop: it is
   * the same total order with none of the bookkeeping, and an exception in one
   * command cannot wedge the drain loop for the next.
   */
  private tail: Promise<unknown> = Promise.resolve()
  private booted = false

  constructor(private options: EngineOptions) {}

  /**
   * Rebuild state from the log. Call once at startup, before serving.
   *
   * Reads every session's events and folds them. This is also the check that
   * the projections are total: if `hydrate` produces a different state than the
   * one built incrementally, a reducer and its projection disagree.
   */
  async hydrate(): Promise<void> {
    const state = emptyState()
    for (const sessionId of await this.options.store.sessionIds())
      replay(await this.options.store.read(sessionId), state)
    this.state = state
    this.booted = true
  }

  /** The current read model. Treat as read-only. */
  get current(): HarnessState {
    return this.state
  }

  /**
   * Dispatch a command from a client.
   *
   * Separate from `dispatchInternal` so the allowlist is applied at the door.
   * A client holding a valid socket must not be able to forge assistant text
   * by naming an internal command.
   */
  async dispatch(envelope: CommandEnvelope): Promise<DispatchResult> {
    const allowed = this.options.isClientAllowed ?? isClientCommand
    if (!allowed(envelope.command.type))
      throw new CommandRejected(`${envelope.command.type} is not client-dispatchable`)
    return this.enqueue(envelope)
  }

  /** Dispatch a command the server itself raised, e.g. from provider output. */
  async dispatchInternal(envelope: CommandEnvelope): Promise<DispatchResult> {
    return this.enqueue(envelope)
  }

  private enqueue(envelope: CommandEnvelope): Promise<DispatchResult> {
    // Chain onto the tail, and make the tail swallow failures so one rejected
    // command does not poison every command queued behind it.
    const result = this.tail.then(() => this.process(envelope))
    this.tail = result.catch(() => {})
    return result
  }

  private async process(envelope: CommandEnvelope): Promise<DispatchResult> {
    if (!this.booted)
      throw new CommandRejected('engine has not hydrated; call hydrate() before dispatching')

    const existing = await this.options.store.receipt(envelope.id)
    if (existing) {
      // The command already ran. Return what it produced rather than running it
      // again — this is the whole point of the receipt.
      const events: HarnessEvent[] = []
      for (const sessionId of await this.options.store.sessionIds()) {
        for (const event of await this.options.store.read(sessionId)) {
          if (event.commandId === envelope.id) events.push(event)
        }
      }
      events.sort((a, b) => a.seq - b.seq)
      return { events, replayed: true }
    }

    const produced = this.options.reducer(this.state, envelope.command, envelope)
    const events = produced.length > 0 ? await this.options.store.append(produced) : []

    for (const event of events) apply(this.state, event)

    // The receipt is written after the events, so a crash between the two
    // leaves the command looking un-run and it is retried. Writing the receipt
    // first would risk the opposite — a command recorded as done whose effects
    // never landed — and a lost retry is far easier to recover from than a
    // silently skipped command.
    await this.options.store.putReceipt({
      commandId: envelope.id,
      seqs: events.map(event => event.seq),
      at: envelope.at,
    })

    return { events, replayed: false }
  }

  /** Wait for everything currently queued to finish. For deterministic tests. */
  async drain(): Promise<void> {
    await this.tail
  }
}
