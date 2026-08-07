import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Proof that a command already ran.
 *
 * A client generates the command id, so re-sending after a dropped connection
 * carries the same one. The engine looks here first and returns the original
 * result instead of running it again — which for "start a turn" is the
 * difference between one agent run and two.
 *
 * Written *after* the events it accounts for. A crash in between leaves the
 * command looking un-run so it is retried; the reverse ordering would risk a
 * command recorded as done whose effects never landed, and a lost retry is far
 * easier to recover from than a silently skipped command.
 */
export default defineModel({
  name: 'CommandReceipt',
  table: 'command_receipts',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'commandId', 'createdAt'],
      searchable: ['commandId'],
      sortable: ['createdAt'],
      filterable: [],
    },
    useSeeder: { count: 0 },
    // No API surface: receipts are engine bookkeeping, not application data.
  },

  attributes: {
    commandId: {
      order: 1,
      fillable: true,
      unique: true,
      validation: { rule: schema.string().required().max(200) },
      factory: faker => faker.string.alphanumeric({ length: 24 }),
    },

    seqs: {
      order: 2,
      fillable: true,
      // JSON array of the sequence numbers this command produced, so a retry
      // can return the same events without re-deriving them.
      validation: { rule: schema.string() },
      factory: () => '[]',
    },

    at: {
      order: 3,
      fillable: true,
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },
  },

  dashboard: { enabled: false },
} as const)
