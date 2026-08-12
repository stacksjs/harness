/**
 * A queue an async generator drains, so producer and consumer can run apart.
 *
 * Both stdio drivers (codex, acp) push events from process callbacks while the
 * engine pulls from an async iterator; this is the seam between the two. Shared
 * rather than duplicated because its one subtle guarantee — `finish` emits a
 * final event and closes in a single step, so no terminal can race a second —
 * is exactly the kind of thing two copies would drift on.
 */

import type { ProviderEvent } from './types'

/** The consumer parked in `next()`, waiting for the producer to push. */
type Waiter = (result: IteratorResult<ProviderEvent>) => void

export class EventQueue {
  private readonly buffer: ProviderEvent[] = []
  private waiting: Waiter | null = null
  private done = false

  push(event: ProviderEvent): void {
    if (this.done) return
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: event, done: false })
      return
    }
    this.buffer.push(event)
  }

  /** Emit a final event and close, in one step, so no terminal can race a second. */
  finish(event?: ProviderEvent): void {
    if (this.done) return
    if (event) this.push(event)
    this.done = true
    if (this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve({ value: undefined as never, done: true })
    }
  }

  get closed(): boolean {
    return this.done
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderEvent> {
    return {
      next: (): Promise<IteratorResult<ProviderEvent>> => {
        const next = this.buffer.shift()
        if (next) return Promise.resolve({ value: next, done: false })
        if (this.done) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => { this.waiting = resolve })
      },
    }
  }
}
