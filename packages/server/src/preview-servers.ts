import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { promisify } from 'node:util'
import { PREVIEW_THREAD_ENV } from '@harness/drivers'
import { isLoopbackHost } from './access'
import type { PreviewServer, PreviewServerSnapshot } from './browser-preview'

const exec = promisify(execFile)
const commandOptions = { timeout: 2_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } } as const
const argvDebugPort = /(?:^|\s)--remote-debugging-port(?:=|\s|$)/u
const macOwner = new RegExp(`(?:^|\\s)${PREVIEW_THREAD_ENV}=([a-f0-9]{64})(?=\\s|$)`, 'g')
const linuxOwner = new RegExp(`(?:^|\\0)${PREVIEW_THREAD_ENV}=([a-f0-9]{64})(?=\\0)`, 'g')

interface ListeningSocket extends PreviewServer {
  pid: number
}

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

export function parsePreviewListeners(output: string, format: 'lsof' | 'ss', ipv6 = false): ListeningSocket[] {
  const servers: ListeningSocket[] = []
  const add = (pid: number, address: string, name: string) => {
    const entry = listener(address, name, ipv6)
    if (entry && Number.isSafeInteger(pid) && pid > 0) servers.push({ ...entry, pid })
  }
  if (format === 'lsof') {
    let pid = 0
    let name = ''
    for (const raw of output.split('\0')) {
      const field = raw.replace(/^\n/u, '')
      if (field.startsWith('p')) { pid = Number(field.slice(1)); name = '' }
      else if (field.startsWith('c')) name = field.slice(1)
      else if (field.startsWith('t')) ipv6 = field === 'tIPv6'
      else if (field.startsWith('n')) add(pid, field.slice(1), name)
    }
  }
  else {
    for (const row of output.split('\n')) {
      const match = /^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+\s+(.*)$/u.exec(row.trim())
      if (!match) continue
      const [, address = '', processes = ''] = match
      for (const owner of processes.matchAll(/\("([^"\r\n]*)",pid=(\d+),fd=\d+\)/gu)) {
        add(Number(owner[2]), address, owner[1] ?? '')
      }
    }
  }
  return servers
}

async function readListeningSockets(): Promise<ListeningSocket[]> {
  const ss = process.platform === 'linux' ? Bun.which('ss') : null
  const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : Bun.which('lsof')
  if (ss) {
    const scans = await Promise.all(['-4', '-6'].map(family => exec(ss, [family, '-H', '-ltnp'], commandOptions)))
    return scans.flatMap((scan, index) => parsePreviewListeners(scan.stdout, 'ss', index === 1))
  }
  const uid = process.getuid?.()
  if (!lsof || uid === undefined) throw new Error('Socket listing is unavailable')
  const scan = await exec(lsof, ['-nP', '-a', '-u', String(uid), '-iTCP', '-sTCP:LISTEN', '-F0pctn'], commandOptions)
    .catch((error) => {
      if (error.code === 1 && !error.stderr && !error.killed) return { stdout: error.stdout ?? '' }
      throw error
    })
  return parsePreviewListeners(scan.stdout, 'lsof')
}

async function readProc(pid: number, name: 'cmdline' | 'environ' | 'stat'): Promise<string> {
  const file = await open(`/proc/${pid}/${name}`, 'r')
  try {
    const buffer = Buffer.allocUnsafe(128 * 1024)
    const { bytesRead } = await file.read(buffer)
    return buffer.toString('utf8', 0, bytesRead)
  }
  finally { await file.close() }
}

function singleOwner(environment: string, pattern: RegExp): string | undefined {
  const matches = environment.matchAll(pattern)
  const first = matches.next().value?.[1]
  return matches.next().done ? first : undefined
}

