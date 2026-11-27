import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { cloneRemote } from './project-clone-url'

type ClonePhase = 'cloning' | 'publishing' | 'done' | 'failed' | 'cancelled'

interface CloneJob {
  id: string
  remote: string
  destination: string
  stage: string
  profile: number | null
  workspace: number | null
  phase: ClonePhase
  error: string | null
}

type RegisterClone = (id: string, path: string, profile: number | null) => Promise<{ workspace: number, profile: number }>

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function gitClone(remote: string, checkout: string, signal: AbortSignal, report: (progress: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn('git', [
      '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
      '-c', 'core.hooksPath=/dev/null', 'clone', '--progress', '--template=', '--no-recurse-submodules',
      '--', remote, checkout,
    ], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    })
    let timedOut = false
    let idle: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    function kill(kind: NodeJS.Signals) {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind)
        else child.kill(kind)
      }
      catch { /* Git already exited. */ }
    }
    function interrupt() {
      kill('SIGTERM')
      killTimer ??= setTimeout(() => kill('SIGKILL'), 2000)
    }
    function resetIdle() {
      clearTimeout(idle)
      idle = setTimeout(() => {
        timedOut = true
        interrupt()
      }, 120_000)
    }
    let remainder = ''
    child.stderr.on('data', (data: Buffer) => {
      resetIdle()
      const lines = (remainder + data.toString('utf8')).split(/[\r\n]/u)
      remainder = lines.pop()?.slice(-256) ?? ''
      for (const line of lines) {
        const step = /^(?:remote: )?(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files):\s*(\d{1,3})%/u.exec(line)
        if (step) report(step[1] + ' ' + step[2] + '%')
      }
    })
    function cleanup() {
      clearTimeout(idle)
      clearTimeout(killTimer)
      signal.removeEventListener('abort', interrupt)
    }
    signal.addEventListener('abort', interrupt, { once: true })
    resetIdle()
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup()
      reject(new Error(error.code === 'ENOENT' ? 'Git is unavailable on this host.' : 'The host could not start Git.'))
    })
    child.once('close', (code) => {
      cleanup()
      if (signal.aborted) reject(signal.reason)
      else if (code === 0) resolve()
      else reject(new Error(timedOut
        ? 'Git stopped reporting progress. Check the connection and retry.'
        : 'Git could not clone the repository. Check the URL, network and Git credentials.'))
    })
  })
}

/** Record the operation before Git starts. Only an owned staging directory is removed. */
export class ProjectClones {
  private readonly db: Database
  private readonly running = new Map<string, { controller: AbortController, progress: string }>()
  private closed = false

  constructor(databasePath: string, private readonly register: RegisterClone) {
    this.db = new Database(databasePath)
    this.db.exec(`PRAGMA busy_timeout = 250;
      CREATE TABLE IF NOT EXISTS harness_project_clones (
        id TEXT PRIMARY KEY, remote TEXT NOT NULL, destination TEXT NOT NULL,
        stage TEXT NOT NULL, profile INTEGER, workspace INTEGER, phase TEXT NOT NULL, error TEXT
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS harness_clones_active_destination ON harness_project_clones (destination)
        WHERE phase IN ('cloning', 'publishing');`)
  }

