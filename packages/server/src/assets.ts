/**
 * Shared page assets, served once instead of inlined every render.
 *
 * stx inlines the signals runtime, the router and the generated stylesheet
 * directly into the HTML. For a static build that is a per-page cost; for a
 * server it is a per-*request* cost, and nothing bounds it. Measured on the
 * harness page: 392KB, of which 159KB is the runtime and 33KB is component
 * code, all byte-identical on every request.
 *
 * `externalizeHtml` (stx) lifts those blobs out and hands back the rewritten
 * HTML plus content-addressed assets. This keeps them in memory and serves them
 * under `/_stx/`, immutable — the filename contains the content hash, so a URL
 * can never go stale and the browser never revalidates.
 *
 * In memory rather than on disk on purpose: the assets are derived from the
 * render, a restart re-derives them, and a cache that outlives the process
 * would be one more thing that can disagree with the code that produced it.
 */

import type { ExternalizedAsset } from '@stacksjs/stx'

/** Where externalized assets are mounted. Matches stx's own default. */
export const ASSET_PREFIX = '/_stx'

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
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  }
}
