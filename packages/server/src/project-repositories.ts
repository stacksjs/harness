import type { Dirent } from 'node:fs'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface ProjectRepository {
  key: string
  label: string
}

const MAX_REPOSITORIES = 128
const MAX_SCAN_ENTRIES = 10_000
const MAX_CONFIG_BYTES = 128 * 1024

function projectRelative(root: string, target: string): string | null {
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null
  return path.split(sep).join('/')
}

async function folderEntries(folder: string, budget: { remaining: number }): Promise<Dirent[]> {
  if (budget.remaining <= 0) return []
  const handle = await opendir(folder).catch(() => null)
  if (!handle) return []
  const entries: Dirent[] = []
  try {
    for await (const entry of handle) {
      entries.push(entry)
      if (--budget.remaining === 0) break
    }
  }
  catch { return [] }
  return entries.sort((a, b) => a.name < b.name ? -1 : Number(a.name > b.name))
}

async function readConfig(path: string): Promise<unknown> {
  try {
    const info = await lstat(path)
    if (info.isFile() && info.size <= MAX_CONFIG_BYTES) return Bun.JSONC.parse(await readFile(path, 'utf8'))
  }
  catch { return undefined }
}

function stringMember(value: unknown, key: string): string {
  if (!value || typeof value !== 'object' || !(key in value)) return ''
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' && !field.includes('\0') ? field.trim() : ''
}

export async function projectWorktreeLayout(root: string) {
  const config = await readConfig(join(root, 't3.json'))
  const layout = config && typeof config === 'object' && 'worktreeLayout' in config ? config.worktreeLayout : undefined
  if (layout === undefined) return null
  const create = stringMember(layout, 'create')
  const remove = stringMember(layout, 'remove')
  if (!create) throw new Error('Set a nonempty worktreeLayout.create command in the project’s t3.json.')
  const fingerprint = new Bun.CryptoHasher('sha256').update(JSON.stringify([create, remove])).digest('hex')
  return { create, remove, fingerprint }
}

function listMember(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object' || !(key in value)) return []
  const field = (value as Record<string, unknown>)[key]
  return Array.isArray(field) ? field : []
}

function autoFolder(name: string): boolean {
  return !name.startsWith('.') && name !== 'node_modules'
}

function validRepositoryKey(key: string): boolean {
  return key.length <= 4096 && !key.includes('\\') && !key.includes('\0')
    && key.split('/').every(part => part && !/^(?:\.{1,2}|\.(?:git|hg|svn))$/iu.test(part))
}

async function projectConfig(root: string, entries: Dirent[]) {
  const codeWorkspace = entries.find(entry => entry.isFile() && entry.name.endsWith('.code-workspace'))
  const [compatibility, workspace] = await Promise.all([
    readConfig(join(root, 't3.json')),
    codeWorkspace ? readConfig(join(root, codeWorkspace.name)) : undefined,
  ])
  const ignored = listMember(compatibility, 'ignoreRepositories').flatMap((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.includes('\0')) return []
    const path = projectRelative(root, resolve(root, entry.trim()))
    return path === null ? [] : [path]
  })
  const listed = new Map<string, string>()
  for (const folder of listMember(workspace, 'folders')) {
    const path = stringMember(folder, 'path')
    const key = path ? projectRelative(root, resolve(root, path)) : null
    if (key && validRepositoryKey(key) && !listed.has(key))
      listed.set(key, stringMember(folder, 'name').slice(0, 128) || basename(key))
  }
  return { listed, ignored }
}

function ignoredRepository(key: string, ignored: string[]): boolean {
  return ignored.some(path => !path || key === path || key.startsWith(`${path}/`))
}

async function ownedRepository(root: string, key: string): Promise<boolean> {
  if (!validRepositoryKey(key)) return false
  const path = join(root, key)
  const canonical = await realpath(path).catch(() => null)
  if (canonical !== path) return false
  return (await lstat(join(path, '.git')).catch(() => null))?.isDirectory() ?? false
}

export async function scanProjectRepositories(folder: string): Promise<ProjectRepository[]> {
  const root = await realpath(folder).catch(() => null)
  if (!root) return []
  const budget = { remaining: MAX_SCAN_ENTRIES }
  const entries = await folderEntries(root, budget)
  const { listed, ignored } = await projectConfig(root, entries)
  const repositories = new Map<string, ProjectRepository>()
  const add = async (key: string, label: string) => {
    if (repositories.size < MAX_REPOSITORIES && !repositories.has(key) && !ignoredRepository(key, ignored)
      && await ownedRepository(root, key)) repositories.set(key, { key, label })
  }

  for (const [key, label] of listed) await add(key, label)
  for (const entry of entries) {
    if (repositories.size >= MAX_REPOSITORIES || ignored.includes('')) break
    if (!entry.isDirectory() || !autoFolder(entry.name) || ignoredRepository(entry.name, ignored)) continue
    await add(entry.name, entry.name)
    if (await lstat(join(root, entry.name, '.git')).catch(() => null)) continue
    for (const child of await folderEntries(join(root, entry.name), budget)) {
      if (repositories.size >= MAX_REPOSITORIES) break
      if (child.isDirectory() && autoFolder(child.name))
        await add(`${entry.name}/${child.name}`, child.name)
    }
  }
  return [...repositories.values()]
}

/** Apply the same project scope to a requested diff as to the repository list. */
export async function resolveProjectRepository(folder: string, key: string): Promise<string | null> {
  if (!validRepositoryKey(key)) return null
  const root = await realpath(folder).catch(() => null)
  if (!root) return null
  const parts = key.split('/')
  const auto = parts.length <= 2 && parts.every(autoFolder)
    && (parts.length === 1 || !await lstat(join(root, parts[0]!, '.git')).catch(() => null))
  const entries = auto ? [] : await folderEntries(root, { remaining: MAX_SCAN_ENTRIES })
  const { listed, ignored } = await projectConfig(root, entries)
  if ((!auto && !listed.has(key)) || ignoredRepository(key, ignored)) return null
  return await ownedRepository(root, key) ? join(root, key) : null
}
