import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { resolveWorkspaceEntry } from './workspace-files'

const INDEX_LIMIT = 25_000
const INDEX_BYTES = 2 * 1024 * 1024
const RESULT_LIMIT = 24
const ignoredDirectories = new Set(['.git', '.hg', '.svn', 'node_modules'])

async function gitFileNames(root: string): Promise<string[] | undefined> {
  try {
    const child = Bun.spawn(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', signal: AbortSignal.timeout(3000),
    })
    const paths = new Set<string>()
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    let pending = ''
    let bytes = 0
    let limited = false
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > INDEX_BYTES) { limited = true; break }
        const fields = (pending + decoder.decode(value, { stream: true })).split('\0')
        pending = fields.pop() ?? ''
        for (const path of fields) paths.add(path)
        if (paths.size >= INDEX_LIMIT) { limited = true; break }
      }
    }
    finally {
      if (limited) child.kill()
      reader.releaseLock()
    }
    return (await child.exited === 0 || limited) ? Array.from(paths).slice(0, INDEX_LIMIT) : undefined
  }
  catch {
    return undefined
  }
}

async function directoryFileNames(root: string): Promise<string[]> {
  const frontier = ['']
  const paths: string[] = []
  let inspected = 0
  for (let index = 0; index < frontier.length; index++) {
    const parent = frontier[index]!
    const directory = await opendir(join(root, parent)).catch(() => null)
    if (!directory) continue
    for await (const entry of directory) {
      if (++inspected > INDEX_LIMIT) return paths
      const path = parent ? `${parent}/${entry.name}` : entry.name
      if (entry.isDirectory() && !ignoredDirectories.has(entry.name.toLowerCase())) frontier.push(path)
      if (entry.isFile()) paths.push(path)
    }
  }
  return paths
}

async function visibleFile(root: string, name: string): Promise<boolean> {
  const path = name ? await resolveWorkspaceEntry(root, name) : null
  return path ? await stat(path).then(info => info.isFile(), () => false) : false
}

export function createWorkspaceFileSearch() {
  const indices = new Map<string, { until: number, paths: Promise<string[]> }>()
  return async (workspace: string, query: string, refresh = false): Promise<string[]> => {
    const root = await realpath(workspace)
    let index = indices.get(root)
    if (!index || refresh || index.until <= Date.now()) {
      index = { until: Date.now() + 2000, paths: gitFileNames(root).then(paths => paths ?? directoryFileNames(root)) }
      indices.delete(root)
      indices.set(root, index)
      if (indices.size > 4) indices.delete(indices.keys().next().value!)
    }
    const needle = query.slice(0, 200).toLowerCase().normalize('NFC')
    const terms = needle.split(/\s+/u).filter(Boolean)
    const matches = (await index.paths).flatMap((path) => {
      const folded = path.toLowerCase().normalize('NFC')
      if (!terms.every(term => folded.includes(term))) return []
      const file = basename(folded)
      const rank = file === needle ? 0 : file.startsWith(needle) ? 1 : file.includes(needle) ? 2 : 3
      return [{ path, rank }]
    }).sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || a.path.localeCompare(b.path))
    const results: string[] = []
    for (let start = 0; start < matches.length && results.length < RESULT_LIMIT; start += RESULT_LIMIT) {
      const batch = matches.slice(start, start + RESULT_LIMIT)
      const available = await Promise.all(batch.map(({ path }) => visibleFile(root, path)))
      for (const [position, result] of batch.entries()) if (available[position]) results.push(result.path)
    }
    return results.slice(0, RESULT_LIMIT)
  }
}
