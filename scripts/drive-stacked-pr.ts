/** Exercise the combined GitHub publication against its own real Git and forge fixtures. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { chromium, webkit } from 'playwright-core'
import { serve } from '../packages/server/src/index'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'

const root = mkdtempSync(join(tmpdir(), 'harness-stacked-pr-'))
const screenshots = process.env.HARNESS_SCREENSHOT_DIR
const toolPath = process.env.PATH
let host: Awaited<ReturnType<typeof serve>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  const checkout = join(root, 'Notebook project')
  const remote = join(root, 'notebook.git')
  mkdirSync(checkout)
  const git = (...args: string[]) => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8' }).trim()
  git('init', '-qb', 'main')
  git('config', 'user.name', 'Fixture author')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', join(root, 'fixture-hooks'))
  writeFileSync(join(checkout, 'review.txt'), 'Original report\n')
  git('add', 'review.txt')
  git('commit', '-qm', 'Initial report')
  const initial = git('rev-parse', 'HEAD')
  git('clone', '-q', '--bare', '--', checkout, remote)
  const publishedUrl = 'https://github.com/fixture/notebook.git'
  git('remote', 'add', 'origin', publishedUrl)
  git('config', 'url.' + remote + '.insteadOf', publishedUrl)
  const branch = 'feature/published-report'
  git('switch', '-qc', branch)
  writeFileSync(join(checkout, 'review.txt'), 'Selected report contents\n')
  writeFileSync(join(checkout, 'excluded.txt'), 'Excluded staged contents\n')
  git('add', 'excluded.txt')

  const forge = fixtureGitHubCli(root, { 'fixture/notebook': { bare: remote } })
  const readForge = () => JSON.parse(readFileSync(forge.state, 'utf8'))
  const issue = { tracker: 'github' as const, repository: 'fixture/notebook', number: 24 }
  const issueUrl = 'https://github.com/fixture/notebook/issues/24'
  const fixture = readForge()
  fixture.issues = { [issue.repository]: [{
    number: issue.number, html_url: issueUrl, title: 'Review the report from a project issue',
    state: 'open', created_at: '2026-11-25T12:00:00Z', updated_at: '2026-11-26T12:00:00Z',
    body: 'Publish the reviewed report from the connected thread.',
  }] }
  writeFileSync(forge.state, JSON.stringify(fixture))
  process.env.PATH = [forge.bin, toolPath].filter(Boolean).join(delimiter)
  const databasePath = join(root, 'test.sqlite')
  {
    using db = new Database(databasePath)
    db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
    db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
    db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
  }

  const commitPatches: string[] = []
  const pullRequestPatches: string[] = []
  const issuePrompts: string[] = []
  host = await serve({ port: 0, databasePath, resolveDriver: kind => ({
    kind,
    async probe() { return { status: 'ready' } },
    async create() {
      return {
        async *startTurn(input) {
          issuePrompts.push(input.text)
          yield { type: 'assistant-delta', text: 'Fixture reviewed the connected issue.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
        },
        async interrupt() {},
        async stop() {},
      }
    },
    async generateCommitMessage(_config, input) {
      commitPatches.push(input.patch)
      return { subject: 'Review the report', body: '' }
    },
    async generatePullRequestText(_config, input) {
      pullRequestPatches.push(input.patch)
      return { title: 'Review the published report', body: 'Validate the committed report.' }
    },
  }) })
  const now = new Date('2026-11-26T17:00:00Z')
  await host.engine.dispatch({ id: 'stacked-pr-workspace', at: now.getTime(), command: { type: 'workspace.register', path: checkout, trusted: true } })
  const base = 'http://127.0.0.1:' + host.server.port

  const engine = process.env.HARNESS_BROWSER === 'webkit' ? webkit : chromium
  const colorScheme = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
  browser = await engine.launch()
  const page = await browser.newPage({ colorScheme, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })
  page.setDefaultTimeout(45_000)
  await page.clock.setFixedTime(now)
  console.log('Combined PR browser fixture', engine.name(), browser.version(), colorScheme)
  const capture = async (name: string) => {
    if (!screenshots) return
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'stacked-pr-' + name + '.png'), animations: 'disabled' })
  }
  async function openChanges() {
    if (await page.locator('[data-diff-git-status]').isVisible()) return
    await page.locator('button[title="Changes"], button[aria-label="Show changes"]').filter({ visible: true }).first().click()
  }

  try {
    await page.goto(base + '/issues?' + new URLSearchParams({ selected: issue.repository, issue: String(issue.number) }))
    await page.getByRole('link', { name: 'Open as draft' }).click()
    await page.getByRole('button', { name: 'Open project draft' }).click()
    await page.locator('[data-draft-issue]').getByRole('link', { name: 'fixture/notebook#24' }).waitFor()
    assert.equal(host.engine.current.sessions.size, 0)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await page.getByText('Fixture reviewed the connected issue.').waitFor()
    assert.deepEqual(issuePrompts, [issueUrl])
    const [thread] = host.engine.current.sessions.values()
    assert.ok(thread)
    assert.deepEqual(thread.linkedIssues, [issue])
    assert.equal(thread.isolate, false)
    await openChanges()
    const trigger = page.getByRole('button', { name: 'Commit, push & PR', exact: true })
    const review = page.getByRole('dialog', { name: 'Commit, push & create PR', exact: true })
    await trigger.press('Enter')
    await review.getByText('fixture/notebook:main', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await review.waitFor({ state: 'hidden' })
    assert.equal(await trigger.evaluate(element => element === element.ownerDocument.activeElement), true)
    assert.equal(git('rev-parse', 'HEAD'), initial)
    assert.equal(readForge().posts, 0)

    await trigger.click()
    await review.getByText('fixture-user', { exact: true }).waitFor()
    await review.getByRole('button', { name: 'Edit files', exact: true }).click()
    await review.getByRole('checkbox', { name: 'Include excluded.txt', exact: true }).uncheck()
    await review.getByRole('checkbox', { name: 'Open as draft', exact: true }).check()
    const submit = review.getByRole('button', { name: 'Commit, push & create PR', exact: true })
    for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]] as const) {
      await page.setViewportSize({ width, height })
      assert.equal(await page.locator('html').evaluate(element => element.scrollWidth > element.clientWidth), false)
      await submit.scrollIntoViewIfNeeded()
      const bounds = await submit.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      await capture('review-' + width + 'x' + height)
    }

    forge.configure('denied')
    await submit.click()
    await review.waitFor({ state: 'hidden' })
    const continuation = page.getByRole('button', { name: 'Continue pull request', exact: true })
    await continuation.waitFor()
    const commit = git('rev-parse', 'HEAD')
    assert.notEqual(commit, initial)
    assert.equal(git('rev-parse', 'main'), initial)
    assert.equal(git('diff', '--cached', '--name-only'), 'excluded.txt')
    assert.equal(git('--git-dir', remote, 'rev-parse', 'refs/heads/' + branch), commit)
    assert.equal(readForge().posts, 1)
    assert.equal(commitPatches.length, 1)
    assert.equal(pullRequestPatches.length, 1)
    assert.match(pullRequestPatches[0]!, /Selected report contents/u)
    assert.doesNotMatch(pullRequestPatches[0]!, /Excluded staged contents/u)
    await capture('rejected-360x800')

    await page.reload()
    await openChanges()
    await continuation.click()
    const retry = page.getByRole('dialog', { name: 'Continue pull request', exact: true })
    const title = retry.getByRole('textbox', { name: 'Title', exact: true })
    await title.waitFor()
    assert.equal(await title.inputValue(), 'Review the published report')
    assert.notEqual(await retry.getByRole('textbox', { name: 'Base branch', exact: true }).getAttribute('readonly'), null)
    await capture('retry-360x800')
    forge.configure('lost-response')
    await retry.getByRole('button', { name: 'Create pull request', exact: true }).click()
    await retry.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('link', { name: 'GitHub #1', exact: true }).getAttribute('href'), 'https://github.com/fixture/notebook/pull/1')
    const result = readForge()
    assert.equal(result.posts, 2)
    assert.equal(result.pulls.length, 1)
    assert.equal(result.pulls[0].draft, true)
    assert.equal(result.pulls[0].head.sha, commit)
    assert.equal(git('rev-parse', 'HEAD'), commit)
    assert.equal(commitPatches.length, 1)
    assert.equal(pullRequestPatches.length, 1)
    await capture('linked-360x800')
    await page.getByRole('button', { name: /close changes/i }).click()
    await page.getByRole('navigation', { name: 'Linked issues' }).getByRole('link', { name: 'fixture/notebook#24' }).click()
    await page.getByRole('heading', { name: 'Review the report from a project issue' }).waitFor()
    const pull = page.getByRole('link', { name: 'fixture/notebook#1', exact: true })
    const pullAddress = new URL(await pull.getAttribute('href') ?? '', base)
    assert.equal(pullAddress.pathname, '/pull-requests')
    assert.equal(pullAddress.searchParams.get('selectedUrl'), 'https://github.com/fixture/notebook/pull/1')
    await pull.scrollIntoViewIfNeeded()
    await capture('issue-to-pr-360x800')
    console.log('PASS combined publication recovers with one commit, one pull request, and a link from the issue')
  }
  catch (error) {
    await capture('failure').catch(() => {})
    console.error('Review feedback:', await page.locator('dialog[open] [role="alert"]').allTextContents().catch(() => []))
    throw error
  }
}
finally {
  await browser?.close()
  host?.stop()
  if (toolPath === undefined) delete process.env.PATH
  else process.env.PATH = toolPath
  rmSync(root, { recursive: true, force: true })
}
