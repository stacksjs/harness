import type { HarnessServer } from '../src/server'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { Terminal } from '@harness/ansi'
import { decode, encode } from '@harness/contract'
import { derivedId } from '@harness/engine'
import { ProjectScripts } from '../src/project-scripts'
import { PullRequestReplyReceipts } from '../src/pull-request-reply-receipts'
import { repositoryGitHubRequest } from '../src/repository-pull-request'
import { serve } from '../src/server'
import { fixtureGitHubCli } from './fixtures/github-cli'
import { fixtureGitRepository, fixturePullRequest, serveFixtureGit } from './fixtures/git-http'

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

async function pullRequestLifecycleForm(view: string, label = 'Update pull request') {
  const html = await fetch(view).then(response => response.text())
  const forms = [...html.matchAll(/<form method="post" action="([^"]+)" (aria-label|aria-labelledby)="([^"]+)"[^>]*>([\s\S]*?)<\/form>/gu)]
  const form = forms.find(candidate => candidate[3] === label)
  if (!form) throw new Error('Missing pull request lifecycle form')
  const entities: Record<string, string> = { amp: '&', quot: '"', '#34': '"', apos: "'", '#39': "'", lt: '<', gt: '>' }
  const values = Object.fromEntries(
    [...form[4]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)"/gu)].map(field => [field[1]!,
      field[2]!.replace(/&(amp|quot|#34|apos|#39|lt|gt);/gu, (_, entity: string) => entities[entity]!)]),
  )
  return { endpoint: new URL(form[1]!.replaceAll('&amp;', '&'), view), values, html }
}

function seedPullRequestLifecycle(title: string, draft: boolean) {
  const project = join(dir, 'pr-project')
  mkdirSync(project)
  const repository = 'fixture/notebook'
  const url = 'https://github.com/' + repository + '/pull/1'
  for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', 'https://github.com/' + repository]]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: project })
    if (!result.success) throw new Error(result.stderr.toString())
  }
  const cli = fixtureGitHubCli(dir, { [repository]: { bare: join(project, '.git') } })
  const local = 'a'.repeat(40)
  const base = 'b'.repeat(40)
  const readState = () => JSON.parse(readFileSync(cli.state, 'utf8'))
  const state = readState()
  state.pulls.push({ number: 1, html_url: url, title, state: 'open', draft,
    updated_at: '2026-11-01T17:00:00Z', user: { login: 'fixture-user' },
    head: { sha: local, ref: 'report' }, base: { ref: 'main', sha: base, repo: { full_name: repository } } })
  writeFileSync(cli.state, JSON.stringify(state))
  return { project, cli, local, base, url, readState }
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'harness-server-'))
  const dbPath = join(dir, 'test.sqlite')
  prepareDatabase(dbPath)
  harness = await serve({ port: 0, databasePath: dbPath })
  port = harness.server.port
})

afterEach(() => {
  harness?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('repository cloning', () => {
  const cloneId = 'web_clone_1'
  const cloneUrl = (suffix = '') => `http://127.0.0.1:${port}/projects/clone${suffix}`
  const start = (input: { id?: string, remote: string, destination: string }) => fetch(cloneUrl(), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: cloneId, ...input }),
  })
  async function jobAfter(id = cloneId) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const result = await fetch(cloneUrl('?id=' + id))
      const job = await result.json()
      if (['done', 'failed', 'cancelled'].includes(job.phase)) return job
      await Bun.sleep(50)
    }
    throw new Error('Clone did not finish.')
  }

  it('uses real Git, replays one intent and registers an untrusted checkout', async () => {
    const fixture = fixtureGitRepository(dir)
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    const git = serveFixtureGit(fixture.remote, () => { entered.resolve(); return resume.promise })
    const destination = join(dir, 'working-copy')
    const remote = `http://127.0.0.1:${git.port}/notebook.git`
    try {
      expect((await start({ remote: 'ext::anything', destination })).status).toBe(400)
      expect((await start({ remote, destination })).status).toBe(202)
      await entered.promise
      expect((await start({ remote, destination })).status).toBe(200)
      expect((await start({ id: 'web_clone_2', remote, destination })).status).toBe(409)
      expect(existsSync(destination)).toBe(false)
      resume.resolve()
      const job = await jobAfter()
      expect(job).toMatchObject({ phase: 'done', destination: realpathSync(destination) })
      expect(typeof job.workspace).toBe('number')
      expect(typeof job.profile).toBe('number')
      expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('Clone fixture notebook\n')
      expect(harness.engine.current.workspaces.get(job.workspace)).toMatchObject({ path: realpathSync(destination), trusted: false })
      expect(harness.engine.current.sessions.size).toBe(0)
      expect(await (await start({ remote, destination })).json()).toMatchObject({ workspace: job.workspace, phase: 'done' })
    }
    finally { resume.resolve(); git.stop(true) }
  }, 20_000)

  it('stops Git or preserves a folder that arrives during a clone', async () => {
    const fixture = fixtureGitRepository(dir)
    for (const cancel of [true, false]) {
      const entered = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      const git = serveFixtureGit(fixture.remote, () => { entered.resolve(); return resume.promise })
      const id = cancel ? 'web_clone_3' : 'web_clone_4'
      const destination = join(dir, id)
      const remote = `http://127.0.0.1:${git.port}/notebook.git`
      try {
        expect((await start({ id, remote, destination })).status).toBe(202)
        await entered.promise
        if (cancel) {
          expect((await fetch(cloneUrl('?id=' + id), { method: 'DELETE' })).status).toBe(200)
          expect(await jobAfter(id)).toMatchObject({ phase: 'cancelled' })
          expect(existsSync(destination)).toBe(false)
        }
        else {
          mkdirSync(destination)
          writeFileSync(join(destination, 'keep.txt'), 'existing data')
          resume.resolve()
          expect(await jobAfter(id)).toMatchObject({ phase: 'failed', error: 'The destination folder already exists. Choose a new folder.' })
          expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('existing data')
          expect(existsSync(join(destination, '.git'))).toBe(false)
        }
      }
      finally { resume.resolve(); git.stop(true) }
    }
    expect(harness.engine.current.workspaces.size).toBe(0)
  }, 25_000)

  it('finishes publishing an owned checkout after restart', async () => {
    const fixture = fixtureGitRepository(dir)
    const stage = join(dir, '.harness-clone-fixture')
    const checkout = join(stage, 'checkout')
    const destination = join(dir, 'interrupted-checkout')
    mkdirSync(checkout, { recursive: true })
    mkdirSync(destination)
    cpSync(fixture.bare, join(checkout, '.git'), { recursive: true })
    copyFileSync(join(dir, 'seed', 'README.md'), join(destination, 'README.md'))
    writeFileSync(join(destination, '.harness-clone-fixture'), cloneId)
    harness.stop()
    const databasePath = join(dir, 'test.sqlite')
    {
      using db = new Database(databasePath)
      db.run("INSERT INTO harness_project_clones (id, remote, destination, stage, phase) VALUES (?, ?, ?, ?, 'publishing')",
        [cloneId, 'https://github.com/fixture/notebook.git', realpathSync(destination), realpathSync(stage)])
    }
    harness = await serve({ port, databasePath })
    const job = await jobAfter()
    expect(job.phase).toBe('done')
    expect(harness.engine.current.workspaces.get(job.workspace)).toMatchObject({ trusted: false })
    expect(existsSync(join(destination, '.git'))).toBe(true)
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('Clone fixture notebook\n')
  }, 20_000)

  it('blocks clone requests from another web origin and from a paired device', async () => {
    const foreign = await fetch(cloneUrl('?remote=fixture/notebook'), { headers: { origin: 'https://example.org' } })
    expect(foreign.status).toBe(403)
    const databasePath = join(dir, 'paired-clone.sqlite')
    prepareDatabase(databasePath)
    const remote = await serve({ port: 0, remote: true, databasePath, localTokenPath: join(dir, 'clone-token') })
    try {
      const base = `http://127.0.0.1:${remote.server.port}`
      const pair = await fetch(base + '/pair', {
        method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ code: remote.access!.openPairing().code, name: 'Clone fixture' }),
      })
      const cookie = pair.headers.get('set-cookie')!.split(';')[0]!
      expect((await fetch(base + '/projects/clone?remote=fixture/notebook', { headers: { cookie } })).status).toBe(403)
    }
    finally { remote.stop() }
  })
})

describe('pull request links', () => {
  it.skipIf(process.platform === 'win32')('fetches a pinned PR after confirmation and reopens it after restart', async () => {
    const fixture = fixtureGitRepository(dir)
    const commit = fixturePullRequest(dir, 7)
    const project = join(dir, 'project')
    const repository = join(project, 'api')
    mkdirSync(project)
    const runGit = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    runGit(dir, 'clone', '-q', '--', fixture.bare, repository)
    runGit(repository, 'remote', 'add', 'upstream', 'https://github.com/fixture/notebook.git')
    const sourceHead = runGit(repository, 'rev-parse', 'HEAD')
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    let reads = 0
    const git = serveFixtureGit(fixture.remote, () => { reads++; entered.resolve(); return resume.promise })
    const restore = new Map<string, string | undefined>()
    function gitEnv(key: string, value: string) {
      restore.set(key, process.env[key])
      process.env[key] = value
    }
    const index = Number(process.env.GIT_CONFIG_COUNT) || 0
    gitEnv('GIT_CONFIG_COUNT', String(index + 1))
    gitEnv('GIT_CONFIG_KEY_' + index, 'url.http://127.0.0.1:' + git.port + '/notebook.git.insteadOf')
    gitEnv('GIT_CONFIG_VALUE_' + index, 'https://github.com/fixture/notebook.git')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    const endpoint = (number = 7, workspace?: number) => {
      const params = new URLSearchParams({ pr: 'Fixture/Notebook/' + number })
      if (workspace) params.set('workspace', String(workspace))
      return 'http://127.0.0.1:' + port + '/prompt-link/pull-request?' + params
    }
    const post = (workspace: number, number?: number) => fetch(endpoint(number, workspace), {
      method: 'POST', headers: { 'content-type': 'application/json' },
    })
    let pending: Promise<Response> | undefined
    try {
      await dispatch('pr-profile', { type: 'profile.create', name: 'PR fixture' })
      await dispatch('pr-project', { type: 'workspace.add', profileId: derivedId('pr-profile'), path: realpathSync(project) })
      const workspace = derivedId('pr-project')
      expect(await (await fetch(endpoint())).json()).toMatchObject({ project: null })
      expect((await post(workspace)).status).toBe(409)
      await dispatch('pr-project-trust', { type: 'workspace.trust', workspaceId: workspace, trusted: true })
      const scripts = new ProjectScripts(join(dir, 'test.sqlite'))
      try {
        scripts.save(workspace, {
          name: 'PR fixture setup', command: "printf 'configured setup\\n' >> setup.txt",
          runOnWorktreeCreate: true, waitForSetup: true, previewUrl: '', stopOnSettle: false, autoOpenPreview: false,
        })
      }
      finally { scripts.close() }
      expect(await (await fetch(endpoint())).json()).toMatchObject({ project: { id: workspace }, canCheckOut: true })
      expect(reads).toBe(0)
      expect(harness.engine.current.sessions.size).toBe(0)
      const stale = await fetch(endpoint(7, workspace) + '&session=1234', {
        method: 'POST', headers: { 'content-type': 'application/json' },
      })
      expect(stale.status).toBe(409)
      expect(reads).toBe(0)
      const foreign = await fetch(endpoint(7, workspace), {
        method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.invalid' },
      })
      expect(foreign.status).toBe(403)
      pending = post(workspace)
      expect(await Promise.race([entered.promise.then(() => true), Bun.sleep(3000).then(() => false)])).toBe(true)
      expect((await post(workspace)).status).toBe(409)
      resume.resolve()
      const response = await pending
      expect(response.status).toBe(201)
      const { sessionId } = await response.json()
      const deadline = Date.now() + 8000
      while (!harness.engine.current.sessions.get(sessionId)?.worktreePath && Date.now() < deadline) await Bun.sleep(20)
      const thread = harness.engine.current.sessions.get(sessionId)!
      expect(thread).toMatchObject({
        workspaceId: workspace, isolate: true, providerSessionId: '', turns: [],
        pullRequest: { repository: 'Fixture/Notebook', repositoryKey: 'api', commit, number: 7 },
      })
      expect(runGit(join(thread.worktreePath, 'api'), 'rev-parse', 'HEAD')).toBe(commit)
      expect(readFileSync(join(thread.worktreePath, 'api', 'review.txt'), 'utf8')).toBe('Only in the pull request\n')
      const setupUrl = 'http://127.0.0.1:' + port + '/s/' + sessionId + '/project-setup'
      let setup
      do {
        setup = await (await fetch(setupUrl)).json()
        if (setup?.status === 'completed') break
        await Bun.sleep(25)
      } while (Date.now() < deadline)
      expect(setup).toMatchObject({ status: 'completed' })
      expect(readFileSync(join(thread.worktreePath, 'setup.txt'), 'utf8')).toBe('configured setup\n')
      expect(runGit(repository, 'rev-parse', 'HEAD')).toBe(sourceHead)
      expect(existsSync(join(repository, 'review.txt'))).toBe(false)
      const fetched = reads
      expect(await (await post(workspace)).json()).toEqual({ sessionId })
      expect(reads).toBe(fetched)
      expect((await post(workspace, 8)).status).toBe(502)
      expect(harness.engine.current.sessions.size).toBe(1)
      harness.stop()
      harness = await serve({ port, databasePath: join(dir, 'test.sqlite') })
      expect(await (await fetch(endpoint())).json()).toEqual({ sessionId })
      expect(harness.engine.current.sessions.get(sessionId)?.pullRequest?.commit).toBe(commit)
      harness.stop()
      harness = await serve({ port, databasePath: join(dir, 'test.sqlite'), remote: true, localTokenPath: join(dir, 'pr-token') })
      const pair = await fetch('http://127.0.0.1:' + port + '/pair', {
        method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ code: harness.access!.openPairing().code, name: 'PR fixture device' }),
      })
      const cookie = pair.headers.get('set-cookie')!.split(';')[0]!
      expect(await (await fetch(endpoint(), { headers: { cookie } })).json()).toEqual({ sessionId })
      expect((await fetch(endpoint(8, workspace), { method: 'POST', headers: { 'content-type': 'application/json', cookie } })).status).toBe(403)
    }
    finally {
      resume.resolve()
      git.stop(true)
      await pending?.catch(() => {})
      for (const [key, value] of restore) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }, 20_000)
})

