import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Database } from 'bun:sqlite'
import { derivedId } from '../packages/engine/src/index'
import { serve } from '../packages/server/src/server'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'
import { chromium, webkit } from 'playwright-core'

const directory = mkdtempSync(join(tmpdir(), 'harness-workflow-drive-'))
const destination = process.env.HARNESS_SCREENSHOT_DIR
const browserType = process.env.HARNESS_BROWSER === 'webkit' ? webkit : chromium
const appearance = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const fixtureClock = Date.parse('2026-11-28T12:00:00Z')
const originalNow = Date.now
let fixtureTime = fixtureClock
Date.now = () => fixtureTime
const captures: { name: string, width: number, height: number }[] = []
const dimensions = [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]] as const
const repository = 'fixture/workflow'
const title = 'Review recovery for changes in the production draft handoff workflow'
const databasePath = join(directory, 'fixture.sqlite')
const project = join(directory, 'workbench')
const gate = join(directory, 'allow-review')
const definition = join(directory, 'review.ts')
const profile = String(derivedId('workflow-ui-profile'))
mkdirSync(project)
for (const args of [['init', '-qb', 'main'], ['remote', 'add', 'origin', 'https://github.com/' + repository]]) {
  const command = Bun.spawnSync(['git', ...args], { cwd: project })
  assert.ok(command.success, command.stderr.toString())
}
const cli = fixtureGitHubCli(directory, { [repository]: { bare: join(project, '.git') } })
const fixture = JSON.parse(readFileSync(cli.state, 'utf8'))
fixture.issueCreate = { push: true, writes: [] }
writeFileSync(cli.state, JSON.stringify(fixture))
const PATH = process.env.PATH
process.env.PATH = [cli.bin, PATH].join(delimiter)
writeFileSync(definition, `
  import { existsSync } from 'node:fs'
  const review = { name: 'review-changes', version: 1, async run(input, { title, step }) {
    title(input.title)
    const issue = await step('File issue', ({ issues }) => issues.create({ project: 'workbench', title: 'Review fixture draft', body: 'Recheck **draft** recovery.' }))
    await step('Review fixture', async () => {
      if (!existsSync(${JSON.stringify(gate)})) throw new Error('Waiting for a reviewer')
      await Bun.sleep(3500)
      return { verified: true }
    })
    return { issue: issue.url, reviewed: true }
  }}
  const delayed = { name: 'wait-for-review', version: 1, async run(input, { title, step }) {
    title(input.title)
    return step('Wait for review', async ({ signal }) => {
      while (!signal.aborted) await Bun.sleep(20)
      signal.throwIfAborted()
    })
  }}
  const scheduled = {
    name: 'check-drafts', version: 1,
    schedules: [
      { id: 'draft-check', profile: ${profile}, everyMs: 60000 },
      { id: 'weekday-check', profile: ${profile}, timeOfDay: '09:30', weekdays: [1, 2, 3, 4, 5], enabled: false },
    ],
    async run(tick, { title, step }) {
      title('Check draft integrity')
      return step('Inspect draft', () => tick)
    },
  }
  const webhook = {
    name: 'receive-draft', version: 1, webhooks: [{ name: 'draft-intake', profile: ${profile} }],
    async run(request, { title, step }) {
      title('Inspect draft delivery')
      return step('Record arrival', () => ({ accepted: request.method === 'POST' }))
    },
  }
  const tracker = {
    name: 'triage-drafts', version: 1, trackerTriggers: [
      { id: 'draft-issues', profile: ${profile}, project: 'workbench', kind: 'issue', labels: ['draft-fixture'] },
    ],
    async run(issue, { title, step }) {
      title('Triage the new draft issue')
      return step('Record source', () => ({ source: issue.displayKey, state: issue.state }))
    },
  }
  const question = {
    name: 'draft-decision', version: 1,
    async run(input, { title, step, ask }) {
      title('Approve the draft update')
      await step('Prepare draft', () => ({ ready: true }))
      const answer = await ask('draft-review', {
        title: 'Apply the prepared draft changes?',
        choices: ['Apply changes', 'Keep draft'],
        data: 'The draft and review notes are ready. Choose whether to apply the update.',
        timeoutMs: 3_600_000,
      })
      return step('Record decision', () => answer)
    },
  }
  export default [review, delayed, scheduled, webhook, tracker, question]
`)
{
  using db = new Database(databasePath)
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
  db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
  db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
}
const host = await serve({ port: 0, workflowDirectory: definition, databasePath, resolveDriver: () => null })
const base = 'http://127.0.0.1:' + host.server.port
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try {
  const dispatch = (id: string, command: Parameters<typeof host.engine.dispatch>[0]['command']) => host.engine.dispatch({ id, at: 1, command })
  await dispatch('workflow-ui-profile', { type: 'profile.create', name: 'Fixture workspace' })
  await dispatch('workflow-ui-other', { type: 'profile.create', name: 'Other workspace' })
  await dispatch('workflow-ui-project', { type: 'workspace.add', profileId: Number(profile), path: project })
  await dispatch('workflow-ui-trust', { type: 'workspace.trust', workspaceId: derivedId('workflow-ui-project'), trusted: true })
  const query = (extra: Record<string, string> = {}) => new URLSearchParams({ profile, ...extra })
  const start = (workflow: string, key: string, name: string) => fetch(base + '/workflows/start?' + query(), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflow, key, payload: { title: name } }),
  }).then(async response => {
    assert.equal(response.status, 202)
    return (await response.json()).run.runId as string
  })
  const paused = await start('review-changes', 'review-a', title)
  fixtureTime += 1000
  const running = await start('wait-for-review', 'review-b', 'Await input from a reviewer')
  const wait = async (id: string, status: string) => {
    const deadline = performance.now() + 12_000
    while (performance.now() < deadline) {
      const result = await fetch(base + '/workflows/run?' + query({ id })).then(response => response.json())
      if (result.run.status === status && result.steps.length) return result
      await Bun.sleep(60)
    }
    throw new Error('Run did not reach ' + status)
  }
  await wait(paused, 'paused')
  await wait(running, 'running')

  browser = await browserType.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: appearance, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20_000)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const capture = async (name: string) => {
    if (!destination) return
    mkdirSync(destination, { recursive: true })
    const size = page.viewportSize()
    assert.ok(size)
    const filename = 'workflows-' + browserType.name() + '-' + appearance + '-' + name + '-' + size.width + 'x' + size.height + '.png'
    await page.screenshot({ path: join(destination, filename), animations: 'disabled', caret: 'hide' })
    captures.push({ name: filename, ...size })
  }
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), page.viewportSize()?.width)

  await page.goto(base + '/?' + query())
  await page.getByRole('link', { name: 'Workflows', exact: true }).click()
  await page.getByRole('heading', { name: title, exact: true }).waitFor()
  await page.getByRole('link', { name: 'Issue #101', exact: true }).waitFor()
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    if (width < 720) {
      assert.ok((await page.getByLabel('Profile', { exact: true }).boundingBox())!.height >= 44)
      assert.ok((await page.getByRole('link', { name: 'Workspace', exact: true }).boundingBox())!.width >= 44)
      await capture('phone-list')
      await page.locator('[data-workflow-row]').filter({ hasText: title }).click()
      await page.getByRole('heading', { name: title, exact: true }).waitFor()
    }
    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    const box = await resume.boundingBox()
    assert.ok(box && box.x >= 0 && box.x + box.width <= width)
    await capture('paused')
    if (width < 720) await page.getByRole('link', { name: 'Back to runs', exact: true }).click()
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  const issue = page.getByRole('link', { name: 'Issue #101', exact: true })
  const issueAddress = new URL((await issue.getAttribute('href')) ?? '', base)
  assert.equal(issueAddress.pathname, '/issues')
  assert.equal(issueAddress.searchParams.get('selected'), repository)
  await page.getByRole('button', { name: 'Resume', exact: true }).waitFor()
  writeFileSync(gate, '')
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Run resumed.' }).waitFor()
  const originalUrl = page.url()
  const completedStep = page.locator('[data-workflow-step-card]').filter({ hasText: 'File issue' })
  await completedStep.locator('summary').click()
  await page.getByLabel('Saved step result').filter({ hasText: '"key": "101"' }).waitFor()
  await page.locator('[data-workflow-run-meta]').getByText('Completed', { exact: true }).waitFor()
  assert.equal(page.url(), originalUrl)
  assert.equal(await completedStep.evaluate(element => element.hasAttribute('open')), true)
  assert.equal(await completedStep.getByRole('link', { name: 'Issue #101', exact: true }).getAttribute('href'), issueAddress.pathname + issueAddress.search)
  await capture('completed')

  await page.getByRole('link', { name: /^Running/ }).click()
  await page.getByRole('heading', { name: 'Await input from a reviewer', exact: true }).waitFor()
  const opener = page.getByRole('button', { name: 'Cancel run', exact: true })
  const dialog = page.getByRole('dialog', { name: 'Cancel this run?' })
  await opener.click()
  await dialog.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Keep running')
  await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement?.closest('dialog')?.open), true)
  await capture('cancel')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await opener.evaluate(element => element.ownerDocument.activeElement === element), true)
  await opener.click()
  await dialog.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await page.locator('[data-workflow-run-meta]').getByText('Cancelled', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Definitions', exact: true }).click()
  await page.getByRole('heading', { name: 'Definitions', exact: true }).waitFor()
  await page.getByText('review-changes', { exact: true }).waitFor()
  const schedules = page.getByRole('list', { name: 'Schedules' })
  await schedules.getByText('Every 1 minute', { exact: true }).waitFor()
  await schedules.getByText(/Mon, Tue, Wed, Thu, Fri at 09:30/u).waitFor()
  await schedules.getByText('Disabled', { exact: true }).waitFor()
  assert.equal(await schedules.locator('time').getAttribute('datetime'), '2026-11-28T12:01:00.000Z')
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    await capture('definitions')
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('link', { name: 'Start run', exact: true }).click()
  await page.getByLabel('Workflow', { exact: true }).selectOption('review-changes')
  await page.getByLabel('Start key').fill('review-a')
  await page.getByLabel('Input (JSON)').fill('{bad')
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'Enter valid JSON' }).waitFor()
  assert.equal(await page.getByLabel('Start key').inputValue(), 'review-a')
  assert.equal(await page.getByLabel('Input (JSON)').inputValue(), '{bad')
  await capture('invalid-input')
  await page.getByLabel('Input (JSON)').fill('{}')
  await page.getByRole('button', { name: 'Start run', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'already has a run' }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('run'), paused)
  await page.getByRole('link', { name: 'Issue #101', exact: true }).click()
  await page.getByRole('heading', { name: 'Review fixture draft', exact: true }).waitFor()
  await page.goBack()
  await page.getByLabel('Profile', { exact: true }).selectOption({ label: 'Other workspace' })
  await page.getByText('Nothing is running.', { exact: true }).waitFor()
  await page.getByRole('link', { name: /^All/ }).click()
  await page.getByText('No runs yet.', { exact: true }).waitFor()
  await capture('empty-profile')
  await page.getByRole('link', { name: 'Definitions', exact: true }).click()
  assert.equal(await page.getByRole('list', { name: 'Schedules' }).count(), 0)
  const state = JSON.parse(readFileSync(cli.state, 'utf8'))
  const source = {
    number: 202, state: 'closed', title: 'Draft queue update',
    html_url: 'https://github.com/' + repository + '/issues/202', body: 'Send this issue to triage.',
    created_at: '2026-11-28T12:00:30.000Z', updated_at: '2026-11-28T12:00:50.000Z',
    user: { login: 'fixture-user' }, labels: [{ name: 'draft-fixture', color: '3377bb' }],
  }
  state.issues[repository].push(source)
  writeFileSync(cli.state, JSON.stringify(state))
  fixtureTime = fixtureClock + 65_000
  const deadline = performance.now() + 8000
  let scheduledId
  while (!scheduledId && performance.now() < deadline) {
    const data = await fetch(base + '/workflows?' + query()).then(response => response.json())
    scheduledId = data.runs.find(run => run.schedule?.id === 'draft-check' && run.status === 'completed')?.runId
    if (!scheduledId) await Bun.sleep(100)
  }
  assert.ok(scheduledId, 'Scheduled workflow completed')
  await page.goto(base + '/workflows?' + query({ view: 'workspace', run: scheduledId }))
  await page.getByRole('heading', { name: 'Check draft integrity', exact: true }).waitFor()
  await page.locator('[data-workflow-scheduled]').getByText('draft-check', { exact: true }).waitFor()
  assert.equal(await page.locator('[data-workflow-scheduled] time').getAttribute('datetime'), '2026-11-28T12:01:00.000Z')
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    if (width === 1440 || width === 390) await capture('scheduled')
  }

  fixtureTime += 1000
  const { hooks } = await fetch(base + '/workflows/hooks?' + query()).then(response => response.json())
  assert.equal(hooks.length, 1)
  const delivery = await fetch(new URL(hooks[0].path, base), { method: 'POST', headers: { 'x-github-delivery': 'draft-fixture' } })
  assert.equal(delivery.status, 202)
  const { runId: webhookRun } = await delivery.json()
  await wait(webhookRun, 'completed')
  await page.goto(base + '/workflows?' + query({ view: 'workspace', run: webhookRun }))
  await page.getByRole('heading', { name: 'Inspect draft delivery', exact: true }).waitFor()
  await page.locator('[data-workflow-webhook]').getByText('draft-intake', { exact: true }).waitFor()
  assert.ok(!(await page.content()).includes(hooks[0].path))
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    await capture('webhook')
  }

  const trackerExpiry = performance.now() + 8000
  let trackerRun
  while (!trackerRun && performance.now() < trackerExpiry) {
    const data = await fetch(base + '/workflows?' + query()).then(response => response.json())
    trackerRun = data.runs.find(run => run.tracker?.id === 'draft-issues' && run.status === 'completed')?.runId
    if (!trackerRun) await Bun.sleep(100)
  }
  assert.ok(trackerRun, 'Issue trigger completed')
  await page.goto(base + '/workflows?' + query({ view: 'workspace', run: trackerRun }))
  await page.getByRole('heading', { name: 'Triage the new draft issue', exact: true }).waitFor()
  const sourceLink = page.getByRole('link', { name: 'Issue #202', exact: true })
  await sourceLink.waitFor()
  await page.locator('[data-workflow-tracker-source]').getByText('Draft queue update', { exact: true }).waitFor()
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    await capture('tracker')
  }
  await sourceLink.click()
  await page.getByRole('heading', { name: 'Draft queue update', exact: true }).waitFor()
  await page.goto(base + '/workflows?' + query({ view: 'workspace', page: 'definitions' }))
  const trackerList = page.getByRole('list', { name: 'Tracker triggers' })
  await trackerList.getByText('Watching', { exact: true }).waitFor()
  await trackerList.getByText('New issue', { exact: true }).waitFor()
  await noOverflow()
  await capture('tracker-definitions')

  fixtureTime += 1000
  const questionRun = await start('draft-decision', 'draft-answer', 'Review prompt')
  await wait(questionRun, 'waiting')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base + '/workflows?' + query({ view: 'workspace', run: questionRun }))
  const question = page.getByRole('form', { name: 'Apply the prepared draft changes?' })
  await question.getByRole('heading', { name: 'Apply the prepared draft changes?' }).waitFor()
  const approve = question.getByRole('button', { name: 'Apply changes', exact: true })
  await question.getByRole('button', { name: 'Keep draft', exact: true }).waitFor()
  await page.getByRole('link', { name: /^Needs you\s*1$/ }).waitFor({ state: 'attached' })
  assert.equal(await question.locator('time').getAttribute('datetime'), '2026-11-28T13:01:07.000Z')
  for (const [width, height] of dimensions) {
    await page.setViewportSize({ width, height })
    await noOverflow()
    if (width < 720) assert.ok((await approve.boundingBox())!.height >= 44)
    await capture('question')
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await question.getByText('Add a reason', { exact: true }).click()
  const reason = question.getByRole('textbox', { name: 'Reason', exact: true })
  await reason.fill('The draft matches the review notes.')
  const extra = await start('check-drafts', 'check-reason-draft', 'Verify existing data')
  await wait(extra, 'completed')
  await page.getByRole('link', { name: 'Refresh runs', exact: true }).click()
  assert.equal(await reason.inputValue(), 'The draft matches the review notes.')
  await capture('question-reason')
  await approve.press('Enter')
  await page.getByRole('status').filter({ hasText: 'Answer recorded.' }).waitFor()
  await page.locator('[data-workflow-run-meta]').getByText('Completed', { exact: true }).waitFor()
  await page.getByLabel('Workflow result').filter({ hasText: 'The draft matches the review notes.' }).waitFor()
  assert.equal(new URL(page.url()).searchParams.get('run'), questionRun)
  assert.equal(await question.count(), 0)
  await capture('question-answered')

  const writes = JSON.parse(readFileSync(cli.state, 'utf8')).issueCreate.writes
  assert.equal(writes.length, 1)
  assert.deepEqual(errors, [])
  if (destination) {
    const manifest = {
      revision: Bun.spawnSync(['git', 'rev-parse', 'HEAD']).stdout.toString().trim(),
      platform: process.platform, osRelease: release(), browser: browserType.name(), browserVersion: browser.version(),
      appearance, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, fixtureClock: new Date(fixtureClock).toISOString(),
      captures, passed: true,
    }
    writeFileSync(join(destination, 'workflows-' + browserType.name() + '-' + appearance + '.json'), JSON.stringify(manifest, null, 2))
  }
  console.log('Workflow drive passed for ' + browserType.name() + ' ' + appearance)
}
finally {
  await browser?.close()
  host.stop()
  process.env.PATH = PATH
  Date.now = originalNow
  rmSync(directory, { recursive: true, force: true })
}
