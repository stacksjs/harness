/**
 * The wire codec, bundled for the browser.
 *
 * The page speaks CBOR to the socket, so it needs `encode`/`decode` — the same
 * implementation the server uses, not a second one. Shipping the contract
 * package itself is what keeps a frame the server can write always a frame the
 * page can read; a hand-written browser copy would be a codec that agrees with
 * the server only until someone edits one of them.
 *
 * Built once at startup rather than per request, and content-addressed like
 * every other shared asset, so it is fetched once per deploy and never
 * revalidated.
 *
 * `@harness/contract` is pure — no imports beyond a type — so this bundle is
 * small and has no server-only code to strip.
 */

import type { ExternalizedAsset } from '@stacksjs/stx'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Re-exported, not assigned to globals: the island is a module and imports it,
 * so the codec is scoped to the code that uses it rather than being two more
 * names on `window` that anything could overwrite.
 */
const ENTRY = `export { encode, decode } from '@harness/contract'
export { Terminal, toHtml } from '@harness/ansi'`

let cached: ExternalizedAsset | null = null

/**
 * Build the codec bundle, or null when the contract source cannot be found.
 *
 * Null rather than throwing: a missing bundle costs the page its live updates,
 * and the server refusing to start would cost it everything.
 */
export async function buildClientCodec(): Promise<ExternalizedAsset | null> {
  if (cached) return cached

  const contract = join(process.cwd(), 'packages/contract/src/index.ts')
  if (!existsSync(contract)) return null

  const built = await Bun.build({
    entrypoints: ['./client-codec-entry.ts'],
    target: 'browser',
    format: 'esm',
    minify: true,
    plugins: [{
      name: 'harness-codec-entry',
      setup(build) {
        // A virtual entry, so nothing has to be written to the repo just to
        // name two exports.
        build.onResolve({ filter: /^\.\/client-codec-entry\.ts$/ }, () => ({
          path: 'client-codec-entry.ts',
          namespace: 'harness-codec',
        }))
        build.onLoad({ filter: /.*/, namespace: 'harness-codec' }, () => ({
          contents: ENTRY,
          loader: 'ts',
          resolveDir: process.cwd(),
        }))
      },
    }],
  })

  const output = built.outputs[0]
  if (!built.success || !output) return null

  const contents = await output.text()
  cached = {
    filename: `codec.${Bun.hash(contents).toString(16).slice(0, 8)}.js`,
    contents,
    contentType: 'text/javascript; charset=utf-8',
  }
  return cached
}
