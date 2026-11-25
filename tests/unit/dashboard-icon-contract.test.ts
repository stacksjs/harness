import { describe, expect, test } from 'bun:test'
import f7 from '@iconify-json/f7/icons.json'
import hugeicons from '@iconify-json/hugeicons/icons.json'
import { join } from 'node:path'

const dashboardRoots = [
  join(process.cwd(), 'storage/framework/defaults/views/dashboard'),
  join(process.cwd(), 'storage/framework/defaults/resources/components/Dashboard'),
]

async function dashboardIconTokens(): Promise<string[]> {
  const tokens = new Set<string>()
  const glob = new Bun.Glob('**/*.{stx,ts}')

  for (const root of dashboardRoots) {
    for await (const file of glob.scan({ cwd: root, absolute: true })) {
      const source = await Bun.file(file).text()
      for (const match of source.matchAll(/\bi-[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g))
        tokens.add(match[0])
    }
  }

  return [...tokens].sort()
}

describe('dashboard icon contract', () => {
  // Stacks ships Hugeicons for the dashboard and Framework7 for native settings.
  test('every dashboard icon belongs to a bundled collection', async () => {
    const collections: Record<string, { icons: Record<string, unknown>, aliases?: Record<string, unknown> }> = {
      'i-hugeicons-': hugeicons,
      'i-f7-': f7,
    }
    const tokens = await dashboardIconTokens()
    const prefixOf = (token: string) => Object.keys(collections).find(prefix => token.startsWith(prefix))
    const unexpectedCollections = tokens.filter(token => !prefixOf(token))
    const missingNames = tokens.filter((token) => {
      const prefix = prefixOf(token)
      if (!prefix)
        return false
      const name = token.slice(prefix.length)
      const collection = collections[prefix]!
      return !(name in collection.icons) && !(name in (collection.aliases || {}))
    })

    expect(tokens.length).toBeGreaterThan(150)
    expect(unexpectedCollections).toEqual([])
    expect(missingNames).toEqual([])
  })
})
