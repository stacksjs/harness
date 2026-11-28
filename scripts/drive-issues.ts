import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'

import type { Browser, Locator } from 'playwright-core'
import { chromium, webkit } from 'playwright-core'
import { derivedId } from '../packages/engine/src/index'
import { serve } from '../packages/server/src/server'
import { fixtureForgejoCli } from '../packages/server/test/fixtures/forgejo-cli'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'
import { fixtureGitLabCli } from '../packages/server/test/fixtures/gitlab-cli'

const dir = mkdtempSync(join(tmpdir(), 'harness-issues-drive-'))
const browserKind = process.env.HARNESS_BROWSER === 'webkit' ? webkit : chromium
const appearance = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const label = browserKind.name() + '-' + appearance
const destination = process.env.HARNESS_SCREENSHOT_DIR
if (destination) mkdirSync(destination, { recursive: true })
const now = Date.parse('2026-11-27T18:00:00Z')
function localProject(folder: string, remote: string) {
  const path = join(dir, folder)
  mkdirSync(path)
  for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', remote]]) {
    const result = Bun.spawnSync(['git', ...args], { cwd: path })
    assert.ok(result.success, result.stderr.toString())
  }
  return path
}
const projects = {
  'fixture/notebook': localProject('notebook', 'https://github.com/fixture/notebook'),
  'fixture/atlas': localProject('atlas', 'https://github.com/fixture/atlas'),
}
const atlasMirror = localProject('atlas archive', 'https://github.com/fixture/atlas')
const cli = fixtureGitHubCli(dir, Object.fromEntries(Object.entries(projects).map(([repo, path]) => [repo, { bare: join(path, '.git') }])))
fixtureGitLabCli(cli.bin)
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
  'fixture/atlas': [{ ...row('fixture/atlas', 51, 'Newest fixture issue', '2026-11-26T12:00:00Z'),
    comments: [{ id: 501, issue_url: 'https://api.github.com/repos/fixture/atlas/issues/51', user: { login: 'fixture-user' },
      created_at: '2026-11-27T12:30:00Z', body: 'A comment on a different issue.' }],
  }],
}
const fixtureIssueNode = 'ISSUE_fixture_notebook_24'
fixture.issueEvents = {
  [fixtureIssueNode]: [
    { __typename: 'LabeledEvent', id: 'event-label', createdAt: '2026-11-27T11:00:00Z', actor: { login: 'fixture-reviewer' }, label: { name: 'offline' } },
    { __typename: 'AssignedEvent', id: 'event-assignment', createdAt: '2026-11-27T11:05:00Z', actor: { login: 'fixture-reviewer' }, assignee: { login: 'fixture-user' } },
    { __typename: 'ReopenedEvent', id: 'event-reopen', createdAt: '2026-11-27T11:06:00Z', actor: { login: 'fixture-reviewer' } },
    { __typename: 'CrossReferencedEvent', id: 'event-reference', createdAt: '2026-11-27T13:01:00Z', actor: { login: 'fixture-reviewer' },
      source: { __typename: 'Issue', number: 51, url: 'https://github.com/fixture/atlas/issues/51', repository: { nameWithOwner: 'fixture/atlas' } } },
    { __typename: 'RenamedTitleEvent', id: 'event-rename', createdAt: '2026-11-27T13:02:00Z', actor: { login: 'fixture-reviewer' }, currentTitle: longTitle },
  ],
}
fixture.issueReactions = { [fixtureIssueNode]: { THUMBS_UP: ['another-viewer'] } }
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
function readReactionRequest(form: Locator, reaction: string) {
  return form.evaluate((element, reaction) => {
    const values = new URLSearchParams(Array.from(new FormData(element as HTMLFormElement), ([key, value]) => [key, String(value)]))
    values.set('reaction', reaction)
    return { url: (element as HTMLFormElement).action, body: values.toString() }
  }, reaction)
}

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
  await page.getByLabel('Assignee username', { exact: true }).fill('Review Team')
  await page.getByLabel('Assignee username', { exact: true }).press('Enter')
  await page.getByRole('button', { name: /fixture-reviewer/ }).click()
  await page.waitForURL(url => url.searchParams.get('pickAssignee') === 'fixture-reviewer')
  await issue.waitFor()
  await filters.click()
  assert.equal(await page.getByLabel('Assignee username', { exact: true }).inputValue(), 'fixture-reviewer')
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
  const detailUrl = page.url()
  await page.locator('[data-issue-markdown="21"]').waitFor()
  assert.equal(await page.locator('[data-issue-markdown="1"]').count(), 0)
  const crossReference = page.getByRole('link', { name: 'fixture/atlas #51', exact: true })
  assert.equal(new URL(await crossReference.getAttribute('href') ?? '', base).searchParams.get('selected'), 'fixture/atlas')
  await page.getByRole('link', { name: 'Older activity' }).click()
  await page.locator('[data-issue-markdown="1"]').waitFor()
  await page.getByText('added label offline', { exact: true }).waitFor()
  await page.getByText('assigned fixture-user', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-issue-markdown="21"]').count(), 0)
  await page.getByRole('link', { name: 'Newer activity' }).click()
  await page.locator('[data-issue-markdown="21"]').waitFor()
  await page.goto(detailUrl + '&comments=2')
  await page.locator('[data-issue-markdown="21"]').waitFor()
  assert.equal(await page.locator('[data-issue-markdown="20"]').count(), 0)
  await page.getByRole('link', { name: 'Older comments' }).click()
  await page.locator('[data-issue-markdown="1"]').waitFor()
  await page.goto(detailUrl)
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
  const changeStatus = issuePage.getByRole('link', { name: /^Change issue status,/ })
  assert.equal(await changeStatus.count(), 0)
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
  const editStatus = issuePage.getByRole('form', { name: 'Change issue status', exact: true })
  const saveStatus = editStatus.getByRole('button', { name: 'Save status', exact: true })
  const statusUpdated = issuePage.getByText('Issue status updated on GitHub.', { exact: true })
  const readForge = () => JSON.parse(readFileSync(cli.state, 'utf8'))
  // An issue author can close their issue even without repository triage.
  alterForge(current => {
    current.issuePermission = 'READ'
    current.issueAuthorCanChange = true
    current.issueUnsupportedPlanning = true
  })
  await issuePage.goto(detailUrl)
  assert.equal(await changeLabels.count(), 0)
  await changeStatus.focus()
  await issuePage.keyboard.press('Enter')
  await editStatus.getByRole('radio', { name: 'Not planned', exact: true }).check()
  await captureEditor('edit-status', saveStatus)
  const statusPost = await editStatus.evaluate(form => {
    const values = new URLSearchParams()
    new FormData(form as HTMLFormElement).forEach((value, key) => {
      if (typeof value === 'string') values.append(key, value)
    })
    return { url: (form as HTMLFormElement).action, body: values.toString() }
  })
  const submitStatus = () => fetch(statusPost.url, {
    method: 'POST', body: statusPost.body, redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  })
  alterForge(current => { current.issueAuthorCanChange = false })
  assert.equal((await submitStatus()).status, 403)
  alterForge(current => {
    current.issueAuthorCanChange = true
    const item = current.issues['fixture/notebook'][0]
    item.state = 'closed'
    item.state_reason = 'completed'
  })
  assert.equal((await submitStatus()).status, 409)
  assert.equal(readForge().issueStateWrites, undefined)
  alterForge(current => {
    const item = current.issues['fixture/notebook'][0]
    item.state = 'open'
    item.state_reason = null
    current.issueStateDropResponse = true
  })
  await saveStatus.click()
  const recoverStatus = issuePage.getByRole('form', { name: 'Check issue status', exact: true })
  await recoverStatus.waitFor()
  const statusPort = host.server.port
  host.stop()
  host = await startHost(statusPort)
  await recoverStatus.getByRole('button', { name: 'Check GitHub', exact: true }).click()
  await statusUpdated.waitFor()
  assert.equal(await changeStatus.getAttribute('aria-label'), 'Change issue status, Not planned')
  assert.equal((await submitStatus()).status, 303)
  await changeStatus.click()
  await editStatus.getByRole('radio', { name: 'Open', exact: true }).check()
  await saveStatus.click()
  await statusUpdated.waitFor()
  assert.equal(await changeStatus.getAttribute('aria-label'), 'Change issue status, Open')

  alterForge(current => {
    delete current.issueUnsupportedPlanning
    current.issuePermission = 'TRIAGE'
    current.planningStatuses = [
      { id: 'STATUS_OPEN', name: 'Backlog', category: { state: 'OPEN', stateReason: null } },
      { id: 'STATUS_ACTIVE', name: 'In progress', category: { state: 'OPEN', stateReason: null } },
      { id: 'STATUS_DONE', name: 'Done', category: { state: 'CLOSED', stateReason: 'COMPLETED' } },
      { id: 'STATUS_DUPLICATE', name: 'Duplicate', category: { state: 'CLOSED', stateReason: 'DUPLICATE' } },
    ]
    current.issues['fixture/notebook'][0].status_id = 'STATUS_OPEN'
  })
  await issuePage.goto(detailUrl)
  assert.equal(await changeStatus.getAttribute('aria-label'), 'Change issue status, Backlog')
  await changeStatus.click()
  await editStatus.getByRole('radio', { name: 'In progress', exact: true }).check()
  await captureEditor('edit-planning-status', saveStatus)
  await saveStatus.click()
  await statusUpdated.waitFor()
  assert.equal(await changeStatus.getAttribute('aria-label'), 'Change issue status, In progress')
  await changeStatus.click()
  await editStatus.getByRole('radio', { name: 'Duplicate', exact: true }).check()
  await saveStatus.click()
  await statusUpdated.waitFor()
  assert.equal(await changeStatus.getAttribute('aria-label'), 'Change issue status, Duplicate')
  assert.deepEqual(readForge().issueStateWrites, [
    [24, 'closed', 'not_planned'], [24, 'open', 'reopened'], [24, 'STATUS_ACTIVE'], [24, 'closed', 'duplicate'],
  ])
  await issuePage.goto(detailUrl)
  const commentForm = issuePage.getByRole('form', { name: 'Issue comment', exact: true })
  const commentBody = commentForm.getByRole('textbox', { name: 'Add a comment', exact: true })
  const postComment = commentForm.getByRole('button', { name: 'Post comment', exact: true })
  const postedComment = commentForm.getByText('Comment posted to GitHub.', { exact: true })
  const commentText = '    preserve-leading-indent\n\nSynthetic **review note** with a line break.\n\n<script>private-fixture-tag()</script>'
  await commentBody.fill(commentText)
  await captureEditor('comment', postComment)
  const commentPost = await commentForm.evaluate(form => ({
    url: (form as HTMLFormElement).action,
    body: new URLSearchParams(Array.from(new FormData(form as HTMLFormElement), ([key, value]) => [key, String(value)])).toString(),
  }))
  const replayComment = (origin: string) => fetch(commentPost.url, {
    method: 'POST', body: commentPost.body, redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal((await replayComment('https://outside.invalid')).status, 403)
  const oversized = new URLSearchParams(commentPost.body)
  const multibyteDraft = 'あ'.repeat(7000)
  oversized.set('body', multibyteDraft)
  const rejectedSize = await fetch(commentPost.url, {
    method: 'POST', body: oversized, headers: { origin: base },
  })
  assert.equal(rejectedSize.status, 422)
  assert.ok((await rejectedSize.text()).includes(multibyteDraft))

  alterForge(current => { current.issueLocked = true; current.issuePermission = 'READ' })
  assert.equal((await replayComment(base)).status, 403)
  alterForge(current => { delete current.issueLocked; current.actor = 'new-comment-account' })
  assert.equal((await replayComment(base)).status, 409)
  alterForge(current => { delete current.actor; current.issueRefuseComment = true })
  await postComment.click()
  await commentForm.getByText('GitHub rejected the comment. Review your draft and try again.', { exact: true }).waitFor()
  assert.equal(await commentBody.inputValue(), commentText)
  assert.equal(readForge().issueCommentWrites, undefined)
  alterForge(current => { delete current.issueRefuseComment; current.issueDropComment = true })
  const retryPayload = await commentForm.evaluate(form => ({
    url: (form as HTMLFormElement).action,
    body: new URLSearchParams(Array.from(new FormData(form as HTMLFormElement), ([key, value]) => [key, String(value)])).toString(),
  }))
  await commentBody.press('Control+Enter')
  const checkComment = commentForm.getByRole('button', { name: 'Check GitHub', exact: true })
  await checkComment.waitFor()
  assert.equal(await commentBody.inputValue(), commentText)
  assert.equal(await commentBody.getAttribute('readonly') !== null, true)
  await captureEditor('comment-recovery', checkComment)
  const commentPort = host.server.port
  host.stop()
  host = await startHost(commentPort)
  alterForge(current => { delete current.issueHideComment })
  await checkComment.click()
  await postedComment.waitFor()
  assert.equal(await commentBody.inputValue(), '')
  const published = issuePage.locator('#issue-comment-22')
  await published.getByText('review note', { exact: true }).waitFor()
  await published.locator('pre code').getByText('preserve-leading-indent', { exact: true }).waitFor()
  assert.equal(await published.getByText('private-fixture-tag').count(), 0)
  assert.equal(await published.getByText('harness:issue-comment', { exact: false }).count(), 0)
  assert.equal(new URL(issuePage.url()).hash, '#issue-comment-22')
  const duplicate = await fetch(retryPayload.url, {
    method: 'POST', body: retryPayload.body, redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(duplicate.status, 303)
  assert.ok(duplicate.headers.get('location')?.endsWith('#issue-comment-22'))
  await issuePage.reload()
  await published.getByText('review note', { exact: true }).waitFor()
  assert.deepEqual(readForge().issueCommentWrites, [[24, 22]])
  const legacyBody = new URLSearchParams(retryPayload.body)
  const legacyIntent = crypto.randomUUID()
  const legacyText = 'Previously trimmed draft'
  legacyBody.set('intent', legacyIntent)
  legacyBody.set('body', '    ' + legacyText)
  const legacyFingerprint = createHash('sha256').update(JSON.stringify([legacyBody.get('scope'), legacyText])).digest('hex')
  {
    using db = new Database(databasePath)
    db.query('INSERT INTO harness_pull_request_reply_receipts (token, fingerprint) VALUES (?, ?)').run(legacyIntent, legacyFingerprint)
  }
  alterForge(current => {
    current.issues['fixture/notebook'][0].comments.push({
      id: 23, body: '<!-- harness:issue-comment:' + legacyIntent + ' -->\n\n' + legacyText,
      user: { login: 'fixture-user', node_id: 'VIEWER_fixture-user' }, created_at: '2026-11-27T18:00:00Z',
      issue_url: 'https://api.github.com/repos/fixture/notebook/issues/24',
    })
  })
  const recoveredLegacy = await fetch(retryPayload.url, {
    method: 'POST', body: legacyBody, redirect: 'manual', headers: { origin: base },
  })
  assert.equal(recoveredLegacy.status, 303)
  assert.ok(recoveredLegacy.headers.get('location')?.endsWith('#issue-comment-23'))
  assert.deepEqual(readForge().issueCommentWrites, [[24, 22]])
  await issuePage.goto(detailUrl)
  const editTitle = issuePage.getByRole('link', { name: 'Edit title', exact: true })
  const editDescription = issuePage.getByRole('link', { name: 'Edit description', exact: true })
  assert.equal(await editTitle.count(), 0)
  assert.equal(await editDescription.count(), 0)
  alterForge(current => { current.issueCanEditText = true; current.issuePermission = 'READ' })
  await issuePage.reload()
  await editTitle.click()
  const textForm = issuePage.locator('[data-issue-text-editor]')
  const title = textForm.getByRole('textbox', { name: 'Issue title', exact: true })
  const saveText = textForm.getByRole('button', { name: 'Save', exact: true })
  const savedText = issuePage.getByText('Issue text saved on GitHub.', { exact: true })
  const proposed = 'Review offline drafts after reopening the workspace'
  await title.fill(proposed)
  await captureEditor('edit-title', saveText)
  await title.press('Escape')
  await editTitle.waitFor()
  assert.equal(readForge().issueTextWrites, undefined)
  await editTitle.click()
  await title.fill(proposed)
  const captureTextRequest = () => textForm.evaluate(form => ({
    url: (form as HTMLFormElement).action,
    body: new URLSearchParams(Array.from(new FormData(form as HTMLFormElement), ([key, value]) => [key, String(value)])).toString(),
  }))
  const restoreTitle = await captureTextRequest()
  const postText = (payload: typeof restoreTitle, origin = base) => fetch(payload.url, {
    method: 'POST', body: payload.body, redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal((await postText(restoreTitle, 'https://outside.invalid')).status, 403)
  alterForge(current => { current.issueCanEditText = false })
  assert.equal((await postText(restoreTitle)).status, 403)
  alterForge(current => {
    current.issueCanEditText = true
    current.actor = 'swapped-edit-account'
  })
  assert.equal((await postText(restoreTitle)).status, 409)
  alterForge(current => {
    delete current.actor
    current.issues['fixture/notebook'][0].title = 'Concurrent title from GitHub'
  })
  await saveText.click()
  const keepDraft = textForm.getByRole('button', { name: 'Keep my draft', exact: true })
  await keepDraft.waitFor()
  assert.equal(await textForm.getByRole('textbox', { name: /^Your draft/ }).inputValue(), proposed)
  await textForm.getByText('Concurrent title from GitHub', { exact: true }).waitFor()
  assert.equal(readForge().issueTextWrites, undefined)
  await captureEditor('edit-conflict', keepDraft)
  await keepDraft.click()
  assert.equal(await title.inputValue(), proposed)
  assert.equal(readForge().issueTextWrites, undefined)
  await saveText.click()
  await savedText.waitFor()
  await issuePage.getByRole('heading', { name: proposed, exact: true }).waitFor()
  await editDescription.click()
  const description = textForm.getByRole('textbox', { name: 'Description', exact: true })
  const markdown = '    kept-indentation\n\n**Updated description**\n\n<script>private-fixture-preview()</script>'
  await description.fill(markdown)
  await captureEditor('edit-description', saveText)
  await textForm.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = textForm.locator('[data-issue-text-preview]')
  await preview.getByText('Updated description', { exact: true }).waitFor()
  assert.equal(await preview.getByText('private-fixture-preview', { exact: false }).count(), 0)
  assert.equal(readForge().issueTextWrites.length, 1)
  await captureEditor('edit-description-preview', saveText)
  await textForm.getByRole('button', { name: 'Write', exact: true }).click()
  assert.equal(await description.inputValue(), markdown)
  alterForge(current => { current.issueRefuseText = true })
  await description.press('Control+Enter')
  await textForm.getByText('GitHub rejected the edit. Review your draft and try again.', { exact: true }).waitFor()
  assert.equal(await description.inputValue(), markdown)
  alterForge(current => { delete current.issueRefuseText; current.issueDropText = true })
  const replayText = await captureTextRequest()
  await saveText.click()
  const recoverText = textForm.getByRole('button', { name: 'Check GitHub', exact: true })
  await recoverText.waitFor()
  const textPort = host.server.port
  host.stop()
  host = await startHost(textPort)
  await recoverText.click()
  await savedText.waitFor()
  await issuePage.locator('[data-issue-markdown="description"]').getByText('Updated description', { exact: true }).waitFor()
  assert.equal((await postText(replayText)).status, 303)
  assert.deepEqual(readForge().issueTextWrites, [[24, 'title', proposed], [24, 'body', markdown]])
  await editDescription.click()
  await description.fill('  ')
  await textForm.getByRole('button', { name: 'Preview', exact: true }).click()
  await preview.getByText('Nothing to preview.', { exact: true }).waitFor()
  assert.equal(readForge().issueTextWrites.length, 2)
  await textForm.getByRole('button', { name: 'Write', exact: true }).click()
  await description.fill('')
  await saveText.click()
  await savedText.waitFor()
  await issuePage.getByText('No description.', { exact: true }).waitFor()
  assert.equal(readForge().issues['fixture/notebook'][0].title, proposed)
  await issuePage.goto(detailUrl)
  const issueReactions = issuePage.getByRole('form', { name: 'Issue reactions', exact: true })
  const commentReactions = issuePage.getByRole('form', { name: 'Comment 21 reactions', exact: true })
  const addIssueReaction = issueReactions.getByRole('button', { name: 'Add Thumbs up reaction, 1', exact: true })
  const intent = await readReactionRequest(issueReactions, 'add:THUMBS_UP')
  const react = (request: typeof intent, origin = base) => fetch(request.url, { method: 'POST', body: request.body, redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } })
  assert.equal((await react(intent, 'https://outside.invalid')).status, 403)
  alterForge(current => { current.actor = 'different-reaction-account' })
  assert.equal((await react(intent)).status, 409)
  alterForge(current => { delete current.actor; current.issueLocked = true })
  assert.equal((await react(intent)).status, 403)
  alterForge(current => { delete current.issueLocked })
  const crossTarget = new URLSearchParams(intent.body)
  crossTarget.set('subject', 'ISSUE_fixture_notebook_25')
  assert.equal((await react({ ...intent, body: crossTarget.toString() })).status, 409)
  await addIssueReaction.click()
  const removeIssueReaction = issueReactions.getByRole('button', { name: 'Remove Thumbs up reaction, 2', exact: true })
  await removeIssueReaction.waitFor()
  assert.equal(await removeIssueReaction.getAttribute('aria-pressed'), 'true')
  await removeIssueReaction.click()
  await addIssueReaction.waitFor()
  assert.equal((await react(intent)).status, 303)
  await issuePage.reload()
  await addIssueReaction.waitFor()
  const openReactionPicker = commentReactions.getByText('Add reaction', { exact: true })
  await openReactionPicker.click()
  const heart = commentReactions.getByRole('button', { name: 'Add Heart reaction', exact: true })
  await heart.press('Escape')
  await heart.waitFor({ state: 'hidden' })
  assert.equal(await openReactionPicker.evaluate(node => node === node.ownerDocument.activeElement), true)
  await openReactionPicker.click()
  await captureEditor('comment-reaction', heart)
  await heart.click({ trial: true })
  const heartIntent = await readReactionRequest(commentReactions, 'add:HEART')
  const foreignComment = new URLSearchParams(heartIntent.body)
  foreignComment.set('subject', 'ISSUE_fixture_atlas_51_COMMENT_501')
  assert.equal((await react({ ...heartIntent, body: foreignComment.toString() })).status, 409)
  const badComment = new URL(heartIntent.url)
  badComment.searchParams.set('issue', '25')
  assert.equal((await react({ ...heartIntent, url: badComment.href })).status, 409)
  alterForge(current => { current.issueDropReaction = true })
  assert.equal((await react(heartIntent)).status, 202)
  const reactionPort = host.server.port
  host.stop()
  host = await startHost(reactionPort)
  assert.equal((await react(heartIntent)).status, 303)
  await issuePage.reload()
  const removeHeart = commentReactions.getByRole('button', { name: 'Remove Heart reaction, 1', exact: true })
  await removeHeart.click()
  await commentReactions.getByRole('button', { name: 'Remove Heart reaction, 1', exact: true }).waitFor({ state: 'hidden' })
  assert.deepEqual(readForge().issueReactionWrites, [
    [fixtureIssueNode, 'THUMBS_UP', true], [fixtureIssueNode, 'THUMBS_UP', false],
    [fixtureIssueNode + '_COMMENT_21', 'HEART', true], [fixtureIssueNode + '_COMMENT_21', 'HEART', false],
  ])
  alterForge(current => { current.issueActivityUnavailable = true })
  await issuePage.goto(detailUrl)
  await issuePage.getByText('GitHub could only load comments. Refresh for issue events.', { exact: true }).waitFor()
  await issuePage.locator('[data-issue-markdown="1"]').waitFor()
  assert.equal(await issuePage.locator('[data-issue-markdown="21"]').count(), 0)
  const gitlabHost = 'forge.fixture.invalid'
  const gitlabRepo = 'fixture/mobile/notebook'
  const gitlabKey = 'gitlab:' + gitlabHost + '/' + gitlabRepo
  const gitlabUrl = 'https://' + gitlabHost + '/' + gitlabRepo + '/-/work_items/24'
  const gitlabTitle = 'Review offline drafts on GitLab'
  const mergeRequestUrl = 'https://' + gitlabHost + '/' + gitlabRepo + '/-/merge_requests/19'
  const gitlabPath = localProject('gitlab project', 'git@' + gitlabHost + ':' + gitlabRepo + '.git')
  const untrustedPath = localProject('untrusted gitlab project', 'https://' + gitlabHost + '/fixture/private/workspace.git')
  const unlistedPath = localProject('other forge project', 'https://other.fixture.invalid/fixture/other/workspace.git')
  const gitlabIssue = {
    iid: 24, web_url: gitlabUrl, title: gitlabTitle, state: 'opened', created_at: '2026-09-03T00:00:00Z', updated_at: '2026-11-27T14:00:00Z',
    description: 'Keep **GitLab draft attachments** after reconnect.', author: { username: 'fixture-reviewer' },
    assignees: [{ username: 'fixture-reviewer' }], labels: ['offline'], user_notes_count: 20,
  }
  const catalogMember = { username: 'mobile.review', name: 'Review Team' }
  const catalogLabel = { name: 'Mobile triage', color: '#cc7733', description: 'Inherited group label' }
  alterForge(current => {
    current.gitlab = {
      host: gitlabHost, repository: gitlabRepo, issue: gitlabIssue,
      otherIssues: [{
        ...gitlabIssue, iid: 25, web_url: gitlabUrl.replace(/24$/u, '25'), title: 'Completed background scheduling', state: 'closed',
        labels: [...gitlabIssue.labels, catalogLabel.name], assignees: [...gitlabIssue.assignees, catalogMember],
      }],
      labels: [catalogLabel, { name: 'needs triage' }, { name: null }],
      members: [catalogMember, { username: 'fixture-reviewer', name: 'Review Team' }, { username: 'unsafe username', name: 'Review Team' }],
      notes: Array.from({ length: 21 }, (_, index) => ({
        id: index + 1, author: gitlabIssue.author, created_at: new Date(now + index * 60_000).toISOString(),
        ...(index === 10 ? { system: true, body: 'changed the milestone' } : { body: 'GitLab note **' + (index + 1) + '**' }),
      })),
      relatedRequests: [{ web_url: mergeRequestUrl, title: 'Preserve GitLab draft' }, { web_url: 'https://external.invalid/-/merge_requests/1', title: 'Foreign merge request' }],
    }
  })
  for (const [id, path, trusted] of [
    ['register-gitlab-project', gitlabPath, true],
    ['register-untrusted-gitlab-project', untrustedPath, false],
    ['register-other-forge-project', unlistedPath, true],
  ] as const) {
    await host.engine.dispatch({ id, at: now, command: { type: 'workspace.register', path, trusted } })
  }
  const previousGitLabToken = process.env.GITLAB_TOKEN
  process.env.GITLAB_TOKEN = 'fixture-default-host-token'
  const mixed = base + '/issues?' + new URLSearchParams({ q: 'offline', state: 'all', profile: String(restored.get('profile')) })
  try {
    await page.goto(mixed)
    const issueRows = page.locator('[data-issue-row]')
    const gitlabRow = page.getByRole('link', { name: new RegExp(gitlabTitle) })
    await gitlabRow.waitFor()
    assert.match((await issueRows.first().textContent()) ?? '', /Review offline drafts on GitLab/)
    assert.equal(await issueRows.count(), 2)
    await page.getByLabel('Order').selectOption('created')
    await page.waitForURL(url => url.searchParams.get('sort') === 'created')
    assert.match((await issueRows.first().textContent()) ?? '', /Review offline drafts after reopening/)
    assert.match((await gitlabRow.textContent()) ?? '', /forge\.fixture\.invalid/)
    const gitlabSelection = new URL((await gitlabRow.getAttribute('href')) ?? '', base)
    assert.equal(gitlabSelection.searchParams.get('selected'), gitlabKey)
    assert.equal(gitlabSelection.searchParams.get('issue'), '24')
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      await capture('mixed-trackers-' + width + 'x' + height)
    }
    const gitlabFilter = new URL(mixed)
    gitlabFilter.searchParams.set('repository', gitlabKey)
    gitlabFilter.searchParams.set('label', 'offline')
    gitlabFilter.searchParams.set('involvement', 'authored')
    gitlabFilter.searchParams.set('assignee', '@me')
    await page.goto(gitlabFilter.href)
    await gitlabRow.waitFor()
    assert.equal(await issueRows.count(), 1)
    await filters.click()
    const options = await page.locator('select[name="repository"] option').allTextContents()
    assert.ok(options.some(option => option.includes(gitlabHost + '/' + gitlabRepo)))
    assert.ok(options.every(option => !option.includes('private/workspace') && !option.includes('other.fixture.invalid')))
    await page.keyboard.press('Escape')
    gitlabFilter.searchParams.delete('q')
    gitlabFilter.searchParams.set('state', 'closed')
    await page.goto(gitlabFilter.href)
    await page.getByRole('link', { name: /Completed background scheduling/ }).waitFor()
    assert.equal(await issueRows.count(), 1)

    const catalogScope = new URL(mixed)
    catalogScope.searchParams.set('label', 'offline')
    await page.goto(catalogScope.href)
    await filters.click()
    const peopleSearch = page.getByLabel('Assignee username', { exact: true })
    await peopleSearch.fill('Review Team')
    await peopleSearch.press('Enter')
    const choices = page.getByLabel('Issue assignee choices')
    await choices.getByRole('button', { name: /mobile.review/ }).waitFor()
    assert.equal(await choices.getByRole('button', { name: /fixture-reviewer/ }).count(), 1)
    assert.equal(await choices.getByRole('button', { name: /unsafe username/ }).count(), 0)
    const hitTest = (selector: string) => page.waitForFunction((target) => {
      const button = document.querySelector(target)
      const bounds = button?.getBoundingClientRect()
      return Boolean(bounds && button?.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)))
    }, selector)
    await hitTest('button[name="pickAssignee"][value="mobile.review"]')
    await capture('gitlab-assignee-search-360x800')
    await choices.getByRole('button', { name: /mobile.review/ }).click()
    await page.waitForURL(url => url.searchParams.get('pickAssignee') === 'mobile.review')
    assert.equal(await gitlabRow.count(), 0)
    await filters.click()
    assert.equal(await peopleSearch.inputValue(), 'mobile.review')
    await page.keyboard.press('Escape')
    const search = page.getByLabel('Search issues')
    await search.fill('scheduling')
    await search.press('Enter')
    await page.getByRole('link', { name: /Completed background scheduling/ }).waitFor()

    await page.goto(catalogScope.href)
    await filters.click()
    const labelSearch = page.getByRole('searchbox', { name: 'Find labels', exact: true })
    await labelSearch.fill('triage')
    await labelSearch.press('Enter')
    const inherited = page.getByRole('checkbox', { name: catalogLabel.name, exact: true })
    await hitTest('input[name="label"][value="Mobile triage"]')
    assert.equal(await page.getByRole('checkbox', { name: /^needs triage$/i }).count(), 1)
    assert.ok(await page.getByRole('checkbox', { name: 'offline', exact: true }).isChecked())
    await capture('gitlab-label-search-360x800')
    await inherited.check()
    await applyFilters.click()
    await page.waitForURL(url => url.searchParams.getAll('label').includes(catalogLabel.name))
    assert.equal(await gitlabRow.count(), 0)

    const catalogFailure = new URL(catalogScope)
    catalogFailure.searchParams.set('findLabels', '1')
    catalogFailure.searchParams.set('findLabel', 'triage')
    alterForge(current => { current.gitlab.catalogUnavailable = true })
    await page.goto(catalogFailure.href)
    await page.getByText('Some label results are unavailable.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('checkbox', { name: /^needs triage$/i }).count(), 1)
    assert.equal(await inherited.count(), 0)
    assert.equal(await gitlabRow.count(), 1)
    alterForge(current => { delete current.gitlab.catalogUnavailable })

    await page.goto(gitlabSelection.href)
    await page.getByRole('heading', { name: gitlabTitle }).waitFor()
    assert.equal(await page.getByRole('link', { name: 'View on GitLab' }).getAttribute('href'), gitlabUrl)
    await page.getByText('GitLab draft attachments', { exact: true }).waitFor()
    await page.getByText('changed the milestone', { exact: true }).waitFor()
    const request = page.getByRole('link', { name: 'Preserve GitLab draft', exact: true })
    assert.equal(await request.getAttribute('href'), mergeRequestUrl)
    assert.equal(await page.getByRole('link', { name: 'Foreign merge request' }).count(), 0)
    assert.equal(await page.getByRole('link', { name: 'View comment 21 on GitLab' }).getAttribute('href'), gitlabUrl + '#note_21')
    assert.equal(await page.getByRole('button', { name: 'Post comment', exact: true }).isDisabled(), true)
    await page.getByRole('link', { name: 'Older comments', exact: true }).click()
    await page.getByRole('link', { name: 'View comment 1 on GitLab' }).waitFor()
    assert.equal(await page.getByRole('link', { name: 'View comment 21 on GitLab' }).count(), 0)
    await page.getByRole('link', { name: 'Newer comments', exact: true }).click()
    const newestNote = page.getByRole('link', { name: 'View comment 21 on GitLab' })
    await newestNote.waitFor()
    await page.setViewportSize({ width: 360, height: 800 })
    await capture('gitlab-activity-360x800')
    await page.goto(gitlabSelection.href)
    const draftAction = page.getByRole('link', { name: 'Open as draft' })
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      const rect = await draftAction.boundingBox()
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height)
      await capture('gitlab-detail-' + width + 'x' + height)
    }
    alterForge(current => { current.gitlab.listUnavailable = true })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.reload()
    await page.getByText('GitLab access is unavailable. Check glab auth status for this host.', { exact: false }).waitFor()
    await page.getByRole('link', { name: /Review offline drafts after reopening/ }).first().waitFor()
    await page.getByRole('heading', { name: gitlabTitle }).waitFor()
    await capture('gitlab-partial-failure')
    alterForge(current => { delete current.gitlab.listUnavailable })
    const expectedLink = { tracker: 'gitlab' as const, host: gitlabHost, repository: gitlabRepo, number: 24 }
    await assert.rejects(host.engine.dispatch({ id: 'foreign-gitlab-issue', at: now, command: {
      type: 'session.create', workspaceId, driverKind: 'claude', issue: expectedLink,
    } }), /different repository/)
    await page.setViewportSize({ width: 360, height: 800 })
    const beforeDraft = host.engine.current.sessions.size
    await page.getByRole('link', { name: 'Open as draft' }).click()
    await page.getByRole('button', { name: 'Open project draft' }).click()
    await awaitPrompt(gitlabUrl)
    assert.equal(Number(new URL(page.url()).searchParams.get('workspace')), derivedId('register-gitlab-project'))
    assert.equal(host.engine.current.sessions.size, beforeDraft)
    await page.locator('[data-draft-issue]').getByRole('link', { name: gitlabRepo + '#24' }).waitFor()
    await capture('gitlab-project-draft')
    const threadWorkspace = derivedId('register-gitlab-project')
    const waitForThreadCatalog = async () => {
      const response = await page.waitForResponse((candidate) => {
        const url = new URL(candidate.url())
        return url.pathname === '/drivers' && url.searchParams.get('workspace') === String(threadWorkspace)
          && !url.searchParams.has('models') && candidate.ok()
      })
      assert.equal(await response.finished(), null)
    }
    // Host restarts exercise link replay. Let each mounted thread finish its
    // unrelated provider probe before cutting the connection or navigating.
    await Promise.all([waitForThreadCatalog(), page.getByRole('button', { name: 'Send', exact: true }).click()])
    await page.getByText('Fixture issue draft received.').waitFor()
    assert.equal(observedPrompts.at(-1), gitlabUrl)
    const session = [...host.engine.current.sessions.values()].find(item => item.workspaceId === threadWorkspace)
    assert.ok(session)
    assert.deepEqual(session.linkedIssues, [expectedLink])
    const port = host.server.port
    host.stop()
    host = await startHost(port)
    await Promise.all([waitForThreadCatalog(), page.reload()])
    const linked = page.locator('[data-thread-issues]').getByRole('link', { name: gitlabRepo + '#24' })
    await linked.waitFor()
    assert.deepEqual(host.engine.current.sessions.get(session.id)?.linkedIssues, [expectedLink])
    await linked.click()
    await page.getByRole('link', { name: 'View on GitLab' }).waitFor()
    await page.getByRole('heading', { name: 'Linked threads' }).waitFor()
    await page.locator('a[href="/s/' + session.id + '"]').waitFor()

    const editGitLabTitle = page.getByRole('link', { name: 'Edit title', exact: true })
    const editGitLabBody = page.getByRole('link', { name: 'Edit description', exact: true })
    const gitLabEditor = page.locator('[data-issue-text-editor]')
    assert.equal(await editGitLabTitle.count(), 0)
    const forcedEditor = new URL(page.url())
    forcedEditor.searchParams.set('editText', 'title')
    await page.goto(forcedEditor.href)
    assert.equal(await gitLabEditor.count(), 0)
    await page.getByText('GitLab could not open this editor.', { exact: true }).waitFor()

    alterForge(current => { current.gitlab.canEditText = true })
    await page.goto(gitlabSelection.href)
    await editGitLabTitle.click()
    const newTitle = 'Review GitLab drafts with attachments after reconnect'
    await gitLabEditor.getByRole('textbox', { name: 'Issue title', exact: true }).fill(newTitle)
    const saveGitLabText = gitLabEditor.getByRole('button', { name: 'Save', exact: true })
    const gitLabSubmission = () => gitLabEditor.evaluate((form: HTMLFormElement) => ({
      url: form.action, body: new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString(),
    }))
    const postGitLabForm = (request: { url: string, body: string }, origin = base) => fetch(request.url, {
      method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: request.body, redirect: 'manual',
    })
    const titleSubmission = await gitLabSubmission()
    assert.equal((await postGitLabForm(titleSubmission, 'https://outside.invalid')).status, 403)
    alterForge(current => { current.gitlab.viewer = 18 })
    assert.equal((await postGitLabForm(titleSubmission)).status, 409)
    alterForge(current => { delete current.gitlab.viewer; current.gitlab.archived = true })
    assert.equal((await postGitLabForm(titleSubmission)).status, 403)
    alterForge(current => { delete current.gitlab.archived; current.gitlab.refuseText = true })
    await saveGitLabText.click()
    await gitLabEditor.getByText('GitLab rejected the edit. Review your draft and try again.', { exact: true }).waitFor()
    assert.equal(await gitLabEditor.getByRole('textbox', { name: 'Issue title', exact: true }).inputValue(), newTitle)
    assert.equal(readForge().gitlab.textWrites, undefined)

    alterForge(current => { delete current.gitlab.refuseText; current.gitlab.issue.title = 'A change from another GitLab client' })
    await saveGitLabText.click()
    await gitLabEditor.getByText('Current on GitLab', { exact: true }).waitFor()
    await gitLabEditor.getByText('A change from another GitLab client', { exact: true }).waitFor()
    await gitLabEditor.getByRole('button', { name: 'Keep my draft' }).click()
    await saveGitLabText.click()
    await page.getByRole('heading', { name: newTitle }).waitFor()
    await page.getByText('Issue text saved on GitLab.', { exact: true }).waitFor()

    await editGitLabBody.click()
    const body = gitLabEditor.getByRole('textbox', { name: 'Description', exact: true })
    const gitLabDescription = '    indentation stays\n\n**Reviewed GitLab description**\n\n<script>fixture-private-text()</script>'
    await body.fill(gitLabDescription)
    await gitLabEditor.getByRole('button', { name: 'Preview', exact: true }).click()
    const gitLabPreview = gitLabEditor.getByLabel('Markdown preview')
    await gitLabPreview.getByText('Reviewed GitLab description', { exact: true }).waitFor()
    assert.equal(await gitLabPreview.getByText('fixture-private-text', { exact: false }).count(), 0)
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      await capture('gitlab-text-preview-' + width + 'x' + height)
    }
    await gitLabEditor.getByRole('button', { name: 'Write', exact: true }).click()
    assert.equal(await body.inputValue(), gitLabDescription)
    const originalWrite = await gitLabSubmission()
    alterForge(current => { current.gitlab.dropTextReply = true })
    await saveGitLabText.click()
    const recoverGitLabText = gitLabEditor.getByRole('button', { name: 'Check GitLab', exact: true })
    await recoverGitLabText.waitFor()
    const gitLabTextPort = host.server.port
    host.stop()
    host = await startHost(gitLabTextPort)
    await recoverGitLabText.click()
    await page.locator('[data-issue-markdown="description"]').getByText('Reviewed GitLab description', { exact: true }).waitFor()
    assert.equal((await postGitLabForm(originalWrite)).status, 303)
    assert.deepEqual(readForge().gitlab.textWrites, [['title', newTitle, 17], ['description', gitLabDescription, 17]])
    await editGitLabBody.click()
    await body.fill('')
    await saveGitLabText.click()
    await page.getByText('Issue text saved on GitLab.', { exact: true }).waitFor()
    assert.equal(readForge().gitlab.issue.description, '')
    assert.equal(readForge().gitlab.issue.title, newTitle)

    const gitLabComposer = page.getByRole('form', { name: 'Issue comment', exact: true })
    const commentInput = gitLabComposer.getByRole('textbox', { name: 'Add a comment', exact: true })
    const postComment = gitLabComposer.getByRole('button', { name: 'Post comment', exact: true })
    assert.equal(await postComment.isDisabled(), true)
    alterForge(current => { current.gitlab.canComment = true })
    await page.goto(gitlabSelection.href)
    const commentSubmission = () => gitLabComposer.evaluate((form: HTMLFormElement) => ({
      url: form.action, body: new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString(),
    }))
    const note = '    a preserved code line\n\n**First GitLab comment**'
    await commentInput.fill(note)
    const originalComment = await commentSubmission()
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      const button = await postComment.boundingBox()
      assert.ok(button && button.x >= 0 && button.x + button.width <= width && button.y + button.height <= height)
      await capture('gitlab-comment-' + width + 'x' + height)
    }
    assert.equal((await postGitLabForm(originalComment, 'https://outside.invalid')).status, 403)
    alterForge(current => { current.gitlab.viewer = 18 })
    assert.equal((await postGitLabForm(originalComment)).status, 409)
    alterForge(current => { delete current.gitlab.viewer; current.gitlab.locked = true })
    assert.equal((await postGitLabForm(originalComment)).status, 403)
    alterForge(current => { delete current.gitlab.locked; current.gitlab.refuseComment = true })
    await postComment.click()
    await gitLabComposer.getByText('GitLab rejected the comment. Review your draft and try again.').waitFor()
    assert.equal(await commentInput.inputValue(), note)
    assert.equal(readForge().gitlab.commentWrites, undefined)
    alterForge(current => { delete current.gitlab.refuseComment })
    await commentInput.press('Control+Enter')
    await page.getByText('Comment posted to GitLab.', { exact: true }).waitFor()
    const firstCommentId = readForge().gitlab.notes.at(-1).id
    assert.equal(new URL(page.url()).hash, '#issue-comment-' + firstCommentId)
    const firstComment = page.locator('#issue-comment-' + firstCommentId)
    await firstComment.getByText('First GitLab comment', { exact: true }).waitFor()
    await firstComment.getByText('a preserved code line', { exact: true }).waitFor()
    assert.ok(readForge().gitlab.notes.at(-1).body.endsWith(note))
    assert.doesNotMatch(await firstComment.innerText(), /harness:issue-comment/)

    const interruptedNote = '/subscribe\n\n**Recovered GitLab comment**'
    await commentInput.fill(interruptedNote)
    const interrupted = await commentSubmission()
    alterForge(current => { current.gitlab.dropCommentReply = true })
    await postComment.click()
    const checkGitLab = gitLabComposer.getByRole('button', { name: 'Check GitLab', exact: true })
    await checkGitLab.waitFor()
    assert.equal(await commentInput.inputValue(), interruptedNote)
    assert.equal(await commentInput.getAttribute('readonly'), '')
    await gitLabComposer.scrollIntoViewIfNeeded()
    await capture('gitlab-comment-recovery-360x800')
    const gitLabCommentPort = host.server.port
    host.stop()
    host = await startHost(gitLabCommentPort)
    await checkGitLab.click()
    const recoveredId = readForge().gitlab.notes.at(-1).id
    await page.locator('#issue-comment-' + recoveredId).getByText('Recovered GitLab comment', { exact: true }).waitFor()
    assert.equal(new URL(page.url()).hash, '#issue-comment-' + recoveredId)
    assert.equal((await postGitLabForm(interrupted)).status, 303)
    assert.equal(readForge().gitlab.commentWrites, 2)

    const gitLabStatusControl = (state: 'Open' | 'Closed') => page.getByRole('link', { name: 'Change issue status, ' + state, exact: true })
    const gitLabStatus = page.locator('#issue-status')
    const statusForm = gitLabStatus.locator('form')
    const statusSubmission = () => statusForm.evaluate((form: HTMLFormElement) => ({
      url: form.action, body: new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString(),
    }))
    const openStatusEditor = async () => {
      await gitLabStatusControl('Open').click()
      assert.equal(await gitLabStatus.getByRole('radio').count(), 1)
      await gitLabStatus.getByRole('radio', { name: 'Closed', exact: true }).check()
    }
    await openStatusEditor()
    const statusPost = await statusSubmission()
    assert.equal((await postGitLabForm(statusPost, 'https://outside.invalid')).status, 403)
    alterForge(current => { current.gitlab.viewer = 18 })
    assert.equal((await postGitLabForm(statusPost)).status, 409)
    alterForge(current => { delete current.gitlab.viewer; current.gitlab.archived = true })
    assert.equal((await postGitLabForm(statusPost)).status, 403)
    alterForge(current => { delete current.gitlab.archived; current.gitlab.issue.state = 'closed' })
    assert.equal((await postGitLabForm(statusPost)).status, 409)
    alterForge(current => { current.gitlab.issue.state = 'opened'; current.gitlab.refuseStatus = true })
    const saveStatus = gitLabStatus.getByRole('button', { name: 'Save status', exact: true })
    await saveStatus.click()
    await gitLabStatus.getByText('GitLab refused a reviewed change.', { exact: false }).waitFor()
    assert.equal(readForge().gitlab.statusWrites, undefined)
    alterForge(current => { delete current.gitlab.refuseStatus })
    await openStatusEditor()
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      await capture('gitlab-status-' + width + 'x' + height)
    }
    const closePost = await statusSubmission()
    alterForge(current => { current.gitlab.dropStatusReply = true })
    await saveStatus.click()
    const checkStatus = gitLabStatus.getByRole('button', { name: 'Check GitLab', exact: true })
    await checkStatus.waitFor()
    await capture('gitlab-status-recovery-360x800')
    const gitLabStatusPort = host.server.port
    host.stop()
    host = await startHost(gitLabStatusPort)
    await checkStatus.click()
    await gitLabStatusControl('Closed').waitFor()
    assert.equal((await postGitLabForm(closePost)).status, 303)
    assert.deepEqual(readForge().gitlab.statusWrites, [['closed', 17]])
    alterForge(current => { current.gitlab.denyReopen = true })
    await page.reload()
    assert.equal(await gitLabStatusControl('Closed').count(), 0)
    alterForge(current => { delete current.gitlab.denyReopen })
    await page.reload()
    await gitLabStatusControl('Closed').click()
    await gitLabStatus.getByRole('radio', { name: 'Open', exact: true }).check()
    await saveStatus.click()
    await gitLabStatusControl('Open').waitFor()
    await gitLabStatus.getByText('Issue status updated on GitLab.', { exact: true }).waitFor()
    assert.deepEqual(readForge().gitlab.statusWrites, [['closed', 17], ['opened', 17]])

    const gitLabMetadata = page.locator('#issue-metadata')
    const editor = gitLabMetadata.locator('form[data-issue-metadata-editor]')
    const changeLabels = gitLabMetadata.getByRole('link', { name: 'Change labels', exact: true })
    const changeAssignees = gitLabMetadata.getByRole('link', { name: 'Change assignees', exact: true })
    const metadataForm = () => editor.evaluate((form: HTMLFormElement) => ({
      url: form.action, body: new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString(),
    }))
    const searchTriage = editor.getByRole('button', { name: 'Search GitLab', exact: true })
    const checkTriage = editor.getByRole('button', { name: 'Check GitLab', exact: true })
    assert.equal(await changeLabels.count(), 0)
    assert.equal(await changeAssignees.count(), 0)
    alterForge(current => {
      current.gitlab.canTriage = true
      current.gitlab.labels.push({ name: 'Retired offline', archived: true })
    })
    await page.reload()
    await changeLabels.click()
    const labelChoice = (name: string | RegExp) => editor.getByRole('checkbox', { name })
    const offline = labelChoice('offline')
    const mobileTriage = labelChoice(/^Mobile triage/)
    await mobileTriage.check()
    assert.equal(await labelChoice('Retired offline').count(), 0)
    await offline.uncheck()
    const labelQuery = editor.getByRole('searchbox', { name: 'Search labels', exact: true })
    await labelQuery.fill('needs triage')
    await searchTriage.click()
    await labelChoice('needs triage').waitFor()
    assert.ok(await mobileTriage.isChecked())
    assert.ok(!(await offline.isChecked()))
    await capture('gitlab-edit-labels-360x800')
    const labelPost = await metadataForm()
    assert.equal((await postGitLabForm(labelPost, 'https://outside.invalid')).status, 403)
    alterForge(current => { current.gitlab.viewer = 18 })
    assert.equal((await postGitLabForm(labelPost)).status, 409)
    alterForge(current => { delete current.gitlab.viewer; current.gitlab.canTriage = false })
    assert.equal((await postGitLabForm(labelPost)).status, 403)
    alterForge(current => { current.gitlab.canTriage = true; current.gitlab.issue.labels.push('Unrelated label') })
    assert.equal((await postGitLabForm(labelPost)).status, 409)
    alterForge(current => { current.gitlab.issue.labels.pop(); current.gitlab.dropTriageReply = true })
    await editor.getByRole('button', { name: 'Save labels', exact: true }).click()
    await checkTriage.waitFor()
    await capture('gitlab-edit-labels-recovery-360x800')
    const gitLabTriagePort = host.server.port
    host.stop()
    host = await startHost(gitLabTriagePort)
    await checkTriage.click()
    await gitLabMetadata.getByText('Issue updated on GitLab.', { exact: true }).waitFor()
    assert.deepEqual(readForge().gitlab.issue.labels, ['Mobile triage'])
    assert.equal((await postGitLabForm(labelPost)).status, 303)
    assert.equal(readForge().gitlab.triageWrites.length, 1)

    alterForge(current => { current.gitlab.multipleAssignees = false })
    await changeAssignees.click()
    const mobileAssignee = labelChoice(/^mobile.review/)
    const fixtureReviewer = labelChoice(/^fixture-reviewer/)
    await mobileAssignee.check()
    const assigneeQuery = editor.getByRole('searchbox', { name: 'Search assignees', exact: true })
    await assigneeQuery.fill('fixture')
    await searchTriage.click()
    assert.ok(await fixtureReviewer.isChecked())
    assert.ok(await mobileAssignee.isChecked())
    const saveAssignees = editor.getByRole('button', { name: 'Save assignees', exact: true })
    await saveAssignees.click()
    await gitLabMetadata.getByText('This project has no confirmed support for multiple assignees. Select one assignee.', { exact: true }).waitFor()
    assert.equal(readForge().gitlab.triageWrites.length, 1)
    await fixtureReviewer.uncheck()
    await capture('gitlab-edit-assignees-360x800')
    await saveAssignees.click()
    await gitLabMetadata.getByText('Issue updated on GitLab.', { exact: true }).waitFor()
    assert.deepEqual(readForge().gitlab.issue.assignees.map((person: { username: string }) => person.username), ['mobile.review'])
    alterForge(current => { current.gitlab.multipleAssignees = true })
    await changeAssignees.click()
    await fixtureReviewer.check()
    await saveAssignees.click()
    await gitLabMetadata.getByText('Issue updated on GitLab.', { exact: true }).waitFor()
    assert.deepEqual(readForge().gitlab.issue.assignees.map((person: { username: string }) => person.username).sort(), ['fixture-reviewer', 'mobile.review'])
    assert.equal(readForge().gitlab.triageWrites.length, 3)
    const [chip, control] = await Promise.all([
      gitLabMetadata.locator('[data-issue-label]').boundingBox(),
      changeLabels.boundingBox(),
    ])
    assert.ok(chip && control && chip.height < control.height && control.height >= 44, 'the label stays compact beside the phone touch target')
    await capture('gitlab-edit-saved-360x800')

    alterForge(current => {
      current.gitlab.awardPageSize = 1
      current.gitlab.awards = { issue: [{ name: 'thumbsup', user: { id: 99 } }, { name: 'thumbsup', user: { id: 98 } }] }
    })
    await page.reload()
    const issueAwards = page.getByRole('form', { name: 'Issue reactions', exact: true })
    const addGitLabThumb = issueAwards.getByRole('button', { name: 'Add Thumbs up reaction, 2', exact: true })
    await addGitLabThumb.waitFor()
    const gitLabThumb = await readReactionRequest(issueAwards, 'add:THUMBS_UP')
    const sendAward = (request: typeof gitLabThumb, origin = new URL(request.url).origin) => fetch(request.url, {
      method: 'POST', body: request.body, redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    })
    assert.equal((await sendAward(gitLabThumb, 'https://outside.invalid')).status, 403)
    alterForge(current => { current.gitlab.viewer = 18 })
    assert.equal((await sendAward(gitLabThumb)).status, 409)
    alterForge(current => { delete current.gitlab.viewer; current.gitlab.locked = true })
    assert.equal((await sendAward(gitLabThumb)).status, 403)
    alterForge(current => { delete current.gitlab.locked })
    await addGitLabThumb.click()
    const removeGitLabThumb = issueAwards.getByRole('button', { name: 'Remove Thumbs up reaction, 3', exact: true })
    await removeGitLabThumb.waitFor()
    assert.equal(await removeGitLabThumb.getAttribute('aria-pressed'), 'true')
    await removeGitLabThumb.click()
    await addGitLabThumb.waitFor()
    assert.equal((await sendAward(gitLabThumb)).status, 303)
    assert.deepEqual(readForge().gitlab.awards.issue, [{ name: 'thumbsup', user: { id: 99 } }, { name: 'thumbsup', user: { id: 98 } }])

    const latestNote = readForge().gitlab.notes.at(-1).id
    const noteAwards = page.getByRole('form', { name: 'Comment ' + latestNote + ' reactions', exact: true })
    const notePicker = noteAwards.getByText('Add reaction', { exact: true })
    const gitLabHeart = noteAwards.getByRole('button', { name: 'Add Heart reaction', exact: true })
    await notePicker.click()
    await gitLabHeart.press('Escape')
    await gitLabHeart.waitFor({ state: 'hidden' })
    assert.equal(await notePicker.evaluate(node => node === node.ownerDocument.activeElement), true)
    await notePicker.click()
    const heartWrite = await readReactionRequest(noteAwards, 'add:HEART')
    for (const badId of [901, 11]) {
      const body = new URLSearchParams(heartWrite.body)
      body.set('subject', 'gid://gitlab/Note/' + badId)
      assert.equal((await sendAward({ ...heartWrite, body: body.toString() })).status, 409)
    }
    alterForge(current => { current.gitlab.notes.at(-1).reactionAllowed = false })
    assert.equal((await sendAward(heartWrite)).status, 403)
    alterForge(current => { delete current.gitlab.notes.at(-1).reactionAllowed; current.gitlab.dropReactionReply = true })
    for (const [width, height] of viewports) {
      await page.setViewportSize({ width, height })
      await gitLabHeart.scrollIntoViewIfNeeded()
      assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
      await capture('gitlab-note-reaction-' + width + 'x' + height)
    }
    await gitLabHeart.click()
    const confirmAward = page.getByRole('form', { name: 'Check GitLab reaction', exact: true })
    const checkAward = confirmAward.getByRole('button', { name: 'Check GitLab', exact: true })
    await checkAward.waitFor()
    await checkAward.scrollIntoViewIfNeeded()
    await capture('gitlab-reaction-recovery-360x800')
    const gitLabReactionPort = host.server.port
    host.stop()
    host = await startHost(gitLabReactionPort)
    await checkAward.click()
    const removeGitLabHeart = noteAwards.getByRole('button', { name: 'Remove Heart reaction, 1', exact: true })
    await removeGitLabHeart.waitFor()
    assert.equal(new URL(page.url()).hash, '#issue-comment-' + latestNote)
    assert.equal((await sendAward(heartWrite)).status, 303)
    const removedHeart = page.waitForResponse(response => new URL(response.url()).pathname === '/issues/reactions' && response.request().method() === 'POST')
    await removeGitLabHeart.click()
    assert.equal((await removedHeart).status(), 303)
    await notePicker.waitFor()
    await removeGitLabHeart.waitFor({ state: 'hidden' })
    assert.deepEqual(readForge().gitlab.reactionWrites, [
      ['issue', 'thumbsup', true, 17], ['issue', 'thumbsup', false, 17],
      [latestNote, 'heart', true, 17], [latestNote, 'heart', false, 17],
    ])
  }
  finally {
    if (previousGitLabToken === undefined) delete process.env.GITLAB_TOKEN
    else process.env.GITLAB_TOKEN = previousGitLabToken
  }
  fixtureForgejoCli(cli.bin)
  const forgejoBase = 'https://forgejo.fixture.invalid/workbench'
  const forgejoRepository = 'fixture/notes'
  const forgejoKey = 'forgejo:forgejo.fixture.invalid/workbench/' + forgejoRepository
  const forgejoUrl = forgejoBase + '/' + forgejoRepository + '/issues/73'
  const forgejoTitle = 'Verify offline drafts on Forgejo after reconnect'
  const forgejoPath = localProject('forgejo project', 'git@issue-ssh.fixture.invalid:' + forgejoRepository + '.git')
  const forgejoIssue = {
    id: 300, is_locked: false, ...row(forgejoRepository, 73, forgejoTitle, '2026-11-02T00:00:00Z', '2026-11-27T16:00:00Z'),
    html_url: forgejoUrl, body: 'Keep **Forgejo drafts** available for @fixture-user.', user: { id: 17, login: 'fixture-user' },
    assignees: [{ login: 'fixture-user', full_name: 'Fixture review team' }], labels: [{ id: 7, name: 'offline', color: '#5577aa' }], comments: 1,
  }
  const otherForgejoIssue = { ...forgejoIssue, id: 301, number: 74, html_url: forgejoUrl.replace(/73$/u, '74'),
    title: 'Newer Forgejo issue', created_at: '2026-11-27T13:00:00Z', updated_at: '2026-11-27T13:00:00Z', labels: [] }
  alterForge(current => {
    current.forgejo = {
      base: forgejoBase, repository: forgejoRepository, viewer: 'fixture-user', selected: 'fixture-default',
      logins: [
        { name: 'secondary', url: forgejoBase, ssh_host: 'issue-ssh.fixture.invalid', user: 'secondary', default: 'false' },
        { name: 'fixture-default', url: forgejoBase + '/', ssh_host: 'issue-ssh.fixture.invalid', user: 'fixture-user', default: 'true' },
        { name: 'unrelated', url: 'https://foreign.fixture.invalid', user: 'unrelated', default: 'false' },
      ],
      issues: [forgejoIssue, otherForgejoIssue, { ...forgejoIssue, number: 76, html_url: forgejoUrl.replace(/73$/u, '76'),
        title: 'A Forgejo pull request', pull_request: { merged: false } },
        { ...forgejoIssue, number: 77, html_url: forgejoUrl.replace('forgejo.fixture.invalid', 'foreign.fixture.invalid').replace(/73$/u, '77'),
          title: 'An issue on the wrong forge' }],
      labels: [{ id: 9, name: 'Forgejo triage', color: '#5577aa', description: 'Review stale issue drafts' }],
      assignees: forgejoIssue.assignees,
      comments: [{ id: 702, body: 'Review the **saved draft**.', user: { login: 'fixture-user' }, created_at: '2026-11-27T15:00:00Z' }],
    }
  })
  await host.engine.dispatch({ id: 'register-forgejo-project', at: now, command: { type: 'workspace.register', path: forgejoPath, trusted: true } })
  const forge = (query: Record<string, string> = {}) => base + '/issues?' + new URLSearchParams({ profile: restored.get('profile') ?? '1', ...query })
  const forgejoRow = page.getByRole('link', { name: new RegExp(forgejoTitle) })
  await page.goto(forge({ q: 'offline' }))
  await forgejoRow.waitFor()
  assert.match(await page.locator('[data-issue-row]').first().innerText(), /Forgejo after reconnect/)
  await page.goto(forge({ repository: forgejoKey }))
  assert.equal(await page.locator('[data-issue-row]').count(), 2)
  assert.match(await page.locator('[data-issue-row]').first().innerText(), /Forgejo after reconnect/)
  await page.getByLabel('Order').selectOption('created')
  await page.waitForURL(url => url.searchParams.get('sort') === 'created')
  assert.match(await page.locator('[data-issue-row]').first().innerText(), /Newer Forgejo issue/)
  await page.goto(forge({ repository: forgejoKey, label: 'offline', involvement: 'mentioned', assignee: '@me' }))
  await forgejoRow.waitFor()
  assert.equal(await page.locator('[data-issue-row]').count(), 1)
  await forgejoRow.click()
  await page.getByRole('heading', { name: forgejoTitle, exact: true }).waitFor()
  const openForgejo = page.getByRole('link', { name: 'View on Forgejo', exact: true })
  assert.equal(await openForgejo.getAttribute('href'), forgejoUrl)
  await page.getByText('saved draft', { exact: true }).waitFor()
  const capturedHostLink = page.getByRole('link', { name: 'Open as draft', exact: true })
  const forgejoDraft = new URL((await capturedHostLink.getAttribute('href')) ?? '', base)
  assert.equal(forgejoDraft.searchParams.get('repo'), forgejoKey)
  assert.equal(forgejoDraft.searchParams.get('issue'), forgejoUrl)
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
    await capture('forgejo-detail-' + width + 'x' + height)
  }
  const beforeForgejoDraft = host.engine.current.sessions.size
  await capturedHostLink.click()
  await page.waitForURL(url => url.pathname === '/new')
  await page.getByRole('button', { name: 'Open project draft', exact: true }).click()
  await page.locator('[data-draft-issue]').getByRole('link', { name: 'workbench/' + forgejoRepository + '#73', exact: true }).waitFor()
  assert.equal(Number(new URL(page.url()).searchParams.get('workspace')), derivedId('register-forgejo-project'))
  assert.equal(host.engine.current.sessions.size, beforeForgejoDraft)
  await capture('forgejo-project-draft-360x800')
  alterForge(current => {
    current.forgejo.issues.push(...Array.from({ length: 22 }, (_, index) => ({
      ...otherForgejoIssue, number: 80 + index, title: 'Pagination sample ' + index,
      html_url: forgejoUrl.replace(/73$/u, String(80 + index)), body: '',
      updated_at: new Date(now - index * 60_000).toISOString(),
    })))
  })
  const forgejoRows = page.locator('[data-issue-row]')
  await page.goto(forge({ repository: forgejoKey, q: 'Pagination sample' }))
  assert.equal(await forgejoRows.count(), 20)
  await page.getByRole('link', { name: 'Next page', exact: true }).click()
  await page.waitForURL(url => url.searchParams.get('page') === '2')
  assert.equal(await forgejoRows.count(), 2)
  await page.goto(forge({ repository: forgejoKey, findLabels: '1', findLabel: 'stale issue' }))
  await page.getByText('Forgejo triage', { exact: true }).waitFor()
  const mixedForgejoUrl = forge({ q: 'offline', state: 'all' })
  const retainedIssue = forgejoRows.filter({ hasText: readForge().issues['fixture/notebook'][0].title })
  alterForge(current => { current.forgejo.unavailable = true })
  await page.goto(mixedForgejoUrl)
  await retainedIssue.waitFor()
  await page.getByText('Forgejo could not load this resource. Check the configured CLI login.', { exact: false }).first().waitFor()
  assert.equal(await forgejoRow.count(), 0)
  alterForge(current => {
    current.forgejo.unavailable = false
    current.forgejo.logins[0].default = 'true'
  })
  await page.goto(mixedForgejoUrl)
  await retainedIssue.waitFor()
  assert.equal(await forgejoRow.count(), 0)
  alterForge(current => { current.forgejo.logins[0].default = 'false' })
  await page.goto(forge({ selected: forgejoKey, issue: '73', repository: forgejoKey }))
  const forgejoComposer = page.getByRole('form', { name: 'Issue comment', exact: true })
  const forgejoComment = forgejoComposer.getByRole('textbox', { name: 'Add a comment', exact: true })
  const postForgejo = forgejoComposer.getByRole('button', { name: 'Post comment', exact: true })
  const readForgejoForm = () => forgejoComposer.evaluate((form: HTMLFormElement) => ({
    url: form.action, body: new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)])).toString(),
  }))
  const sendForgejo = (submission: { url: string, body: string }, origin = base) => fetch(submission.url, {
    method: 'POST', body: submission.body, redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
  })
  const firstForgejoText = '    a preserved code line\n\n**First Forgejo comment**'
  await forgejoComment.fill(firstForgejoText)
  const firstForgejo = await readForgejoForm()
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
    const button = await postForgejo.boundingBox()
    assert.ok(button && button.x + button.width <= width && button.y + button.height <= height)
    await capture('forgejo-comment-' + width + 'x' + height)
  }
  assert.equal((await sendForgejo(firstForgejo, 'https://outside.invalid')).status, 403)
  const otherIssueForm = new URL(firstForgejo.url)
  otherIssueForm.searchParams.set('issue', '74')
  assert.equal((await sendForgejo({ ...firstForgejo, url: otherIssueForm.href })).status, 409)
  alterForge(current => { current.forgejo.viewerId = 18 })
  assert.equal((await sendForgejo(firstForgejo)).status, 409)
  alterForge(current => { delete current.forgejo.viewerId; current.forgejo.archived = true })
  assert.equal((await sendForgejo(firstForgejo)).status, 403)
  alterForge(current => { current.forgejo.archived = false; current.forgejo.issues[0].is_locked = true })
  assert.equal((await sendForgejo(firstForgejo)).status, 403)
  await page.reload()
  await forgejoComposer.getByText('This Forgejo issue is locked.', { exact: true }).waitFor()
  assert.equal(await postForgejo.isDisabled(), true)
  alterForge(current => { current.forgejo.push = true; current.forgejo.refuseComment = true })
  await page.reload()
  await forgejoComment.fill(firstForgejoText)
  await postForgejo.click()
  await forgejoComposer.getByText('Forgejo rejected the comment. Review your draft and try again.', { exact: true }).waitFor()
  assert.equal(await forgejoComment.inputValue(), firstForgejoText)
  assert.equal(readForge().forgejo.commentWrites, undefined)
  alterForge(current => { delete current.forgejo.refuseComment })
  await forgejoComment.press('Control+Enter')
  await page.getByText('Comment posted to Forgejo.', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).hash, '#issue-comment-703')
  const firstForgejoNote = page.locator('#issue-comment-703')
  await firstForgejoNote.getByText('First Forgejo comment', { exact: true }).waitFor()
  await firstForgejoNote.getByText('a preserved code line', { exact: true }).waitFor()

  await forgejoComment.fill('**Recovered Forgejo comment**')
  const lostForgejo = await readForgejoForm()
  alterForge(current => { current.forgejo.dropCommentReply = true })
  await postForgejo.click()
  const checkForgejo = forgejoComposer.getByRole('button', { name: 'Check Forgejo', exact: true })
  await checkForgejo.waitFor()
  assert.equal(await forgejoComment.inputValue(), '**Recovered Forgejo comment**')
  await capture('forgejo-comment-recovery-360x800')
  alterForge(current => {
    const saved = current.forgejo.comments.at(-1)
    current.forgejo.comments.unshift({ ...saved, id: 800, user: { ...saved.user, id: 180 } },
      { ...saved, id: 801, issue_url: saved.issue_url.replace(/73$/u, '74') })
    current.forgejo.comments.push(...Array.from({ length: 22 }, (_, index) => ({ ...saved, id: 820 + index, body: 'Follow-up ' + index })))
    current.forgejo.issues[0].comments = current.forgejo.comments.length
  })
  const recoveryPort = host.server.port
  host.stop()
  host = await startHost(recoveryPort)
  await checkForgejo.click()
  await page.locator('#issue-comment-704').getByText('Recovered Forgejo comment', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).hash, '#issue-comment-704')
  assert.equal(await forgejoComment.inputValue(), '')
  assert.equal((await sendForgejo(lostForgejo)).status, 303)
  assert.deepEqual(readForge().forgejo.commentWrites, [[73, 17, 703], [73, 17, 704]])
  const forgejoDetail = forge({ selected: forgejoKey, issue: '73', repository: forgejoKey, state: 'all' })
  const forgejoStatus = page.locator('#issue-status')
  const statusControlForForgejo = (state: 'Open' | 'Closed') => page.locator('[data-issue-status-menu] summary').and(page.getByLabel('Change issue status, ' + state, { exact: true }))
  const forgejoStatusForm = page.getByRole('form', { name: 'New issue status', exact: true })
  const readForgejoStatus = (choice: string) => forgejoStatusForm.evaluate((form: HTMLFormElement, choice: string) => {
    const values = new URLSearchParams(Array.from(new FormData(form), ([key, value]) => [key, String(value)]))
    values.set('choice', choice)
    return { url: form.action, body: values.toString() }
  }, choice)
  const closeForgejoIssue = forgejoStatusForm.getByRole('button', { name: 'Closed', exact: true })
  const openForgejoIssue = forgejoStatusForm.getByRole('button', { name: 'Open', exact: true })
  alterForge(current => { current.forgejo.push = false; current.forgejo.viewerId = 18 })
  await page.goto(forgejoDetail)
  assert.equal(await statusControlForForgejo('Open').count(), 0)
  alterForge(current => { delete current.forgejo.viewerId })
  await page.reload()
  await statusControlForForgejo('Open').press('ArrowDown')
  assert.ok(await closeForgejoIssue.evaluate(node => node === node.ownerDocument.activeElement))
  await closeForgejoIssue.press('Escape')
  await closeForgejoIssue.waitFor({ state: 'hidden' })
  assert.ok(await statusControlForForgejo('Open').evaluate(node => node === node.ownerDocument.activeElement))
  await statusControlForForgejo('Open').click()
  const forgejoClose = await readForgejoStatus('closed')
  assert.equal((await sendForgejo(forgejoClose, 'https://outside.invalid')).status, 403)
  alterForge(current => { current.forgejo.viewerId = 18 })
  assert.equal((await sendForgejo(forgejoClose)).status, 409)
  alterForge(current => { delete current.forgejo.viewerId; current.forgejo.archived = true })
  assert.equal((await sendForgejo(forgejoClose)).status, 403)
  alterForge(current => { current.forgejo.archived = false; current.forgejo.issues[0].state = 'closed' })
  assert.equal((await sendForgejo(forgejoClose)).status, 409)
  alterForge(current => { current.forgejo.issues[0].state = 'open'; current.forgejo.refuseStatus = true })
  await closeForgejoIssue.click()
  await forgejoStatus.getByText('Forgejo refused a reviewed change.', { exact: false }).waitFor()
  assert.equal(readForge().forgejo.statusWrites, undefined)
  alterForge(current => { delete current.forgejo.refuseStatus })
  await statusControlForForgejo('Open').click()
  const interruptedForgejoClose = await readForgejoStatus('closed')
  for (const [width, height] of viewports) {
    await page.setViewportSize({ width, height })
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]), [width, width])
    const menu = await closeForgejoIssue.boundingBox()
    assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= width && menu.y + menu.height <= height)
    const draft = await page.getByRole('link', { name: 'Open as draft', exact: true }).boundingBox()
    assert.ok(draft && menu.y + menu.height <= draft.y)
    await capture('forgejo-status-' + width + 'x' + height)
  }
  alterForge(current => { current.forgejo.dropStatusReply = true })
  await closeForgejoIssue.click()
  const checkForgejoStatus = forgejoStatus.getByRole('button', { name: 'Check Forgejo', exact: true })
  await checkForgejoStatus.waitFor()
  await capture('forgejo-status-recovery-360x800')
  const forgejoStatusPort = host.server.port
  host.stop()
  host = await startHost(forgejoStatusPort)
  await checkForgejoStatus.click()
  await statusControlForForgejo('Closed').waitFor()
  assert.equal((await sendForgejo(interruptedForgejoClose)).status, 303)
  assert.deepEqual(readForge().forgejo.statusWrites, [[73, 17, 'closed']])
  alterForge(current => {
    current.forgejo.viewerId = 18
    current.forgejo.push = true
  })
  await page.reload()
  await statusControlForForgejo('Closed').click()
  await openForgejoIssue.click()
  await statusControlForForgejo('Open').waitFor()
  assert.deepEqual(readForge().forgejo.statusWrites, [[73, 17, 'closed'], [73, 18, 'open']])
  assert.deepEqual(errors, [])
  console.log('PASS', label, 'six sizes, filters, saved views, project visibility, draft and send, permission-gated metadata, status, comments, text, activity, reactions, recovery, mixed trackers, catalog lookup, and GitLab draft, text, comments, status, triage and reactions, and Forgejo browsing, draft links, comments and status recovery')
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
