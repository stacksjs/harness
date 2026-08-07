import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A configured agent CLI, owned by a profile.
 *
 * Belonging to a profile rather than to the app is what lets one profile hold
 * a personal Claude account and another a work one: the driver keys its probe
 * cache by binary plus resolved HOME, so two instances do not cross-contaminate
 * account metadata.
 *
 * Credentials are **not** here. They live in the OS keychain via
 * `@stacksjs/desktop`; this row only records where to find the binary and which
 * HOME to run it under.
 */
export default defineModel({
  name: 'ProviderInstance',
  table: 'provider_instances',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'driverKind', 'status', 'profileId'],
      searchable: ['driverKind'],
      sortable: ['createdAt'],
      filterable: ['profileId', 'driverKind', 'status'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'provider-instances',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
      middleware: ['auth'],
    },
  },

  belongsTo: ['Profile'],

  attributes: {
    profileId: {
      order: 1,
      fillable: true,
      validation: { rule: schema.number().required() },
      factory: () => 1,
    },

    driverKind: {
      order: 2,
      fillable: true,
      validation: { rule: schema.enum(['claude', 'codex', 'cursor', 'opencode', 'grok']) },
      factory: () => 'claude',
    },

    config: {
      order: 3,
      fillable: true,
      // JSON, decoded against the driver's own schema at construction. Kept
      // opaque here so adding a driver option is not a migration.
      validation: { rule: schema.string() },
      factory: () => '{}',
    },

    status: {
      order: 4,
      fillable: true,
      // `unavailable` is a first-class state, not an error: a driver whose
      // binary is absent must surface as a shadow entry the UI can explain,
      // rather than crashing the registry.
      validation: { rule: schema.enum(['unknown', 'ready', 'unauthenticated', 'unavailable', 'failed']) },
      factory: () => 'unknown',
    },

    binaryPath: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => '',
    },

    resolvedHome: {
      order: 6,
      fillable: true,
      // The HOME this instance runs under. Two profiles pointing at two HOMEs
      // is how multi-account works.
      validation: { rule: schema.string().max(4000) },
      factory: () => '',
    },

    version: {
      order: 7,
      fillable: true,
      // Last probed CLI version. Providers change their protocols without
      // notice; recording what we saw makes a break diagnosable.
      validation: { rule: schema.string().max(120) },
      factory: () => '',
    },
  },

  dashboard: { enabled: false },
} as const)
