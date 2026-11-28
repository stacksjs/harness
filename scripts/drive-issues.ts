import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'

import type { Browser } from 'playwright-core'
import { chromium, webkit } from 'playwright-core'
import { derivedId } from '../packages/engine/src/index'
import { serve } from '../packages/server/src/server'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'

const dir = mkdtempSync(join(tmpdir(), 'harness-issues-drive-'))
const browserKind = process.env.HARNESS_BROWSER === 'webkit' ? webkit : chromium
const appearance = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const label = browserKind.name() + '-' + appearance
const destination = process.env.HARNESS_SCREENSHOT_DIR
if (destination) mkdirSync(destination, { recursive: true })
const now = Date.parse('2026-11-27T18:00:00Z')
function localProject(repo: string, folder: string) {
  const path = join(dir, folder)
  mkdirSync(path)
  for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', 'https://github.com/' + repo]]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: path })
    assert.ok(result.success, result.stderr.toString())
  }
  return path
}
const projects = {
  'fixture/notebook': localProject('fixture/notebook', 'notebook'),
  'fixture/atlas': localProject('fixture/atlas', 'atlas'),
}
const atlasMirror = localProject('fixture/atlas', 'atlas archive')
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
    assignees: [{ login: 'fixture-reviewer' }, { login: 'fixture-user' }],
    comments: Array.from({ length: 21 }, (_, index) => ({
      id: index + 1, issue_url: 'https://api.github.com/repos/fixture/notebook/issues/24', user: { login: 'fixture-reviewer' },
      created_at: '2026-11-27T12:30:00Z', body: 'Fixture comment **' + (index + 1) + '**.',
    })),
  }, ...Array.from({ length: 21 }, (_, index) => row('fixture/notebook', 25 + index,
    'Notebook issue ' + (index + 25), new Date(Date.UTC(2026, 10, index + 1)).toISOString()))],
  'fixture/atlas': [row('fixture/atlas', 51, 'Newest fixture issue', '2026-11-26T12:00:00Z')],
}
fixture.filterAssignees = [{ login: 'fixture-reviewer', name: 'Review Team' }, { login: 'fixture-helper', name: 'Helper' }]
const triageLabel = { id: 42, name: 'Needs triage', color: '8794a1', description: 'Fixture label for new reports' }
fixture.labelCatalog = [...fixture.issues['fixture/notebook'][0].labels, triageLabel]
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
const startHost = (port = 0) => serve({ port, databasePath, resolveDriver: kind => ({
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
let host = await startHost()
let browser: Browser | undefined
try {
  browser = await browserKind.launch()
  for (const [repo, path] of Object.entries(projects))
    await host.engine.dispatch({ id: 'register-' + repo, at: now, command: { type: 'workspace.register', path, trusted: true } })
  await host.engine.dispatch({ id: 'register-atlas-archive', at: now, command: {
    type: 'workspace.register', path: atlasMirror, trusted: true,
  } })
  const base = 'http://127.0.0.1:' + host.server.port
  const context = await browser.newContext({ colorScheme: appearance, reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
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
  const filters = page.locator('[data-issue-filter-menu] > summary')
  assert.ok(await page.getByLabel('Search issues').evaluate(input => Number.parseFloat(getComputedStyle(input).paddingInlineStart) >= 30))
  assert.ok(await page.getByLabel('Order').evaluate(select => Number.parseFloat(getComputedStyle(select).paddingInlineEnd) >= 26))
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
    await capture('list-' + width + 'x' + height)
    await filters.click()
    const bounds = await page.locator('[data-issue-filter-fields]').boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
    await capture('filters-' + width + 'x' + height)
    await page.keyboard.press('Escape')
    assert.ok(await filters.evaluate(element => element === element.ownerDocument.activeElement))
  }
  await page.getByLabel('Order').selectOption('created')
  await page.waitForURL(url => url.searchParams.get('sort') === 'created')
  assert.match((await page.locator('[data-issue-row]').first().textContent()) ?? '', /Newest fixture issue/)
  const projectMenu = page.locator('[data-issue-project-filter] > summary')
  const applyFilters = page.getByRole('button', { name: 'Apply filters' })
  const atlasIssue = page.getByRole('link', { name: /Newest fixture issue/ })
  async function openProjectFilters() {
    await filters.click()
    await projectMenu.click()
  }
  await openProjectFilters()
  await page.getByRole('checkbox', { name: 'Hide atlas', exact: true }).check()
  await capture('project-filter-360x800')
  await applyFilters.click()
  await page.waitForURL(url => url.searchParams.getAll('hideProject').length === 1)
  await atlasIssue.waitFor()
  assert.equal(await atlasIssue.count(), 1)
  await openProjectFilters()
  await page.getByRole('checkbox', { name: 'Hide atlas archive', exact: true }).check()
  await applyFilters.click()
  await page.waitForURL(url => url.searchParams.getAll('hideProject').length === 2)
  assert.equal(await atlasIssue.count(), 0)
  await openProjectFilters()
  await page.getByRole('button', { name: 'Show all', exact: true }).click()
  await applyFilters.click()
  await page.waitForURL(url => !url.searchParams.has('hideProject'))
  await atlasIssue.waitFor()
  await page.getByLabel('Search issues').fill('offline')
  await page.getByLabel('Search issues').press('Enter')
  await page.waitForURL(url => url.searchParams.get('q') === 'offline')
  await issue.waitFor()
  await filters.click()
  await page.getByLabel('Repository').selectOption('fixture/notebook')
  await page.getByLabel('Involvement', { exact: true }).selectOption('assigned')
  await page.getByLabel('GitHub username', { exact: true }).fill('Review Team')
  await page.getByLabel('GitHub username', { exact: true }).press('Enter')
  await page.getByRole('button', { name: /fixture-reviewer/ }).click()
  await page.waitForURL(url => url.searchParams.get('pickAssignee') === 'fixture-reviewer')
  await issue.waitFor()
  await filters.click()
  assert.equal(await page.getByLabel('GitHub username', { exact: true }).inputValue(), 'fixture-reviewer')
  await page.getByRole('checkbox', { name: 'bug', exact: true }).check()
  await page.getByRole('checkbox', { name: 'offline', exact: true }).check()
  await page.getByRole('checkbox', { name: 'fixture/atlas', exact: true }).check()
  await projectMenu.click()
  await page.getByRole('checkbox', { name: 'Hide atlas archive', exact: true }).check()
  await page.getByRole('searchbox', { name: 'Find labels', exact: true }).fill('triage')
  await page.getByRole('searchbox', { name: 'Find labels', exact: true }).press('Enter')
  const foundLabel = page.getByRole('checkbox', { name: 'Needs triage', exact: true })
  await foundLabel.scrollIntoViewIfNeeded()
  await capture('label-search-360x800')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await issue.waitFor()
  assert.equal(await page.locator('[data-issue-row]').count(), 1)
  const views = page.getByLabel('Saved issue views')
  const saveCurrent = page.getByRole('button', { name: 'Save current view…', exact: true })
  const viewName = page.getByRole('textbox', { name: 'Name', exact: true })
  const saveView = page.getByRole('button', { name: 'Save view', exact: true })
  const savedName = 'Offline drafts needing maintainer review'
  await views.waitFor()
  await views.press('ArrowDown')
  assert.ok(await saveCurrent.evaluate(element => element === element.ownerDocument.activeElement))
  await saveCurrent.press('Enter')
  await page.getByRole('dialog', { name: 'Save issue view' }).waitFor()
  assert.ok(await viewName.evaluate(element => element === element.ownerDocument.activeElement))
  assert.equal(await page.evaluate(() => document.querySelector('dialog')?.matches(':modal')), true)
  await capture('save-view-360x800')
  await viewName.fill(savedName)
  await saveView.click()
  await page.getByText('View saved.', { exact: true }).waitFor()
  assert.ok(await views.evaluate(element => element === element.ownerDocument.activeElement))
  await page.reload()
  await views.getByText(savedName, { exact: true }).waitFor()
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    await views.click()
    const panel = page.locator('[data-list-view-panel]')
    const rect = await panel.boundingBox()
    assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height)
    assert.equal(await page.getByRole('button', { name: savedName, exact: true }).getAttribute('aria-current'), 'true')
    await capture('saved-views-' + width + 'x' + height)
    await page.keyboard.press('Escape')
    assert.ok(await views.evaluate(element => element === element.ownerDocument.activeElement))
  }
  await views.click()
  await saveCurrent.click()
  await viewName.fill(savedName.toLowerCase())
  await saveView.click()
  await page.getByRole('alert').getByText('A view with this name already exists.', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  assert.ok(await views.evaluate(element => element === element.ownerDocument.activeElement))
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
  const detailUrl = page.url()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByLabel('Order').selectOption('updated')
  await page.waitForURL(url => url.searchParams.get('sort') === 'updated')
  await page.getByRole('heading', { name: longTitle }).waitFor()
  await views.getByText('Modified', { exact: true }).waitFor()
  const withPage = new URL(page.url())
  withPage.searchParams.set('page', '2')
  await page.goto(withPage.href)
  await views.click()
  await page.getByRole('button', { name: savedName, exact: true }).click()
  await page.getByRole('heading', { name: longTitle }).waitFor()
  const restored = new URL(page.url()).searchParams
  assert.equal(restored.get('selected'), 'fixture/notebook')
  assert.equal(restored.get('q'), 'offline')
  assert.equal(restored.get('sort'), 'created')
  assert.equal(restored.has('page'), false)
  assert.equal(restored.get('involvement'), 'assigned')
  assert.equal(restored.get('assignee'), 'fixture-reviewer')
  assert.deepEqual(restored.getAll('label').sort(), ['bug', 'offline'])
  assert.deepEqual(restored.getAll('hideRepository'), ['fixture/atlas'])
  assert.deepEqual(restored.getAll('hideProject'), [String(derivedId('register-atlas-archive'))])
  assert.equal(restored.has('findLabel'), false)
  await views.getByText('Modified', { exact: true }).waitFor({ state: 'hidden' })
  await openProjectFilters()
  await page.getByRole('button', { name: 'Hide all', exact: true }).click()
  await applyFilters.click()
  await page.getByText('Show at least one project or repository in Filters.', { exact: true }).waitFor()
  await page.getByRole('heading', { name: longTitle }).waitFor()
  await views.click()
  await page.getByRole('button', { name: savedName, exact: true }).click()
  await views.getByText('Modified', { exact: true }).waitFor({ state: 'hidden' })

  await filters.click()
  await page.getByLabel('Status', { exact: true }).selectOption('all')
  await page.getByRole('button', { name: 'Apply filters' }).click()
  await views.getByText('Modified', { exact: true }).waitFor()
  await views.click()
  await page.getByRole('button', { name: 'Update saved view', exact: true }).click()
  await page.getByText('Saved view updated.', { exact: true }).waitFor()
  await views.getByText('Modified', { exact: true }).waitFor({ state: 'hidden' })
  const savedTwin = await context.newPage()
  await savedTwin.goto(page.url())
  const twinViews = savedTwin.getByLabel('Saved issue views')
  await twinViews.getByText(savedName, { exact: true }).waitFor()
  const renamed = 'Offline drafts'
  await views.click()
  await page.getByRole('button', { name: 'Rename view…', exact: true }).click()
  await page.getByRole('dialog', { name: 'Rename issue view' }).waitFor()
  await viewName.fill(renamed)
  await saveView.click()
  await twinViews.getByText(renamed, { exact: true }).waitFor()
  await views.click()
  await page.getByRole('button', { name: 'Delete view', exact: true }).click()
  await twinViews.getByText('Views', { exact: true }).waitFor()
  await savedTwin.close()
  await page.reload()
  await views.getByText('Views', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('state'), 'all')
  await page.setViewportSize({ width: 360, height: 800 })
  await draft.click()
  await page.getByRole('button', { name: 'Open project draft' }).click()
  const composer = page.getByRole('textbox', { name: 'Message', exact: true })
  const awaitPrompt = (text: string) => page.waitForFunction(value => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === value, text)
  await awaitPrompt(issueUrl)
  const workspaceId = Number(new URL(page.url()).searchParams.get('workspace'))
  assert.equal(workspaceId, derivedId('register-fixture/notebook'))
  assert.equal(host.engine.current.sessions.size, 0)
  assert.equal(observedPrompts.length, 0)
  const draftBadge = page.locator('[data-draft-issue]').getByRole('link', { name: 'fixture/notebook#24' })
  await draftBadge.waitFor()
  const prompt = 'Review recovery on both devices.\n\n' + issueUrl
  await composer.fill(prompt)
  await page.reload()
  await awaitPrompt(prompt)
  await draftBadge.waitFor()
  await capture('project-draft')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByText('Fixture issue draft received.').waitFor()
  assert.deepEqual(observedPrompts, [prompt])
  assert.equal(host.engine.current.sessions.size, 1)
  const original = [...host.engine.current.sessions.values()][0]!
  assert.deepEqual(original.linkedIssues, [{ tracker: 'github', repository: 'fixture/notebook', number: 24 }])
  const chip = page.locator('[data-thread-issues]').getByRole('link', { name: 'fixture/notebook#24' })
  await chip.waitFor()
  await capture('linked-thread')
  await host.engine.dispatchInternal({
    id: 'issue-thread-related-pr', at: now,
    command: { type: 'thread.pull-request.link', sessionId: original.id, pullRequest: { repository: 'fixture/notebook', number: 81, repositoryKey: '' } },
  })
  await host.engine.dispatch({ id: 'issue-existing-thread', at: now, command: { type: 'session.create', workspaceId, driverKind: 'claude' } })
  const existing = derivedId('issue-existing-thread')
  await host.engine.dispatch({ id: 'name-existing-issue-thread', at: now,
    command: { type: 'session.organize', sessionId: existing, action: 'rename', title: 'Existing offline thread' } })
  const issuePage = await context.newPage()
  const existingPage = await context.newPage()
  await existingPage.goto(base + '/s/' + existing)
  await issuePage.goto(detailUrl)
  await issuePage.getByRole('heading', { name: 'Linked threads' }).waitFor()
  await issuePage.getByRole('link', { name: 'fixture/notebook#24', exact: true }).waitFor()
  const pullLink = issuePage.getByRole('link', { name: 'fixture/notebook#81', exact: true })
  assert.equal(new URL(await pullLink.getAttribute('href') ?? '', base).searchParams.get('selectedUrl'), 'https://github.com/fixture/notebook/pull/81')
  await issuePage.getByText('Link an existing thread', { exact: true }).click()
  await issuePage.getByLabel('Thread', { exact: true }).selectOption(String(existing))
  const [linkedResponse] = await Promise.all([
    issuePage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/issues/threads'),
    issuePage.getByRole('button', { name: 'Link thread', exact: true }).click(),
  ])
  assert.equal(linkedResponse.status(), 303)
  await issuePage.getByRole('link', { name: 'Existing offline thread', exact: true }).waitFor()
  await existingPage.locator('[data-thread-issues]').getByRole('link', { name: 'fixture/notebook#24' }).waitFor()
  await issuePage.getByRole('button', { name: 'Unlink fixture/notebook#24' }).click()
  await chip.waitFor({ state: 'hidden' })
  assert.equal(await pullLink.count(), 0)
  await issuePage.reload()
  await issuePage.getByRole('link', { name: 'Existing offline thread', exact: true }).waitFor()
  await issuePage.goto(detailUrl)
  const changeLabels = issuePage.getByRole('link', { name: 'Change labels', exact: true })
  const changeAssignees = issuePage.getByRole('link', { name: 'Change assignees', exact: true })
  assert.equal(await changeLabels.count(), 0)
  assert.equal(await changeAssignees.count(), 0)
  function alterForge(update: (current: typeof fixture) => void) {
    const current = JSON.parse(readFileSync(cli.state, 'utf8'))
    update(current)
    writeFileSync(cli.state, JSON.stringify(current))
  }
  alterForge(current => { current.issuePermission = 'TRIAGE' })
  await issuePage.setViewportSize({ width: 360, height: 800 })
  await issuePage.reload()
  await changeLabels.click()
  const labelsForm = issuePage.getByRole('form', { name: 'Change labels', exact: true })
  const bug = labelsForm.getByRole('checkbox', { name: 'bug', exact: true })
  await bug.waitFor()
  assert.equal(await bug.isChecked(), true)
  await bug.uncheck()
  await labelsForm.getByRole('searchbox', { name: 'Search labels', exact: true }).fill('triage')
  await labelsForm.getByRole('button', { name: 'Search GitHub', exact: true }).click()
  const triage = labelsForm.getByRole('checkbox', { name: /Needs triage/ })
  await triage.waitFor()
  assert.equal(await bug.isChecked(), false)
  await triage.check()
  const requestData = await labelsForm.evaluate(form => {
    const values = new URLSearchParams()
    for (const [key, value] of new FormData(form as HTMLFormElement)) {
      if (typeof value === 'string') values.append(key, value)
    }
    return { url: (form as HTMLFormElement).action, body: values.toString() }
  })
  async function captureEditor(name: string, button: ReturnType<typeof issuePage.getByRole>) {
    for (const [width, height] of viewports) {
      await issuePage.setViewportSize({ width, height })
      await button.scrollIntoViewIfNeeded()
      const bounds = await button.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height)
      if (destination) await issuePage.screenshot({ path: join(destination, 'issues-' + label + '-' + name + '-' + width + 'x' + height + '.png') })
    }
  }
  const saveLabels = labelsForm.getByRole('button', { name: 'Save labels', exact: true })
  await captureEditor('edit-labels', saveLabels)
  const post = () => fetch(requestData.url, {
    method: 'POST', body: requestData.body, redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal((await fetch(requestData.url, {
    method: 'POST', body: requestData.body, headers: { origin: 'https://outside.invalid', 'content-type': 'application/x-www-form-urlencoded' },
  })).status, 403)
  alterForge(current => { current.issuePermission = 'READ' })
  assert.equal((await post()).status, 403)
  alterForge(current => { current.issuePermission = 'TRIAGE'; current.actor = 'different-actor' })
  assert.equal((await post()).status, 409)
  assert.equal(JSON.parse(readFileSync(cli.state, 'utf8')).labelWrites?.length, undefined)
  alterForge(current => { delete current.actor; current.labelDropResponse = 42 })
  await saveLabels.click()
  const recover = issuePage.getByRole('form', { name: 'Recover issue changes' })
  await recover.waitFor()
  const editorPort = host.server.port
  host.stop()
  host = await startHost(editorPort)
  alterForge(current => {
    current.issues['fixture/notebook'][0].labels.push({ id: 91, name: 'Concurrent label', color: '654321' })
  })
  await recover.getByRole('button', { name: 'Check GitHub and finish changes' }).click()
  await issuePage.getByText('Issue updated on GitHub.', { exact: true }).waitFor()
  const issuedMetadata = issuePage.getByRole('region', { name: 'Issue labels and assignees' })
  await issuedMetadata.getByText('Concurrent label', { exact: true }).waitFor()
  assert.equal(await issuedMetadata.getByText('bug', { exact: true }).count(), 0)
  assert.equal((await post()).status, 303)
  assert.deepEqual(JSON.parse(readFileSync(cli.state, 'utf8')).labelWrites.map((write: unknown[]) => write[2]), [42, 1])

  await issuePage.setViewportSize({ width: 1280, height: 800 })
  await changeAssignees.click()
  const people = issuePage.getByRole('form', { name: 'Change assignees', exact: true })
  const reviewer = people.getByRole('checkbox', { name: 'fixture-reviewer', exact: true })
  await reviewer.uncheck()
  await people.getByRole('searchbox', { name: 'Search assignees', exact: true }).fill('Helper')
  await people.getByRole('button', { name: 'Search GitHub', exact: true }).click()
  const helper = people.getByRole('checkbox', { name: /fixture-helper/ })
  await helper.check()
  assert.equal(await reviewer.isChecked(), false)
  const saveAssignees = people.getByRole('button', { name: 'Save assignees', exact: true })
  await captureEditor('edit-assignees', saveAssignees)
  alterForge(current => { current.assigneeDropResponse = 'PERSON_fixture-helper' })
  await saveAssignees.click()
  await recover.waitFor()
  alterForge(current => {
    current.issues['fixture/notebook'][0].assignees.push({ login: 'concurrent-person' })
  })
  await recover.getByRole('button', { name: 'Check GitHub and finish changes' }).click()
  await issuePage.getByText('Issue updated on GitHub.', { exact: true }).waitFor()
  await issuedMetadata.getByText('fixture-helper', { exact: true }).waitFor()
  await issuedMetadata.getByText('concurrent-person', { exact: true }).waitFor()
  assert.equal(await issuedMetadata.getByText('fixture-reviewer', { exact: true }).count(), 0)
  assert.deepEqual(JSON.parse(readFileSync(cli.state, 'utf8')).assigneeWrites, [
    [24, false, 'PERSON_fixture-reviewer'], [24, true, 'PERSON_fixture-helper'],
  ])
  assert.deepEqual(errors, [])
  console.log('PASS', label, 'six sizes, filters, saved views, project visibility, draft and send, permission-gated edits and recovery')
}
catch (error) {
  console.error(error)
  throw error
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
