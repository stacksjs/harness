import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * STX Configuration for Stacks
 * Note: Dashboard mode overrides these settings via serve() options
 */

export default {
  // Pinned rather than inferred. Auto-detection keys on the directory that
  // holds `views/` and `layouts/`, and this app deleted its scaffold
  // layouts/ — leaving the inference resting on one directory and a boot
  // warning asking for exactly this line.
  root: 'resources',

  // Where stx keeps everything it generates: the compiled-template cache, the
  // Crosswind CSS cache, client-script bundles, the route manifest and route
  // types. Stacks keeps every runtime-owned directory under storage/ rather
  // than a `.stx` in the project root - see `stxPath()` in @stacksjs/path,
  // which also exports this as STX_DIR for processes that never read a config.
  stateDir: 'storage/framework/stx',

  // Components, layouts and partials directories.
  //
  // These are resolved RELATIVE TO the stx root, which auto-detects as
  // `resources` in a Stacks app (it is the directory holding `views/` and
  // `layouts/`). Spelling them `resources/components` here made stx join the
  // root on a second time and look in `resources/resources/components`, so
  // `<Card />` in a template resolved to nothing and stx warned on every boot.
  componentsDir: 'components',

  // Expose @stacksjs/components' ui library (<Sidebar>, <Button>, ...)
  // to tag resolution everywhere — the dashboard's macOS-style sidebar
  // resolves through this. See the plugin file for the lookup order.
  plugins: ['./storage/framework/defaults/stx-components-plugin.ts'],

  layoutsDir: 'layouts',

  partialsDir: 'partials',

  // Report prohibited DOM usage in client scripts (stx-standards §8). Warn
  // only, permanently — a considered decision, not a pending flip:
  //
  // - The island is on refs/signals now, and precisely because it declares
  //   signals the pipeline wraps it as a __stx_setup_ script BEFORE this
  //   validator runs — the validator cannot see the page it was meant to
  //   guard. The real regression guards are scripts/drive-page.ts and
  //   source greps, both in CI.
  // - failOnViolation throws during render, so on pages only rendered in
  //   production (index.stx, coming-soon.stx — both documented §11.1
  //   exceptions with a handful of vanilla-DOM lines) it would turn a lint
  //   warning into a 500.
  strict: { enabled: true, failOnViolation: false },

  // Every page gets a real document shell — doctype, <html>, <head>, <body>.
  // Without it the harness view shipped as a bare fragment: no charset, no
  // viewport, no title, and the browser rendering in quirks mode.
  autoShell: true,

  // The one shared head (stx-standards §4.8): pages refine it, nothing
  // hand-writes <title> or <meta> tags in markup.
  app: {
    head: {
      title: 'harness',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'An agent harness control surface — drive Claude Code, Codex, Cursor and friends.' },
      ],
    },
  },

  // Whether this app serves the framework's default views, which include a
  // demo storefront (/cart, /checkout/*, /orders/:id) alongside the error
  // pages and mail previews. `true` serves all of them and is the historical
  // behaviour; `false` serves only `resources/views`; an array names the
  // subtrees to keep, e.g. `['errors', 'emails']`. Applies to `buddy dev` and
  // `buddy serve` alike, and to whatever the route manifest enumerates into
  // the sitemap.
  defaultViews: true,
// `plugins` landed in stx after the pinned @stacksjs/stx types — widen until the dep updates.
} satisfies UiOptions & {
  plugins?: string[]
  defaultViews?: boolean | string[]
  // `strict.enabled`/`failOnViolation` are what the runtime reads
  // (script-validation.js); the pinned types only know `bundlerFallback`.
  strict?: { enabled?: boolean, failOnViolation?: boolean }
}
