import { describe, expect, it } from 'bun:test'
import { ASSET_PREFIX, AssetCache } from '../src/assets'

/**
 * The cache is small, but it sits in front of every page request, and its two
 * failure modes are both silent: a stale asset served forever because the
 * cache headers promise immutability, or a page referencing an asset the
 * process cannot serve.
 */

const RUNTIME = {
  filename: 'runtime.abc123.js',
  contents: 'var stx = 1',
  contentType: 'text/javascript; charset=utf-8',
}

describe('serving shared assets', () => {
  it('serves an asset a render produced', async () => {
    const cache = new AssetCache()
    cache.remember([RUNTIME])

    const response = cache.respond(`${ASSET_PREFIX}/${RUNTIME.filename}`)

    expect(response?.status).toBe(200)
    expect(response?.headers.get('content-type')).toContain('javascript')
    expect(await response!.text()).toBe('var stx = 1')
  })

  it('promises immutability, which the content hash makes true', () => {
    // Safe only because the filename *is* the content hash: a change to the
    // runtime changes the URL, so a year-long max-age can never serve stale
    // code. Without that hash this header would be a bug.
    const cache = new AssetCache()
    cache.remember([RUNTIME])

    const cacheControl = cache.respond(`${ASSET_PREFIX}/${RUNTIME.filename}`)!.headers.get('cache-control')

    expect(cacheControl).toContain('immutable')
    expect(cacheControl).toContain('max-age=31536000')
  })

  it('ignores paths that are not ours, so page routes still match', () => {
    // Returning a 404 here instead of null would shadow `/` and every session
    // route with a not-found.
    const cache = new AssetCache()

    expect(cache.respond('/')).toBeNull()
    expect(cache.respond('/s/12')).toBeNull()
    expect(cache.respond('/health')).toBeNull()
  })

  it('404s an asset this process has not rendered', async () => {
    // A page held open across a restart asks for an asset the new process has
    // not produced yet. A 404 lets the browser recover with a reload; hanging
    // or throwing would not.
    const cache = new AssetCache()

    expect(cache.respond(`${ASSET_PREFIX}/runtime.gone.js`)?.status).toBe(404)
  })

  it('collapses the same asset across many renders', () => {
    // Content-addressed: every page inlines the same runtime, so the cache
    // must hold one entry, not one per request.
    const cache = new AssetCache()
    for (let i = 0; i < 50; i++) cache.remember([RUNTIME])

    expect(cache.size).toBe(1)
  })

  it('keeps distinct assets apart', () => {
    const cache = new AssetCache()
    cache.remember([RUNTIME, { filename: 'crosswind.d4d4.css', contents: '.a{}', contentType: 'text/css' }])

    expect(cache.size).toBe(2)
    expect(cache.respond(`${ASSET_PREFIX}/crosswind.d4d4.css`)?.headers.get('content-type')).toBe('text/css')
  })

  it('does not treat the prefix itself as an asset', () => {
    const cache = new AssetCache()

    expect(cache.respond(ASSET_PREFIX)).toBeNull()
  })
})
