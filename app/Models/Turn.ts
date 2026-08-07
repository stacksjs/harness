import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One exchange inside a session: a user prompt and everything the agent did in
 * response.
 *
 * A projection of the event log, like `Session`. Token counts and cost land
 * here so "what did this session cost" is a query rather than a replay.
 */
export default defineModel({
  name: 'Turn',
  table: 'turns',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'sessionId', 'role', 'status', 'startedAt'],
      searchable: [],
      sortable: ['startedAt', 'createdAt'],
      filterable: ['sessionId', 'role', 'status'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'turns',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
  },

  belongsTo: ['Session'],
  hasMany: ['Event'],

  attributes: {
    sessionId: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    role: {
      order: 2,
      fillable: true,
      validation: { rule: schema.enum(['user', 'assistant', 'system']) },
      factory: () => 'user',
    },

    status: {
      order: 3,
      fillable: true,
      // `interrupted` is distinct from `failed`: the user stopped it, nothing
      // went wrong, and the difference matters when deciding whether to offer
      // a retry.
      validation: { rule: schema.enum(['pending', 'running', 'complete', 'interrupted', 'failed']) },
      factory: () => 'pending',
    },

    startedAt: {
      order: 4,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },

    endedAt: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(40) },
      factory: () => '',
    },

    tokensIn: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    tokensOut: {
      order: 7,
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    cost: {
      order: 8,
      fillable: true,
      // Micro-units of USD, integer, so summing a thousand turns does not
      // accumulate float error.
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  dashboard: { enabled: false },
} as const)