  recover(): void {
    const jobs = this.db.query<CloneJob, []>("SELECT * FROM harness_project_clones WHERE phase IN ('cloning', 'publishing') OR (phase = 'done' AND stage != '')").all()
    for (const job of jobs) {
      if (job.phase === 'done') void this.clearPublishedStage(job)
      else if (job.phase === 'publishing') this.launch(job)
      else {
        this.update(job.id, 'failed', 'The host stopped during the clone. Start it again.')
        void rm(job.stage, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  close(): void {
    this.closed = true
    for (const job of this.running.values()) job.controller.abort()
    this.db.close()
  }

  private read(id: string): CloneJob | null {
    return this.db.query<CloneJob, [string]>('SELECT * FROM harness_project_clones WHERE id = ?').get(id)
  }

  private update(id: string, phase: ClonePhase, error: string | null = null): void {
    if (!this.closed) this.db.run('UPDATE harness_project_clones SET phase = ?, error = ? WHERE id = ?', [phase, error, id])
  }

  private snapshot(job: CloneJob) {
    return {
      id: job.id, phase: job.phase, destination: job.destination, workspace: job.workspace, profile: job.profile,
      progress: this.running.get(job.id)?.progress ?? '', error: job.error,
    }
  }

  private launch(job: CloneJob): void {
    const operation = { controller: new AbortController(), progress: '' }
    this.running.set(job.id, operation)
    void this.run(job, operation).finally(() => this.running.delete(job.id))
  }

  private async clearPublishedStage(job: CloneJob): Promise<void> {
    try {
      const marker = join(job.destination, basename(job.stage))
      const isDirectory = await lstat(job.destination).then(stat => stat.isDirectory(), () => false)
      if (isDirectory && await readFile(marker, 'utf8').then(text => text === job.id, () => false))
        await unlink(marker)
      await rm(job.stage, { recursive: true, force: true })
      if (!this.closed) this.db.run("UPDATE harness_project_clones SET stage = '' WHERE id = ?", [job.id])
    }
    catch { /* The next host start retries cleanup after the successful clone. */ }
  }

  private async run(job: CloneJob, operation: { controller: AbortController, progress: string }): Promise<void> {
    const { signal } = operation.controller
    const checkout = join(job.stage, 'checkout')
    const owner = join(job.destination, basename(job.stage))
    let publishing = job.phase === 'publishing'
    let ownsStage = publishing
    try {
      if (!publishing) {
        await mkdir(job.stage, { mode: 0o700 })
        ownsStage = true
        await gitClone(job.remote, checkout, signal, progress => { operation.progress = progress })
        signal.throwIfAborted()
        this.update(job.id, 'publishing')
        publishing = true
      }
      if (this.closed) return
      if (!await exists(job.destination)) {
        await mkdir(job.destination)
        await writeFile(owner, job.id, { flag: 'wx' })
      }
      if (!(await lstat(job.destination)).isDirectory() || !await readFile(owner, 'utf8').then(text => text === job.id, () => false))
        throw new Error('The destination folder already exists. Choose a new folder.')
      // The marker lets a restarted host finish only its own directory.
      for (const entry of await readdir(checkout)) {
        if (this.closed) return
        const target = join(job.destination, entry)
        if (await exists(target)) throw new Error('A file was added to the destination while cloning. The host kept both folders.')
        await rename(join(checkout, entry), target)
      }
      if (this.closed) return
      const { workspace, profile } = await this.register('clone_' + job.id, job.destination, job.profile)
      if (this.closed) return
      this.db.run("UPDATE harness_project_clones SET phase = 'done', workspace = ?, profile = ? WHERE id = ?", [workspace, profile, job.id])
      await this.clearPublishedStage(job)
    }
    catch (error) {
      if (ownsStage && (!publishing || !await exists(owner).catch(() => false)))
        await rm(job.stage, { recursive: true, force: true }).catch(() => {})
      if (!this.closed) {
        const message = error instanceof Error && !('code' in error) ? error.message : 'The host could not write to the clone destination.'
        this.update(job.id, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? null : message)
      }
    }
  }

  async handle(request: Request, url: URL, profileExists: (profile: number) => boolean): Promise<Response> {
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
    try {
      if (request.method === 'GET' && url.searchParams.has('remote')) {
        const { directory } = cloneRemote(url.searchParams.get('remote'))
        return json({ destination: join(homedir(), directory), directory })
      }
      if (request.method === 'GET' || request.method === 'DELETE') {
        const job = this.read(url.searchParams.get('id') ?? '')
        if (!job) return json({ error: 'This clone operation is unavailable.' }, 404)
        if (request.method === 'DELETE' && job.phase === 'cloning') this.running.get(job.id)?.controller.abort()
        return json(this.snapshot(job))
      }
      if (request.method !== 'POST') return json({ error: 'Unsupported clone request.' }, 405)
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Send clone settings as JSON.' }, 415)
      const body = await request.text()
      if (body.length > 8192) return json({ error: 'Clone settings are too long.' }, 413)
      let input: { id?: unknown, remote?: unknown, destination?: unknown, profile?: unknown } | null
      try { input = JSON.parse(body) }
      catch { return json({ error: 'Clone settings must be valid JSON.' }, 400) }
      if (typeof input?.id !== 'string' || !/^web_[a-z0-9]{1,16}_[a-z0-9]{1,6}$/u.test(input.id))
        return json({ error: 'Missing clone operation ID.' }, 400)
      const existing = this.read(input.id)
      if (existing) return json(this.snapshot(existing))
      const profile = input.profile ?? null
      if (profile !== null && (typeof profile !== 'number' || !Number.isSafeInteger(profile) || !profileExists(profile)))
        return json({ error: 'Choose an available profile.' }, 400)
      const { remote } = cloneRemote(input.remote)
      if (typeof input.destination !== 'string' || input.destination.length > 4096 || !isAbsolute(input.destination)
        || input.destination.includes('\0'))
        return json({ error: 'Enter an absolute path for a new folder on the host.' }, 400)
      const requested = resolve(input.destination)
      if (dirname(requested) === requested) return json({ error: 'Choose a new folder inside the host filesystem.' }, 400)
      const parent = await realpath(dirname(requested)).catch(() => null)
      if (!parent || !(await lstat(parent)).isDirectory())
        return json({ error: 'Choose a destination inside an existing host folder.' }, 400)
      const destination = join(parent, basename(requested))
      const replayed = this.read(input.id)
      if (replayed) return json(this.snapshot(replayed))
      if (await exists(destination)) return json({ error: 'The destination folder already exists. Choose a new folder.' }, 409)
      const stage = join(parent, '.harness-clone-' + randomUUID())
      // No await between checking the id and claiming the destination.
      const duplicate = this.read(input.id)
      if (duplicate) return json(this.snapshot(duplicate))
      const claimed = this.db.query("SELECT id FROM harness_project_clones WHERE destination = ? AND phase IN ('cloning', 'publishing')").get(destination)
      if (claimed) return json({ error: 'A clone is already using that destination.' }, 409)
      this.db.run("INSERT INTO harness_project_clones (id, remote, destination, stage, profile, phase) VALUES (?, ?, ?, ?, ?, 'cloning')",
        [input.id, remote, destination, stage, profile])
      const job = this.read(input.id)!
      this.launch(job)
      return json(this.snapshot(job), 202)
    }
    catch (error) {
      const message = error instanceof Error && !('code' in error) ? error.message : 'The host could not start the clone.'
      return json({ error: message }, 400)
    }
  }
}
