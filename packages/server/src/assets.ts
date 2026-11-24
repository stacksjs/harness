/**
 * Serve the framework's shared assets and the client codec by content hash.
 */

import type { ExternalizedAsset } from '@stacksjs/stx'

/** Where externalized assets are mounted. Matches stx's own default. */
export const ASSET_PREFIX = '/_stx'

const IMMUTABLE = 'public, max-age=31536000, immutable'

export function respondStxAsset(pathname: string): Promise<Response> | null {
  const parts = /^\/_stx\/(?:(runtime|router|modules)\.([0-9a-f]{16})\.js|css\.([0-9a-f]{16})\.css)$/u.exec(pathname)
  if (!parts) return null
  const [, kind, scriptHash, cssHash] = parts
  return import('@stacksjs/stx').then(async (stx) => {
    let content: string | undefined
    if (cssHash)
      content = stx.getCssServeAsset(cssHash)
    else if (kind === 'modules' && scriptHash)
      content = stx.getServeModuleBundle(scriptHash)
    else if (kind === 'runtime' || kind === 'router') {
      const asset = await stx.getServeClientAsset(kind)
      if (asset.hash === scriptHash) content = asset.content
    }
    if (content === undefined) return new Response('not found', { status: 404 })
    return new Response(content, {
      headers: {
        'content-type': cssHash ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
        'cache-control': IMMUTABLE,
        'x-content-type-options': 'nosniff',
      },
    })
  })
}

export class AssetCache {
  private readonly assets = new Map<string, ExternalizedAsset>()

  /** Remember every asset a render produced. Content-addressed, so re-adding is free. */
  remember(assets: ExternalizedAsset[]): void {
    for (const asset of assets) this.assets.set(asset.filename, asset)
  }

  get size(): number {
    return this.assets.size
  }

  /**
   * Serve an asset, or null when the path is not one of ours.
   *
   * A miss on a well-formed path is still null rather than an error: it means
   * a page from before a restart is asking for an asset this process has not
   * rendered yet, and a 404 lets the browser recover by reloading.
   */
  respond(pathname: string): Response | null {
    if (!pathname.startsWith(`${ASSET_PREFIX}/`)) return null
    const asset = this.assets.get(pathname.slice(ASSET_PREFIX.length + 1))
    if (!asset) return new Response('not found', { status: 404 })

    return new Response(asset.contents, {
      headers: {
        'content-type': asset.contentType,
        // The hash is the filename, so this content is this URL forever.
        'cache-control': IMMUTABLE,
      },
    })
  }
}
