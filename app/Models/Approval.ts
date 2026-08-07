import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A tool call the agent asked permission for, and what was decided.
 *
 * Persisted rather than kept in memory because "what did I approve, and when"
 * is a question you will want answered after the fact. `scope` is what turns a
 * one-off yes into a standing one, and `argsDigest` is what makes a standing
 * yes safe: an approval matches only calls with the same arguments, so
 * "always allow this" cannot silently widen into "always allow anything from
 * this tool".
 */
export default defineModel({
  name: 'Approval',
  table: 'approvals',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'sessionId', 'toolName', 'decision', 'scope', 'createdAt'],
      searchable: ['toolName'],
      sortable: ['createdAt'],
      filterable: ['sessionId', 'decision', 'scope'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'approvals',
      routes: ['index', 'show'],
      middleware: ['auth'],
    },
  },

  belongsTo: ['Session'],

  attributes: {
    sessionId: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    requestId: {
      order: 2,
      fillable: true,
      // The provider's own id for the request, so a response can be routed
      // back to the call that is blocked on it.
      validation: { rule: schema.string().required().max(200) },
      factory: () => '',
    },

    toolName: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string().required().max(200) },
      factory: () => 'bash',
    },

    argsDigest: {
      order: 4,
      fillable: true,
      // Hash of the normalised arguments. A `workspace`- or `always`-scoped
      // approval only matches an identical digest.
      validation: { rule: schema.string().max(128) },
      factory: () => '',
    },

    decision: {
      order: 5,
      fillable: true,
      validation: { rule: schema.enum(['pending', 'allowed', 'denied', 'expired']) },
      factory: () => 'pending',
    },

    scope: {
      order: 6,
      fillable: true,
      validation: { rule: schema.enum(['once', 'session', 'workspace', 'always']) },
      factory: () => 'once',
    },
  },

  dashboard: { enabled: false },
} as const)
