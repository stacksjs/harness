import type { EventPayload } from './events'

export interface QueuedFollowUp {
  id: string
  text: string
}

export interface FollowUpQueue {
  entries: QueuedFollowUp[]
  held: boolean
}

/** The host and subscribed clients fold the same committed queue events. */
export function applyFollowUpEvent(queue: FollowUpQueue, event: EventPayload): FollowUpQueue {
  switch (event.type) {
    case 'queue.added':
      return { ...queue, entries: [...queue.entries, event.entry] }
    case 'queue.edited':
      return { ...queue, entries: queue.entries.map(entry => entry.id === event.id ? { ...entry, text: event.text } : entry) }
    case 'queue.removed':
      return { ...queue, entries: queue.entries.filter(entry => entry.id !== event.id) }
    case 'queue.moved': {
      const index = queue.entries.findIndex(entry => entry.id === event.id)
      if (index === -1) return queue
      const entries = queue.entries.slice()
      const [entry] = entries.splice(index, 1)
      entries.splice(event.toIndex, 0, entry!)
      return { ...queue, entries }
    }
    case 'turn.interrupted':
    case 'turn.failed':
    case 'session.failed':
    case 'session.stopped':
    case 'queue.held':
      return queue.held ? queue : { ...queue, held: true }
    case 'turn.started':
      if (event.queuedId) return { held: false, entries: queue.entries.filter(entry => entry.id !== event.queuedId) }
      return queue.held ? { ...queue, held: false } : queue
    default:
      return queue
  }
}
