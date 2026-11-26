import { createHash, randomUUID } from 'node:crypto'
import { constants, open } from 'node:fs/promises'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

export interface ProjectScriptInput {
  name: string
  command: string
  previewUrl: string
  autoOpenPreview: boolean
  stopOnSettle: boolean
  runOnWorktreeCreate?: boolean
  waitForSetup?: boolean
}

export interface ProjectScript extends ProjectScriptInput {
  id: string
}

const maxScripts = 50
const maxProjectFileBytes = 128 * 1024
export const scriptIdPattern = /^[0-9a-f-]{36}$/u

export class ProjectScriptError extends Error {}

export function projectScriptInput(value: unknown): ProjectScriptInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProjectScriptError('Enter a name and command.')
  const input = value as Record<string, unknown>
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const command = typeof input.command === 'string' ? input.command.trim() : ''
  if (!name || name.length > 96 || /[\x00-\x1F\x7F]/u.test(name)) throw new ProjectScriptError('Enter a script name of up to 96 characters.')
  if (!command || command.length > 4096 || /[\x00-\x08\x0B-\x1F\x7F]/u.test(command)) throw new ProjectScriptError('Enter a shell command of up to 4096 characters.')
  let previewUrl = typeof input.previewUrl === 'string' ? input.previewUrl.trim() : ''
  if (previewUrl) {
    try {
      const address = new URL(previewUrl)
      if (previewUrl.length > 4096 || /[\x00-\x20\x7F\\]/u.test(previewUrl)
        || !['http:', 'https:'].includes(address.protocol) || address.username || address.password)
        throw new Error('invalid preview URL')
      previewUrl = address.href
    }
    catch { throw new ProjectScriptError('Enter a full HTTP or HTTPS preview URL without credentials.') }
  }
  return {
    name, command, previewUrl,
    autoOpenPreview: Boolean(previewUrl) && input.autoOpenPreview === true,
    stopOnSettle: input.stopOnSettle === true,
    ...(input.runOnWorktreeCreate === true && { runOnWorktreeCreate: true, waitForSetup: input.waitForSetup === true }),
  }
}

