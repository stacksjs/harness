import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * The append-only log. This is the source of truth.
 *
 * `Session.state`, `Turn.status` and the whole transcript are projections
 * rebuilt from these rows. That costs a little write amplification and buys
 * checkpoint/revert, lossless reconnect, multi-client consistency and an audit
 * trail of what an agent actually did — none of which can realistically be
 * retrofitted onto mutable state later. It is in M1 for that reason.
 *
 * Nothing updates or deletes an Event. If a fact turns out to be wrong, a
 * later event corrects it.
 */
export default defineModel({
  name: 'Event',
  table: 'events',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'sessionId', 'seq', 'type', 'createdAt'],
      searchable: ['type'],
      sortable: ['seq', 'createdAt'],
      filterable: ['sessionId', 'turnId', 'type'],
    },
    useSeeder: { count: 0 },
    // No write routes: events are produced by the engine, never posted.
    useApi: {
      uri: 'events',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
  },

  attributes: {
    sessionId: {
      order: 1,
      fillable: true,
      // Nullable, because some facts belong to no session — creating a
      // profile, adding a workspace. They still live in this log and still get
      // a sequence number; NULL is simply how "no session" is spelled in a
      // table with a foreign key. The engine uses the sentinel 0 in memory,
      // and the store translates at the boundary.
      validation: { rule: schema.number() },
      factory: () => 1,
    },

    turnId: {
      order: 2,
      fillable: true,
      // Null for session-level events that belong to no particular turn.
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    seq: {
      order: 3,
      fillable: true,
      // Monotonic **per session**, starting at 1. Assigned by the engine
      // inside the command queue, which is what makes the order total rather
      // than merely probable.
      validation: { rule: schema.number().required().min(1) },
      factory: () => 1,
    },

    type: {
      order: 4,
      fillable: true,
      // Dotted event name, e.g. `thread.message.assistant.delta`. Kept as a
      // string rather than an enum so adding an event type is not a migration.
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'session.created',
    },

    payload: {
      order: 5,
      fillable: true,
      // JSON. Shape is per event type and lives in packages/contract.
      validation: { rule: schema.string() },
      factory: () => '{}',
    },

    at: {
      order: 6,
      fillable: true,
      // Milliseconds, stored explicitly rather than derived from `created_at`.
      // SQLite's `datetime('now')` is second-resolution, so a replayed event
      // came back with its milliseconds truncated while the live broadcast of
      // the *same* event carried them — two different timestamps for one fact,
      // depending only on how you received it.
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    commandId: {
      order: 7,
      fillable: true,
      // The command that produced this event. Paired with the receipt table,
      // this is what makes a retried command idempotent instead of duplicating
      // its effects.
      validation: { rule: schema.string().max(200) },
      factory: () => '',
    },
  },

  dashboard: { enabled: false },
} as const)
