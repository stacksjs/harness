import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A snapshot of the workspace taken around a turn, so a turn can be undone.
 *
 * Captured on turn start and turn end by the checkpoint reactor. Reverting is
 * itself a command, so it lands in the event log like everything else — the
 * log records that you reverted, not just the state you reverted to.
 */
export default defineModel({
  name: 'Checkpoint',
  table: 'checkpoints',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'sessionId', 'kind', 'vcsRef', 'createdAt'],
      searchable: ['vcsRef'],
      sortable: ['createdAt'],
      filterable: ['sessionId', 'kind'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'checkpoints',
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

    turnId: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    kind: {
      order: 3,
      fillable: true,
      validation: { rule: schema.enum(['turn-start', 'turn-end', 'manual']) },
      factory: () => 'turn-start',
    },

    vcsRef: {
      order: 4,
      fillable: true,
      // Commit or stash ref holding the tracked state.
      validation: { rule: schema.string().max(200) },
      factory: () => '',
    },

    dirtyFilesSnapshot: {
      order: 5,
      fillable: true,
      // JSON list of untracked/ignored files captured alongside the ref.
      // Without it a revert restores tracked files and silently leaves the
      // agent's new untracked ones behind, which is the confusing half of a
      // half-undo.
      validation: { rule: schema.string() },
      factory: () => '[]',
    },
  },

  dashboard: { enabled: false },
} as const)