/** Read checked-in actions on request. Importing records a snapshot for review and execution. */
export async function readProjectScriptImports(root: string): Promise<Array<ProjectScriptInput & { key: string }>> {
  try {
    const file = await open(join(root, 't3.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > maxProjectFileBytes) throw new ProjectScriptError('t3.json must be a regular file of at most 128 KB.')
      const buffer = Buffer.alloc(maxProjectFileBytes + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > maxProjectFileBytes) throw new ProjectScriptError('t3.json must be at most 128 KB.')
      const config: unknown = JSON.parse(buffer.toString('utf8', 0, bytesRead))
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ProjectScriptError('t3.json must contain a JSON object.')
      if (!('scripts' in config)) return []
      if (!Array.isArray(config.scripts) || config.scripts.length > maxScripts) throw new ProjectScriptError('t3.json must contain at most 50 scripts.')
      return config.scripts.map((entry) => {
        const input = projectScriptInput(entry && typeof entry === 'object' ? { ...entry, waitForSetup: entry.async === false } : entry)
        return { ...input, key: createHash('sha256').update(JSON.stringify(input)).digest('hex') }
      })
    }
    finally { await file.close() }
  }
  catch (error) {
    if (error instanceof ProjectScriptError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new ProjectScriptError('Could not read t3.json. Check that it is a valid JSON file in this checkout.')
  }
}

/** Private host data. Commands are kept out of event replay and device subscriptions. */
export class ProjectScripts {
  private readonly db: Database

  constructor(databasePath: string) {
    this.db = new Database(databasePath)
    this.db.exec('PRAGMA busy_timeout = 250; PRAGMA secure_delete = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_project_scripts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      config TEXT NOT NULL
    )`)
    this.db.exec('CREATE INDEX IF NOT EXISTS harness_project_scripts_workspace ON harness_project_scripts(workspace_id)')
  }

  list(workspaceId: number): ProjectScript[] {
    return this.db.query<{ id: string, config: string }, [number]>(
      'SELECT id, config FROM harness_project_scripts WHERE workspace_id = ? ORDER BY rowid',
    ).all(workspaceId).map(row => ({ ...JSON.parse(row.config) as ProjectScriptInput, id: row.id }))
  }

  get(workspaceId: number, id: string): ProjectScript | undefined {
    return this.list(workspaceId).find(script => script.id === id)
  }

  save(workspaceId: number, input: ProjectScriptInput, id?: string): ProjectScript {
    return this.db.transaction(() => {
      const scripts = this.list(workspaceId)
      if (id && !scripts.some(script => script.id === id)) throw new ProjectScriptError('This script is no longer available.')
      if (!id && scripts.length >= maxScripts) throw new ProjectScriptError('A project can have up to 50 scripts.')
      if (scripts.some(script => script.id !== id && (script.name.toLowerCase() === input.name.toLowerCase() || script.command === input.command)))
        throw new ProjectScriptError('This project already has a script with that name or command.')
      if (input.runOnWorktreeCreate && scripts.some(script => script.id !== id && script.runOnWorktreeCreate))
        throw new ProjectScriptError('Only one script can run automatically when a worktree is created.')
      const key = id ?? randomUUID()
      if (id) this.db.query('UPDATE harness_project_scripts SET config = ? WHERE workspace_id = ? AND id = ?').run(JSON.stringify(input), workspaceId, id)
      else this.db.query('INSERT INTO harness_project_scripts VALUES (?, ?, ?)').run(key, workspaceId, JSON.stringify(input))
      return { ...input, id: key }
    }).immediate()
  }

  remove(workspaceId: number, id: string): void {
    this.db.query('DELETE FROM harness_project_scripts WHERE workspace_id = ? AND id = ?').run(workspaceId, id)
  }

  close(): void { this.db.close() }
}

async function scriptOperation(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json') || !request.body)
    throw new ProjectScriptError('Send a JSON script action.')
  const reader = request.body.getReader()
  const buffer = new Uint8Array(32 * 1024)
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (length + chunk.value.length > buffer.length) throw new ProjectScriptError('The script action is too large.')
      buffer.set(chunk.value, length)
      length += chunk.value.length
    }
    const operation: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(0, length)))
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Error('invalid script action')
    return operation as Record<string, unknown>
  }
  catch (error) {
    if (error instanceof ProjectScriptError) throw error
    throw new ProjectScriptError('Send a valid JSON script action.')
  }
  finally { void reader.cancel().catch(() => {}) }
}

export async function respondProjectScripts(request: Request, scripts: ProjectScripts, workspaceId: number, root: () => string | null,
  resolveSetup?: (action: 'retry-setup' | 'skip-setup') => boolean,
): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store' }
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers })
  const cwd = root()
  if (!cwd) return json({ error: 'Open a trusted project thread to manage its scripts.' }, 403)
  try {
    if (request.method === 'GET') {
      let imports: Awaited<ReturnType<typeof readProjectScriptImports>> = []
      let importError = ''
      try { imports = await readProjectScriptImports(cwd) }
      catch (error) {
        if (!(error instanceof ProjectScriptError)) throw error
        importError = error.message
      }
      if (root() !== cwd) return json({ error: 'The project checkout changed. Open Scripts again.' }, 409)
      const saved = scripts.list(workspaceId)
      return json({
        scripts: saved,
        imports: imports.filter(item => !saved.some(script => script.command === item.command || script.name.toLowerCase() === item.name.toLowerCase())),
        importError,
      })
    }
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, POST' } })
    const operation = await scriptOperation(request)
    if (operation.action === 'import') {
      const selected = (await readProjectScriptImports(cwd)).find(script => script.key === operation.key)
      if (!selected) return json({ error: 'The script changed in t3.json. Open Scripts again to review it.' }, 409)
      if (root() !== cwd) return json({ error: 'The project checkout changed. Open Scripts again.' }, 409)
      return json({ script: scripts.save(workspaceId, projectScriptInput(selected)) }, 201)
    }
    if (root() !== cwd) return json({ error: 'The project checkout changed. Open Scripts again.' }, 409)
    if (operation.action === 'retry-setup' || operation.action === 'skip-setup') {
      if (!resolveSetup?.(operation.action)) return json({ error: 'This setup run can no longer be changed. Reload the thread.' }, 409)
      return new Response(null, { status: 204, headers })
    }
    const id = operation.id
    if (id !== undefined && (typeof id !== 'string' || !scriptIdPattern.test(id)))
      throw new ProjectScriptError('Select a saved project script.')
    if (operation.action === 'save') return json({ script: scripts.save(workspaceId, projectScriptInput(operation.script), id) }, id ? 200 : 201)
    if (operation.action === 'remove' && id) {
      scripts.remove(workspaceId, id)
      return new Response(null, { status: 204, headers })
    }
    throw new ProjectScriptError('Choose a script action.')
  }
  catch (error) {
    if (error instanceof ProjectScriptError) return json({ error: error.message }, 400)
    return json({ error: 'The host could not update project scripts.' }, 500)
  }
}
