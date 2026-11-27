# Client stores

Use this directory for state shared across pages through `defineStore(...)`
(stx-standards §6.3). STX discovers TypeScript files here for page store
bundles. Keep page-specific helpers in `resources/client` and import them
from the views that use them.

Use a literal store ID and read it with `useStore('id')` inside
`onMount(...)`. The loader skips `index.ts`, `types.ts`, and declaration files.
