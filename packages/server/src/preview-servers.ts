import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isLoopbackHost } from './access'
import type { PreviewServer, PreviewServerSnapshot } from './browser-preview'

const exec = promisify(execFile)
const commandOptions = { timeout: 2_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } } as const

export function terminalDescendants(output: string, roots: readonly number[]): Set<number> {
  const children = new Map<number, number[]>()
  const present = new Set<number>()
  for (const row of output.trim().split('\n')) {
    const [pid = 0, parent = -1] = row.trim().split(/\s+/u).map(Number)
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parent) || parent < 0) continue
    present.add(pid)
    const group = children.get(parent) ?? []
    group.push(pid)
    children.set(parent, group)
  }
  const owned = new Set(roots.filter(root => present.has(root)))
  for (const owner of owned) for (const child of children.get(owner) ?? []) owned.add(child)
  return owned
}

function listener(address: string, processName: string, ipv6: boolean): PreviewServer | undefined {
  const match = /^(.+):(\d{1,5})$/u.exec(address)
  if (!match) return
  const [, bind = '', port = ''] = match
  if (Number(port) < 1 || Number(port) > 65535) return
  // Wildcard listeners can be reached through the corresponding loopback interface.
  const host = bind === '*' ? (ipv6 ? '[::1]' : '127.0.0.1')
    : bind === '0.0.0.0' ? '127.0.0.1' : ['[::]', '::', '::1'].includes(bind) ? '[::1]' : bind
  if (!isLoopbackHost(host)) return
  const url = new URL(`http://${host}:${port}`)
  return { url: url.href, label: processName.trim().slice(0, 80) || 'Local server' }
}

export function parsePreviewListeners(output: string, owned: ReadonlySet<number>, format: 'lsof' | 'ss', ipv6 = false): PreviewServer[] {
  const servers = new Map<string, PreviewServer>()
  const add = (address: string, name: string) => {
    const entry = listener(address, name, ipv6)
    if (entry && !servers.has(entry.url)) servers.set(entry.url, entry)
  }
  if (format === 'lsof') {
    let pid = 0
    let name = ''
    for (const raw of output.split('\0')) {
      const field = raw.replace(/^\n/u, '')
      if (field.startsWith('p')) { pid = Number(field.slice(1)); name = '' }
      else if (field.startsWith('c')) name = field.slice(1)
      else if (field.startsWith('t')) ipv6 = field === 'tIPv6'
      else if (field.startsWith('n') && owned.has(pid)) add(field.slice(1), name)
    }
  }
  else {
    for (const row of output.split('\n')) {
      const match = /^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+\s+(.*)$/u.exec(row.trim())
      if (!match) continue
      const [, address = '', processes = ''] = match
      for (const owner of processes.matchAll(/\("([^"\r\n]*)",pid=(\d+),fd=\d+\)/gu)) {
        if (owned.has(Number(owner[2]))) add(address, owner[1] ?? '')
      }
    }
  }
  return [...servers.values()].sort((left, right) => left.url.localeCompare(right.url, 'en', { numeric: true })).slice(0, 24)
}

/** Local socket metadata only. Opening a listed URL remains a separate browser action. */
export async function readPreviewServers(roots: readonly number[]): Promise<PreviewServerSnapshot> {
  const ss = process.platform === 'linux' ? Bun.which('ss') : null
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : Bun.which('lsof')
  const ps = Bun.which('ps')
  if (!ps || (!ss && !lsof) || (process.platform !== 'linux' && process.platform !== 'darwin')) return { status: 'unavailable', servers: [] }
  if (!roots.length) return { status: 'ready', servers: [] }
  try {
    const table = await exec(ps, ['-A', '-o', 'pid=,ppid='], commandOptions)
    const owned = terminalDescendants(table.stdout, roots)
    if (!owned.size) return { status: 'ready', servers: [] }
    const scans = ss
      ? await Promise.all(['-4', '-6'].map(family => exec(ss, [family, '-H', '-ltnp'], commandOptions)))
      : [await exec(lsof!, ['-nP', '-a', '-p', [...owned].join(','), '-iTCP', '-sTCP:LISTEN', '-F0pctn'], commandOptions)
        .catch((error) => {
          if (error.code === 1 && !error.stderr && !error.killed) return { stdout: error.stdout ?? '' }
          throw error
        })]
    const current = terminalDescendants((await exec(ps, ['-A', '-o', 'pid=,ppid='], commandOptions)).stdout, roots)
    for (const pid of owned) if (!current.has(pid)) owned.delete(pid)
    return { status: 'ready', servers: scans.flatMap((scan, index) => parsePreviewListeners(scan.stdout, owned, ss ? 'ss' : 'lsof', index === 1)).slice(0, 24) }
  }
  catch { return { status: 'unavailable', servers: [] } }
}