describe('shared workspace addresses', () => {
  it('serves prompt routes without caching or embedding the prompt in HTML', async () => {
    const previousCwd = process.cwd()
    process.chdir(join(import.meta.dir, '../../..'))
    try {
      const marker = 'UNIQUE_PRIVATE_PROMPT_FOR_SHARE'
      const response = await fetch(`http://127.0.0.1:${port}/new?prompt=${marker}`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(await response.text()).not.toContain(marker)
      const missing = await fetch(`http://127.0.0.1:${port}/s/999992`)
      expect(missing.status).toBe(404)
      expect(await missing.text()).toContain('Thread unavailable')
    }
    finally { process.chdir(previousCwd) }
  }, 15_000)

  it('preserves only a safe destination while pairing a new device', async () => {
    const databasePath = join(dir, 'link-pairing.sqlite')
    prepareDatabase(databasePath)
    const remote = await serve({ port: 0, remote: true, databasePath, localTokenPath: join(dir, 'link-pairing-token') })
    try {
      const base = `http://127.0.0.1:${remote.server.port}`
      const pending = await fetch(base + '/s/112?prompt=Open+draft&model=fixture&token=ignore-me', { headers: { accept: 'text/html' } })
      expect(pending.status).toBe(401)
      const html = await pending.text()
      expect(html).toContain('/s/112?prompt=Open+draft&amp;model=fixture')
      expect(html).not.toContain('ignore-me')
      const redeem = (next: string) => fetch(base + '/pair', {
        method: 'POST', redirect: 'manual',
        body: new URLSearchParams({ code: remote.access!.openPairing().code, next, name: 'Shared link fixture' }),
      })
      const onThread = await redeem('/s/112?prompt=Open+draft&branch=foreign#turn-56')
      expect(onThread.status).toBe(303)
      expect(onThread.headers.get('location')).toBe('/s/112?prompt=Open+draft#turn-56')
      expect(onThread.headers.get('set-cookie')).toContain('HttpOnly')
      expect((await redeem('/\\evil.invalid/new?prompt=x')).headers.get('location')).toBe('/')
    }
    finally { remote.stop() }
  })
})

function url(): string {
  return `ws://127.0.0.1:${port}/ws`
}

describe('harness serve — HTTP', () => {
  it.skipIf(process.platform === 'win32')('shows people, bots, and teams requested to review a GitHub pull request', async () => {
    const { project, cli, url, readState } = seedPullRequestLifecycle('Review the monthly report', false)
    const fixture = readState()
    fixture.pulls[0].requested_reviewers = [{ login: 'requested-reviewer' }, { login: 'requested-reviewer' }, { login: 'quality-check[bot]' }, null]
    fixture.pulls[0].requested_teams = [{ slug: 'release-review' }, { slug: '<img src=x>' }]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-reviewers-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      const detail = 'http://127.0.0.1:' + port + '/pull-requests?' + new URLSearchParams({ selectedUrl: url })
      const summary = await fetch(detail).then(response => response.text())
      expect(summary).toContain('id="pr-reviewers-title">Reviewers')
      expect(summary.match(/@requested-reviewer/gu)).toHaveLength(1)
      expect(summary).toContain('@quality-check[bot]')
      expect(summary).toContain('@fixture/release-review')
      expect(summary).not.toContain('<img src=x>')
      fixture.pulls[0].requested_reviewers = []
      fixture.pulls[0].requested_teams = []
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect(await fetch(detail).then(response => response.text())).not.toContain('id="pr-reviewers-title">Reviewers')
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      rmSync(project, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('shows latest GitHub review outcomes for the displayed head and retains pending reviewers during read failures', async () => {
    const { project, cli, local, base, url, readState } = seedPullRequestLifecycle('Review the monthly report', false)
    const fixture = readState()
    const verdict = (id: number, login: string | null, state: string, timestamp: string, commit: string | null = local) =>
      ({ id, user: login && { login }, state, submitted_at: timestamp, commit_id: commit })
    fixture.pulls[0].requested_reviewers = [{ login: 'Release-Reviewer' }]
    fixture.pulls[0].requested_teams = [{ slug: 'shipping-team' }]
    fixture.pulls[0].reviewDecision = 'CHANGES_REQUESTED'
    fixture.pulls[0].latestReviews = [
      { state: 'COMMENTED', author: { __typename: 'Bot', login: 'quality-bot' } },
      { state: 'COMMENTED', isMinimized: true, author: { login: 'minimized-reviewer' } },
      { state: 'DISMISSED', author: { login: 'dismissed-approver' } },
    ]
    fixture.reviewOutcomePages = [[
      verdict(1, 'dismissed-approver', 'APPROVED', '2026-11-01T12:00:00Z'),
      verdict(2, 'release-reviewer', 'APPROVED', '2026-11-01T13:00:00Z'),
      verdict(3, 'older-approval', 'APPROVED', '2026-11-01T13:00:00Z', base),
      verdict(4, 'waiting-user', 'PENDING', '2026-11-01T13:00:00Z'),
    ], [
      verdict(5, 'dismissed-approver', 'DISMISSED', '2026-11-01T14:00:00Z'),
      verdict(6, 'Release-Reviewer', 'COMMENTED', '2026-11-01T14:00:00Z'),
      verdict(8, 'requested-corrections', 'CHANGES_REQUESTED', '2026-11-01T09:00:00-05:00'),
      verdict(7, 'requested-corrections', 'APPROVED', '2026-11-01T14:00:00Z'),
      verdict(9, null, 'APPROVED', '2026-11-01T14:01:00Z', null),
    ]]
    fixture.reviewDismissed = [{ event: 'review_dismissed', actor: { login: 'maintainer' }, created_at: '2026-11-01T14:02:00Z' }]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'review-outcomes-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      const detail = 'http://127.0.0.1:' + port + '/pull-requests?' + new URLSearchParams({ selectedUrl: url })
      const section = async () => (await fetch(detail).then(response => response.text())).match(/<section id="pr-reviewers"[\s\S]*?<\/section>/u)?.[0] ?? ''
      const summary = await section()
      expect(summary).toContain('GitHub review status <strong>Changes requested</strong>')
      expect(summary.match(/@Release-Reviewer/gu)).toHaveLength(1)
      expect(summary).toContain('Review requested again')
      expect(summary).toContain('Approved on an earlier commit')
      expect(summary).toMatch(/@requested-corrections[\s\S]*?data-pr-review-outcome="changes-requested"/u)
      expect(summary).toContain('Unknown reviewer')
      expect(summary).toContain('Commit unavailable')
      expect(summary).toMatch(/@dismissed-approver\s*<\/span>\s*<small>Review dismissed<\/small>/u)
      expect(summary).toMatch(/@quality-bot\[bot\]\s*<\/span>\s*<small>Commented<\/small>/u)
      expect(summary).not.toMatch(/minimized-reviewer|waiting-user/u)
      expect(await fetch(detail + '&tab=timeline').then(response => response.text())).toContain('Dismissed a review')

      fixture.pulls[0].head.sha = 'd'.repeat(40)
      fixture.pulls[0].reviewDecision = 'REVIEW_REQUIRED'
      writeFileSync(cli.state, JSON.stringify(fixture))
      const afterPush = await section()
      expect(afterPush).toContain('GitHub review status <strong>Review required</strong>')
      expect(afterPush).toContain('Changes requested on an earlier commit')

      fixture.reviewOutcomeReadFailure = 2
      writeFileSync(cli.state, JSON.stringify(fixture))
      const failed = await section()
      expect(failed).toContain('Could not load review outcomes from GitHub.')
      expect(failed).toContain('@Release-Reviewer')
      expect(failed).toContain('@fixture/shipping-team')
      expect(failed).not.toMatch(/older-approval|Private review history diagnostics/u)
      delete fixture.reviewOutcomeReadFailure
      fixture.reviewOutcomePages = [...fixture.reviewOutcomePages, ...Array.from({ length: 9 }, () => [])]
      writeFileSync(cli.state, JSON.stringify(fixture))
      const truncated = await section()
      expect(truncated).toContain('Open the pull request on GitHub to see its full review history.')
      expect(truncated).not.toContain('@older-approval')
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
      rmSync(project, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('searches and changes reviewed GitHub reviewers with durable recovery', async () => {
    const { project, cli, url, readState } = seedPullRequestLifecycle('Review the monthly report', false)
    const team = { id: 'team:release', __typename: 'Team', slug: 'release', name: 'Release review' }
    const bot = { id: 'bot:checks', __typename: 'Bot', login: 'checks[bot]' }
    const person = { id: 'user:1', __typename: 'User', login: 'alix', name: 'Alix Example' }
    const next = { id: 'user:2', __typename: 'User', login: 'dorian', name: 'Dorian Reviewer' }
    const other = { id: 'user:3', __typename: 'User', login: 'sam' }
    const fixture = readState()
    fixture.labelPermission = 'WRITE'
    fixture.reviewerPeople = [{ ...person, id: 'user:author', login: 'fixture-user' }, person, next, other]
    fixture.reviewerPageSize = 2
    fixture.pulls[0].reviewerNodes = [team, bot]
    fixture.pulls[0].requested_reviewers = [bot]
    fixture.pulls[0].requested_teams = [team]
    fixture.pulls.push({ ...fixture.pulls[0], number: 2, html_url: url.replace(/1$/u, '2'), reviewerNodes: [], requested_reviewers: [], requested_teams: [] })
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'reviewer-picker-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const address = () => host + '/pull-requests?' + new URLSearchParams({ selectedUrl: url, reviewers: 'edit' })
      const first = await pullRequestLifecycleForm(address(), 'pr-reviewer-editor-title')
      expect(first.html).toContain('More people match on GitHub.')
      expect(first.html).toContain('Alix Example')
      expect(first.html).not.toContain('Dorian Reviewer')
      const values = first.values
      expect(JSON.parse(values.scope!)).toHaveLength(3)
      const post = (fields: Record<string, string>, ids: string[], options: { search?: string, origin?: string, target?: string, accept?: string } = {}) => {
        const endpoint = new URL(first.endpoint.pathname + first.endpoint.search, host)
        if (options.target) endpoint.searchParams.set('selectedUrl', options.target)
        const body = new URLSearchParams(fields)
        for (const id of ids) body.append('reviewer', id)
        if (options.search) {
          body.set('operation', 'search')
          body.set('query', options.search)
        }
        return fetch(endpoint, { method: 'POST', redirect: 'manual', headers: {
          accept: options.accept ?? 'application/json', origin: options.origin ?? host, 'content-type': 'application/x-www-form-urlencoded',
        }, body })
      }
      const staged = [person.id, bot.id]
      expect((await post(values, staged, { origin: 'https://elsewhere.invalid' })).status).toBe(403)
      expect((await post(values, [...staged, 'unknown'])).status).toBe(400)
      expect((await post(values, staged, { target: url.replace(/1$/u, '2') })).status).toBe(409)
      fixture.labelPermission = 'TRIAGE'
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await post(values, staged)).status).toBe(403)
      expect(await fetch(address()).then(response => response.text())).not.toContain('Save reviewers')

      fixture.labelPermission = 'WRITE'
      fixture.reviewerSearchFailure = true
      writeFileSync(cli.state, JSON.stringify(fixture))
      const failedSearch = await post(values, staged, { search: next.login })
      expect(failedSearch.status).toBe(503)
      expect(await failedSearch.json()).toMatchObject({ editor: { search: next.login,
        options: expect.arrayContaining([expect.objectContaining({ id: person.id, checked: true, display: '@alix' })]) } })
      fixture.reviewerSearchFailure = false
      writeFileSync(cli.state, JSON.stringify(fixture))
      const searched = await post(values, staged, { search: next.login })
      expect(searched.status).toBe(200)
      const found = await searched.json() as { editor: Record<string, string> & { options: { id: string, checked: boolean }[] } }
      expect(found.editor.options.map(({ id, checked }) => [id, checked])).toEqual([[bot.id, true], [team.id, false], [person.id, true], [next.id, false]])
      const { head, viewer, intent, scope, revision } = found.editor
      const revised = { head, viewer, intent, scope, revision }
      expect(readState().reviewerWrites).toBeUndefined()

      fixture.reviewerPeople[2] = { ...next, login: 'new-login' }
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await post(revised, [...staged, next.id])).status).toBe(409)
      expect(readState().reviewerWrites).toBeUndefined()
      fixture.reviewerPeople[2] = next
      fixture.pulls[0].reviewerNodes.push(other)
      fixture.pulls[0].requested_reviewers.push(other)
      fixture.reviewerDropResponse = person.id
      writeFileSync(cli.state, JSON.stringify(fixture))

      const partial = await post(revised, [...staged, next.id], { accept: 'text/html' })
      expect(partial.status).toBe(202)
      expect(await partial.text()).toContain('Check GitHub and finish')
      expect(readState().reviewerWrites).toEqual([[1, 'DELETE', team.id], [1, 'POST', person.id]])
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      const resumed = await post(revised, [...staged, next.id], { accept: 'text/html' })
      expect(resumed.status).toBe(303)
      const saved = await fetch(new URL(resumed.headers.get('location')!, host)).then(response => response.text())
      expect(saved).toContain('Review requests updated on GitHub.')
      expect(saved).toContain('@sam')
      expect(saved).not.toContain('@fixture/release')
      const done = readState()
      expect(done.pulls[0].reviewerNodes.map(({ id }: { id: string }) => id)).toEqual([bot.id, other.id, person.id, next.id])
      done.pulls[0].reviewerNodes = [bot, other]
      writeFileSync(cli.state, JSON.stringify(done))
      expect(await (await post(revised, [...staged, next.id])).json()).toMatchObject({ result: 'confirmed' })
      expect(readState().reviewerWrites).toEqual([[1, 'DELETE', team.id], [1, 'POST', person.id], [1, 'POST', next.id]])
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('applies the reviewed pull request label changes and recovers a partial save across restarts', async () => {
    const { project, cli, url, readState } = seedPullRequestLifecycle('Review the monthly report', false)
    const old = { id: 11, name: 'legacy/needs review', color: 'aa2222', archived_at: '2026-11-10T15:00:00Z' }
    const inactive = { ...old, id: 12, name: 'Unused archived' }
    const add = { id: 31, name: 'Report & analysis', color: '298265', description: 'Review the CSV export' }
    const concurrent = { id: 41, name: 'Accessibility', color: 'cc5599' }
    const fixture = readState()
    fixture.pulls[0].state = 'closed'
    fixture.pulls[0].labels = [old]
    fixture.pulls.push({ ...fixture.pulls[0], number: 2, html_url: url.replace(/1$/u, '2'), labels: [] })
    fixture.labelPermission = 'TRIAGE'
    fixture.labelPages = [[old, inactive], [add, concurrent]]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-labels-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const editor = () => host + '/pull-requests?' + new URLSearchParams({ selectedUrl: url, state: 'closed', labels: 'edit' })
      const original = await pullRequestLifecycleForm(editor(), 'pr-label-editor-title')
      expect(original.html).toContain('legacy/needs review')
      expect(original.html).toContain('Review the CSV export')
      expect(original.html).not.toContain('Unused archived')
      expect(JSON.parse(original.values.scope)).toHaveLength(3)
      const save = (form: typeof original, selected: string[], overrides: Record<string, string> = {}, accept = 'application/json') => {
        const endpoint = new URL(form.endpoint.pathname + form.endpoint.search, host)
        if (overrides.selectedUrl) endpoint.searchParams.set('selectedUrl', overrides.selectedUrl)
        const body = new URLSearchParams(form.values)
        for (const id of selected) body.append('label', id)
        return fetch(endpoint, { method: 'POST', redirect: 'manual', headers: {
          origin: overrides.origin ?? host, accept, 'content-type': 'application/x-www-form-urlencoded',
        }, body })
      }
      expect((await save(original, ['31'], { origin: 'https://elsewhere.invalid' })).status).toBe(403)
      expect((await save(original, ['99'])).status).toBe(400)
      expect((await save(original, ['31'], { selectedUrl: url.replace(/1$/u, '2') })).status).toBe(409)
      fixture.labelPermission = 'READ'
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await save(original, ['31'])).status).toBe(403)
      expect(await fetch(editor()).then(response => response.text())).not.toContain('Save labels')

      fixture.labelPermission = 'TRIAGE'
      fixture.labelPages[1][0] = { ...add, name: 'Renamed since review' }
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await save(original, ['31'])).status).toBe(409)
      expect(readState().labelWrites).toBeUndefined()
      fixture.labelPages[1][0] = add
      fixture.pulls[0].labels.push(concurrent)
      fixture.labelDropResponse = add.id
      writeFileSync(cli.state, JSON.stringify(fixture))

      const partial = await save(original, ['31'], {}, 'text/html')
      expect(partial.status).toBe(202)
      expect(await partial.text()).toContain('Check GitHub and finish labels')
      expect(readState().labelWrites).toEqual([[1, 'POST', 31, add.name]])
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      const resumed = await save(original, ['31'], {}, 'text/html')
      expect(resumed.status).toBe(303)
      const result = await fetch(new URL(resumed.headers.get('location')!, host)).then(response => response.text())
      expect(result).toContain('Labels updated on GitHub.')
      expect(result).toContain('Accessibility')
      expect(result).not.toContain('legacy/needs review')
      const done = readState()
      expect(done.labelWrites).toEqual([[1, 'POST', 31, add.name], [1, 'DELETE', 11, old.name]])
      expect(done.pulls[0].labels.map((label: { id: number }) => label.id)).toEqual([41, 31])
      expect(done.pulls[1].labels).toEqual([])
      // An older confirmed form cannot reapply a label removed by a subsequent editor.
      done.pulls[0].labels = [concurrent]
      done.pulls[0].state = 'open'
      writeFileSync(cli.state, JSON.stringify(done))
      expect(await (await save(original, ['31'])).json()).toMatchObject({ result: 'confirmed' })
      expect(readState().labelWrites).toEqual(done.labelWrites)

      const fresh = await pullRequestLifecycleForm(editor(), 'pr-label-editor-title')
      done.labelDenied = true
      writeFileSync(cli.state, JSON.stringify(done))
      const denied = await save(fresh, ['31', '41'])
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ message: 'This GitHub account cannot change these labels.' })
      done.labelDenied = false
      writeFileSync(cli.state, JSON.stringify(done))
      expect((await save(fresh, ['31', '41'])).status).toBe(200)
      expect(readState().labelWrites).toEqual([...done.labelWrites, [1, 'POST', 31, add.name]])
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('combines GitHub pull request filters, discovers choices, and preserves the query through review navigation', async () => {
    const { project, cli, url, readState } = seedPullRequestLifecycle('Small report with checks', false)
    const fixture = readState()
    const original = fixture.pulls[0]
    const compliance = { id: 41, node_id: 'LA_fixture_41', name: 'Release / Lång, phase 2', color: '224488', description: 'Validate the staged export' }
    const report = { id: 31, node_id: 'LA_fixture_31', name: 'Report & analysis', color: '298265' }
    Object.assign(original, {
      labels: [compliance, report], filterReview: 'approved', filterChecks: 'success',
      requested_reviewers: [{ login: 'fixture-user' }],
    })
    fixture.pulls.push(
      { ...original, number: 2, html_url: url.replace(/1$/u, '2'), title: 'Draft report with checks', draft: true },
      { ...original, number: 3, html_url: url.replace(/1$/u, '3'), title: 'External report with checks', user: { login: 'alix' }, filterReview: 'changes_requested', filterChecks: 'failure' },
      { ...original, number: 4, html_url: url.replace(/1$/u, '4'), title: 'Another report with checks', labels: [report] },
    )
    fixture.labelPages = [[report], [compliance]]
    fixture.filterAuthors = [{ login: 'alix', name: 'Alix Coder' }]
    fixture.filterListIncomplete = 'fixture/notebook'
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pull-request-filters-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      const host = 'http://127.0.0.1:' + port
      const list = (params: URLSearchParams | Record<string, string>) => fetch(host + '/pull-requests?' + new URLSearchParams(params))
      const filters = new URLSearchParams({ draft: 'hide', involvement: 'reviewing', review: 'approved', checks: 'passing', author: '@me', q: 'report' })
      for (const name of [compliance.name, report.name, report.name.toUpperCase()]) filters.append('label', name)
      const response = await list(filters)
      expect(response.status).toBe(200)
      const page = await response.text()
      expect(page).toContain('Small report with checks')
      expect(page).not.toContain('Draft report with checks')
      expect(page).not.toContain('External report with checks')
      expect(page).not.toContain('Another report with checks')
      expect(page).toContain('GitHub returned partial results.')
      const selection = [...page.matchAll(/href="([^"]*selectedUrl=[^"]+)"/gu)][0]?.[1]
      expect(selection).toBeDefined()
      const selected = new URL(selection!.replaceAll('&amp;', '&'), host)
      expect(selected.searchParams.getAll('label')).toEqual([compliance.name, report.name])
      for (const name of ['draft', 'involvement', 'review', 'checks', 'author']) expect(selected.searchParams.get(name)).toBe(filters.get(name))
      const detail = await (await fetch(selected)).text()
      const timeline = [...detail.matchAll(/href="([^"]*tab=timeline[^"]+)"/gu)][0]?.[1]
      expect(timeline).toBeDefined()
      expect(new URL(timeline!.replaceAll('&amp;', '&'), host).searchParams.getAll('label')).toEqual([compliance.name, report.name])

      const labels = await (await list({ find: 'labels', findQuery: 'phase 2', draft: 'hide' })).text()
      expect(labels).toContain('Validate the staged export')
      expect(labels).toMatch(/value="hide"\s+selected/u)
      const authors = await (await list({ find: 'authors', findQuery: 'alix' })).text()
      expect(authors).toContain('Alix Coder')
      expect(authors).toContain('<strong>@alix</strong>')
      const chosen = await (await list({ chooseAuthor: 'alix', author: 'fixture-user', review: 'changes-requested', checks: 'failing' })).text()
      expect(chosen).toContain('External report with checks')
      expect(chosen).not.toContain('Small report with checks')
      expect(await (await list({ involvement: 'authored', author: 'alix' })).text()).toContain('No pull requests match these filters.')

      for (let number = 10; number < 32; number++) fixture.pulls.push({ ...original, number, html_url: url.replace(/1$/u, String(number)),
        title: 'Paged report ' + number, labels: [report] })
      writeFileSync(cli.state, JSON.stringify(fixture))
      const firstPage = await (await list({ addLabel: report.name, author: 'fixture-user' })).text()
      expect([...firstPage.matchAll(/<a\b[^>]*\bdata-pr-row\b/gu)]).toHaveLength(20)
      const next = /<a href="([^"]+)"[^>]*>Next page<\/a>/u.exec(firstPage)?.[1]
      expect(next).toBeDefined()
      const nextPage = new URL(next!.replaceAll('&amp;', '&'), host)
      expect(nextPage.searchParams.get('page')).toBe('2')
      expect(nextPage.searchParams.getAll('label')).toEqual([report.name])
      expect(nextPage.searchParams.get('author')).toBe('fixture-user')

      original.labels.push({ id: 51, name: 'size:S' })
      original.body = 'The ledger needs a checksum.'
      original.searchComments = ['An earlier result was redacted.']
      fixture.pulls[1].labels = [compliance, report, { id: 52, name: 'size:XS' }]
      fixture.pulls.push({ ...original, number: 5, html_url: url.replace(/1$/u, '5'), title: 'Ignored report with checks',
        labels: [...original.labels, { id: 53, name: 'wip' }] })
      fixture.filterListTotal = 1001
      writeFileSync(cli.state, JSON.stringify(fixture))
      const typed = 'repo:fixture/elsewhere is:closed label:"Release / Lång, phase 2",unused size:S,XS -label:wip draft:false author:me review:approved checks:success "report with checks"'
      const typedPage = await (await list({ q: typed, label: 'incompatible menu label', draft: 'only', author: 'alix',
        review: 'changes-requested', checks: 'failing' })).text()
      expect(typedPage).toContain('Small report with checks')
      expect(typedPage).not.toContain('Draft report with checks')
      expect(typedPage).not.toContain('Ignored report with checks')
      expect(typedPage).toMatch(/value="hide"\s+selected/u)
      expect(typedPage).toContain('GitHub search shows up to 1,000 results')
      const typedOnly = await (await list({ q: 'draft:false "Small report"' })).text()
      expect(typedOnly).toContain('More filters (1)')
      expect(typedOnly).not.toContain('Clear additional filters')
      for (const text of ['ledger needs a checksum', 'earlier result was redacted']) {
        const contentSearch = await (await list({ q: 'size:S -label:wip "' + text + '"' })).text()
        expect(contentSearch).toContain('Small report with checks')
        expect(contentSearch).not.toContain('Ignored report with checks')
      }
      const typedHref = /href="([^"]*selectedUrl=[^"]+)"/u.exec(typedPage)?.[1]
      expect(new URL(typedHref!.replaceAll('&amp;', '&'), host).searchParams.get('q')).toBe(typed)
      const changedDraft = await (await list({ q: typed, chooseDraft: 'only', shownDraft: 'hide' })).text()
      expect(changedDraft).toContain('Draft report with checks')
      expect(changedDraft).not.toContain('Small report with checks')
      const changedHref = /href="([^"]*selectedUrl=[^"]+)"/u.exec(changedDraft)?.[1]
      const changedParams = new URL(changedHref!.replaceAll('&amp;', '&'), host).searchParams
      expect(changedParams.get('q')).toBe(typed.replace(' draft:false', ''))
      expect(changedParams.get('draft')).toBe('only')

      fixture.filterListFailure = 'fixture/notebook'
      writeFileSync(cli.state, JSON.stringify(fixture))
      const beyondIndex = await (await list({ q: 'label:bug', page: '51' })).text()
      expect(beyondIndex).toContain('GitHub search shows up to 1,000 results')
      expect(beyondIndex).not.toContain('GitHub could not list this repository.')

      const appendix = join(dir, 'filter-appendix')
      mkdirSync(appendix)
      for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', 'https://github.com/fixture/appendix']])
        expect(Bun.spawnSync(['git', ...args], { cwd: appendix }).success).toBe(true)
      await harness.engine.dispatch({ id: 'pull-request-filters-appendix', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(appendix), trusted: true } })
      fixture.repositories['fixture/appendix'] = { bare: join(appendix, '.git') }
      fixture.filterListFailure = 'fixture/appendix'
      fixture.filterAuthorFailure = 'fixture/appendix'
      writeFileSync(cli.state, JSON.stringify(fixture))
      const partialList = await (await list({ author: '@me', label: compliance.name, q: 'Small report' })).text()
      expect(partialList).toContain('Small report with checks')
      expect(partialList).toContain('fixture/appendix')
      expect(partialList).not.toContain('Private list search diagnostics')
      const partialChoices = await (await list({ find: 'authors', findQuery: 'alix' })).text()
      expect(partialChoices).toContain('Alix Coder')
      expect(partialChoices).toContain('Could not search all selected repositories.')
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('searches a large GitHub label catalog and verifies the selected identities before saving', async () => {
    const { project, cli, local, url, readState } = seedPullRequestLifecycle('Review the monthly report', false)
    const tag = (id: number, name: string) => ({ id: 13_000_000_000 + id, node_id: 'LA_fixture_' + id, name, color: '336611', description: '' })
    const old = { ...tag(1, 'legacy/needs review'), archived_at: '2026-11-10T15:00:00Z' }
    const staged = { ...tag(2, 'Reports & QA'), description: 'For "monthly" reviews' }
    const outside = tag(1201, 'Release / Lång, phase 2')
    const other = tag(1202, 'Concurrent approval')
    const fixture = readState()
    fixture.labelPermission = 'TRIAGE'
    fixture.pulls[0].labels = [old]
    fixture.labelPages = [[old, staged, ...Array.from({ length: 98 }, (_, i) => tag(i + 3, 'Queue ' + (i + 3)))],
      ...Array.from({ length: 11 }, (_, page) => Array.from({ length: 100 }, (_, i) => {
        const id = 101 + page * 100 + i
        return tag(id, 'Queue ' + id)
      })), [outside, other]]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      const projectCommand = 'large-label-catalog-project'
      await harness.engine.dispatch({ id: projectCommand, at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      const host = 'http://127.0.0.1:' + port
      const editor = host + '/pull-requests?' + new URLSearchParams({ selectedUrl: url, labels: 'edit' })
      const original = await pullRequestLifecycleForm(editor, 'pr-label-editor-title')
      expect(original.html).toContain('More labels are available on GitHub.')
      expect(original.html).toContain('Search GitHub')
      expect(original.html).not.toContain(outside.node_id)
      expect(JSON.parse(original.values.scope)).toHaveLength(200)

      const post = (fields: Record<string, string>, selected: string[], search?: string) => {
        const body = new URLSearchParams(fields)
        for (const id of selected) body.append('label', id)
        if (search !== undefined) {
          body.set('operation', 'search')
          body.set('query', search)
        }
        return fetch(original.endpoint, { method: 'POST', redirect: 'manual', headers: {
          origin: host, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
        }, body })
      }
      const checked = [staged.node_id]
      fixture.labelSearchFailure = true
      writeFileSync(cli.state, JSON.stringify(fixture))
      const unavailable = await post(original.values, checked, 'phase 2')
      expect(unavailable.status).toBe(503)
      expect(await unavailable.json()).toMatchObject({ editor: { search: 'phase 2', labels: expect.arrayContaining([
        expect.objectContaining({ key: old.node_id, checked: false }), expect.objectContaining({ key: staged.node_id, checked: true }),
      ]) } })
      fixture.labelSearchFailure = false
      writeFileSync(cli.state, JSON.stringify(fixture))
      const broad = await post(original.values, checked, 'queue')
      expect(broad.status).toBe(200)
      expect(await broad.json()).toMatchObject({ editor: { more: true, matches: 100 } })
      const narrow = await post(original.values, checked, 'phase 2')
      expect(narrow.status).toBe(200)
      const { editor: found } = await narrow.json() as { editor: Record<string, string> & { labels: { key: string, checked: boolean }[] } }
      expect(found.labels.map(({ key, checked }) => [key, checked])).toEqual([[outside.node_id, false], [old.node_id, false], [staged.node_id, true]])
      const { head, viewer, intent, scope, revision } = found
      const reviewed = { head, viewer, intent, scope, revision }

      fixture.labelPages[12][0] = { ...outside, node_id: 'LA_recreated', id: outside.id + 1_000 }
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await post(reviewed, [...checked, outside.node_id])).status).toBe(409)
      fixture.labelPages[12][0] = { ...outside, archived_at: '2026-11-11T15:00:00Z' }
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await post(reviewed, [...checked, outside.node_id])).status).toBe(409)
      expect(readState().labelWrites).toBeUndefined()
      fixture.labelPages[12][0] = outside
      fixture.pulls[0].labels.push(other)
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await post(reviewed, [...checked, outside.node_id])).status).toBe(200)
      const saved = readState()
      expect(saved.pulls[0].labels.map(({ id }: { id: number }) => id)).toEqual([other.id, outside.id, staged.id])
      expect(saved.labelWrites).toHaveLength(3)

      const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      const legacyScope = [outside, old].map(label => `${label.id}:${label === old ? 1 : 0}:${createHash('sha256').update(label.name).digest('hex').slice(0, 24)}`).join(',')
      const profile = Number(original.endpoint.searchParams.get('profile'))
      const legacyRevision = hash(['pr-label-review', profile, derivedId(projectCommand), 'fixture/notebook', 'fixture-pull-1', viewer, legacyScope])
      const legacyIntent = crypto.randomUUID()
      const fingerprint = hash(['pr-label-changes', legacyRevision, [String(outside.id)]])
      const receipts = new PullRequestReplyReceipts(join(dir, 'test.sqlite'))
      receipts.claim(legacyIntent, fingerprint, true)
      const priorItem = hash(['pr-label', legacyIntent, outside.id])
      receipts.claim(priorItem, fingerprint, true)
      receipts.confirm(priorItem, fingerprint)
      saved.pulls[0].labels = [...saved.pulls[0].labels.filter((label: { id: number }) => label.id !== outside.id), old]
      writeFileSync(cli.state, JSON.stringify(saved))
      const legacy = await post({ head: local, viewer, intent: legacyIntent, scope: legacyScope, revision: legacyRevision }, [String(outside.id)])
      expect(legacy.status).toBe(200)
      expect(readState().labelWrites).toEqual([...saved.labelWrites, [1, 'DELETE', old.id, old.name]])
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('accepts an empty response after GitHub approves a workflow run', async () => {
    const { project, cli, readState } = seedPullRequestLifecycle('Check the report workflow', false)
    const fixture = readState()
    fixture.workflowRuns = [{ id: 41, status: 'completed', conclusion: 'action_required' }]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    process.env.PATH = cli.bin + delimiter + path
    try {
      const approve = () => repositoryGitHubRequest(project, 'repos/fixture/notebook/actions/runs/41/approve', {})
      expect(await approve()).toEqual({ status: 204, body: null, hasNextPage: false })
      expect(readState().workflowRuns).toEqual([{ id: 41, status: 'queued', conclusion: null }])
      expect((await approve()).status).toBe(409)
    }
    finally {
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  })

  it.skipIf(process.platform === 'win32')('shows only GitHub workflows awaiting approval for the exact fork head', async () => {
    const { project, cli, local, url, readState } = seedPullRequestLifecycle('Check the report workflow', false)
    const fixture = readState()
    const fork = { full_name: 'contributor/notebook', node_id: 'fixture-repo:contributor/notebook' }
    fixture.pulls[0].head.repo = fork
    const run = { id: 41, run_attempt: 1, name: 'Check report on Linux', event: 'pull_request',
      status: 'completed', conclusion: 'action_required', head_branch: 'report', head_sha: local,
      repository: { full_name: 'fixture/notebook' }, head_repository: fork, pull_requests: [] }
    fixture.workflowRuns = [
      run,
      { ...run, id: 42, name: 'Wrong fork', head_repository: { full_name: 'other/notebook' } },
      { ...run, id: 43, name: 'Wrong commit', head_sha: 'e'.repeat(40) },
      { ...run, id: 44, name: 'Different pull request', pull_requests: [{ number: 2 }] },
      { ...run, id: 45, name: 'Wrong event', event: 'push' },
      { ...run, id: 46, name: 'Already running', status: 'in_progress', conclusion: null },
      { ...run, id: 47, name: 'Replaced fork', head_repository: { ...fork, node_id: 'replaced-fork-id' } },
    ]
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-workflow-approval-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      const summary = 'http://127.0.0.1:' + port + '/pull-requests?' + new URLSearchParams({ selectedUrl: url })
      const read = () => fetch(summary).then(response => response.text())
      const html = await read()
      expect(html).toContain('1 workflow awaiting approval')
      expect(html).toContain('Check report on Linux')
      expect(html).toContain('https://github.com/fixture/notebook/actions/runs/41')
      expect(html).not.toMatch(/Wrong fork|Wrong commit|Different pull request|Wrong event|Already running|Replaced fork|No checks reported/u)

      fixture.pulls.push({ ...fixture.pulls[0], number: 2, html_url: url.replace(/1$/u, '2') })
      writeFileSync(cli.state, JSON.stringify(fixture))
      const ambiguous = await read()
      expect(ambiguous).toContain('GitHub could not confirm which workflows are awaiting approval')
      expect(ambiguous).not.toContain('Check report on Linux')

      fixture.pulls[0].head = { ...fixture.pulls[0].head, repo: { full_name: 'fixture/notebook' } }
      writeFileSync(cli.state, JSON.stringify(fixture))
      const sameRepository = await read()
      expect(sameRepository).not.toMatch(/workflow awaiting approval|workflows are awaiting approval/u)
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('approves the reviewed GitHub runs and recovers partial approval across restarts', async () => {
    const { project, cli, local, url, readState } = seedPullRequestLifecycle('Check the report workflow', false)
    const fixture = readState()
    const fork = { full_name: 'contributor/notebook', node_id: 'fixture-repo:contributor/notebook' }
    fixture.pulls[0].head.repo = fork
    const run = (id: number) => ({ id, run_attempt: 1, name: 'Check report ' + id, event: 'pull_request',
      status: 'completed', conclusion: 'action_required', head_branch: 'report', head_sha: local,
      repository: { full_name: 'fixture/notebook' }, head_repository: fork, pull_requests: [] })
    fixture.workflowRuns = [run(41), run(42), run(43)]
    fixture.workflowApprovalStatus = 201
    fixture.mergeMode = 'ready'
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const cwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-approve-runs-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const summary = () => host + '/pull-requests?' + new URLSearchParams({ selectedUrl: url })
      const form = await pullRequestLifecycleForm(summary(), 'pr-workflow-approval-title')
      const approve = (overrides: Record<string, string> = {}, accept = 'application/json') =>
        fetch(new URL(form.endpoint.pathname + form.endpoint.search, host), {
          method: 'POST', redirect: 'manual', headers: { accept, origin: host, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form.values, action: 'approve-workflows', ...overrides }),
        })
      expect(form.values.approvalRuns).toBe('41:1,42:1,43:1')
      expect((await approve({ approvalRuns: '41:1,41:1' })).status).toBe(400)
      expect((await approve({ approvalRuns: '41:1,42:1' })).status).toBe(409)
      expect((await approve({ approvalRevision: 'e'.repeat(64) })).status).toBe(409)
      cli.configureMerge('readonly')
      expect((await approve()).status).toBe(403)
      expect(await fetch(summary()).then(response => response.text())).not.toContain('Confirm approval')
      fixture.pulls[0].head.sha = 'e'.repeat(40)
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await approve()).status).toBe(409)
      fixture.pulls[0].head.sha = local
      fixture.workflowRuns.push(run(44))
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await approve()).status).toBe(409)
      fixture.workflowRuns.pop()
      fixture.workflowAttemptChanged = 41
      writeFileSync(cli.state, JSON.stringify(fixture))
      expect((await approve()).status).toBe(409)
      expect(readState().workflowApprovalPosts).toBeUndefined()

      delete fixture.workflowAttemptChanged
      fixture.workflowDropReply = 42
      writeFileSync(cli.state, JSON.stringify(fixture))
      const pending = await approve({}, 'text/html')
      expect(pending.status).toBe(202)
      const pendingHtml = await pending.text()
      expect(pendingHtml).toContain('Check GitHub and finish approval')
      expect(pendingHtml).toContain('name="approvalRuns" value="41:1,42:1,43:1"')
      expect(pendingHtml).not.toContain('Confirm approval')
      expect(readState().workflowApprovalPosts).toEqual([41, 42])

      const next = readState()
      next.workflowRuns.push(run(44))
      next.workflowStaleRead = 42
      writeFileSync(cli.state, JSON.stringify(next))
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      expect((await approve()).status).toBe(202)
      expect(readState().workflowApprovalPosts).toEqual([41, 42])
      delete next.workflowStaleRead
      writeFileSync(cli.state, JSON.stringify(next))
      const recovered = await approve({}, 'text/html')
      expect(recovered.status).toBe(303)
      const html = await fetch(new URL(recovered.headers.get('location')!, host)).then(response => response.text())
      expect(html).toContain('Reviewed workflows are no longer awaiting approval.')
      expect(html).toContain('1 workflow awaiting approval')
      expect(html).toContain('Check report 44')
      expect((await approve()).status).toBe(200)
      expect(readState().workflowApprovalPosts).toEqual([41, 42, 43])
      expect(readState().workflowRuns.map((item: { status: string }) => item.status)).toEqual(['queued', 'queued', 'queued', 'completed'])

      const last = readState()
      last.workflowDenied = 44
      writeFileSync(cli.state, JSON.stringify(last))
      const remaining = await pullRequestLifecycleForm(summary(), 'pr-workflow-approval-title')
      const denied = await fetch(remaining.endpoint, { method: 'POST', headers: {
        accept: 'application/json', origin: host, 'content-type': 'application/x-www-form-urlencoded',
      }, body: new URLSearchParams({ ...remaining.values, action: 'approve-workflows' }) })
      expect(denied.status).toBe(403)
      expect(await denied.json()).toMatchObject({ message: 'This GitHub account cannot approve these workflow runs.' })
      expect(readState().workflowRuns.at(-1)?.conclusion).toBe('action_required')
    }
    finally {
      process.chdir(cwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it('reports health with the hydrated projection', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, profiles: 0, sessions: 0 })
  })

  it.skipIf(process.platform === 'win32')('imports and runs a private project script once in its thread checkout', async () => {
    const project = join(dir, 'script project')
    mkdirSync(project)
    const configuration = join(project, 't3.json')
    const command = "printf '%s\\n' \"$PWD\" >> launched.txt\nprintf 'fixture complete\\n'\nexit 7"
    const previewUrl = 'https://localhost:7443/dev/status?mode=fixture'
    const writeProjectScript = (name: string) => writeFileSync(configuration, JSON.stringify({
      scripts: [{ name, command, previewUrl, autoOpenPreview: true }],
    }))
    writeProjectScript('Fixture action')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('script-profile', { type: 'profile.create', name: 'Script fixture' })
    const profileId = derivedId('script-profile')
    const workspaceId = derivedId('script-workspace')
    await dispatch('script-workspace', { type: 'workspace.add', profileId, path: project })
    await dispatch('script-initial-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    await dispatch('script-thread', { type: 'session.create', workspaceId, driverKind: 'claude' })
    await dispatch('script-withdraw-trust', { type: 'workspace.trust', workspaceId, trusted: false })
    const sessionId = derivedId('script-thread')
    const endpoint = `http://127.0.0.1:${port}/s/${sessionId}/project-scripts`
    const marker = join(project, 'launched.txt')
    const post = (operation: unknown) => fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation),
    })
    expect((await fetch(endpoint)).status).toBe(403)
    await dispatch('script-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    expect((await fetch(endpoint, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    const available = await (await fetch(endpoint)).json()
    expect(available).toMatchObject({ scripts: [], imports: [{ name: 'Fixture action', command, previewUrl }], importError: '' })
    const key = available.imports[0].key
    writeProjectScript('Changed action')
    expect((await post({ action: 'import', key })).status).toBe(409)
    writeProjectScript('Fixture action')
    const saved = await post({ action: 'import', key })
    expect(saved.status).toBe(201)
    const { script } = await saved.json()
    expect(script).toMatchObject({ name: 'Fixture action', previewUrl, autoOpenPreview: true })
    expect((await post({ action: 'import', key })).status).toBe(400)
    expect(existsSync(marker)).toBe(false)

    const openScript = { t: 'term-open', workspaceId, sessionId, resumeKey: crypto.randomUUID(), projectScriptId: script.id }
    const client = await TestClient.connect(url())
    try {
      client.send(openScript)
      const opened = await client.until('term-opened', 'term-error')
      expect(opened).toMatchObject({ t: 'term-opened', openPreview: previewUrl })
      expect(await client.until('term-exit')).toMatchObject({ code: 7 })
      client.send(openScript)
      const resumed = await client.until('term-opened')
      expect(resumed).toMatchObject({ termId: opened.termId, exit: { code: 7 } })
      expect(resumed.openPreview).toBeUndefined()
      expect(readFileSync(marker, 'utf8')).toBe(realpathSync(project) + '\n')

      const live = await post({ action: 'save', script: { name: 'Long action', command: "printf 'started\n'; exec sleep 30", stopOnSettle: true } })
      expect(live.status).toBe(201)
      const liveScript = (await live.json()).script
      client.send({ ...openScript, resumeKey: crypto.randomUUID(), projectScriptId: liveScript.id })
      const running = await client.until('term-opened')
      expect(await client.until('term-data')).toMatchObject({ termId: running.termId, data: expect.stringContaining('started') })
      client.send({ t: 'dispatch', envelope: { id: 'settle-script-thread', at: Date.now(), command: { type: 'session.organize', sessionId, action: 'settle' } } })
      expect(await client.until('term-exit')).toMatchObject({ termId: running.termId, code: null })
      expect((await post({ action: 'remove', id: liveScript.id })).status).toBe(204)
    }
    finally { client.close() }

    harness.stop()
    harness = await serve({ port, databasePath: join(dir, 'test.sqlite') })
    expect(await (await fetch(endpoint)).json()).toMatchObject({ scripts: [{ id: script.id, command }], imports: [] })
    const restored = await TestClient.connect(url())
    try {
      restored.send(openScript)
      expect(await restored.until('term-opened')).not.toHaveProperty('openPreview')
      expect(readFileSync(marker, 'utf8')).toBe(realpathSync(project) + '\n')
    }
    finally { restored.close() }
  })

  it('reviews only repositories discovered inside a trusted project', async () => {
    const project = join(dir, 'project repos')
    const outside = join(dir, 'outside')
    const runGit = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd })
      expect(result.exitCode).toBe(0)
      return result.stdout.toString().trim()
    }
    const repo = async (path: string, label: string) => {
      mkdirSync(path, { recursive: true })
      runGit(path, 'init', '-qb', 'main')
      await Bun.write(join(path, 'fixture.txt'), 'Original\n')
      runGit(path, 'add', 'fixture.txt')
      runGit(path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Initial')
      await Bun.write(join(path, 'fixture.txt'), `Original\n${label}\n`)
    }
    await repo(join(project, 'api'), 'API change')
    await repo(join(project, 'packages', 'web'), 'Web change')
    await repo(join(project, 'deep', 'tools', 'composer'), 'Listed change')
    await repo(join(project, 'vendor', 'ignored'), 'Ignored change')
    await repo(outside, 'Outside change')
    runGit(join(project, 'api'), 'worktree', 'add', '-qb', 'scratch', join(project, 'checkout'))
    symlinkSync(outside, join(project, 'link'))
    await Bun.write(join(project, 'fixture.code-workspace'), `{
      // Folder names can come from a workspace file.
      "folders": [
        { "path": "api", "name": "API" },
        { "path": "deep/tools/composer", "name": "Composer" },
        { "path": "../outside", "name": "Outside" },
        { "path": "checkout", "name": "Linked checkout" },
      ],
    }`)
    await Bun.write(join(project, 't3.json'), '{"ignoreRepositories":["vendor"]}')

    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('repo-profile', { type: 'profile.create', name: 'Project fixture' })
    const workspaceId = derivedId('repo-workspace')
    await dispatch('repo-workspace', { type: 'workspace.add', profileId: derivedId('repo-profile'), path: project })
    await dispatch('repo-trust', { type: 'workspace.trust', workspaceId, trusted: true })
    await dispatch('repo-session', { type: 'session.create', workspaceId, driverKind: 'claude' })
    const route = `http://127.0.0.1:${port}/s/${derivedId('repo-session')}/diff`
    const review = (key: string, mode = 'uncommitted') =>
      fetch(route + '?' + new URLSearchParams({ repository: key, comparison: mode }))
    await dispatch('repo-untrust', { type: 'workspace.trust', workspaceId, trusted: false })
    expect((await review('api')).status).toBe(404)
    expect((await fetch(route + '/options')).status).toBe(404)
    await dispatch('repo-trust-again', { type: 'workspace.trust', workspaceId, trusted: true })

    const getOptions = async () => (await fetch(route + '/options')).json()
    expect(await getOptions()).toMatchObject({
      hasProjectRepository: false,
      repositories: [
        { key: 'api', label: 'API' },
        { key: 'deep/tools/composer', label: 'Composer' },
        { key: 'packages/web', label: 'web' },
      ],
    })
    for (const [key, label] of [['api', 'API change'], ['packages/web', 'Web change'], ['deep/tools/composer', 'Listed change']]) {
      const response = await review(key!)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ scope: 'working-tree', patch: expect.stringContaining(`+${label}`) })
    }
    const api = join(project, 'api')
    runGit(api, 'add', 'fixture.txt')
    await Bun.write(join(api, 'fixture.txt'), 'Unstaged on top of staged\n')
    await Bun.write(join(api, 'draft.txt'), 'Untracked\n')
    expect(await (await fetch(route + '/status?repository=api')).json()).toMatchObject({
      status: { branch: 'main', upstream: null, staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
    })
    const web = join(project, 'packages', 'web')
    runGit(web, 'switch', '-qc', 'review/web')
    runGit(web, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'Web review')
    runGit(web, 'branch', '--set-upstream-to=main', 'review/web')
    const branches = await (await fetch(route + '/options?repository=packages%2Fweb')).json()
    expect(branches).toMatchObject({
      hasProjectRepository: false,
      branches: [{ ref: 'refs/heads/main' }, { ref: 'refs/heads/review/web' }],
      commits: [{ subject: 'Web review' }],
    })
    expect(await (await fetch(route + '/status?repository=packages%2Fweb')).json()).toMatchObject({
      status: { branch: 'review/web', upstream: 'main', ahead: 1, behind: 0, staged: 0, unstaged: 0, untracked: 0 },
    })
    expect(await (await review('packages/web', 'branch')).json()).toMatchObject({
      scope: 'branch', comparisonTarget: 'refs/heads/main', patch: expect.stringContaining('+Web change'),
    })
    expect(await (await review('api', 'branch')).json()).toMatchObject({
      scope: 'branch', patch: expect.not.stringContaining('Web change'),
    })

    for (const invalid of ['../outside', outside, 'link', 'checkout', 'vendor/ignored', 'packages/../api', 'api/.git'])
      expect((await review(invalid)).status).toBe(404)
    expect((await review('api', 'turn')).status).toBe(404)

    rmSync(join(project, 'packages', 'web'), { recursive: true })
    expect((await review('packages/web')).status).toBe(404)
    expect((await getOptions()).repositories.map((item: { key: string }) => item.key)).toEqual(['api', 'deep/tools/composer'])
  })

  it.skipIf(process.platform === 'win32')('commits only the reviewed index and preserves unstaged files on success and failure', async () => {
    const project = join(dir, 'worktree')
    mkdirSync(project)
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: project })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    git('init', '-qb', 'main')
    git('config', 'user.name', 'Fixture Author')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(project, 'a.txt'), 'Baseline\n')
    writeFileSync(join(project, 'b.txt'), 'Other baseline\n')
    git('add', '--', 'a.txt', 'b.txt')
    git('commit', '-qm', 'Initial')
    const initial = git('rev-parse', 'HEAD')
    writeFileSync(join(project, 'a.txt'), 'Staged snapshot\n')
    git('add', '--', 'a.txt')
    writeFileSync(join(project, 'a.txt'), 'Newer worktree content\n')
    writeFileSync(join(project, 'draft.txt'), 'Untracked draft\n')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    const workspace = derivedId('commit-project')
    const session = derivedId('commit-thread')
    await dispatch('commit-project', { type: 'workspace.register', path: realpathSync(project), trusted: true })
    await dispatch('commit-thread', { type: 'session.create', workspaceId: workspace, driverKind: 'claude' })
    const route = 'http://127.0.0.1:' + port + '/s/' + session + '/git/commit'
    const post = (revision: string, message: string, origin?: string) => fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin && { origin }) },
      body: JSON.stringify({ revision, message }),
    })
    expect((await fetch(route + '?repository=../outside')).status).toBe(404)
    const preview = await (await fetch(route)).json()
    expect(preview).toMatchObject({ branch: 'main', files: ['a.txt'], problem: null })
    expect(git('rev-parse', 'HEAD')).toBe(initial)
    expect((await post(preview.revision, 'Foreign write', 'https://example.invalid')).status).toBe(403)
    writeFileSync(join(project, 'b.txt'), 'New staged selection\n')
    git('add', '--', 'b.txt')
    expect((await post(preview.revision, 'Stale selection')).status).toBe(409)
    expect(git('rev-parse', 'HEAD')).toBe(initial)
    const refreshed = await (await fetch(route)).json()
    expect(refreshed.files).toEqual(['a.txt', 'b.txt'])
    const hook = join(project, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect((await post(refreshed.revision, 'Hook will reject')).status).toBe(503)
    expect(git('rev-parse', 'HEAD')).toBe(initial)
    expect(git('diff', '--cached', '--name-only')).toBe('a.txt\nb.txt')
    writeFileSync(hook, '#!/bin/sh\nexit 0\n')
    const accepted = await post(refreshed.revision, 'Review staged changes')
    expect(accepted.status).toBe(201)
    expect(await accepted.json()).toEqual({ commit: git('rev-parse', 'HEAD') })
    expect(git('log', '-1', '--format=%an%n%s')).toBe('Fixture Author\nReview staged changes')
    expect(git('show', 'HEAD:a.txt')).toBe('Staged snapshot')
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('Newer worktree content\n')
    expect(readFileSync(join(project, 'draft.txt'), 'utf8')).toBe('Untracked draft\n')
    expect((await post(refreshed.revision, 'Replay after survival')).status).toBe(409)
    await dispatch('commit-untrust', { type: 'workspace.trust', workspaceId: workspace, trusted: false })
    expect((await fetch(route)).status).toBe(404)
  }, 20_000)

  it('publishes and fast-forwards the selected branch through its configured remote', async () => {
    const remote = join(dir, 'remote.git')
    const project = join(dir, 'project')
    const other = join(dir, 'other')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    const setIdentity = (path: string) => {
      git(path, 'config', 'user.name', 'Fixture')
      git(path, 'config', 'user.email', 'fixture@example.invalid')
    }
    git(dir, 'init', '--bare', '-qb', 'main', remote)
    git(dir, 'clone', '-q', '--', remote, project)
    setIdentity(project)
    git(project, 'switch', '-qc', 'review/topic')
    writeFileSync(join(project, 'note.txt'), 'First note\n')
    git(project, 'add', '--', 'note.txt')
    git(project, 'commit', '-qm', 'First note')
    const initial = git(project, 'rev-parse', 'HEAD')
    git(project, 'branch', 'private')
    git(project, 'tag', '-am', 'Private tag', 'private-tag')
    git(project, 'config', 'push.followTags', 'true')
    git(project, 'config', 'remote.origin.mirror', 'true')
    const workspace = derivedId('sync-workspace')
    const session = derivedId('sync-thread')
    const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
      harness.engine.dispatch({ id, at: Date.now(), command })
    await dispatch('sync-workspace', { type: 'workspace.register', path: realpathSync(project), trusted: true })
    await dispatch('sync-thread', { type: 'session.create', workspaceId: workspace, driverKind: 'claude' })
    const base = 'http://127.0.0.1:' + port + '/s/' + session + '/git/'
    const read = (action: string) => fetch(base + action).then(result => result.json())
    const send = async (action: string, revision: string, origin?: string) => {
      const response = await fetch(base + action, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(origin && { origin }) },
        body: JSON.stringify({ revision }),
      })
      return { status: response.status, body: await response.json().catch(() => null) }
    }

    const publish = await read('push')
    expect(publish).toMatchObject({ branch: 'review/topic', remote: 'origin', ref: 'refs/heads/review/topic', firstPush: true, problem: null })
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('')
    expect((await send('push', publish.revision, 'https://example.invalid')).status).toBe(403)
    git(project, 'remote', 'set-url', '--push', 'origin', join(dir, 'missing.git'))
    expect(await send('push', publish.revision)).toMatchObject({ status: 409, body: { error: expect.stringContaining('remote changed') } })
    git(project, 'remote', 'set-url', '--push', 'origin', remote)
    expect(await send('push', publish.revision)).toEqual({ status: 200, body: { message: 'Pushed to origin/review/topic.' } })
    expect(git(remote, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/review/topic')
    expect(git(project, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/review/topic')
    git(project, 'remote', 'set-head', 'origin', 'review/topic')
    expect(await read('push')).toMatchObject({ defaultTarget: true })

    git(dir, 'clone', '-qb', 'review/topic', '--', remote, other)
    setIdentity(other)
    writeFileSync(join(other, 'note.txt'), 'Upstream note\n')
    git(other, 'commit', '-qam', 'Upstream note')
    git(other, 'push', '-q')
    const upstream = git(other, 'rev-parse', 'HEAD')
    const pull = await read('pull')
    expect(pull).toMatchObject({ firstPush: false, problem: null })
    writeFileSync(join(project, 'draft.txt'), 'Keep this draft\n')
    expect(await send('pull', pull.revision)).toMatchObject({ status: 409, body: { error: expect.stringContaining('Commit or stash') } })
    expect(git(project, 'rev-parse', 'HEAD')).toBe(initial)
    rmSync(join(project, 'draft.txt'))
    expect(await send('pull', pull.revision)).toEqual({ status: 200, body: { message: 'Pulled from origin/review/topic.' } })
    expect(git(project, 'rev-parse', 'HEAD')).toBe(upstream)
    expect(git(project, 'rev-parse', '@{upstream}')).toBe(upstream)
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('Upstream note\n')
    expect(git(project, 'for-each-ref', 'refs/harness/sync')).toBe('')
    expect((await send('pull', pull.revision)).status).toBe(409)

    writeFileSync(join(project, 'note.txt'), 'Local note\n')
    git(project, 'commit', '-qam', 'Local note')
    const local = git(project, 'rev-parse', 'HEAD')
    writeFileSync(join(other, 'note.txt'), 'Concurrent note\n')
    git(other, 'commit', '-qam', 'Concurrent note')
    git(other, 'push', '-q')
    const concurrent = git(other, 'rev-parse', 'HEAD')
    const push = await read('push')
    expect(await send('push', push.revision)).toMatchObject({ status: 409, body: { error: expect.stringContaining('remote branch moved') } })
    expect(await send('pull', (await read('pull')).revision)).toMatchObject({ status: 409, body: { error: expect.stringContaining('diverged') } })
    expect(git(project, 'rev-parse', 'HEAD')).toBe(local)
    expect(git(remote, 'rev-parse', 'refs/heads/review/topic')).toBe(concurrent)
    expect(git(project, 'for-each-ref', 'refs/harness/sync')).toBe('')
    expect(readFileSync(join(project, 'note.txt'), 'utf8')).toBe('Local note\n')

    // The branch can publish to its own repository even while its pull history has diverged.
    const publishDefault = join(dir, 'publishing.git')
    const companion = join(dir, 'companion.git')
    git(dir, 'init', '--bare', '-qb', 'main', publishDefault)
    git(dir, 'init', '--bare', '-qb', 'main', companion)
    git(project, 'remote', 'add', 'publishing', publishDefault)
    git(project, 'remote', 'add', 'companion', companion)
    git(project, 'config', 'remote.pushDefault', 'publishing')
    const sharedDefault = await read('push')
    expect(sharedDefault).toMatchObject({ remote: 'publishing', ref: 'refs/heads/review/topic', firstPush: false, problem: null })
    git(project, 'config', 'branch.review/topic.pushRemote', 'companion')
    expect(await send('push', sharedDefault.revision)).toMatchObject({ status: 409, body: { error: expect.stringContaining('remote changed') } })
    const privatePush = await read('push')
    expect(privatePush).toMatchObject({ remote: 'companion', ref: 'refs/heads/review/topic', firstPush: false, problem: null })
    expect(await send('push', privatePush.revision)).toEqual({ status: 200, body: { message: 'Pushed to companion/review/topic.' } })
    expect(git(companion, 'rev-parse', 'refs/heads/review/topic')).toBe(local)
    expect(git(publishDefault, 'for-each-ref')).toBe('')
    expect(git(remote, 'rev-parse', 'refs/heads/review/topic')).toBe(concurrent)
    expect(git(project, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/review/topic')
    expect(await read('pull')).toMatchObject({ remote: 'origin', ref: 'refs/heads/review/topic' })

    git(project, 'config', 'branch.review/topic.pushRemote', companion)
    expect(await read('push')).toMatchObject({ remote: '', ref: '', problem: expect.stringContaining('named Git remote') })
    expect((await send('push', privatePush.revision)).status).toBe(409)

    // Tracking a base branch does not make it the destination of a feature push.
    git(project, 'config', '--unset', 'remote.pushDefault')
    git(remote, 'update-ref', 'refs/heads/main', concurrent)
    git(project, 'fetch', '-q', 'origin', 'refs/heads/main:refs/remotes/origin/main')
    git(project, 'switch', '-qc', 'from-base')
    git(project, 'branch', '--set-upstream-to=origin/main')
    const based = await read('push')
    expect(based).toMatchObject({ remote: 'origin', ref: 'refs/heads/from-base', trackingRef: '', defaultTarget: false, problem: null })
    expect(await send('push', based.revision)).toEqual({ status: 200, body: { message: 'Pushed to origin/from-base.' } })
    expect(git(remote, 'rev-parse', 'refs/heads/from-base')).toBe(local)
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(concurrent)
    expect(git(project, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
  }, 45_000)

  it.skipIf(process.platform === 'win32')('creates a reviewed GitHub fork pull request and recovers the link after a lost reply', async () => {
    const fixture = fixtureGitRepository(dir)
    const project = join(dir, 'project')
    const fork = join(dir, 'fork.git')
    const git = (cwd: string, ...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd })
      if (!result.success) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    git(dir, 'clone', '-q', '--', fixture.bare, project)
    git(dir, 'clone', '-q', '--bare', '--', fixture.bare, fork)
    const base = git(project, 'rev-parse', 'HEAD')
    git(project, 'remote', 'set-url', 'origin', 'https://github.com/fixture/notebook.git')
    git(project, 'remote', 'add', 'publish', 'https://github.com/fixture/notebook-fork.git')
    git(project, 'config', 'url.' + fixture.bare + '.insteadOf', 'https://github.com/fixture/notebook.git')
    git(project, 'config', 'url.' + fork + '.insteadOf', 'https://github.com/fixture/notebook-fork.git')
    git(project, 'switch', '-qc', 'review/export')
    git(project, 'branch', '--set-upstream-to=origin/main')
    git(project, 'config', 'branch.review/export.pushRemote', 'publish')
    writeFileSync(join(project, 'report.txt'), 'Report fixture\n')
    git(project, 'add', 'report.txt')
    git(project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Add a report')
    const local = git(project, 'rev-parse', 'HEAD')
    const cli = fixtureGitHubCli(dir, {
      'fixture/notebook': { bare: fixture.bare },
      'fixture/notebook-fork': { bare: fork, parent: 'fixture/notebook' },
    })
    const path = process.env.PATH
    const previousCwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      const workspaceId = derivedId('pr-create-project')
      const sessionId = derivedId('pr-create-thread')
      const dispatch = (id: string, command: Parameters<typeof harness.engine.dispatch>[0]['command']) =>
        harness.engine.dispatch({ id, at: Date.now(), command })
      await dispatch('pr-create-project', { type: 'workspace.register', path: realpathSync(project), trusted: true })
      await dispatch('pr-create-thread', { type: 'session.create', workspaceId, driverKind: 'claude' })
      const host = 'http://127.0.0.1:' + port
      const route = host + '/s/' + sessionId + '/git/pull-request'
      const get = (suffix = '') => fetch(route + suffix).then(response => response.json())
      const post = async (revision: string, origin?: string) => {
        const response = await fetch(route, {
          method: 'POST', headers: { 'content-type': 'application/json', ...(origin && { origin }) },
          body: JSON.stringify({ revision, baseRef: 'main', title: 'Review the report', body: 'Verify the export.', draft: true }),
        })
        return { status: response.status, body: await response.json().catch(() => null) }
      }
      const readState = () => JSON.parse(readFileSync(cli.state, 'utf8'))
      const preview = await get()
      expect(preview).toMatchObject({ actor: 'fixture-user', repository: 'fixture/notebook',
        headRepository: 'fixture/notebook-fork', headRef: 'review/export', baseRef: 'main',
        publish: true, problem: null, existing: null, title: 'Add a report' })
      expect(await get('?base=missing')).toMatchObject({ problem: 'GitHub could not find the selected base branch.' })
      const checksRoute = route + '-checks'
      expect((await fetch(checksRoute)).status).toBe(404)
      expect(readState().posts).toBe(0)
      expect(git(fork, 'for-each-ref', 'refs/heads/review/export')).toBe('')
      expect((await post(preview.revision, 'https://other.example')).status).toBe(403)
      git(project, 'reset', '--soft', 'HEAD^')
      expect((await post(preview.revision)).status).toBe(409)
      expect(readState().posts).toBe(0)
      git(project, 'reset', '--soft', local)

      cli.configure('denied')
      const denied = await post(preview.revision)
      expect(denied.status).toBe(409)
      expect(denied.body.error).toContain('repository permissions')
      expect(denied.body.error).not.toContain('Private forge diagnostics')
      expect(git(fixture.bare, 'rev-parse', 'refs/heads/main')).toBe(base)
      expect(git(fork, 'rev-parse', 'refs/heads/review/export')).toBe(local)
      expect(git(project, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main')
      expect(readState().pulls).toEqual([])
      expect((await get()).publish).toBe(false)

      cli.configure('lost-response')
      const confirmed = await post((await get()).revision)
      const url = 'https://github.com/fixture/notebook/pull/1'
      expect(confirmed).toMatchObject({ status: 200, body: { linked: true, existing: true, headChanged: false,
        pullRequest: { url, number: 1, draft: true } } })
      expect(readState().posts).toBe(2)
      expect(readState().pulls).toMatchObject([{ head_repo: 'notebook-fork', draft: true,
        title: 'Review the report', body: 'Verify the export.', head: { sha: local } }])
      const reopen = await post((await get()).revision)
      expect(reopen).toMatchObject({ status: 200, body: { linked: true, existing: true } })
      expect(readState().posts).toBe(2)
      const links = [{ repository: 'fixture/notebook', repositoryKey: '', number: 1 }]
      expect(harness.engine.current.sessions.get(sessionId)?.linkedPullRequests).toEqual(links)
      expect(harness.engine.current.sessions.get(sessionId)?.pullRequest).toBeUndefined()
      const pages = [[
        { __typename: 'CheckRun', id: '1', name: 'Integration', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://ci.example.com/build' },
        { __typename: 'StatusContext', id: '2', context: 'Upload', state: 'PENDING', description: 'Upload queued', targetUrl: 'https://user:secret@ci.example.com/build' },
      ], [
        { __typename: 'CheckRun', id: '3', name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', id: '4', context: 'Policy', state: 'EXPECTED', targetUrl: 'javascript:alert(0)' },
      ]]
      cli.configureChecks(pages)
      const checks = await fetch(checksRoute + '?number=999&owner=attacker')
      expect(checks.status).toBe(200)
      expect(checks.headers.get('cache-control')).toBe('private, no-store')
      expect(await checks.json()).toEqual({ title: 'Review the report', state: 'OPEN', draft: true, head: local, truncated: false, checks: [
        { id: '1', name: 'Integration', status: 'failed', url: 'https://ci.example.com/build' },
        { id: '2', name: 'Upload', status: 'pending', description: 'Upload queued' },
        { id: '3', name: 'Lint', status: 'passed' },
        { id: '4', name: 'Policy', status: 'pending' },
      ] })
      expect((await fetch(checksRoute, { method: 'POST' })).status).toBe(405)
      expect((await fetch(checksRoute, { headers: { origin: 'https://other.example' } })).status).toBe(403)
      expect((await fetch(checksRoute + '?repository=..')).status).toBe(404)
      cli.configureChecks(pages, 'head-changed')
      const stale = await fetch(checksRoute)
      expect(stale.status).toBe(409)
      expect(await stale.json()).toEqual({ error: 'The pull request head could not be confirmed. Refresh checks and try again.' })
      cli.configureChecks(pages, 'unreadable')
      const unreadable = await fetch(checksRoute)
      expect(unreadable.status).toBe(409)
      expect(await unreadable.text()).not.toContain('Private forge diagnostics')
      cli.configureChecks([])
      expect(await fetch(checksRoute).then(response => response.json())).toMatchObject({ checks: [], head: local })
      expect(readState().posts).toBe(2)
      expect(git(project, 'status', '--porcelain')).toBe('')

      process.chdir(join(import.meta.dir, '../../..'))
      cli.configureChecks(pages)
      const review = host + '/pull-requests'
      const view = await fetch(review)
      expect(view.status).toBe(200)
      expect(view.headers.get('cache-control')).toBe('private, no-store')
      expect(await view.text()).toContain('Review the report')
      expect((await fetch(review, { headers: { origin: 'https://other.example' } })).status).toBe(403)
      expect((await fetch(review, { method: 'POST' })).status).toBe(405)
      const detail = review + '?' + new URLSearchParams({ selectedUrl: url })
      const summary = await fetch(detail).then(response => response.text())
      expect(summary).toContain('Details')
      expect(summary).toContain('Verify the export.')
      expect(summary).toContain('href="/s/' + sessionId + '"')
      const timeline = await fetch(detail + '&tab=timeline').then(response => response.text())
      expect(timeline).toContain('Opened the request')
      expect(timeline).toContain('fixture-reviewer')
      expect(timeline).toContain('<strong>export</strong>')
      expect(timeline).not.toContain('<script>globalThis.__pr_html')
      expect(timeline.indexOf('fixture-reviewer')).toBeLessThan(timeline.indexOf('fixture-approver'))
      const code = await fetch(detail + '&tab=code').then(response => response.text())
      expect(code).toContain('Patch for report.txt')
      expect(code).toContain('+Report fixture')
      expect(code).toContain('0 of 1 viewed on this page')
      expect(code).toContain('aria-label="Viewed report.txt" aria-pressed="false"')
      const lineAnchor = code.match(/id="(file-[a-f0-9]+-R2)"/u)?.[1]
      expect(lineAnchor).toBeDefined()
      const lineLink = new URL(detail + '&tab=code')
      lineLink.searchParams.set('reviewHead', local)
      lineLink.searchParams.set('reviewBase', base)
      lineLink.searchParams.set('reviewLine', lineAnchor!)
      lineLink.searchParams.set('reviewStart', lineAnchor!.replace(/R2$/u, 'L1'))
      const linePage = await fetch(lineLink).then(response => response.text())
      expect(linePage).toMatch(/data-pr-file-patch\s+open/u)
      expect(linePage.match(/data-selected>/gu)).toHaveLength(3)
      expect(linePage).toMatch(/aria-label="After line 2"\s+autofocus aria-current="location"/u)
      const nativeViewedAction = linePage.match(/<form method="post" action="([^"]+)" data-pr-viewed-form/u)?.[1]
      expect(nativeViewedAction).toBeDefined()
      const nativeViewed = await fetch(new URL(nativeViewedAction!.replaceAll('&amp;', '&'), host), {
        method: 'POST', redirect: 'manual',
        headers: { origin: host, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ path: 'report.txt', head: local, viewer: 'fixture-viewer', viewed: 'false' }),
      })
      expect(nativeViewed.status).toBe(303)
      const afterViewed = new URL(nativeViewed.headers.get('location')!, host)
      expect(afterViewed.searchParams.get('reviewLine')).toBe(lineAnchor)
      expect(afterViewed.searchParams.get('reviewBase')).toBe(base)
      const restoredRange = await fetch(afterViewed).then(response => response.text())
      expect(restoredRange.match(/data-selected>/gu)).toHaveLength(3)
      expect(restoredRange.match(/\sautofocus(?=[\s>])/gu)).toHaveLength(1)
      lineLink.searchParams.set('reviewHead', '3'.repeat(40))
      const staleLine = await fetch(lineLink).then(response => response.text())
      expect(staleLine).toContain('The pull request comparison changed. Select a line in the current diff.')
      expect(staleLine).not.toContain('aria-current="location"')
      lineLink.searchParams.set('reviewHead', local)
      lineLink.searchParams.set('reviewBase', '3'.repeat(40))
      expect(await fetch(lineLink).then(response => response.text())).toContain('The pull request comparison changed.')
      const profileId = harness.engine.current.workspaces.get(workspaceId)!.profileId
      const viewed = host + '/pull-requests/viewed?' + new URLSearchParams({ selectedUrl: url, profile: String(profileId), sort: 'oldest' })
      const mark = (overrides: Record<string, string> = {}, origin = host) => fetch(viewed, {
        method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ path: 'report.txt', head: local, viewer: 'fixture-viewer', viewed: 'true', ...overrides }),
      })
      const resultOf = (reply: Response) => new URL(reply.headers.get('location')!, host).searchParams.get('viewedResult')
      expect((await mark({}, 'https://hostile.example')).status).toBe(403)
      expect((await fetch(viewed)).status).toBe(405)
      expect(resultOf(await mark({ head: 'f'.repeat(40) }))).toBe('changed')
      expect(resultOf(await mark({ path: 'not-in-the-request.txt' }))).toBe('changed')
      cli.configureViewed('normal', 'different-viewer')
      expect(resultOf(await mark())).toBe('changed')
      expect(readState().viewedWrites).toBeUndefined()
      cli.configureViewed('denied')
      expect(resultOf(await mark())).toBe('unavailable')
      expect(readState().viewedWrites).toBeUndefined()
      cli.configureViewed('lost-response')
      const updated = await mark()
      expect(updated.status).toBe(303)
      expect(resultOf(updated)).toBe('viewed')
      const location = new URL(updated.headers.get('location')!, host)
      expect(location.searchParams.get('sort')).toBe('oldest')
      expect(location.hash).toStartWith('#file-')
      expect(await fetch(location).then(response => response.text())).toContain('aria-label="Viewed report.txt" aria-pressed="true"')
      expect(resultOf(await mark())).toBe('viewed')
      expect(readState().viewedWrites).toBe(1)
      cli.configureViewed('normal')
      expect(resultOf(await mark({ viewed: 'false' }))).toBe('unviewed')
      expect(readState().fileViewed).toBe(false)
      expect(readState().viewedWrites).toBe(2)
      cli.configureViewed('revised')
      const revisedCode = await fetch(detail + '&tab=code').then(response => response.text())
      expect(revisedCode).toContain('aria-label="Viewed report.txt" aria-pressed="false"')
      expect(revisedCode).toContain('Changed since viewed')
      cli.configureViewed('unreadable')
      const offlineCode = await fetch(detail + '&tab=code').then(response => response.text())
      expect(offlineCode).toContain('Viewed state is unavailable')
      expect(offlineCode).toContain('+Report fixture')
      expect(offlineCode).not.toContain('Private viewed diagnostics')

      cli.configureViewed('normal')
      cli.configureConversations('normal')
      cli.configureCommentPages('normal')
      const inlineCode = await fetch(detail + '&tab=code').then(response => response.text())
      expect(inlineCode.indexOf('+Report fixture')).toBeLessThan(inlineCode.indexOf('Verify the <strong>inline report</strong>'))
      expect(inlineCode).toContain('Line 1 after changes')
      expect(inlineCode).toContain('Line 12 before changes')
      expect(inlineCode).toContain('Previous review location')
      expect(inlineCode).toContain('Conversations outside this file page')
      expect(inlineCode).toContain('removed-earlier.txt')
      expect(inlineCode).toContain('Earlier file discussion')
      expect(inlineCode).toContain(url + '#discussion_r4')
      expect(inlineCode).toContain('Comment minimized on GitHub.')
      expect(inlineCode).toContain('Load more comments')
      expect(inlineCode).not.toContain('<img src=x')
      expect(inlineCode).not.toContain('hidden inline marker')
      expect(inlineCode).not.toContain('Hidden by GitHub')
      expect(inlineCode).not.toContain('https://other.example/unsafe')
      expect(inlineCode).not.toContain('History comment <strong>19</strong>')
      const commentAddress = new URL(viewed.replace('/viewed?', '/comments?'))
      for (const [key, value] of Object.entries({ head: local, viewer: 'fixture-viewer', thread: 'fixture-conversation', after: 'comments:+19' }))
        commentAddress.searchParams.set(key, value)
      const readComments = (values: Record<string, string> = {}, options?: RequestInit) => {
        const target = new URL(commentAddress)
        for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value)
        return fetch(target, options)
      }
      expect((await readComments({ after: '' })).status).toBe(400)
      expect((await readComments({}, { method: 'POST' })).status).toBe(405)
      expect((await readComments({}, { headers: { origin: 'https://other.example' } })).status).toBe(403)
      expect((await readComments({ thread: 'other-conversation' })).status).toBe(409)
      expect((await readComments({ viewer: 'different-viewer' })).status).toBe(409)
      expect((await readComments({ head: '3'.repeat(40) })).status).toBe(409)
      const middleResponse = await readComments()
      expect(middleResponse.status).toBe(200)
      expect(middleResponse.headers.get('cache-control')).toBe('private, no-store')
      const middle = await middleResponse.json()
      expect(middle.comments).toHaveLength(20)
      expect(middle.comments[0].html).toContain('History comment <strong>19</strong>')
      expect(middle.comments[0].html).not.toContain('<script')
      expect(middle.nextComments).toBe('comments:+39')
      const last = await readComments({ after: middle.nextComments }).then(response => response.json())
      expect(last.comments).toHaveLength(5)
      expect(last.comments[4].html).toContain('History comment <strong>43</strong>')
      expect(last.nextComments).toBeNull()
      const hrefWith = (html: string, key: string) => new URL(html.match(new RegExp('href="([^"]*' + key + '=([^"]*))"'))![1]!.replaceAll('&amp;', '&'), host)
      const nextPage = hrefWith(inlineCode, 'commentsAfter')
      const nextPageHtml = await fetch(nextPage).then(response => response.text())
      expect(nextPage.hash).toStartWith('#review-')
      expect(nextPageHtml).toContain('History comment <strong>19</strong>')
      expect(nextPageHtml).not.toContain('Verify the <strong>inline report</strong>')
      expect(nextPageHtml).toContain('Previous comments')
      const previousPage = hrefWith(nextPageHtml, 'commentsBefore')
      const previousPageHtml = await fetch(previousPage).then(response => response.text())
      expect(previousPageHtml).toContain('Verify the <strong>inline report</strong>')
      expect(hrefWith(previousPageHtml, 'commentsAfter').searchParams.get('commentsAfter')).toBe('comments:+19')
      const wrongScope = new URL(nextPage)
      wrongScope.searchParams.set('commentScope', 'different')
      expect(await fetch(wrongScope).then(response => response.text())).toContain('The comment page belongs to a different review.')
      const ambiguous = new URL(nextPage)
      ambiguous.searchParams.set('commentsBefore', '')
      expect(await fetch(ambiguous).then(response => response.text())).toContain('The comment page belongs to a different review.')
      cli.configureCommentPages('stalled')
      expect((await readComments()).status).toBe(503)
      cli.configureCommentPages('unavailable')
      const failedPage = await readComments()
      expect(failedPage.status).toBe(503)
      expect(await failedPage.text()).not.toContain('Private comment page diagnostics')
      cli.configureCommentPages('normal')
      const inlineRoute = viewed.replace('/viewed?', '/conversation?')
      const changeConversation = (overrides: Record<string, string> = {}, accept = 'application/json', origin = host) => fetch(inlineRoute, {
        method: 'POST', redirect: 'manual', headers: { accept, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ thread: 'fixture-conversation', head: local, viewer: 'fixture-viewer', resolved: 'true', ...overrides }),
      })
      expect((await changeConversation({}, 'application/json', 'https://other.example')).status).toBe(403)
      expect((await changeConversation({ thread: 'other-conversation' })).status).toBe(409)
      expect((await changeConversation({ viewer: 'someone-else' })).status).toBe(409)
      expect((await changeConversation({ head: '3'.repeat(40) })).status).toBe(409)
      expect((await changeConversation({ resolved: 'maybe' })).status).toBe(400)
      cli.configureConversations('readonly')
      const cannotResolve = await changeConversation()
      expect(cannotResolve.status).toBe(403)
      expect(await cannotResolve.json()).toMatchObject({ result: 'denied', conversation: { isResolved: false, viewerCanResolve: false } })
      expect(readState().conversationWrites).toBeUndefined()
      cli.configureConversations('lost-response')
      const resolvedThread = await changeConversation()
      expect(resolvedThread.status).toBe(200)
      expect(await resolvedThread.json()).toMatchObject({ result: 'resolved',
        conversation: { isResolved: true, viewerCanResolve: false, viewerCanUnresolve: true } })
      expect((await changeConversation()).status).toBe(200)
      expect(readState().conversationWrites).toBe(1)
      cli.configureConversations('normal')
      const reopenedThread = await changeConversation({ resolved: 'false' }, 'text/html')
      expect(reopenedThread.status).toBe(303)
      const updatedThreadUrl = new URL(reopenedThread.headers.get('location')!, host)
      expect(updatedThreadUrl.searchParams.get('sort')).toBe('oldest')
      expect(updatedThreadUrl.searchParams.get('conversationResult')).toBe('reopened')
      expect(updatedThreadUrl.hash).toStartWith('#review-')
      const reopenedPage = await fetch(updatedThreadUrl).then(response => response.text())
      expect(reopenedPage).toContain('Conversation reopened.')
      expect(reopenedPage).toContain('id="' + updatedThreadUrl.hash.slice(1) + '"')
      expect(readState().conversationWrites).toBe(2)
      expect(readState().conversationResolved).toBe(false)
      cli.configureConversations('unreadable')
      const noDiscussion = await fetch(detail + '&tab=code').then(response => response.text())
      expect(noDiscussion).toContain('Review conversations are unavailable')
      expect(noDiscussion).toContain('+Report fixture')
      expect(noDiscussion).not.toContain('Private conversation diagnostics')
      cli.configureConversations('head-changed')
      expect(await fetch(detail + '&tab=code').then(response => response.text())).toContain('Refresh to load the current files.')
      cli.configureConversations('normal')

      expect(await fetch(review + '?q=missing-title').then(response => response.text())).toContain('No pull requests match these filters.')
      expect(await fetch(review + '?q=the+report').then(response => response.text())).toContain('Review the report')
      expect(await fetch(review + '?selectedUrl=example%2Fprivate%238').then(response => response.text()))
        .toContain('Choose a pull request in a trusted GitHub project in this profile.')
      await dispatch('pr-review-other-profile', { type: 'profile.create', name: 'Other profile' })
      const other = derivedId('pr-review-other-profile')
      const otherView = await fetch(detail + '&profile=' + other).then(response => response.text())
      expect(otherView).toContain('Choose a pull request in a trusted GitHub project in this profile.')
      expect(otherView).not.toContain('Review the report')
      const crossProfile = host + '/prompt-link/pull-request?' + new URLSearchParams({ pr: url, profile: String(other) })
      expect(await fetch(crossProfile).then(response => response.json())).toEqual({ project: null, canCheckOut: true })
      expect((await fetch(crossProfile + '&workspace=' + workspaceId, { method: 'POST', headers: { 'content-type': 'application/json' } })).status).toBe(409)
      git(project, 'remote', 'add', 'unavailable', 'https://github.com/fixture/unavailable.git')
      const partialList = await fetch(review).then(response => response.text())
      expect(partialList).toContain('Some repositories could not be loaded')
      expect(partialList).toContain('fixture/unavailable')
      expect(partialList).toContain('Review the report')
      git(project, 'remote', 'remove', 'unavailable')

      let replyHost = host
      const replyPath = viewed.replace(host, '').replace('/viewed?', '/reply?')
      const intent = crypto.randomUUID()
      const sendReply = (values: Record<string, string> = {}, accept = 'application/json', origin = replyHost) => fetch(replyHost + replyPath, {
        method: 'POST', redirect: 'manual', headers: { accept, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ thread: 'fixture-conversation', head: local, viewer: 'fixture-viewer',
          intent, body: 'Please check the **new report**.', ...values }),
      })
      expect((await sendReply({}, 'application/json', 'https://other.example')).status).toBe(403)
      expect((await sendReply({ thread: 'other-conversation' })).status).toBe(409)
      expect((await sendReply({ viewer: 'other-viewer' })).status).toBe(409)
      expect((await sendReply({ head: 'e'.repeat(40) })).status).toBe(409)
      expect((await sendReply({ intent: 'not-a-uuid' })).status).toBe(400)
      expect((await sendReply({ body: '   ' })).status).toBe(422)
      cli.configureReplies('denied')
      const deniedReply = await sendReply({ body: 'Keep <strong>my draft</strong>.' }, 'text/html')
      expect(deniedReply.status).toBe(403)
      const deniedDraft = await deniedReply.text()
      expect(deniedDraft).toContain('This GitHub account cannot reply to the conversation.')
      expect(deniedDraft).toContain('Keep &lt;strong&gt;my draft&lt;/strong&gt;.')
      expect(readState().replyRequests).toBeUndefined()
      cli.configureReplies('unconfirmed')
      const unknownReply = await sendReply()
      expect(unknownReply.status).toBe(202)
      expect(await unknownReply.json()).toMatchObject({ result: 'pending' })
      expect(readState().replyRequests).toBe(1)
      expect((await sendReply({ body: 'Different text under the same receipt.' })).status).toBe(409)
      expect((await sendReply()).status).toBe(202)
      expect(readState().replyRequests).toBe(1)

      const reviewPath = viewed.replace(host, '').replace('/viewed?', '/review?')
      const start = lineAnchor!.replace(/R2$/u, 'R1')
      const rangedComment = { path: 'report.txt', page: 1, line: lineAnchor!, start, body: 'Check this **report range**.' }
      const removedLine = lineAnchor!.replace(/R2$/u, 'L20')
      const removedComment = { path: 'report.txt', page: 1, line: removedLine, start: removedLine, body: 'The removal is intentional.' }
      const reviewInput = { intent: crypto.randomUUID(), head: local, base, viewer: 'fixture-viewer', verdict: 'COMMENT',
        summary: 'Review **summary**.', drafts: JSON.stringify([rangedComment, removedComment]) }
      const sendReview = (values: Record<string, string> = {}, origin = replyHost) => fetch(replyHost + reviewPath, {
        method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ ...reviewInput, ...values }),
      })
      expect((await fetch(replyHost + reviewPath)).status).toBe(405)
      expect((await sendReview({}, 'https://other.example')).status).toBe(403)
      expect((await sendReview({ verdict: 'APPROVE' })).status).toBe(403)
      expect((await sendReview({ viewer: 'other-account' })).status).toBe(409)
      expect((await sendReview({ head: 'a'.repeat(40) })).status).toBe(409)
      expect((await sendReview({ base: 'a'.repeat(40) })).status).toBe(409)
      expect((await sendReview({ drafts: JSON.stringify([{ ...rangedComment, start: removedLine }]) })).status).toBe(409)
      expect((await sendReview({ drafts: JSON.stringify([{ ...rangedComment, path: 'outside.txt' }]) })).status).toBe(409)
      expect((await sendReview({ summary: '', drafts: '[]' })).status).toBe(400)
      expect(readState().reviewRequests ?? 0).toBe(0)
      cli.configureInlineReviews('unconfirmed')
      const pendingReview = await sendReview()
      expect(pendingReview.status).toBe(202)
      expect(await pendingReview.json()).toMatchObject({ result: 'pending' })
      expect((await sendReview({ summary: 'Edit a submitted intent.' })).status).toBe(409)
      expect((await sendReview()).status).toBe(202)
      expect(readState().reviewRequests).toBe(1)

      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      replyHost = 'http://127.0.0.1:' + harness.server.port
      expect(harness.engine.current.sessions.get(sessionId)?.linkedPullRequests).toEqual(links)
      const result = await fetch(replyHost + '/prompt-link/pull-request?pr=fixture/notebook/1')
      expect(await result.json()).toEqual({ sessionId })
      cli.configureReplies('normal')
      expect((await sendReply()).status).toBe(202)
      expect(readState().replyRequests).toBe(1)
      cli.revealReply()
      const recovered = await sendReply()
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({ result: 'posted', comment: { html: '<p>Please check the <strong>new report</strong>.</p>\n' } })
      expect(readState().replyRequests).toBe(1)
      cli.configureReplies('lost-response')
      const secondIntent = crypto.randomUUID()
      const nativeReply = await sendReply({ intent: secondIntent, body: 'Check the appendix.' }, 'text/html')
      expect(nativeReply.status).toBe(303)
      const replyLocation = new URL(nativeReply.headers.get('location')!, replyHost)
      expect(replyLocation.hash).toStartWith('#review-')
      expect(replyLocation.searchParams.get('sort')).toBe('oldest')
      expect(replyLocation.searchParams.get('replyResult')).toBe('posted')
      expect(replyLocation.searchParams.get('commentsLatest')).toBe('1')
      const nativePage = await fetch(replyLocation).then(response => response.text())
      expect(nativePage).toContain('Check the appendix.')
      expect(nativePage).toContain('Reply posted.')
      expect(nativePage).toContain('Previous comments')
      expect(nativePage).not.toContain('harness:review-reply:')
      expect(readState().replyRequests).toBe(2)
      cli.configureReplies('normal')
      const sharedReply = { intent: crypto.randomUUID(), body: 'One reply from simultaneous clients.' }
      const simultaneous = await Promise.all([sendReply(sharedReply), sendReply(sharedReply)])
      expect(simultaneous.every(response => [200, 202].includes(response.status))).toBe(true)
      expect((await sendReply(sharedReply)).status).toBe(200)
      expect(readState().replyRequests).toBe(3)
      expect((await sendReview()).status).toBe(202)
      expect(readState().reviewRequests).toBe(1)
      cli.revealInlineReview()
      const confirmedReview = await sendReview()
      expect(confirmedReview.status).toBe(200)
      const confirmedLocation = new URL((await confirmedReview.json()).location, replyHost)
      expect(confirmedLocation.searchParams.get('reviewResult')).toBe('posted')
      const postedReview = await fetch(confirmedLocation).then(response => response.text())
      expect(postedReview).toContain('Review submitted to GitHub.')
      expect(postedReview).toContain('Check this <strong>report range</strong>.')
      expect(postedReview).toContain('The removal is intentional.')
      const reviewedTimeline = new URL(confirmedLocation)
      reviewedTimeline.searchParams.set('tab', 'timeline')
      const postedTimeline = await fetch(reviewedTimeline).then(response => response.text())
      expect(postedTimeline).toContain('Review <strong>summary</strong>.')
      expect(postedTimeline).not.toContain('harness:pr-review:')
      expect(readState().inlineReviews).toMatchObject([{ commit_id: local, event: 'COMMENT', comments: [
        { path: 'report.txt', body: rangedComment.body, line: 2, side: 'RIGHT', start_line: 1, start_side: 'RIGHT' },
        { path: 'report.txt', body: removedComment.body, line: 20, side: 'LEFT' },
      ] }])
      expect(readState().inlineReviews[0].comments[1].start_line).toBeUndefined()
      expect(readState().reviewRequests).toBe(1)
      const approved = { intent: crypto.randomUUID(), verdict: 'APPROVE', summary: '', drafts: '[]' }
      cli.configureInlineReviews('denied', false)
      const deniedReview = await sendReview(approved)
      expect(deniedReview.status).toBe(403)
      expect(await deniedReview.text()).not.toContain('Private review diagnostics')
      cli.configureInlineReviews('invalid', false)
      expect((await sendReview(approved)).status).toBe(422)
      cli.configureInlineReviews('lost-response', false)
      const reviewRequests = await Promise.all([sendReview(approved), sendReview(approved)])
      expect(reviewRequests.every(response => [200, 202].includes(response.status))).toBe(true)
      expect((await sendReview(approved)).status).toBe(200)
      expect(readState().reviewRequests).toBe(4)
      expect(readState().inlineReviews[1].state).toBe('APPROVED')

      const lifecycleView = () => replyHost + '/pull-requests?' + new URLSearchParams({
        selectedUrl: url, profile: String(profileId), sort: 'oldest', tab: 'code', detailPage: '1',
        reviewHead: local, reviewBase: base, reviewLine: lineAnchor!,
      })
      const lifecycleForm = () => pullRequestLifecycleForm(lifecycleView())
      const changeLifecycle = (form: Awaited<ReturnType<typeof lifecycleForm>>, action: string, overrides: Record<string, string> = {},
        accept = 'application/json', origin = replyHost) => fetch(new URL(form.endpoint.pathname + form.endpoint.search, replyHost), {
        method: 'POST', redirect: 'manual', headers: { accept, origin, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...form.values, action, ...overrides }),
      })
      const draftForm = await lifecycleForm()
      expect(draftForm.html).toContain('Ready for review')
      expect(draftForm.html).toContain('Confirm close')
      expect((await fetch(draftForm.endpoint)).status).toBe(405)
      expect((await changeLifecycle(draftForm, 'ready', {}, 'application/json', 'https://other.example')).status).toBe(403)
      expect((await changeLifecycle(draftForm, 'destroy')).status).toBe(400)
      expect((await changeLifecycle(draftForm, 'ready', { base: 'd'.repeat(40) })).status).toBe(409)
      expect((await changeLifecycle(draftForm, 'ready', { viewer: 'other-account' })).status).toBe(409)
      expect((await changeLifecycle(draftForm, 'draft')).status).toBe(409)
      cli.configureLifecycle('readonly')
      expect((await fetch(lifecycleView()).then(response => response.text()))).not.toContain('aria-label="Pull request actions"')
      expect((await changeLifecycle(draftForm, 'ready')).status).toBe(403)
      cli.configureLifecycle('archived')
      expect((await changeLifecycle(draftForm, 'ready')).status).toBe(403)
      cli.configureLifecycle('denied')
      const deniedLifecycle = await changeLifecycle(draftForm, 'ready')
      expect(deniedLifecycle.status).toBe(403)
      expect(await deniedLifecycle.text()).not.toContain('Private lifecycle diagnostics')
      expect(readState().lifecycleWrites ?? 0).toBe(0)
      cli.configureLifecycle('lost-response')
      const ready = await changeLifecycle(draftForm, 'ready', {}, 'text/html')
      expect(ready.status).toBe(303)
      const readyLocation = new URL(ready.headers.get('location')!, replyHost)
      expect(readyLocation.searchParams.get('tab')).toBe('code')
      expect(readyLocation.searchParams.get('reviewLine')).toBe(lineAnchor)
      expect(readyLocation.searchParams.get('sort')).toBe('oldest')
      expect(await fetch(readyLocation).then(response => response.text())).toContain('Pull request is ready for review.')
      expect((await changeLifecycle(draftForm, 'ready', { intent: crypto.randomUUID() })).status).toBe(409)
      expect((await changeLifecycle(draftForm, 'ready')).status).toBe(200)
      expect(readState().lifecycleWrites).toBe(1)
      const openForm = await lifecycleForm()
      expect(openForm.html).toContain('Convert to draft')
      cli.configureLifecycle('refused')
      expect((await changeLifecycle(openForm, 'draft')).status).toBe(422)
      cli.configureLifecycle('normal')
      expect((await changeLifecycle(openForm, 'draft')).status).toBe(200)
      const closeForm = await lifecycleForm()
      cli.configureLifecycle('unconfirmed')
      const delayedClose = await changeLifecycle(closeForm, 'close', {}, 'text/html')
      expect(delayedClose.status).toBe(202)
      expect(await delayedClose.text()).toContain('Check GitHub again')
      expect(readState().lifecycleWrites).toBe(3)
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      replyHost = 'http://127.0.0.1:' + harness.server.port
      expect((await changeLifecycle(closeForm, 'close')).status).toBe(202)
      cli.revealLifecycle()
      expect((await changeLifecycle(closeForm, 'close')).status).toBe(200)
      const closedForm = await lifecycleForm()
      expect(closedForm.html).toContain('Reopen pull request')
      expect(closedForm.html).not.toContain('Confirm close')
      cli.configureLifecycle('normal')
      const reopened = await Promise.all([changeLifecycle(closedForm, 'reopen'), changeLifecycle(closedForm, 'reopen')])
      expect(reopened.every(response => [200, 409].includes(response.status))).toBe(true)
      expect((await changeLifecycle(closedForm, 'reopen')).status).toBe(200)
      const earlierClose = await changeLifecycle(closeForm, 'close')
      expect(earlierClose.status).toBe(200)
      expect(await earlierClose.json()).toMatchObject({ message: 'GitHub already confirmed the earlier update.' })
      expect(readState().lifecycleWrites).toBe(4)
      expect(readState().pulls[0].state).toBe('open')
    }
    finally {
      process.chdir(previousCwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('confirms authorized GitHub merges, queue changes, and interrupted writes', async () => {
    const { project, cli, local, url, readState } = seedPullRequestLifecycle('Merge the reviewed report', true)
    const path = process.env.PATH
    const previousCwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-merge-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let replyHost = 'http://127.0.0.1:' + port
      const lifecycleView = () => replyHost + '/pull-requests?' + new URLSearchParams({ selectedUrl: url })
      const lifecycleForm = () => pullRequestLifecycleForm(lifecycleView())
      const changeLifecycle = (form: Awaited<ReturnType<typeof lifecycleForm>>, action: string, overrides: Record<string, string> = {},
        accept = 'application/json') => fetch(new URL(form.endpoint.pathname + form.endpoint.search, replyHost), {
        method: 'POST', redirect: 'manual', headers: { accept, origin: replyHost, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...form.values, action, ...overrides }),
      })
      cli.configureMerge('ready')
      const readyToMerge = await lifecycleForm()
      expect(readyToMerge.html).not.toContain('data-pr-merge-trigger')
      expect((await changeLifecycle(readyToMerge, 'merge', { method: 'SQUASH' })).status).toBe(409)
      expect((await changeLifecycle(readyToMerge, 'ready')).status).toBe(200)
      cli.configureMerge('readonly')
      const reader = await lifecycleForm()
      expect(reader.html).not.toContain('data-pr-merge-trigger')
      expect((await changeLifecycle(reader, 'merge', { method: 'SQUASH' })).status).toBe(403)
      cli.configureMerge('blocked', ['SQUASH'])
      const blocked = await lifecycleForm()
      expect(blocked.html).toContain('Enable auto-merge')
      expect(blocked.html).not.toContain('Rebase and merge')
      expect((await changeLifecycle(blocked, 'merge', { method: 'SQUASH' })).status).toBe(409)
      expect((await changeLifecycle(blocked, 'enable-auto-merge', { method: 'REBASE' })).status).toBe(409)
      expect((await changeLifecycle(blocked, 'enable-auto-merge', { method: 'SQUASH' })).status).toBe(200)
      const auto = await lifecycleForm()
      expect(auto.html).toContain('Auto-merge enabled')
      expect((await changeLifecycle(auto, 'disable-auto-merge')).status).toBe(200)
      cli.configureMerge('queue')
      const queue = await lifecycleForm()
      expect(queue.html).toContain('Join merge queue')
      expect((await changeLifecycle(queue, 'merge', { method: 'SQUASH' })).status).toBe(409)
      expect((await changeLifecycle(queue, 'enqueue')).status).toBe(200)
      const queued = await lifecycleForm()
      expect(queued.html).toContain('In merge queue')
      expect((await changeLifecycle(queued, 'dequeue')).status).toBe(200)
      cli.configureMerge('ready')
      const merge = await lifecycleForm()
      expect(merge.html).toContain('Squash and merge')
      expect((await changeLifecycle(merge, 'merge')).status).toBe(400)
      expect((await changeLifecycle(merge, 'merge', { method: 'SQUASH', baseBranch: 'other-branch' })).status).toBe(409)
      expect((await changeLifecycle(merge, 'merge', { method: 'SQUASH', base: 'd'.repeat(40) })).status).toBe(409)
      expect((await changeLifecycle(merge, 'merge', { method: 'SQUASH', head: 'd'.repeat(40) })).status).toBe(409)
      cli.configureLifecycle('unconfirmed')
      const delayedMerge = await changeLifecycle(merge, 'merge', { method: 'SQUASH' }, 'text/html')
      expect(delayedMerge.status).toBe(202)
      expect(await delayedMerge.text()).toContain('name="method" value="SQUASH"')
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      replyHost = 'http://127.0.0.1:' + harness.server.port
      expect((await changeLifecycle(merge, 'merge', { method: 'REBASE' })).status).toBe(409)
      cli.revealLifecycle()
      const merged = await changeLifecycle(merge, 'merge', { method: 'SQUASH' })
      expect(merged.status).toBe(200)
      expect(await merged.json()).toMatchObject({ message: 'Pull request merged.' })
      expect((await changeLifecycle(merge, 'merge', { method: 'SQUASH' })).status).toBe(200)
      const mergedView = await fetch(lifecycleView()).then(response => response.text())
      expect(mergedView).toContain('data-pr-state="Merged"')
      expect(mergedView).not.toContain('aria-label="Pull request actions"')
      expect(readState().mergeWrites).toEqual([
        { mutation: 'enablePullRequestAutoMerge', input: { pullRequestId: 'fixture-pull-1', expectedHeadOid: local, mergeMethod: 'SQUASH' } },
        { mutation: 'disablePullRequestAutoMerge', input: { pullRequestId: 'fixture-pull-1' } },
        { mutation: 'enqueuePullRequest', input: { pullRequestId: 'fixture-pull-1', expectedHeadOid: local } },
        { mutation: 'dequeuePullRequest', input: { id: 'fixture-pull-1' } },
        { mutation: 'mergePullRequest', input: { pullRequestId: 'fixture-pull-1', expectedHeadOid: local, mergeMethod: 'SQUASH' } },
      ])
    }
    finally {
      process.chdir(previousCwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('updates a behind GitHub branch once and refreshes the reviewed head', async () => {
    const { project, cli, local, base, url, readState } = seedPullRequestLifecycle('Update the report branch', false)
    const path = process.env.PATH
    const previousCwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-update-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const readForm = () => pullRequestLifecycleForm(host + '/pull-requests?' + new URLSearchParams({ selectedUrl: url, sort: 'oldest' }))
      const update = (form: Awaited<ReturnType<typeof readForm>>, overrides: Record<string, string> = {}, accept = 'application/json') => {
        const endpoint = new URL(form.endpoint.pathname + form.endpoint.search, host)
        if (accept === 'text/html') {
          endpoint.searchParams.set('tab', 'code')
          endpoint.searchParams.set('reviewHead', local)
          endpoint.searchParams.set('reviewBase', base)
          endpoint.searchParams.set('reviewLine', 'old-review-range')
        }
        return fetch(endpoint, {
          method: 'POST', redirect: 'manual', headers: { accept, origin: host, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form.values, action: 'update-branch', method: 'REBASE', ...overrides }),
        })
      }
      cli.configureBranchUpdate(2, 'readonly')
      const reader = await readForm()
      expect(reader.html).toContain('2 commits behind')
      expect(reader.html).not.toContain('data-pr-branch-update-trigger')
      expect((await update(reader)).status).toBe(403)
      cli.configureBranchUpdate(2, 'conflict')
      expect((await readForm()).html).not.toContain('commits behind')
      cli.configureBranchUpdate(2, 'missing-ref')
      expect((await readForm()).html).toContain('Convert to draft')
      cli.configureBranchUpdate(1)
      const form = await readForm()
      expect(form.html).toContain('1 commit behind')
      expect(form.html).toContain('Update with merge')
      expect(form.html).toContain('Update with rebase')
      expect((await update(form, { method: 'SQUASH' })).status).toBe(400)
      expect((await update(form, { head: 'e'.repeat(40) })).status).toBe(409)
      expect((await update(form, { baseBranch: 'stale-base' })).status).toBe(409)
      expect((await update(form, { base: 'e'.repeat(40) })).status).toBe(409)
      cli.configureLifecycle('unconfirmed')
      const pending = await update(form)
      expect(pending.status).toBe(202)
      const refreshedForm = await readForm()
      expect(refreshedForm.values.intent).not.toBe(form.values.intent)
      expect((await update(refreshedForm)).status).toBe(202)
      expect((await update(refreshedForm, { method: 'MERGE' })).status).toBe(409)
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      expect((await update(form)).status).toBe(202)
      cli.revealLifecycle()
      const updated = await update(form, {}, 'text/html')
      expect(updated.status).toBe(303)
      const location = new URL(updated.headers.get('location')!, host)
      expect(location.searchParams.get('tab')).toBe('code')
      expect(location.searchParams.get('sort')).toBe('oldest')
      expect(location.searchParams.has('reviewLine')).toBe(false)
      expect((await update(form)).status).toBe(200)
      const latest = await readForm()
      expect(latest.html).toContain('ffffffff')
      expect(latest.html).not.toContain('data-pr-branch-update-trigger')
      expect(readState().branchWrites).toEqual([{ pullRequestId: 'fixture-pull-1', expectedHeadOid: local, updateMethod: 'REBASE' }])
    }
    finally {
      process.chdir(previousCwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 60_000)

  it.skipIf(process.platform === 'win32')('recovers a GitHub revert PR after restart using the original actor and intent', async () => {
    const { project, cli, local, base, url, readState } = seedPullRequestLifecycle('Review the report changes', false)
    const fixture = readState()
    Object.assign(fixture.pulls[0], { state: 'closed', merged_at: '2026-11-01T18:00:00Z' })
    writeFileSync(cli.state, JSON.stringify(fixture))
    const path = process.env.PATH
    const previousCwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-revert-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const summary = () => host + '/pull-requests?' + new URLSearchParams({ state: 'merged', selectedUrl: url })
      const readForm = () => pullRequestLifecycleForm(summary())
      const revert = (form: Awaited<ReturnType<typeof readForm>>, overrides: Record<string, string> = {}, accept = 'application/json') =>
        fetch(new URL(form.endpoint.pathname + form.endpoint.search, host), {
          method: 'POST', redirect: 'manual', headers: { accept, origin: host, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form.values, action: 'revert', ...overrides }),
        })
      cli.configureRevert('normal')
      cli.configureMerge('ready')
      const form = await readForm()
      expect(form.html).toContain('Open a revert pull request?')
      expect(form.html).toContain('to reverse #1')
      expect((await revert(form, { base: 'e'.repeat(40) })).status).toBe(409)
      expect((await revert(form, { baseBranch: 'another-branch' })).status).toBe(409)
      expect((await revert(form, { revision: 'c'.repeat(64) })).status).toBe(409)
      cli.configureMerge('readonly')
      expect(await fetch(summary()).then(response => response.text())).not.toContain('data-pr-revert-trigger')
      expect((await revert(form)).status).toBe(403)
      cli.configureMerge('ready')
      cli.configureRevert('denied')
      const denied = await revert(form)
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain('Private revert')
      cli.configureRevert('unavailable')
      expect((await revert(form)).status).toBe(503)
      expect(readState().revertWrites).toBeUndefined()
      cli.configureRevert('unconfirmed')
      expect((await revert(form)).status).toBe(202)
      const refreshed = await readForm()
      expect(refreshed.values.intent).not.toBe(form.values.intent)
      expect((await revert(refreshed)).status).toBe(202)
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      cli.configureRevert('wrong-author')
      expect((await revert(form)).status).toBe(202)
      cli.configureRevert('paged')
      const recovered = await revert(form, {}, 'text/html')
      expect(recovered.status).toBe(303)
      const location = new URL(recovered.headers.get('location')!, host)
      expect(location.searchParams.get('selectedUrl')).toBe(url.replace(/1$/u, '2'))
      expect(location.searchParams.get('state')).toBe('open')
      const html = await fetch(location).then(response => response.text())
      expect(html).toContain('Revert pull request opened on GitHub.')
      expect(html).toContain('data-pr-state="Open"')
      expect((await revert(await readForm())).status).toBe(200)
      expect(readState().revertWrites).toHaveLength(1)
      expect(readState().pulls[0]).toMatchObject({ state: 'closed', head: { sha: local }, base: { sha: base } })
    }
    finally {
      process.chdir(previousCwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 30_000)

  it.skipIf(process.platform === 'win32')('deletes only the reviewed GitHub source ref and recovers a lost reply without deleting a recreated branch', async () => {
    const { project, cli, local, base, url, readState } = seedPullRequestLifecycle('Review the report changes', false)
    const setPull = (properties: object) => {
      const fixture = readState()
      Object.assign(fixture.pulls[0], properties)
      writeFileSync(cli.state, JSON.stringify(fixture))
    }
    setPull({ state: 'closed' })
    cli.configureBranchDeletion({ repository: 'fixture-fork/notebook' })
    const path = process.env.PATH
    const previousCwd = process.cwd()
    process.env.PATH = cli.bin + delimiter + path
    try {
      process.chdir(join(import.meta.dir, '../../..'))
      await harness.engine.dispatch({ id: 'pr-delete-branch-project', at: Date.now(),
        command: { type: 'workspace.register', path: realpathSync(project), trusted: true } })
      let host = 'http://127.0.0.1:' + port
      const summary = () => host + '/pull-requests?' + new URLSearchParams({ state: 'closed', selectedUrl: url })
      const readForm = () => pullRequestLifecycleForm(summary(), 'pr-delete-branch-title')
      const remove = (form: Awaited<ReturnType<typeof readForm>>, overrides: Record<string, string> = {}, accept = 'application/json') =>
        fetch(new URL(form.endpoint.pathname + form.endpoint.search, host), {
          method: 'POST', redirect: 'manual', headers: { accept, origin: host, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...form.values, action: 'delete-branch', ...overrides }),
        })
      const hidden = async () => expect(await fetch(summary()).then(response => response.text())).not.toContain('data-pr-delete-branch-trigger')
      const form = await readForm()
      expect(form.html).toContain('Remove <code>report</code> from <strong>fixture-fork/notebook</strong> on GitHub.')
      expect(form.values.sourceRepositoryId).toBe('fixture-repo:fixture-fork/notebook')
      expect((await remove(form, { sourceRepositoryId: 'fixture-repo:fixture/notebook' })).status).toBe(409)
      expect((await remove(form, { sourceBranch: 'another-branch' })).status).toBe(409)
      expect((await remove(form, { base: 'c'.repeat(40) })).status).toBe(409)
      expect((await remove(form, { viewer: 'another-viewer' })).status).toBe(409)
      setPull({ state: 'open' })
      await hidden()
      expect((await remove(form)).status).toBe(409)
      setPull({ state: 'closed' })
      cli.configureBranchDeletion({ mode: 'readonly' })
      await hidden()
      expect((await remove(form)).status).toBe(403)
      cli.configureBranchDeletion({ mode: 'normal', defaultBranch: 'report' })
      await hidden()
      expect((await remove(form)).status).toBe(403)
      cli.configureBranchDeletion({ defaultBranch: 'main', protected: true })
      await hidden()
      expect((await remove(form)).status).toBe(409)
      cli.configureBranchDeletion({ protected: false, stacked: true })
      await hidden()
      expect((await remove(form)).status).toBe(409)
      cli.configureBranchDeletion({ stacked: false, target: 'e'.repeat(40) })
      const moved = await remove(form)
      expect(moved.status).toBe(409)
      expect(await moved.json()).toMatchObject({ result: 'branch-changed' })
      cli.configureBranchDeletion({ target: local, mode: 'denied' })
      const denied = await remove(form)
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain('Private branch deletion')
      expect(readState().deleteBranchWrites).toBeUndefined()

      cli.configureBranchDeletion({ mode: 'lost-response' })
      const pending = await remove(form, {}, 'text/html')
      expect(pending.status).toBe(202)
      expect(await pending.text()).toContain('Check GitHub again')
      harness.stop()
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      host = 'http://127.0.0.1:' + harness.server.port
      cli.configureBranchDeletion({ mode: 'normal' })
      const recovered = await remove(form, {}, 'text/html')
      expect(recovered.status).toBe(303)
      expect(recovered.headers.get('location')).toContain('lifecycleResult=delete-branch')
      await hidden()
      cli.configureBranchDeletion({ target: local })
      expect(await (await remove(await readForm())).json()).toMatchObject({ message: 'GitHub already confirmed the earlier update.' })
      expect(readState().branchDeletion.target).toBe(local)
      expect(readState().deleteBranchWrites).toEqual([{ repositoryId: 'fixture-repo:fixture-fork/notebook', clientMutationId: expect.any(String),
        refUpdates: [{ name: 'refs/heads/report', beforeOid: local, afterOid: '0'.repeat(40) }] }])

      const newHead = 'f'.repeat(40)
      setPull({ merged_at: '2026-11-01T18:00:00Z', head: { sha: newHead, ref: 'report' } })
      cli.configureBranchDeletion({ target: newHead, mode: 'moved-on-write' })
      const revised = await readForm()
      const racing = await remove(revised)
      expect(racing.status).toBe(409)
      expect(await racing.json()).toMatchObject({ result: 'branch-changed' })
      expect(readState().branchDeletion.target).toBe('e'.repeat(40))
      expect((await remove(revised)).status).toBe(409)
      expect(readState().deleteBranchWrites).toHaveLength(2)
      expect(readState().pulls[0]).toMatchObject({ state: 'closed', head: { sha: newHead }, base: { ref: 'main', sha: base } })
    }
    finally {
      process.chdir(previousCwd)
      if (path === undefined) delete process.env.PATH
      else process.env.PATH = path
    }
  }, 30_000)

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
    const editorRoute = `http://127.0.0.1:${port}/workspace-editor`
    expect((await fetch(`${editorRoute}?workspace=${workspaceId}`)).status).toBe(404)
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

    const launcher = join(dir, 'code')
    writeFileSync(launcher, '#!/bin/sh\nprintf "%s\\n" "$@" > .editor-args\n', { mode: 0o755 })
    const originalPath = process.env.PATH
    process.env.PATH = [dir, originalPath].filter(Boolean).join(delimiter)
    try {
      const request = (path: string, line = '2', editor = 'vscode', headers?: HeadersInit) => fetch(`${editorRoute}?${new URLSearchParams({ session: String(sessionId), workspace: String(workspaceId), path, line, editor })}`, { method: 'POST', headers })
      const editorArguments = join(worktree, '.editor-args')
      async function receiveEditorArguments(expected: string): Promise<string> {
        const deadline = Date.now() + 2_000
        let received = ''
        do {
          if (existsSync(editorArguments)) received = readFileSync(editorArguments, 'utf8')
          if (received === expected) break
          await Bun.sleep(20)
        } while (Date.now() < deadline)
        return received
      }
      const catalog = await fetch(`${editorRoute}?session=${sessionId}`)
      expect(catalog.headers.get('cache-control')).toBe('private, no-store')
      expect((await catalog.json()).choices).toContainEqual({ id: 'vscode', label: 'VS Code' })
      expect((await request('worktree-parity.md', '2', 'vscode', { origin: 'https://isolated.invalid' })).status).toBe(403)
      expect((await request('../outside-parity.txt')).status).toBe(404)
      expect((await request('parity notes [draft].md')).status).toBe(404)
      expect((await request('worktree-parity.md', '0.5')).status).toBe(400)
      expect((await request('worktree-parity.md', '2', launcher)).status).toBe(404)
      expect(existsSync(editorArguments)).toBe(false)
      const filename = 'diff lines [new] $(fixture).md'
      await Bun.write(join(worktree, filename), 'one\ntwo\n')
      symlinkSync(join(dir, 'outside-parity.txt'), join(worktree, 'linked.txt'))
      expect((await request('linked.txt')).status).toBe(404)
      expect((await request(filename)).status).toBe(204)
      const openFile = `--goto\n${join(realpathSync(worktree), filename)}:2\n`
      expect(await receiveEditorArguments(openFile)).toBe(openFile)
      expect((await request('', '0')).status).toBe(204)
      const openFolder = `--new-window\n${realpathSync(worktree)}\n`
      expect(await receiveEditorArguments(openFolder)).toBe(openFolder)
    }
    finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
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

  it('keeps editor and terminal listener discovery private when pairing is enabled', async () => {
    const databasePath = join(dir, 'paired.sqlite')
    prepareDatabase(databasePath)
    const remote = await serve({ port: 0, remote: true, databasePath, localTokenPath: join(dir, 'host-token') })
    try {
      const access = remote.access!
      const paired = await access.redeem(access.openPairing().code, 'Editor fixture device')
      if (!paired.ok) throw new Error('Fixture pairing failed')
      const dispatch = (id: string, command: Parameters<typeof remote.engine.dispatch>[0]['command']) =>
        remote.engine.dispatch({ id, at: Date.now(), command })
      await dispatch('editor-profile', { type: 'profile.create', name: 'Editor fixture' })
      const workspaceId = derivedId('editor-workspace')
      await dispatch('editor-workspace', { type: 'workspace.add', profileId: derivedId('editor-profile'), path: dir })
      await dispatch('editor-trust', { type: 'workspace.trust', workspaceId, trusted: true })
      await dispatch('editor-thread', { type: 'session.create', workspaceId, driverKind: 'claude' })
      const base = `http://127.0.0.1:${remote.server.port}`
      const endpoint = `${base}/workspace-editor?workspace=${workspaceId}`
      const headers = (token: string) => ({ authorization: `Bearer ${token}` })
      expect((await fetch(endpoint, { headers: headers(access.localToken) })).status).toBe(200)
      expect((await fetch(endpoint, { headers: headers(paired.token) })).status).toBe(403)
      expect((await fetch(endpoint, { method: 'POST', headers: headers(paired.token) })).status).toBe(403)
      const listeners = `${base}/s/${derivedId('editor-thread')}/preview-servers`
      const localListeners = await fetch(listeners, { headers: headers(access.localToken) })
      expect(localListeners.status).toBe(200)
      expect(localListeners.headers.get('cache-control')).toBe('private, no-store')
      expect(await localListeners.json()).toMatchObject({ servers: [] })
      expect((await fetch(listeners, { headers: headers(paired.token) })).status).toBe(403)
      expect((await fetch(listeners, { headers: { ...headers(access.localToken), origin: 'https://other.invalid' } })).status).toBe(403)
      expect((await fetch(listeners, { method: 'POST', headers: headers(access.localToken) })).status).toBe(405)
      expect((await fetch(`${base}/s/9007199254740992/preview-servers`, { headers: headers(access.localToken) })).status).toBe(404)
      const page = `${base}/?workspace=${workspaceId}`
      const previousCwd = process.cwd()
      process.chdir(join(import.meta.dir, '../../..'))
      try {
        expect(await (await fetch(page, { headers: headers(access.localToken) })).text()).toContain('aria-label="Open workspace in editor"')
        expect(await (await fetch(page, { headers: headers(paired.token) })).text()).not.toContain('aria-label="Open workspace in editor"')
      }
      finally { process.chdir(previousCwd) }
    }
    finally { remote.stop() }
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
    harness = await serve({ port: 0, databasePath: dbPath })
    port = harness.server.port

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
    harness = await serve({ port: 0, databasePath: dbPath })
    port = harness.server.port

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
      harness = await serve({ port: 0, databasePath: join(dir, 'test.sqlite') })
      port = harness.server.port
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
