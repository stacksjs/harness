import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A profile is a workspace/project: its own repos, sessions, agents, MCP
 * servers, env and credentials. Profiles are the Arc-style "spaces" in the
 * sidebar — you swipe between them, and each carries its own colour.
 *
 * Provider instances hang off the profile rather than off the app, which is
 * what lets one profile hold a personal Claude account and another a work one,
 * each with its own resolved HOME.
 */
export default defineModel({
  name: 'Profile',
  table: 'profiles',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'position', 'createdAt'],
      searchable: ['name'],
      sortable: ['position', 'name', 'createdAt'],
      filterable: ['archived'],
    },
    useSeeder: { count: 0 },
    useApi: {
      uri: 'profiles',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
      middleware: ['auth'],
    },
  },

  hasMany: ['Workspace', 'ProviderInstance'],

  attributes: {
    name: {
      order: 1,
      fillable: true,
      validation: { rule: schema.string().required().min(1).max(120) },
      factory: faker => faker.company.name(),
    },

    icon: {
      order: 2,
      fillable: true,
      // SF Symbol name. Used by the native space switcher and, where the web
      // rail renders instead, as an iconify class.
      validation: { rule: schema.string().max(80) },
      factory: () => 'square.stack.fill',
    },

    tint: {
      order: 3,
      fillable: true,
      // Either a seed colour (`#5aa9ee`, `blue`, an oklch() string) or a full
      // light/dark palette as JSON. stx's <Sidebar :spaces> accepts both and
      // mixes the rest, so we store whatever was given rather than resolving
      // it here — a brand colour should not become a second-class citizen by
      // being flattened on the way in.
      validation: { rule: schema.string().max(2000) },
      factory: faker => faker.helpers.arrayElement(['blue', 'green', 'violet', 'amber', 'rose']),
    },

    position: {
      order: 4,
      fillable: true,
      // Order in the switcher. Lower is further left.
      validation: { rule: schema.number().min(0) },
      factory: () => 0,
    },

    settings: {
      order: 5,
      fillable: true,
      // Per-profile overrides as JSON: default provider, MCP servers, env.
      // Free-form on purpose — this is the seam where a profile grows
      // features without a migration each time.
      validation: { rule: schema.string() },
      factory: () => '{}',
    },

    lastActiveWorkspaceId: {
      order: 6,
      fillable: true,
      // Persisted server-side so a phone and a desktop agree on where you left
      // off. The client also keeps its own localStorage copy for instant
      // restore before the socket connects; this one is the tie-breaker.
      validation: { rule: schema.number() },
      factory: () => 0,
    },

    archived: {
      order: 7,
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },
  },

  dashboard: { enabled: false },
} as const)
