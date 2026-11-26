import type { HarnessServer } from '../src/server'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Terminal } from '@harness/ansi'
import { decode, encode } from '@harness/contract'
import { derivedId } from '@harness/engine'
import { serve } from '../src/server'

let dir: string
let harness: HarnessServer
let port: number

/**
 * The two tables the engine needs, standalone.
 *
 * Built here rather than by running the app's migrations so the server suite
 * stays independent of the framework's migration corpus — a broken commerce
 * seeder should not be able to fail the websocket tests.
 */
function prepareDatabase(path: string): void {
  const db = new Database(path)
  // Mirrors the migrated schema, including `PRAGMA foreign_keys = ON` — the
  // store enables it, and a test schema without the pragma silently tolerates
  // constraint violations that production rejects.
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)`)
  db.exec(`CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)`)
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL,
    type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER,
    created_at TEXT, updated_at TEXT, uuid TEXT
  )`)
  db.exec(`CREATE TABLE command_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER,
    created_at TEXT, updated_at TEXT, uuid TEXT
  )`)
  db.close()
}

/** A tiny CBOR websocket client, since that is exactly what a real one is. */
class TestClient {
  private socket: WebSocket
  private inbox: unknown[] = []
  private waiters: Array<(frame: any) => void> = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (event) => {
      const frame = decode(new Uint8Array(event.data as ArrayBuffer))
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.inbox.push(frame)
    }
  }

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('connect failed'))
    })
    return new TestClient(socket)
  }

  send(frame: unknown): void {
    this.socket.send(encode(frame))
  }

  /** Next frame, from the backlog if one is already waiting. */
  next(): Promise<any> {
    const buffered = this.inbox.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    return new Promise((resolve) => {
      this.waiters.push(resolve)
      setTimeout(() => resolve({ t: 'timeout' }), 2000)
    })
  }

  /** Skip forward to the first frame of a given type. */
  async until(...types: string[]): Promise<any> {
    for (let i = 0; i < 40; i++) {
      const frame = await this.next()
      if (types.includes(frame?.t)) return frame
      if (frame?.t === 'timeout') return frame
    }
    return { t: 'timeout' }
  }

  close(): void {
    this.socket.close()
  }
}

let portCounter = 3900

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harness-server-'))
  const dbPath = join(dir, 'test.sqlite')
  prepareDatabase(dbPath)
  port = ++portCounter
  harness = await serve({ port, databasePath: dbPath })
})

afterEach(() => {
  harness.stop()
  rmSync(dir, { recursive: true, force: true })
})

function url(): string {
  return `ws://127.0.0.1:${port}/ws`
}

