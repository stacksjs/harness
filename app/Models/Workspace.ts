import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A checkout on disk that sessions run against.
 *
 * `trusted` is the gate from PLAN.md §12: an untrusted workspace does not load
 * project-level config, does not install packages and does not run project
 * extensions. It defaults to false, and nothing grants it except an explicit
 * decision by the user.
 */
export default defineModel({
  name: 'Workspace',
  table: 'workspaces',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'path', 'profileId'],
      searchable: ['name', 'path'],
      sortable: ['name', 'createdAt'],
      filterable: ['profileId', 'trusted'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'workspaces',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
      middleware: ['auth'],
    },
  },

  belongsTo: ['Profile'],
  hasMany: ['Session'],

  attributes: {
    profileId: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    name: {
      order: 2,
      fillable: true,
      validation: { rule: schema.string().required().min(1).max(200) },
      factory: faker => faker.system.fileName(),
    },

    path: {
      order: 3,
      fillable: true,
      // Absolute path to the checkout. The server is the execution boundary,
      // so this is only ever resolved server-side.
      validation: { rule: schema.string().required().max(4000) },
      factory: () => '/tmp/workspace',
    },

    vcsRoot: {
      order: 4,
      fillable: true,
      // Repository root, which may be an ancestor of `path` when the workspace
      // is a subdirectory of a monorepo.
      validation: { rule: schema.string().max(4000) },
      factory: () => '',
    },

    defaultBranch: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(200) },
      factory: () => 'main',
    },

    trusted: {
      order: 6,
      fillable: true,
      // Never defaults true, and is not inferred from anything. An agent
      // harness is a remote-code-execution surface; trust is a decision, not a
      // heuristic.
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },

  dashboard: { enabled: false },
} as const)