async function macPreviewOwners(ps: string, pids: number[]): Promise<Array<[number, string]>> {
  const columns = ['-p', pids.join(','), '-o', 'pid=,ppid=,command=']
  const rows = (output: string) => output.split('\n').flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
    return row ? [[Number(row[1]), Number(row[2]), row[3] ?? ''] as const] : []
  })
  const read = (flags: string) => exec(ps, [flags, ...columns], commandOptions)
    .catch((error) => {
      if (error.code === 1 && !error.stderr && !error.killed) return { stdout: error.stdout ?? '' }
      throw error
    })
  const [commands, environments] = await Promise.all([read('ww'), read('eww')])
  const commandByPid = new Map(rows(commands.stdout).map(([pid, parent, command]) => [pid, { parent, command }]))
  return rows(environments.stdout).flatMap(([pid, parent, value]) => {
    const argv = commandByPid.get(pid)
    if (!argv?.command || parent !== argv.parent || parent === process.pid
      || argvDebugPort.test(argv.command) || !value.startsWith(argv.command + ' ')) return []
    const owner = singleOwner(value.slice(argv.command.length + 1), macOwner)
    return owner ? [[pid, owner]] : []
  })
}

async function linuxPreviewOwners(pids: number[]): Promise<Array<[number, string]>> {
  const matches = await Promise.all(pids.map(async (pid): Promise<[number, string] | undefined> => {
    try {
      // The executable name in proc stat can include spaces and parentheses.
      const stat = await readProc(pid, 'stat')
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      if (!Number.isSafeInteger(parent) || parent === process.pid) return
      const owner = singleOwner(await readProc(pid, 'environ'), linuxOwner)
      if (owner && !argvDebugPort.test((await readProc(pid, 'cmdline')).replaceAll('\0', ' '))) return [pid, owner]
    }
    catch { /* The process can exit or disallow inspection between reads. */ }
  }))
  return matches.filter(match => match !== undefined)
}

interface SocketInventory {
  sockets: ListeningSocket[]
  providerOwners: Map<number, string>
}

let pendingInventory: Promise<SocketInventory> | undefined

function listenerInventory(ps: string): Promise<SocketInventory> {
  return pendingInventory ??= (async () => {
    const sockets = await readListeningSockets()
    const pids = [...new Set(sockets.map(socket => socket.pid))].filter(pid => pid !== process.pid)
    const providerOwners = new Map<number, string>()
    // Batch the environment lookups to bound the number of open proc files
    // and the amount of environment data a single ps invocation can return.
    for (let start = 0; start < pids.length; start += 32) {
      const batch = pids.slice(start, start + 32)
      const matches = await (process.platform === 'darwin' ? macPreviewOwners(ps, batch) : linuxPreviewOwners(batch))
      for (const [pid, owner] of matches) providerOwners.set(pid, owner)
    }
    return { sockets, providerOwners }
  })().finally(() => { pendingInventory = undefined })
}

/** Local socket metadata only. Opening a listed URL remains a separate browser action. */
export async function readPreviewServers(roots: readonly number[], providerOwner?: string): Promise<PreviewServerSnapshot> {
  const ps = Bun.which('ps')
  if (!ps || (process.platform !== 'linux' && process.platform !== 'darwin')) return { status: 'unavailable', servers: [] }
  if (!roots.length && !providerOwner) return { status: 'ready', servers: [] }
  try {
    const terminalProcesses = async () => roots.length
      ? terminalDescendants((await exec(ps, ['-A', '-o', 'pid=,ppid='], commandOptions)).stdout, roots)
      : new Set<number>()
    const before = await terminalProcesses()
    const { sockets, providerOwners } = await listenerInventory(ps)
    const after = await terminalProcesses()
    const servers = new Map<string, PreviewServer>()
    for (const { pid, url, label } of sockets) {
      if ((before.has(pid) && after.has(pid)) || (providerOwner && providerOwners.get(pid) === providerOwner)) {
        if (!servers.has(url)) servers.set(url, { url, label })
      }
    }
    return { status: 'ready', servers: [...servers.values()].sort((a, b) => a.url.localeCompare(b.url, 'en', { numeric: true })).slice(0, 24) }
  }
  catch { return { status: 'unavailable', servers: [] } }
}
