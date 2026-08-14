# Client stores

A fact used by more than one page belongs here as a `defineStore(...)` file,
not in a per-page signal (stx-standards §6.3). The store loader globs `*.ts`
in this directory — non-recursively — and concatenates every file into one
shared IIFE, which shapes the rules:

- No value imports (`import type` is fine); single-line value imports are
  silently deleted, multi-line ones break the whole bundle.
- Never name a file `index.ts` or `types.ts` — both are skipped silently.
- Top-level identifiers must be unique across every file here.
- Read stores with `useStore('id')` inside `onMount(...)` so the mount
  wrapper is guaranteed.

Harness has no cross-page client fact yet — the surface is one page — so the
directory is empty. It exists so the first store lands in the right place
instead of in a view.