describe('harness serve — HTTP', () => {
  it('reports health with the hydrated projection', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, profiles: 0, sessions: 0 })
  })

  it('reviews uncommitted changes, branch comparisons, and commits without altering the working tree or index', async () => {
    const project = join(dir, 'review')
    mkdirSync(project)
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: project })
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    git('init', '-qb', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\n')
    await Bun.write(join(project, '.gitignore'), '\\[ignored\\].txt\n')
    git('add', '--all')
    git('commit', '-qm', 'Initial ledger')
    const root = git('rev-parse', 'HEAD')
    git('switch', '-qc', 'review/ledger')
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\nCommitted\n')
    git('commit', '-qam', 'Commit ledger')
    const head = git('rev-parse', 'HEAD')
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\nCommitted\nStaged\n')
    git('add', '--', 'ledger.txt')
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\nCommitted\nStaged\nUnstaged\n')
    await Bun.write(join(project, '[new].txt'), 'Untracked\n')
    await Bun.write(join(project, '[ignored].txt'), 'Ignored\n')
    const staged = git('diff', '--cached', '--numstat')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('review-profile', { type: 'profile.create', name: 'Review fixture' })
    const workspaceId = derivedId('review-workspace')
    await dispatch('review-workspace', { type: 'workspace.add', profileId: derivedId('review-profile'), path: project })
    await dispatch('review-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    await dispatch('review-session', { type: 'session.create', workspaceId, driverKind: 'claude' })
    const route = `http://127.0.0.1:${port}/s/${derivedId('review-session')}/diff`
    expect((await fetch(route + '/options', { headers: { origin: 'https://isolated.invalid' } })).status).toBe(403)
    const options = await (await fetch(route + '/options')).json()
    expect(options).toMatchObject({ base: 'refs/heads/main', commits: [{ sha: head, subject: 'Commit ledger' }] })
    expect(options.branches.map((branch: { ref: string }) => branch.ref)).toEqual(['refs/heads/main', 'refs/heads/review/ledger'])
    const read = async (comparison: string, target?: string) => {
      const params = new URLSearchParams({ comparison, ...(target ? { target } : {}) })
      return (await fetch(route + '?' + params)).json()
    }
    const dirty = await read('uncommitted')
    expect(dirty.files).toEqual([
      { path: '[new].txt', status: 'added', insertions: 1, deletions: 0 },
      { path: 'ledger.txt', status: 'modified', insertions: 2, deletions: 0 },
    ])
    expect(dirty.patch).toContain('+Staged\n+Unstaged')
    const branch = await read('branch', 'refs/heads/main')
    expect(branch).toMatchObject({ scope: 'branch', comparisonLabel: 'main' })
    expect(branch.patch).toContain('+Committed\n+Staged\n+Unstaged')
    expect(branch.patch).not.toContain('Ignored')
    expect((await fetch(`${route}?comparison=branch&knownRevision=${branch.revision}`)).status).toBe(204)
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\nCommitted\nStaged\nRefreshed without a commit\n')
    const refreshed = await fetch(`${route}?comparison=branch&knownRevision=${branch.revision}`)
    expect(refreshed.status).toBe(200)
    expect((await refreshed.json()).patch).toContain('+Refreshed without a commit')
    await Bun.write(join(project, 'ledger.txt'), 'Ledger\nCommitted\nStaged\nUnstaged\n')
    expect((await read('branch', 'refs/heads/main~1')).error).toContain('unavailable')
    const commit = await read('commit', head)
    expect(commit.files).toEqual([{ path: 'ledger.txt', status: 'modified', insertions: 1, deletions: 0 }])
    expect(commit.patch).not.toContain('Unstaged')
    expect((await read('commit', root)).patch).toContain('+Ledger')
    expect((await read('commit', 'not-a-hash')).error).toContain('unavailable')
    const oldBlob = git('rev-parse', `${root}:ledger.txt`)
    const context = new URLSearchParams({ file: 'ledger.txt', object: oldBlob, comparison: 'commit', target: head })
    expect((await fetch(`${route}/context?${context}`, { headers: { origin: 'https://isolated.invalid' } })).status).toBe(403)
    const contextResult = await fetch(`${route}/context?${context}`)
    expect(contextResult.headers.get('cache-control')).toBe('private, no-store')
    expect(await contextResult.json()).toEqual({ text: 'Ledger\n' })
    context.set('object', git('rev-parse', `${head}:ledger.txt`))
    expect((await fetch(`${route}/context?${context}`)).status).toBe(409)
    context.set('file', '../ledger.txt')
    expect((await fetch(`${route}/context?${context}`)).status).toBe(404)
    expect(git('diff', '--cached', '--numstat')).toBe(staged)
    expect(await Bun.file(join(project, 'ledger.txt')).text()).toBe('Ledger\nCommitted\nStaged\nUnstaged\n')

    const subdir = join(project, 'subfolder')
    mkdirSync(subdir)
    await dispatch('review-subfolder', { type: 'workspace.add', profileId: derivedId('review-profile'), path: subdir })
    await dispatch('review-subfolder-trust', { type: 'workspace.trust', workspaceId: derivedId('review-subfolder'), trusted: true })
    await dispatch('review-subfolder-session', { type: 'session.create', workspaceId: derivedId('review-subfolder'), driverKind: 'claude' })
    const nested = await fetch(`http://127.0.0.1:${port}/s/${derivedId('review-subfolder-session')}/diff?comparison=uncommitted`)
    expect(await nested.json()).toMatchObject({ isRepository: false, files: [], patch: '' })
  })

  it('searches only files inside the trusted workspace or the thread worktree', async () => {
    const project = join(dir, 'project')
    const worktree = join(dir, 'session-worktree')
    mkdirSync(project)
    mkdirSync(worktree)
    expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: project }).exitCode).toBe(0)
    await Bun.write(join(project, '.gitignore'), 'ignored-parity.txt\n')
    await Bun.write(join(project, 'parity notes [draft].md'), 'project fixture\n')
    await Bun.write(join(project, 'ignored-parity.txt'), 'ignored fixture\n')
    await Bun.write(join(dir, 'outside-parity.txt'), 'outside fixture\n')
    symlinkSync(join(dir, 'outside-parity.txt'), join(project, 'outside-parity.txt'))
    await Bun.write(join(worktree, 'worktree-parity.md'), 'worktree fixture\n')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('files-profile', { type: 'profile.create', name: 'Files fixture' })
    const workspaceId = derivedId('files-project')
    await dispatch('files-project', { type: 'workspace.add', profileId: derivedId('files-profile'), path: project })
    const route = `http://127.0.0.1:${port}/workspace-files/search`
    const projectQuery = `${route}?workspace=${workspaceId}&q=parity`
    expect((await fetch(projectQuery)).status).toBe(404)
    await dispatch('files-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    expect((await fetch(projectQuery, { headers: { origin: 'https://example.invalid' } })).status).toBe(403)
    expect(await (await fetch(projectQuery)).json()).toEqual({ results: ['parity notes [draft].md'] })
    await dispatch('files-session', { type: 'session.create', workspaceId, driverKind: 'claude' })
    const sessionId = derivedId('files-session')
    await harness.engine.dispatchInternal({ id: 'files-isolation', at: Date.now(), command: {
      type: 'thread.worktree.set', sessionId, worktreePath: worktree, branch: 'test-file-picker',
    } })
    expect(await (await fetch(`${route}?session=${sessionId}&workspace=${workspaceId}&q=parity`)).json())
      .toEqual({ results: ['worktree-parity.md'] })
    expect((await fetch(`${route}?session=999&workspace=${workspaceId}`)).status).toBe(404)
    const worktreeRoute = `http://127.0.0.1:${port}/workspace-files/preview?session=${sessionId}`
    const scopedFile = await fetch(`${worktreeRoute}&path=worktree-parity.md`)
    expect(await scopedFile.json()).toMatchObject({ text: 'worktree fixture\n' })
    expect((await fetch(`${worktreeRoute}&path=parity%20notes%20%5Bdraft%5D.md`)).status).toBe(404)
  })

  it('lists, previews, and downloads only scoped workspace files', async () => {
    const project = join(dir, 'workspace')
    const folder = join(project, 'notes & tests')
    mkdirSync(folder, { recursive: true })
    await Bun.write(join(folder, '[draft] #1.txt'), 'First line\nSecond line\n')
    await Bun.write(join(folder, 'binary.txt'), new Uint8Array([0, 1, 2, 3]))
    await Bun.write(join(folder, 'large.txt'), 'row\n'.repeat(5_200))
    await Bun.write(join(project, 'print.html'), '<title>Print</title><h1>Rendered fixture</h1><script>void 0</script><a href="/">Home</a>')
    await Bun.write(join(dir, 'outside.txt'), 'Outside fixture\n')
    symlinkSync(join(dir, 'outside.txt'), join(project, 'outside.txt'))
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('preview-profile', { type: 'profile.create', name: 'File fixture' })
    const workspaceId = derivedId('preview-workspace')
    await dispatch('preview-workspace', { type: 'workspace.add', profileId: derivedId('preview-profile'), path: project })
    const request = (action: string, path = '', headers?: HeadersInit) => {
      const params = new URLSearchParams({ workspace: String(workspaceId), path })
      return fetch(`http://127.0.0.1:${port}/workspace-files/${action}?${params}`, { headers })
    }
    expect((await request('preview', 'print.html')).status).toBe(404)
    await dispatch('preview-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    const listed = await (await request('tree')).json()
    expect(listed.entries).toEqual([
      { path: 'notes & tests', name: 'notes & tests', kind: 'directory' },
      { path: 'print.html', name: 'print.html', kind: 'file' },
    ])
    expect((await request('tree', 'notes & tests')).status).toBe(200)
    expect((await request('tree', '', { origin: 'https://isolated.invalid' })).status).toBe(403)
    const path = 'notes & tests/[draft] #1.txt'
    expect(await (await request('preview', path)).json()).toMatchObject({ kind: 'text', text: 'First line\nSecond line\n', truncated: false })
    expect(await (await request('preview', 'notes & tests/binary.txt')).json()).toMatchObject({ kind: 'binary' })
    expect(await (await request('preview', 'notes & tests/large.txt')).json()).toMatchObject({ truncated: true })
    expect((await request('preview', 'outside.txt')).status).toBe(404)
    expect((await request('download', '../outside.txt')).status).toBe(404)
    expect((await request('tree', '.git')).status).toBe(404)
    const view = await request('content', 'print.html')
    expect(view.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'")
    const html = await view.text()
    expect(html).toContain('Rendered fixture')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href=')
    const download = await request('download', path, { range: 'bytes=0-4' })
    expect(download.status).toBe(206)
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="[draft] #1.txt"; filename*=UTF-8\'\'%5Bdraft%5D%20%231.txt')
    expect(await download.text()).toBe('First')
    expect((await request('download', path, { range: 'bytes=900-' })).status).toBe(416)
    const pdf = '%PDF-1.4\n'
    await Bun.write(join(project, 'document.pdf'), pdf)
    expect(await (await request('preview', 'document.pdf')).json()).toMatchObject({ kind: 'pdf' })
    const content = await request('content', 'document.pdf', { range: 'bytes=-4' })
    expect(content.headers.get('content-type')).toBe('application/pdf')
    expect(content.headers.get('content-disposition')).toStartWith('inline;')
    expect(await content.text()).toBe('1.4\n')
  })

  it('404s an unknown path rather than upgrading it', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404)
  })

  it('refuses a plain GET on the websocket route', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/ws`)).status).toBe(426)
  })
})

describe('harness serve — the socket protocol', () => {
  it('greets a new client', async () => {
    const client = await TestClient.connect(url())
    expect(await client.until('ready')).toMatchObject({ t: 'ready' })
    client.close()
  })

  it('registers a canonical project with an explicit trust choice and rejects duplicate folders', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    const register = (id: string, path: string, trusted: boolean) => client.send({
      t: 'dispatch', envelope: { id, at: 1, command: { type: 'workspace.register', path, trusted } },
    })

    try {
      register('relative', 'projects/repo', true)
      expect(await client.until('rejected')).toMatchObject({ id: 'relative', message: expect.stringContaining('absolute') })
      register('file', join(dir, 'test.sqlite'), true)
      expect(await client.until('rejected')).toMatchObject({ id: 'file', message: expect.stringContaining('open that folder') })
      expect(harness.engine.current.profiles.size).toBe(0)

      register('project', dir, false)
      expect(await client.until('dispatched')).toMatchObject({ id: 'project', replayed: false })
      const id = derivedId('project')
      expect(harness.engine.current.workspaces.get(id)).toMatchObject({ profileId: id, path: realpathSync(dir), trusted: false })
      expect(harness.engine.current.profiles.get(id)?.workspaceIds).toEqual([id])

      register('project', dir, false)
      expect(await client.until('dispatched')).toMatchObject({ id: 'project', replayed: true })

      const alias = join(dir, 'alias')
      symlinkSync(dir, alias, 'dir')
      register('duplicate', alias, true)
      expect(await client.until('rejected')).toMatchObject({ id: 'duplicate', message: expect.stringContaining('already') })
      expect(harness.engine.current.workspaces.size).toBe(1)
      expect(harness.engine.current.workspaces.get(id)?.trusted).toBe(false)
    }
    finally {
      client.close()
    }
  })

  it('acks a replay after the folder is deleted and refuses a new registration for it', async () => {
    const client = await TestClient.connect(url())
    const folder = join(dir, 'temporary-project')
    mkdirSync(folder)
    const register = (id: string) => client.send({
      t: 'dispatch', envelope: { id, at: 1, command: { type: 'workspace.register', path: folder, trusted: false } },
    })

    try {
      await client.until('ready')
      register('project')
      const first = await client.until('dispatched')
      expect(first).toMatchObject({ id: 'project', replayed: false })
      rmSync(folder, { recursive: true })

      register('project')
      expect(await client.until('dispatched')).toMatchObject({ id: 'project', replayed: true, seqs: first.seqs })
      register('missing')
      expect(await client.until('rejected')).toMatchObject({ id: 'missing', message: expect.stringContaining('open that folder') })
      expect(harness.engine.current.workspaces.size).toBe(1)
    }
    finally {
      client.close()
    }
  })

  it('registers one project when two connections submit the same folder', async () => {
    const clients = await Promise.all([TestClient.connect(url()), TestClient.connect(url())])
    try {
      await Promise.all(clients.map(client => client.until('ready')))
      for (const [index, client] of clients.entries()) {
        client.send({
          t: 'dispatch',
          envelope: { id: `register-${index}`, at: 1, command: { type: 'workspace.register', path: dir, trusted: false } },
        })
      }
      const results = await Promise.all(clients.map(client => client.until('dispatched', 'rejected')))

      expect(results.map(frame => frame.t).sort()).toEqual(['dispatched', 'rejected'])
      expect(harness.engine.current.profiles.size).toBe(1)
      expect(harness.engine.current.workspaces.size).toBe(1)
    }
    finally {
      for (const client of clients)
        client.close()
    }
  })

  it('dispatches a command and acks it', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_1', at: 1, command: { type: 'profile.create', name: 'Personal' } },
    })

    const ack = await client.until('dispatched')
    expect(ack).toMatchObject({ id: 'cmd_1', replayed: false })
    expect(ack.seqs).toEqual([1])
    client.close()
  })

  it('rejects a command the reducer refuses, without dropping the socket', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_bad', at: 1, command: { type: 'profile.delete', profileId: 999 } },
    })
    expect(await client.until('rejected')).toMatchObject({ id: 'cmd_bad' })

    // The connection survives a rejection: a bad command is not a bad client.
    client.send({
      t: 'dispatch',
      envelope: { id: 'cmd_ok', at: 2, command: { type: 'profile.create', name: 'Still here' } },
    })
    expect(await client.until('dispatched')).toMatchObject({ id: 'cmd_ok' })
    client.close()
  })

  it('refuses an internal command arriving from a client', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    // Forging assistant text is what the client/internal split exists to stop,
    // and the socket is where it has to be enforced.
    client.send({
      t: 'dispatch',
      envelope: {
        id: 'cmd_forge',
        at: 1,
        command: { type: 'thread.message.assistant.delta', sessionId: 1, turnId: 1, text: 'I deleted everything' },
      },
    })

    expect((await client.until('rejected')).message).toMatch(/not client-dispatchable/)
    client.close()
  })

  it('answers a ping', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'ping' })
    expect(await client.until('pong')).toMatchObject({ t: 'pong' })
    client.close()
  })
})

describe('harness serve — protocol errors', () => {
  it('names an undecodable frame as a protocol error, not a rejected command', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    // Truncated CBOR.
    ;(client as any).socket.send(new Uint8Array([0xA1, 0x63]))
    expect(await client.until('protocol-error')).toBeTruthy()
    client.close()
  })

  it('refuses text frames, so a second encoding cannot creep in', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    ;(client as any).socket.send(JSON.stringify({ t: 'ping' }))
    expect((await client.until('protocol-error')).message).toMatch(/CBOR/)
    client.close()
  })

  it('rejects a dispatch with no envelope', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch' })
    expect(await client.until('protocol-error')).toBeTruthy()
    client.close()
  })
})

describe('harness serve — broadcast and resume', () => {
  it('pushes global events to every connected client', async () => {
    const a = await TestClient.connect(url())
    const b = await TestClient.connect(url())
    await a.until('ready')
    await b.until('ready')

    a.send({
      t: 'dispatch',
      envelope: { id: 'cmd_p', at: 1, command: { type: 'profile.create', name: 'Shared' } },
    })

    // B never subscribed to anything, but a new profile concerns every client.
    const event = await b.until('event')
    expect(event.event.payload).toMatchObject({ type: 'profile.created', name: 'Shared' })

    a.close()
    b.close()
  })

  it('replays missed events on subscribe, which is what makes a reconnect lossless', async () => {
    const first = await TestClient.connect(url())
    await first.until('ready')

    // Build a session with a turn, then drop the connection mid-stream.
    first.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'P' } } })
    const profileAck = await first.until('dispatched')
    expect(profileAck.replayed).toBe(false)
    first.close()

    // A fresh client asks for everything from the start of the global stream.
    const second = await TestClient.connect(url())
    await second.until('ready')
    second.send({ t: 'subscribe', sessionId: 0, sinceSeq: 0 })

    const replayed = await second.until('event')
    expect(replayed.event.payload.type).toBe('profile.created')
    expect((await second.until('subscribed')).caughtUpTo).toBe(1)
    second.close()
  })

  it('sends nothing already seen when resuming from a sequence', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'A' } } })
    await client.until('dispatched')

    client.send({ t: 'subscribe', sessionId: 0, sinceSeq: 1 })
    // Caught up already, so the next frame is the ack rather than a re-send.
    expect(await client.until('subscribed')).toMatchObject({ caughtUpTo: 1 })
    client.close()
  })

  it('gives a replayed event the same timestamp as the live one', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')

    const at = 1786141447969
    client.send({ t: 'dispatch', envelope: { id: 'c_ts', at, command: { type: 'profile.create', name: 'T' } } })
    await client.until('dispatched')
    const live = await client.until('event')

    client.send({ t: 'subscribe', sessionId: 0, sinceSeq: 0 })
    const replayed = await client.until('event')

    // `created_at` is second-resolution, so deriving `at` from it truncated the
    // milliseconds — the same fact arrived with two different timestamps
    // depending only on whether you were connected when it happened.
    expect(replayed.event.at).toBe(live.event.at)
    expect(replayed.event.at).toBe(at)
    client.close()
  })

  it('stops delivering after unsubscribe', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'subscribe', sessionId: 7 })
    await client.until('subscribed')
    client.send({ t: 'unsubscribe', sessionId: 7 })
    client.send({ t: 'ping' })
    // The pong arrives with no session-7 event ahead of it.
    expect(await client.next()).toMatchObject({ t: 'pong' })
    client.close()
  })
})

describe('harness serve — durability', () => {
  it('survives a restart with its state intact', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'c1', at: 1, command: { type: 'profile.create', name: 'Persisted' } } })
    await client.until('dispatched')
    client.close()

    const dbPath = join(dir, 'test.sqlite')
    harness.stop()
    harness = await serve({ port: ++portCounter, databasePath: dbPath })
    port = portCounter

    // Hydrated from the log, not from anything held in memory.
    expect(harness.engine.current.profiles.size).toBe(1)
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json()
    expect(health.profiles).toBe(1)
  })

  it('honours a retried command across a restart', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'dispatch', envelope: { id: 'stable_id', at: 1, command: { type: 'profile.create', name: 'Once' } } })
    await client.until('dispatched')
    client.close()

    const dbPath = join(dir, 'test.sqlite')
    harness.stop()
    harness = await serve({ port: ++portCounter, databasePath: dbPath })
    port = portCounter

    // The client reconnects and resends what it never saw acked.
    const resumed = await TestClient.connect(url())
    await resumed.until('ready')
    resumed.send({ t: 'dispatch', envelope: { id: 'stable_id', at: 1, command: { type: 'profile.create', name: 'Once' } } })

    expect(await resumed.until('dispatched')).toMatchObject({ replayed: true })
    expect(harness.engine.current.profiles.size).toBe(1)
    resumed.close()
  })
})

describe('terminals over the socket', () => {
  // Use a real POSIX shell so local prompts and exit hooks cannot affect the
  // transport assertions. This still exercises the host's native PTY.
  let originalShell: string | undefined
  beforeEach(() => {
    originalShell = process.env.SHELL
    process.env.SHELL = '/bin/sh'
  })
  afterEach(() => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
  })

  function url(): string {
    return `ws://localhost:${port}/ws`
  }

  async function openWorkspace(client: TestClient): Promise<number> {
    client.send({ t: 'dispatch', envelope: { id: 'c_p', at: 1, command: { type: 'profile.create', name: 'P' } } })
    await client.until('dispatched')
    client.send({ t: 'dispatch', envelope: { id: 'c_w', at: 2, command: { type: 'workspace.add', profileId: derivedId('c_p'), path: dir } } })
    await client.until('dispatched')
    return derivedId('c_w')
  }

  it('refuses a workspace the engine does not know', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'term-open', workspaceId: 424242 })
    const error = await client.until('term-error')
    expect(error.message).toContain('no workspace')
    client.close()
  })

  it('runs a real shell in the workspace and streams its bytes back', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    const workspaceId = await openWorkspace(client)

    client.send({ t: 'term-open', workspaceId, cols: 60, rows: 12 })
    const opened = await client.until('term-opened')
    expect(opened.termId).toBeGreaterThan(0)
    expect(opened).toMatchObject({ workspaceId, cols: 60, rows: 12, shell: 'system' })

    // A marker computed by the shell, so matching it proves execution rather
    // than the terminal echoing our own input back.
    client.send({ t: 'term-input', termId: opened.termId, data: 'echo "m-$((40+2))"\n' })
    let seen = ''
    for (let i = 0; i < 60 && !seen.includes('m-42'); i++) {
      const frame = await client.next()
      if (frame?.t === 'term-data' && frame.termId === opened.termId) seen += frame.data
      if (frame?.t === 'timeout') break
    }
    expect(seen).toContain('m-42')

    client.send({ t: 'term-close', termId: opened.termId })
    client.close()
  })

  it('reports a missing Den shell and recovers after switching back to the system shell', async () => {
    const lookup = Bun.which
    const executable = spyOn(Bun, 'which').mockImplementation((name, options) => name === 'den' ? null : lookup(name, options))
    try {
      const client = await TestClient.connect(url())
      await client.until('ready')
      const workspaceId = await openWorkspace(client)
      const chooseShell = async (terminalShell: 'den' | 'system') => {
        client.send({ t: 'dispatch', envelope: {
          id: 'shell-' + terminalShell, at: 3, command: { type: 'settings.update', changes: { terminalShell } },
        } })
        await client.until('dispatched')
        client.send({ t: 'term-open', workspaceId })
      }
      await chooseShell('den')
      expect((await client.until('term-error')).message).toContain('Den was not found')
      await chooseShell('system')
      expect(await client.until('term-opened')).toMatchObject({ shell: 'system' })
      client.close()
    }
    finally {
      executable.mockRestore()
    }
  })

  it('drops input for a terminal that is already gone', async () => {
    const client = await TestClient.connect(url())
    await client.until('ready')
    client.send({ t: 'term-input', termId: 999, data: 'echo boo\n' })
    // Still a healthy protocol afterwards — the frame was dropped, not fatal.
    client.send({ t: 'ping' })
    expect((await client.until('pong')).t).toBe('pong')
    client.close()
  })

  it('retains a thread shell and its real output across connections', async () => {
    const first = await TestClient.connect(url())
    await first.until('ready')
    const workspaceId = await openWorkspace(first)
    const dispatch = async (id: string, command: object) => {
      first.send({ t: 'dispatch', envelope: { id, at: 3, command } })
      await first.until('dispatched')
    }
    await dispatch('term-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    await dispatch('term-session', { type: 'session.create', workspaceId, driverKind: 'claude' })
    const sessionId = derivedId('term-session')
    const resumeKey = crypto.randomUUID()
    const open = { t: 'term-open', workspaceId, sessionId, resumeKey, cols: 80, rows: 12 }
    first.send(open)
    const opened = await first.until('term-opened')
    first.send({ t: 'term-input', termId: opened.termId, data: 'printf "before-%d\\n" $((40+2)); sleep .3; printf "offline-%d\\n" $((43+1))\n' })
    let output = ''
    for (let i = 0; i < 30 && !output.includes('before-42'); i++) output += (await first.until('term-data')).data
    expect(output).toContain('before-42')
    first.close()
    await Bun.sleep(450)

    const second = await TestClient.connect(url())
    try {
      await second.until('ready')
      second.send({ ...open, resumeKey: crypto.randomUUID(), resumeOnly: true })
      expect((await second.until('term-error')).message).toContain('no longer available')
      second.send({ ...open, resumeOnly: true })
      const resumed = await second.until('term-opened')
      expect(resumed.termId).toBe(opened.termId)
      const restored = Terminal.fromCheckpoint(resumed.checkpoint)
      expect(restored.toText()).toContain('before-42')
      expect(restored.toText()).toContain('offline-44')
      second.send({ t: 'term-detach', termId: resumed.termId })
      second.send({ t: 'term-input', termId: resumed.termId, data: 'exit 99\n' })
      second.send({ t: 'term-close', termId: resumed.termId })
      second.send({ ...open, resumeKey: crypto.randomUUID() })
      const otherTab = await second.until('term-opened')
      expect(otherTab.termId).not.toBe(resumed.termId)
      second.send({ t: 'term-close', termId: otherTab.termId })
      expect(await second.until('term-closed')).toMatchObject({ termId: otherTab.termId })
      second.send({ ...open, resumeOnly: true })
      expect(await second.until('term-opened')).toMatchObject({ termId: resumed.termId })
      second.send({ t: 'term-input', termId: resumed.termId, data: 'exit 7\n' })
      expect((await second.until('term-exit')).code).toBe(7)
      second.send({ ...open, resumeOnly: true })
      expect(await second.until('term-opened')).toMatchObject({ termId: opened.termId, exit: { code: 7 } })
      second.send({ t: 'term-close', termId: resumed.termId })
      await second.until('term-closed')
      second.send({ ...open, resumeOnly: true })
      expect((await second.until('term-error')).message).toContain('no longer available')
    }
    finally { second.close() }
  })

  it('recovers each pane’s scrollback with a fresh shell after the host restarts', async () => {
    let client = await TestClient.connect(url())
    const sendOutput = async (termId: number, command: string, expected: string) => {
      client.send({ t: 'term-input', termId, data: `${command}\n` })
      let output = ''
      for (let i = 0; i < 30 && !output.includes(expected); i++) output += (await client.until('term-data')).data ?? ''
      expect(output).toContain(expected)
    }
    const restart = async () => {
      harness.stop()
      client.close()
      port = ++portCounter
      harness = await serve({ port, databasePath: join(dir, 'test.sqlite') })
      client = await TestClient.connect(url())
      await client.until('ready')
    }

    try {
      await client.until('ready')
      const workspaceId = await openWorkspace(client)
      await harness.engine.dispatch({ id: 'persist-trust', at: 3, command: { type: 'workspace.trust', workspaceId, trusted: true } })
      for (const id of ['persist-session', 'other-session'])
        await harness.engine.dispatch({ id, at: 3, command: { type: 'session.create', workspaceId, driverKind: 'claude' } })
      const sessionId = derivedId('persist-session')
      const left = { t: 'term-open', workspaceId, sessionId, resumeKey: crypto.randomUUID() }
      const right = { ...left, resumeKey: crypto.randomUUID() }
      client.send(left)
      const first = await client.until('term-opened')
      await sendOutput(first.termId, 'export HARNESS_PANE_VALUE=41; printf "left-%d\\n" "$HARNESS_PANE_VALUE"', 'left-41')
      client.send(right)
      const second = await client.until('term-opened')
      await sendOutput(second.termId, 'printf "right-%d\\n" $((70+3))', 'right-73')

      await restart()
      client.send({ ...left, sessionId: derivedId('other-session'), resumeOnly: true })
      expect((await client.until('term-error', 'term-opened')).t).toBe('term-error')
      client.send({ ...left, resumeOnly: true })
      const recovered = await client.until('term-error', 'term-opened')
      expect(recovered.t).toBe('term-opened')
      const history = Terminal.fromCheckpoint(recovered.checkpoint).toText()
      expect(history).toContain('left-41')
      expect(history).toContain('[Host restarted. Previous output restored.]')
      expect(history).not.toContain('right-73')
      await sendOutput(recovered.termId, 'printf "fresh-%s\\n" "${HARNESS_PANE_VALUE:-empty}"', 'fresh-empty')
      client.send({ ...right, resumeOnly: true })
      const recoveredRight = await client.until('term-opened')
      expect(Terminal.fromCheckpoint(recoveredRight.checkpoint).toText()).toContain('right-73')

      using writer = new Database(join(dir, 'test.sqlite'))
      writer.exec('BEGIN IMMEDIATE')
      try {
        client.send({ t: 'term-close', termId: recovered.termId })
        expect(await client.until('term-error', 'term-closed')).toMatchObject({ t: 'term-error', termId: recovered.termId })
      }
      finally { writer.exec('ROLLBACK') }
      client.send({ t: 'term-close', termId: recovered.termId })
      await client.until('term-closed')
      await restart()
      client.send({ ...left, resumeOnly: true })
      expect((await client.until('term-error', 'term-opened')).t).toBe('term-error')
      client.send({ ...right, resumeOnly: true })
      const surviving = await client.until('term-opened')
      expect(Terminal.fromCheckpoint(surviving.checkpoint).toText()).toContain('right-73')
    }
    finally { client.close() }
  })

  it('resizes a live terminal, and the shell sees the new size', async () => {
    // The native backend (pty-shim.c via TinyCC) is what makes this possible;
    // asked via `stty size` so the answer comes from the kernel's winsize,
    // not from anything this test wrote.
    const client = await TestClient.connect(url())
    await client.until('ready')
    const workspaceId = await openWorkspace(client)

    client.send({ t: 'term-open', workspaceId, cols: 60, rows: 12 })
    const opened = await client.until('term-opened')

    async function sttySize(marker: string): Promise<string> {
      // The command echo shows the unexpanded substitution, so `marker-NxM`
      // can only come from the shell's answer.
      client.send({ t: 'term-input', termId: opened.termId, data: `echo "${marker}-$(stty size | tr ' ' 'x')"\n` })
      let seen = ''
      const want = new RegExp(`${marker}-(\\d+x\\d+)`)
      for (let i = 0; i < 60; i++) {
        const frame = await client.next()
        if (frame?.t === 'term-data' && frame.termId === opened.termId) seen += frame.data
        if (frame?.t === 'timeout') break
        const match = seen.match(want)
        if (match?.[1]) return match[1]
      }
      return ''
    }

    expect(await sttySize('sz1')).toBe('12x60')

    client.send({ t: 'term-resize', termId: opened.termId, cols: 96, rows: 30 })
    // The resize is an ioctl away, but give the event loop a beat.
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(await sttySize('sz2')).toBe('30x96')

    // The slave must be the shell's *controlling* terminal, not merely its
    // stdio — job control and ^C-to-the-foreground-group depend on it. A
    // shell without one reports tpgid 0 (macOS) or -1 (Linux).
    client.send({ t: 'term-input', termId: opened.termId, data: 'echo "jc-$(ps -o tpgid= -p $$ | tr -d \' \')"\n' })
    let jc = ''
    for (let i = 0; i < 60; i++) {
      const frame = await client.next()
      if (frame?.t === 'term-data' && frame.termId === opened.termId) jc += frame.data
      if (frame?.t === 'timeout') break
      if (/jc-\S+\r?\n/.test(jc.replace(/\x1B\[[0-9;?]*[a-z]/gi, ''))) break
    }
    const tpgid = Number(jc.replace(/\x1B\[[0-9;?]*[a-z]/gi, '').match(/jc-(-?\d+)/)?.[1] ?? 0)
    expect(tpgid).toBeGreaterThan(0)

    client.send({ t: 'term-close', termId: opened.termId })
    client.close()
  })
})

describe('the render cache', () => {
  // The real template renders here — slow, so one test carries the whole
  // contract: miss, hit with identical bytes, invalidation on the next event.
  // The view resolves from cwd, which under `bun test` is the package dir.
  it('renders once per state change and invalidates on the next event', async () => {
    const root = join(import.meta.dir, '../../..')
    const previousCwd = process.cwd()
    process.chdir(root)
    try {
      const base = `http://127.0.0.1:${port}`
      const first = await fetch(`${base}/`)
      expect(first.status).toBe(200)
      expect(first.headers.get('x-render-cache')).toBe('miss')
      const body = await first.text()
      const assets = [...new Set(Array.from(
        body.matchAll(/(?:src|href)="(\/_stx\/(?:runtime|router|modules|css)\.[0-9a-f]{16}\.(?:js|css))"/gu),
        match => match[1]!,
      ))]
      expect(assets.some(path => path.startsWith('/_stx/runtime.'))).toBe(true)
      expect(assets.some(path => path.startsWith('/_stx/css.'))).toBe(true)
      for (const path of assets) {
        const asset = await fetch(`${base}${path}`)
        expect(asset.status).toBe(200)
        expect(asset.headers.get('cache-control')).toContain('immutable')
        expect(asset.headers.get('content-type')).toContain(path.endsWith('.css') ? 'text/css' : 'text/javascript')
        expect((await asset.text()).length).toBeGreaterThan(0)
      }
      expect((await fetch(`${base}/_stx/runtime.0000000000000000.js`)).status).toBe(404)

      const second = await fetch(`${base}/`)
      expect(second.headers.get('x-render-cache')).toBe('hit')
      expect(await second.text()).toBe(body)

      // A different URL is a different page, never the cached one.
      const other = await fetch(`${base}/?profile=1`)
      expect(other.headers.get('x-render-cache')).toBe('miss')

      const client = await TestClient.connect(url())
      await client.until('ready')
      client.send({
        t: 'dispatch',
        envelope: { id: 'rc_1', at: Date.now(), command: { type: 'profile.create', name: 'Cache' } },
      })
      await client.until('dispatched')
      client.close()

      const third = await fetch(`${base}/`)
      expect(third.headers.get('x-render-cache')).toBe('miss')
      // The invalidation was not ceremonial: the new state is in the page.
      expect(await third.text()).toContain('Cache')
    }
    finally {
      process.chdir(previousCwd)
    }
  }, 60000)
})
