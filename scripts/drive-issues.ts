import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'

import type { Browser } from 'playwright-core'
import { chromium, webkit } from 'playwright-core'
import { serve } from '../packages/server/src/server'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'

const dir = mkdtempSync(join(tmpdir(), 'harness-issues-drive-'))
const browserKind = process.env.HARNESS_BROWSER === 'webkit' ? webkit : chromium
const appearance = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const label = browserKind.name() + '-' + appearance
const destination = process.env.HARNESS_SCREENSHOT_DIR
if (destination) mkdirSync(destination, { recursive: true })
const now = Date.parse('2026-11-27T18:00:00Z')
const projects = Object.fromEntries(['fixture/notebook', 'fixture/atlas'].map(repo => {
  const path = join(dir, repo.split('/').at(-1)!)
  mkdirSync(path)
  for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', 'https://github.com/' + repo]]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: path })
    assert.ok(result.success, result.stderr.toString())
  }
  return [repo, path]
}))
const cli = fixtureGitHubCli(dir, Object.fromEntries(Object.entries(projects).map(([repo, path]) => [repo, { bare: join(path, '.git') }])))
const previousPath = process.env.PATH
process.env.PATH = [cli.bin, previousPath].join(delimiter)
const fixture = JSON.parse(readFileSync(cli.state, 'utf8'))
const longTitle = 'Restore offline drafts after reopening the workspace on a narrow screen'
const issueUrl = 'https://github.com/fixture/notebook/issues/24'
const row = (repo: string, number: number, title: string, created: string, updated = created) => ({
  number, title, html_url: 'https://github.com/' + repo + '/issues/' + number,
  state: 'open', user: { login: 'fixture-user' }, created_at: created, updated_at: updated,
})
fixture.issues = {
  'fixture/notebook': [{
    ...row('fixture/notebook', 24, longTitle, '2026-10-01T00:00:00Z', '2026-11-27T12:00:00Z'),
    body: 'The draft should reopen with its **attachments** and selected project.\n\nCheck behavior after the network reconnects.',
    labels: [{ id: 1, name: 'bug', color: 'ff0000' }, { id: 2, name: 'offline', color: '112233' }],
    assignees: [{ login: 'fixture-reviewer' }],
    comments: Array.from({ length: 21 }, (_, index) => ({
      id: index + 1, issue_url: 'https://api.github.com/repos/fixture/notebook/issues/24', user: { login: 'fixture-reviewer' },
      created_at: '2026-11-27T12:30:00Z', body: 'Fixture comment **' + (index + 1) + '**.',
    })),
  }, ...Array.from({ length: 21 }, (_, index) => row('fixture/notebook', 25 + index,
    'Notebook issue ' + (index + 25), new Date(Date.UTC(2026, 10, index + 1)).toISOString()))],
  'fixture/atlas': [row('fixture/atlas', 51, 'Newest fixture issue', '2026-11-26T12:00:00Z')],
}
writeFileSync(cli.state, JSON.stringify(fixture))

const databasePath = join(dir, 'fixture.sqlite')
{
  using db = new Database(databasePath)
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
  db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
  db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
}
const observedPrompts: string[] = []
const host = await serve({ port: 0, databasePath, resolveDriver: kind => ({
  kind,
  async probe() { return { status: 'ready' } },
  async create() {
    return {
      async *startTurn(input) {
        observedPrompts.push(input.text)
        yield { type: 'assistant-delta', text: 'Fixture issue draft received.' }
        yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      },
      async interrupt() {},
      async stop() {},
    }
  },
}) })
let browser: Browser | undefined
try {
  browser = await browserKind.launch()
  for (const [repo, path] of Object.entries(projects))
    await host.engine.dispatch({ id: 'register-' + repo, at: now, command: { type: 'workspace.register', path, trusted: true } })
  const base = 'http://127.0.0.1:' + host.server.port
  const page = await browser.newPage({ colorScheme: appearance, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(25_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.clock.setFixedTime(now)
  const capture = (name: string) => destination
    ? page.screenshot({ path: join(destination, 'issues-' + label + '-' + name + '.png'), animations: 'disabled', caret: 'hide' })
    : undefined
  const viewports = [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]] as const
  await page.goto(base)
  await page.locator('[data-navigation-issues]').click()
  const issue = page.getByRole('link', { name: new RegExp(longTitle) })
  assert.match((await page.locator('[data-issue-row]').first().textContent()) ?? '', /Restore offline drafts/)
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
    await capture('list-' + width + 'x' + height)
  }
  await page.getByLabel('Order').selectOption('created')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  assert.match((await page.locator('[data-issue-row]').first().textContent()) ?? '', /Newest fixture issue/)
  await page.getByLabel('Repository').selectOption('fixture/notebook')
  await page.getByLabel('Search issues').fill('offline')
  await page.getByLabel('Search issues').press('Enter')
  assert.equal(await page.locator('[data-issue-row]').count(), 1)
  await issue.click()
  await page.getByRole('heading', { name: longTitle }).waitFor()
  assert.equal(await page.locator('[data-issue-markdown="description"] strong').textContent(), 'attachments')
  const draft = page.getByRole('link', { name: 'Open as draft' })
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    const rect = await draft.boundingBox()
    assert.ok(rect && rect.width && rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height)
    assert.equal(await page.locator('[data-issue-list]').isVisible(), width >= 768)
    await capture('detail-' + width + 'x' + height)
  }
  await page.getByRole('link', { name: 'Newer comments' }).click()
  await page.locator('[data-issue-markdown="21"]').waitFor()
  assert.equal(await page.locator('[data-issue-markdown="20"]').count(), 0)
  await page.getByRole('link', { name: 'Older comments' }).click()
  await page.locator('[data-issue-markdown="1"]').waitFor()
  await draft.click()
  await page.getByRole('button', { name: 'Open project draft' }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  await page.waitForFunction(url => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === url, issueUrl)
  assert.ok(new URL(page.url()).searchParams.has('workspace'))
  assert.equal(host.engine.current.sessions.size, 0)
  assert.equal(observedPrompts.length, 0)
  await page.reload()
  await page.waitForFunction(url => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === url, issueUrl)
  assert.equal(await composer.inputValue(), issueUrl)
  await capture('project-draft')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByText('Fixture issue draft received.').waitFor()
  assert.deepEqual(observedPrompts, [issueUrl])
  assert.equal(host.engine.current.sessions.size, 1)
  assert.deepEqual(errors, [])
  console.log('PASS', label, 'six sizes, list and detail, sorting, search, comments, draft and explicit send')
}
finally {
  try { await browser?.close() }
  finally {
    host.stop()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(dir, { recursive: true, force: true })
  }
}
