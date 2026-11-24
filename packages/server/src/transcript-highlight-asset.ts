import { existsSync } from 'node:fs'
import { ASSET_PREFIX } from './assets'

export const TRANSCRIPT_HIGHLIGHT_WORKER = `${ASSET_PREFIX}/transcript-highlight.js`

let workerSource: Promise<string | undefined> | undefined

async function buildWorker(): Promise<string | undefined> {
  const entry = 'packages/server/src/transcript-highlight-worker.ts'
  if (!existsSync(entry)) return
  const license = await Bun.file(new URL('../LICENSE', import.meta.resolve('highlight.js'))).text()
  const result = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    format: 'esm',
    minify: true,
    banner: '/*!\n' + license + '\n*/',
  })
  if (result.success) return result.outputs[0]?.text()
}

export async function respondTranscriptHighlightWorker(request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
  workerSource ??= buildWorker().catch(() => undefined)
  const contents = await workerSource
  if (contents === undefined) return new Response('not found', { status: 404 })

  const etag = '"' + Bun.hash(contents).toString(16) + '"'
  const headers = {
    'cache-control': 'private, no-cache',
    'etag': etag,
    'content-type': 'text/javascript; charset=utf-8',
    'x-content-type-options': 'nosniff',
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  return new Response(contents, { headers })
}
