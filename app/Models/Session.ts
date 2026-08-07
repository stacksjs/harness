import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One conversation with one agent, against one workspace.
 *
 * Everything on this model except `id`, `workspaceId` and `driverKind` is a
 * **projection** — derived by replaying `Event` rows, never written directly by
 * application code. `lastSeq` is what a reconnecting client sends back so the
 * replay buffer knows where to resume.
 */
export default defineModel({
  name: 'Session',
  table: 'sessions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'title', 'driverKind', 'state', 'workspaceId'],
      searchable: ['title'],
      sortable: ['createdAt', 'updatedAt'],
      filterable: ['workspaceId', 'driverKind', 'state'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'sessions',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
  },

  belongsTo: ['Workspace'],
  hasMany: ['Turn', 'Checkpoint', 'Approval'],

  attributes: {
    workspaceId: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    title: {
      order: 2,
      fillable: true,
      // Derived from the first user turn, then editable.
      validation: { rule: schema.string().max(400) },
      factory: faker => faker.lorem.sentence(),
    },

    driverKind: {
      order: 3,
      fillable: true,
      validation: { rule: schema.enum(['claude', 'codex', 'cursor', 'opencode', 'grok']) },
      factory: () => 'claude',
    },

    providerSessionId: {
      order: 4,
      fillable: true,
      // The agent CLI's own id for this conversation. Opaque to us; needed to
      // resume a session after the provider process restarts.
      validation: { rule: schema.string().max(400) },
      factory: () => '',
    },

    state: {
      order: 5,
      fillable: true,
      validation: { rule: schema.enum(['idle', 'running', 'awaiting-approval', 'awaiting-input', 'stopped', 'failed']) },
      factory: () => 'idle',
    },

    runtimeMode: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string().max(80) },
      factory: () => 'default',
    },

    interactionMode: {
      order: 7,
      fillable: true,
      // `streaming` pushes every assistant delta; `buffered` accumulates.
      // Buffered still spills at a character cap and flushes at every
      // interaction boundary — without those two rules it becomes "the UI
      // freezes, then dumps a wall of text".
      validation: { rule: schema.enum(['streaming', 'buffered']) },
      factory: () => 'streaming',
    },

    lastSeq: {
      order: 8,
      fillable: true,
      // Highest event sequence applied to this projection. A reconnecting
      // client sends the last seq it saw and gets everything after it.
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  dashboard: { enabled: false },
} as const)
