/**
 * Full-page browser drive: composer, approval round-trip, diff panel and
 * terminal — the safety net for the island conversion. A fake driver (the
 * runtime tests' recorded-transcript shape) stands in for a real agent so the
 * turn is deterministic and the approval genuinely blocks until clicked.
 *
 * Run from the repo root with the bunfig bypassed — the root preload breaks
 * importing serve() outside the buddy runtime, and views resolve from cwd:
 *
 *   bun --config=/dev/null scripts/drive-page.ts
 *
 * Needs a Chromium: playwright-core is a dev dependency and the executable
 * defaults to playwright's cached build; point PLAYWRIGHT_CHROMIUM elsewhere
 * if yours lives somewhere else.
 */
import type { Driver, ProviderEvent, ProviderInstance } from '../packages/drivers/src/types'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chromium, webkit } from 'playwright-core'
import { decode, encode } from '../packages/contract/src/index'
import { serve } from '../packages/server/src/index'

const checks: Array<[string, boolean]> = []
function check(name: string, ok: boolean): void {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

// Use a stable shell with no user startup files. The provider command exercises
// terminal input without starting an actual sign-in on the developer's machine.
const fixtureBin = mkdtempSync(join(tmpdir(), 'harness-page-bin-'))
const fixtureShell = join(fixtureBin, 'harness-test-shell')
writeFileSync(join(fixtureBin, 'codex'), '#!/bin/sh\nprintf "Codex test sign-in\\n"\n', { mode: 0o755 })
writeFileSync(fixtureShell, '#!/bin/sh\nprintf "Harness test terminal\\n"\nexec /bin/sh -i\n', { mode: 0o755 })
process.env.SHELL = fixtureShell
process.env.ENV = ''
process.env.PATH = `${fixtureBin}:${process.env.PATH ?? ''}`

// --- workspace: a real repo with an uncommitted change, so the diff has content
const driveRoot = mkdtempSync(join(tmpdir(), 'harness-page-drive-'))
const dir = join(driveRoot, 'notes-app')
const secondProject = join(driveRoot, 'docs-site')
const scratchDirectory = join(driveRoot, 'scratch')
mkdirSync(dir)
mkdirSync(secondProject)
writeFileSync(join(dir, 'notes.txt'), 'original\n')
execSync('git init -q && git add notes.txt && git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: dir })

// --- db schema
const { Database } = await import('bun:sqlite')
const databasePath = join(driveRoot, 'h.sqlite')
const db = new Database(databasePath)
db.exec('PRAGMA foreign_keys = ON')
db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
db.exec('CREATE TABLE provider_instances (id INTEGER PRIMARY KEY, profile_id INTEGER, driver_kind TEXT, binary_path TEXT, resolved_home TEXT, config TEXT)')
db.close()

// --- fake driver: delta → approval (blocks) → tool call → delta → complete
let releaseGate: () => void
const gate = new Promise<void>((r) => { releaseGate = r })
const markdownGate = Promise.withResolvers<void>()
const parallelApprovalGate = Promise.withResolvers<void>()
const parallelDecisions = new Map<string, boolean>()
const questionGate = Promise.withResolvers<void>()
const questionAnswers = new Map<string, unknown>()
const markdownControlsGate = Promise.withResolvers<void>()
const connectorGate = Promise.withResolvers<void>()
const connectorWithdrawal = Promise.withResolvers<void>()
const followUpGate = Promise.withResolvers<void>()
const followUpDelivery: string[] = []
let releaseSteering: (() => void) | undefined
const steeringCalls: string[] = []
let connectorScope: string | undefined
const script: ProviderEvent[] = [
  { type: 'session-bound', providerSessionId: 'ps-drive' },
  { type: 'assistant-delta', text: 'Thinking… ' },
  { type: 'approval-request', requestId: 'apr_1', toolName: 'Bash', args: { command: 'ls' } },
  { type: 'tool-call-begin', callId: 'c1', toolName: 'Bash', args: {} },
  { type: 'tool-call-end', callId: 'c1', ok: true },
  { type: 'assistant-delta', text: 'done.' },
  { type: 'turn-complete', tokensIn: 5, tokensOut: 3, costMicros: 0 },
]
const instance: ProviderInstance = {
  async *startTurn(input) {
    if (input.text === 'exercise active steering') {
      const { promise, resolve } = Promise.withResolvers<void>()
      releaseSteering = resolve
      yield { type: 'steering-ready' }
      yield { type: 'assistant-delta', text: 'Ready for active steering.' }
      await promise
      releaseSteering = undefined
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text === 'exercise follow-up queue') {
      yield { type: 'assistant-delta', text: 'Waiting for queued messages.' }
      await followUpGate.promise
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text.startsWith('Follow-up fixture:')) {
      followUpDelivery.push(input.text)
      yield { type: 'assistant-delta', text: 'Received the queued message.' }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text === 'exercise connector consent') {
      const connector = {
        prompt: 'Allow this fixture connector to read the calendar?',
        choices: [
          { decision: 'cancelled', scope: 'once', label: 'Cancel' },
          { decision: 'denied', scope: 'once', label: 'Decline' },
          { decision: 'allowed', scope: 'session', label: 'Allow this session' },
          { decision: 'allowed', scope: 'once', label: 'Approve' },
        ],
      } as const
      yield { type: 'approval-request', requestId: 'fixture_connector', toolName: 'Fixture Calendar', args: null, connector: {
        ...connector, choices: [...connector.choices],
      } }
      await connectorGate.promise
      yield { type: 'approval-request', requestId: 'fixture_withdrawal', toolName: 'Fixture Calendar', args: null, connector: {
        prompt: 'This fixture request will be withdrawn.', choices: [...connector.choices],
      } }
      await connectorWithdrawal.promise
      yield { type: 'approval-cancelled', requestId: 'fixture_withdrawal' }
      yield { type: 'assistant-delta', text: 'Connector consent fixture complete.' }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text === 'exercise streaming markdown') {
      yield { type: 'assistant-delta', text: '## Build result\n\n**Completed checks**\n\n' }
      yield { type: 'assistant-delta', text: `${Array.from({ length: 60 }, (_, i) => `Checked component ${i + 1}`).join('\n\n')}\n\nEncoded comparison: \`&lt;\`` }
      await markdownGate.promise
      yield { type: 'assistant-delta', text: '\n\n<em data-fixture="literal">literal markup</em> {{ 1 + 1 }}\n\n```ts\nconst result = ' }
      yield { type: 'assistant-delta', text: '42\nconst format = "{{ value }}"\n```\n' }
      yield { type: 'turn-complete', tokensIn: 3, tokensOut: 4, costMicros: 0 }
      return
    }
    if (input.text === 'exercise transcript controls') {
      yield { type: 'assistant-delta', text: '| Check | Result |\n| --- | --- |\n| Type check | Passed |\n| Formatting | Passed |\n\n' }
      yield { type: 'assistant-delta', text: '\x60\x60\x60ts\nconst line = "' + 'sample-'.repeat(80) + '"\n' }
      await markdownControlsGate.promise
      yield { type: 'assistant-delta', text: 'const next = 1\n\x60\x60\x60\n\n\x60\x60\x60fixture-unknown-language\n<em>Plain fixture</em>\n\x60\x60\x60\n\nChecks recorded.' }
      yield { type: 'turn-complete', tokensIn: 2, tokensOut: 3, costMicros: 0 }
      return
    }
    if (input.text === 'exercise parallel approvals') {
      yield { type: 'approval-request', requestId: 'parallel_read', toolName: 'Read', args: {} }
      yield { type: 'approval-request', requestId: 'parallel_write', toolName: 'Write', args: {} }
      await parallelApprovalGate.promise
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text === 'exercise structured questions') {
      yield { type: 'input-request', requestId: 'fixture_schemas', questions: [
        { id: 'schema', header: 'Fixture', question: 'Should this fixture prefer strict schemas or UI flexibility?', kind: 'choice', allowOther: true, options: [
          { value: 'strict', label: 'Strict schemas (Recommended)' },
          { value: 'flexible', label: 'UI flexibility' },
        ] },
        { id: 'private-note', question: 'Enter the private fixture code.', kind: 'text', sensitive: true, options: [] },
      ] }
      await questionGate.promise
      yield { type: 'assistant-delta', text: 'Question fixture complete.' }
      yield { type: 'turn-complete', tokensIn: 2, tokensOut: 2, costMicros: 0 }
      return
    }
    for (const event of script) {
      if (event.type === 'approval-request' && input.text !== 'run the drive turn') continue
      // A beat before the first token, so the thinking indicator has a
      // deterministic window to be seen in.
      if (event.type === 'assistant-delta') await new Promise(r => setTimeout(r, 300))
      yield event
      if (event.type === 'approval-request') await gate
    }
  },
  async steer(text) {
    steeringCalls.push(text)
    return text === 'Unconfirmed steering fixture.' ? 'uncertain' : 'delivered'
  },
  async interrupt() {
    followUpGate.resolve()
    releaseSteering?.()
  },
  async respondApproval(id, allow, _reason, choice) {
    if (id === 'fixture_connector') {
      connectorScope = allow ? choice?.scope : undefined
      connectorGate.resolve()
      return
    }
    if (id === 'parallel_read' || id === 'parallel_write') {
      parallelDecisions.set(id, allow)
      if (parallelDecisions.size === 2) parallelApprovalGate.resolve()
    }
    else if (allow) releaseGate()
  },
  async respondInput(id, answers) {
    questionAnswers.set(id, answers)
    questionGate.resolve()
  },
  async stop() {},
}
const driver: Driver = {
  kind: 'claude',
  async probe() { return { status: 'ready' } },
  async create(config) {
    if (config.workspacePath.startsWith(`${scratchDirectory}/`)) writeFileSync(join(config.workspacePath, 'kept.txt'), 'scratch fixture')
    return instance
  },
}
let fixtureCodexReady = false
let fixtureCodexLaunchModel: string | undefined
let fixtureCodexLaunchOptions: { effort?: string, serviceTier?: string } | undefined
const codexDriver: Driver = {
  ...driver,
  kind: 'codex',
  async probe(config, { includeModels } = {}) {
    const homeModel = config.home?.endsWith('/model-fixture-home')
    if (!homeModel && !fixtureCodexReady) return { status: 'unauthenticated' }
    const id = homeModel ? 'fixture-fast' : 'fixture-default'
    return {
      status: 'ready',
      ...(includeModels ? { models: [{
        id, name: homeModel ? 'Fixture Fast' : 'Fixture Default', isDefault: true,
        reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: 'medium',
        speedTiers: [{ id: 'fast', name: 'Fast' }],
      }] } : {}),
    }
  },
  async create(config) {
    fixtureCodexLaunchModel = config.model
    fixtureCodexLaunchOptions = config.codexTurnOptions
    return driver.create(config)
  },
}

const port = Number(process.env.HARNESS_DRIVE_PORT ?? 3973)
const harness = await serve({
  port, databasePath, scratchDirectory, chatGptCredentialDirectory: join(driveRoot, 'credentials'),
  resolveDriver: kind => kind === 'codex' ? codexDriver : driver,
})
const baseUrl = `http://localhost:${port}`
// Compile the fixture's template before starting the browser's network drive.
// The performance drive measures cold rendering separately.
const warmup = await harness.server.fetch(new Request(baseUrl))
if (!warmup.ok) throw new Error(`Could not render the browser fixture: HTTP ${warmup.status}`)
await warmup.body?.cancel()
const screenshotDir = process.env.HARNESS_SCREENSHOT_DIR
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true })

const browserName = process.env.HARNESS_BROWSER === 'webkit' ? 'webkit' : 'chromium'
const colorScheme = process.env.HARNESS_COLOR_SCHEME === 'dark' ? 'dark' : 'light'
const reducedMotion = process.env.HARNESS_REDUCED_MOTION === 'reduce' ? 'reduce' : 'no-preference'
const browser = browserName === 'webkit'
  ? await webkit.launch()
  : await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM, headless: true })
const browserContext = await browser.newContext({ colorScheme, reducedMotion })
const page = await browserContext.newPage()
const captures: Array<{ name: string, width: number, height: number }> = []

async function capture(name: string): Promise<void> {
  if (!screenshotDir) return
  const viewport = page.viewportSize()
  if (!viewport) throw new Error('The screenshot drive requires an explicit viewport.')
  await page.screenshot({ path: join(screenshotDir, `${name}.png`), animations: 'disabled' })
  captures.push({ name, ...viewport })
}

const pageErrors: string[] = []
page.on('pageerror', e => pageErrors.push(e.message))

// The first visit has no profiles or workspaces. The flow works in a plain
// browser even when the native directory picker is unavailable.
await page.goto(baseUrl)
await page.setViewportSize({ width: 1280, height: 800 })
await capture('onboarding-desktop')
await page.locator('[data-start-without-project]').click()
await page.waitForURL('**/?project=none')
await page.locator('[data-composer]').waitFor({ state: 'visible', timeout: 4000 })
check('a blank database offers a projectless draft before touching disk', harness.engine.current.profiles.size === 0 && !existsSync(scratchDirectory))
await capture('projectless-draft-desktop')
await page.goto(baseUrl)
await page.locator('[data-first-project]').click()
await page.locator('[data-project-dialog]').waitFor({ state: 'visible' })
check('folder input receives focus and browser hides native browse', await page.locator('[data-project-path]').evaluate(el => el === document.activeElement)
  && !(await page.locator('[data-project-browse]').isVisible()))
await page.keyboard.press('Escape')
await page.locator('[data-project-dialog]').waitFor({ state: 'hidden' })
check('cancelling the first folder picker keeps the empty profile state', harness.engine.current.profiles.size === 0
  && await page.locator('[data-first-project]').evaluate(el => el === document.activeElement))
await page.locator('[data-first-project]').click()
await page.locator('[data-project-path]').fill('notes-app')
await page.locator('[data-project-submit]').click()
await page.locator('[data-project-error]').waitFor({ state: 'visible' })
check('server rejection stays in the picker without creating a profile', (await page.locator('[data-project-error]').textContent())?.includes('absolute') === true
  && harness.engine.current.profiles.size === 0)
await capture('onboarding-path-error')
await page.locator('[data-project-path]').fill(dir)
await page.locator('[data-project-submit]').click()
await page.waitForURL(/\?workspace=/)
const workspaceId = [...harness.engine.current.workspaces.keys()][0]!
const providerProfileId = harness.engine.current.workspaces.get(workspaceId)!.profileId
const settingsDb = new Database(databasePath)
const saveProvider = settingsDb.query('INSERT INTO provider_instances (id, profile_id, driver_kind, config) VALUES (?, ?, ?, ?)')
saveProvider.run(1, providerProfileId, 'claude', '{"name":"Work"}')
saveProvider.run(2, providerProfileId, 'claude', '{"name":"Personal"}')
saveProvider.run(3, providerProfileId, 'codex', '{"name":"Design Review","chatGptClientId":"oaiapp_browser_fixture"}')
settingsDb.close()
check('adds the folder and opens its untrusted workspace', harness.engine.current.workspaces.get(workspaceId)?.trusted === false
  && !(await page.locator('[data-composer]').isVisible()))
await page.locator('[data-project-trust]').click()
await page.locator('[data-composer]').waitFor({ state: 'visible' })
check('explicit trust enables composing in the selected project', harness.engine.current.workspaces.get(workspaceId)?.trusted === true)

// --- seed over the socket
const ws = new WebSocket(`ws://localhost:${port}/ws`)
ws.binaryType = 'arraybuffer'
await new Promise(r => (ws.onopen = r))
const cmd = (id: string, command: unknown) => ws.send(encode({ t: 'dispatch', envelope: { id, at: Date.now(), command } }))
cmd('d_s', { type: 'session.create', workspaceId, driverKind: 'claude' })
await Bun.sleep(300)
const sessionId = [...harness.engine.current.sessions.keys()][0]

// Verify the real Craft bridge contract through a deterministic test double.
await page.addInitScript((folder) => {
  ;(window as any).craft = {
    menu: { set: (options: unknown) => { (window as any).__menuSet = options } },
    window: { setAppearance: async (mode: string) => { (window as any).__windowAppearance = mode } },
    dialog: {
      showOpenDialog: async (options: { properties: string[] }) => {
        if (!options.properties.includes('openDirectory')) throw new Error('Expected the Craft directory picker')
        return { canceled: false, filePaths: [folder] }
      },
    },
  }
}, secondProject)
page.on('dialog', async d => d.accept())
await page.goto(`${baseUrl}/s/${sessionId}`)
await page.setViewportSize({ width: 390, height: 844 })
const workspaceActions = page.locator('[data-workspace-actions-toggle]')
check('mobile keeps the thread title visible and hides contextual actions', await page.locator('[data-workspace-title]').isVisible()
  && !(await page.locator('[data-diff-toggle]').isVisible()))
await workspaceActions.click()
check('mobile workspace actions expose Changes and Terminal', await page.locator('[data-diff-toggle]').isVisible()
  && await page.locator('[data-terminal-toggle]').isVisible())
await capture('workspace-actions-mobile')
await page.keyboard.press('Escape')
check('Escape closes workspace actions and restores focus', await workspaceActions.getAttribute('aria-expanded') === 'false'
  && await workspaceActions.evaluate(el => el === document.activeElement))
await page.locator('[data-sidebar-toggle]').click()
await page.waitForFunction(() => document.querySelector('[data-harness-sidebar]')?.getAttribute('data-open') === 'true')
check('the open phone navigation drawer makes workspace controls inert',
  await page.locator('[data-workspace-layout]').getAttribute('inert') !== null)
await page.keyboard.press('Escape')
await page.locator('[data-harness-sidebar]').waitFor({ state: 'hidden' })
await page.waitForFunction(() => !document.querySelector('[data-workspace-layout]')?.hasAttribute('inert')
  && document.activeElement?.matches('[data-sidebar-toggle]'), undefined, { timeout: 5000 })
check('mobile closes navigation and returns focus to its toggle', true)
check('mobile composer controls fit the viewport', await page.locator('[data-send]').evaluate((el) => {
  const rect = el.getBoundingClientRect()
  return rect.left >= 0 && rect.right <= window.innerWidth
}))
await page.setViewportSize({ width: 1280, height: 800 })
const sidebarResize = page.locator('[data-sidebar-resize]')
await sidebarResize.press('ArrowRight')
await page.waitForFunction(() => document.querySelector('[data-sidebar-resize]')?.getAttribute('aria-valuenow') === '262')
check('keyboard resizing expands desktop navigation', (await page.locator('[data-harness-sidebar]').boundingBox())?.width === 262)
const resizeHandle = await sidebarResize.boundingBox()
if (!resizeHandle) throw new Error('Expected a visible desktop sidebar resize handle.')
const resizeX = resizeHandle.x + resizeHandle.width / 2
const resizeY = resizeHandle.y + resizeHandle.height / 2
await page.mouse.move(resizeX, resizeY)
await page.mouse.down()
await page.mouse.move(resizeX + 32, resizeY, { steps: 4 })
await page.mouse.up()
await page.waitForFunction(() => document.querySelector('[data-sidebar-resize]')?.getAttribute('aria-valuenow') === '294')
await page.reload()
await page.waitForFunction(() => document.querySelector('[data-sidebar-resize]')?.getAttribute('aria-valuenow') === '294')
check('desktop navigation restores its dragged width after reload', (await page.locator('[data-harness-sidebar]').boundingBox())?.width === 294)
const desktopNav = page.locator('[data-harness-sidebar]')
await desktopNav.locator('[data-sidebar-close]').click()
await desktopNav.waitFor({ state: 'hidden' })
await page.reload()
await page.locator('[data-harness-shell][data-sidebar-collapsed="true"]').waitFor()
await page.locator('[data-sidebar-toggle]').click()
await desktopNav.waitFor()
check('desktop navigation collapse survives reload and reopens at the saved width',
  (await desktopNav.boundingBox())?.width === 294)
const desktopChanges = page.locator('[data-diff-toggle]')
await desktopChanges.waitFor()
await workspaceActions.click()
await desktopChanges.waitFor({ state: 'hidden' })
await page.reload()
await page.locator('[data-workspace-layout][data-details-open="false"]').waitFor()
await workspaceActions.click()
await desktopChanges.waitFor()
check('workspace detail visibility survives reload and can be restored', await desktopChanges.isVisible())
const workspaceViewports = [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  check(`workspace header and composer fit at ${width}×${height}`, await page.evaluate(() => {
    const elements = ['[data-workspace-header]', '[data-composer]', '[data-send]']
    return document.documentElement.scrollWidth === innerWidth
      && elements.every((selector) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect()
        return Boolean(bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1)
      })
  }))
  await capture(`workspace-layout-${width}x${height}`)
}
await page.setViewportSize({ width: 1280, height: 800 })



// 1. Composer: type a prompt, send, watch the turn stream in — with the
// thinking dots holding the gap before the first token.
await page.fill('[data-prompt]', 'run the drive turn')
await page.click('[data-send]')
await page.waitForFunction(() => {
  const dots = document.querySelector('[data-turn][data-live], [data-turn]:not([data-live])') && document.querySelector('[data-thinking]')
  return dots !== null && !(dots as HTMLElement).hasAttribute('hidden')
}, undefined, { timeout: 4000 })
check('thinking dots show before the first token', true)
await page.waitForFunction(() => document.querySelector('[data-approval]')?.hasAttribute('hidden') === false, undefined, { timeout: 8000 })
const dotsHiddenAfterDelta = await page.evaluate(() => document.querySelector('[data-thinking]')?.hasAttribute('hidden'))
check('first token hides the dots', dotsHiddenAfterDelta === true)
check('composer starts a turn and the approval surfaces', true)
const tool = await page.textContent('[data-approval-tool]')
check('approval names the tool', (tool ?? '').includes('Bash'))

// 2. Approve: the gated turn resumes, streams, and completes.
await page.click('[data-approve]')
// The turn's article is client-rendered by the `:for` binding, so the check
// reads the turn row rather than a marker attribute the old DOM builder set.
await page.waitForFunction(() => (document.querySelector('[data-turn] [data-response]')?.textContent ?? '').includes('done.'), undefined, { timeout: 8000 })
check('approved turn streams deltas to the live response', true)
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle', undefined, { timeout: 8000 })
check('turn completes back to idle', true)
const toolRows = await page.evaluate(() => document.querySelectorAll('[data-tool-call]').length)
check('tool call rendered in the transcript', toolRows >= 1)

// 3. Diff panel. The change lands after the turn, because the diff
// baselines against the session's first checkpoint.
writeFileSync(join(dir, 'notes.txt'), 'hello from the drive\n')
await page.click('[data-diff-toggle]')
await page.waitForFunction(() => (document.querySelector('[data-diff-files]')?.textContent ?? '').includes('notes.txt'), undefined, { timeout: 8000 })
check('diff panel lists the changed file', true)

// 4. Terminal: unchanged coverage.
await page.click('[data-terminal-toggle]')
await page.waitForFunction(() => document.querySelector('[data-terminal-screen]')?.textContent?.includes('Harness test terminal'), undefined, { timeout: 8000 })
await page.keyboard.type('echo "d-$((40+4))"')
await page.keyboard.press('Enter')
const termOk = await page.waitForFunction(() => (document.querySelector('[data-terminal]')?.textContent ?? '').includes('d-44'), undefined, { timeout: 10000 }).then(() => true).catch(() => false)
if (!termOk) {
  console.log('terminal state:', await page.evaluate(() => {
    const panel = document.querySelector('[data-terminal]')
    return JSON.stringify({ hidden: panel?.hidden, text: (panel?.textContent ?? '').slice(0, 80), active: document.activeElement?.tagName })
  }))
}
check('terminal executes through the PTY', termOk)

// 5. Live resize: shrink the viewport under the panel's 720px cap so the
// panel narrows, the island's ResizeObserver reports the new geometry, and
// the shell's own idea of its width — asked twice via `stty size`, whose
// answer cannot come from the command echo — changes with it.
await page.keyboard.type('echo "s1-$(stty size | tr \' \' x)"')
await page.keyboard.press('Enter')
await page.waitForFunction(() => /s1-\d+x\d+/.test(document.querySelector('[data-terminal]')?.textContent ?? ''), undefined, { timeout: 8000 })
const sizeBefore = await page.evaluate(() => (document.querySelector('[data-terminal]')?.textContent ?? '').match(/s1-(\d+)x(\d+)/))
await page.setViewportSize({ width: 640, height: 720 })
await page.waitForTimeout(600)
await page.keyboard.type('echo "s2-$(stty size | tr \' \' x)"')
await page.keyboard.press('Enter')
await page.waitForFunction(() => /s2-\d+x\d+/.test(document.querySelector('[data-terminal]')?.textContent ?? ''), undefined, { timeout: 8000 })
const sizeAfter = await page.evaluate(() => (document.querySelector('[data-terminal]')?.textContent ?? '').match(/s2-(\d+)x(\d+)/))
const colsBefore = Number(sizeBefore?.[2] ?? 0)
const colsAfter = Number(sizeAfter?.[2] ?? 0)
if (!(colsAfter > 0 && colsAfter < colsBefore)) console.log('resize readings:', sizeBefore?.[0], '->', sizeAfter?.[0])
check('shrinking the window resizes the live PTY', colsAfter > 0 && colsAfter < colsBefore)
await page.setViewportSize({ width: 1280, height: 720 })

// 9. Settings: the Cmd+, chord opens the modal, the driver choice persists,
// and the desktop menu's `craft:settings` event reaches the same modal.
const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
const settingsReturn = page.url()
/** Whether the thread search sheet is open right now, without waiting for it. */
const searchDialogVisible = (): Promise<boolean> =>
  page.evaluate(() => document.querySelector('[data-thread-search]')?.hasAttribute('open') === true)
await page.keyboard.press('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await page.waitForURL(url => url.pathname === '/settings/general')
check('Cmd+, opens the settings modal at its General route', true)
await page.selectOption('#settings-driver', 'opencode')
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(settingsReturn)
const storedDriver = await page.evaluate(() => localStorage.getItem('harness.defaultDriver'))
check('driver choice persists', storedDriver === 'opencode')
await page.evaluate(() => window.dispatchEvent(new CustomEvent('craft:settings')))
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
const reopenedShowsChoice = await page.evaluate(() => (document.querySelector('#settings-driver') as HTMLSelectElement | null)?.value)
check('menu event reopens settings with the saved choice', reopenedShowsChoice === 'opencode')
const accessSection = await page.evaluate(() => document.querySelector('[data-settings-modal]')?.textContent ?? '')
check('settings shows the access section honestly', accessSection.includes('No devices are paired') && accessSection.includes('--remote'))
const settingsNavigation = settingsDialog.getByRole('navigation', { name: 'Settings sections' })

// 9b. Keyboard: the registry renders every chord, refuses one another command
// owns, keeps a rebind across loads, and the rebound chord is the one the
// window actually answers.
await settingsNavigation.getByRole('button', { name: 'Keyboard' }).click()
await page.waitForURL(url => url.pathname === '/settings/keybindings')
const keyboardRows = page.locator('[data-keybinding-row]')
const searchRow = page.locator('[data-keybinding-row="thread.search"]')
const searchChord = searchRow.locator('[data-keybinding-chord]')
const keyboardStatus = page.locator('[data-keybinding-status]')
const defaultChord = (await searchChord.textContent())?.trim() ?? ''
check('the keyboard section lists the registry at its platform chords',
  await keyboardRows.count() >= 5 && (defaultChord === '⌘K' || defaultChord === 'Ctrl+K'))
check('a shortcut on its default offers no reset',
  await searchRow.getByRole('button', { name: 'Reset' }).isDisabled())

// The chord Open settings owns: refused by name, and the row keeps the chord
// it had rather than being left unbound.
await searchRow.getByRole('button', { name: 'Change' }).click()
await page.keyboard.press('Meta+Comma')
await page.waitForFunction(
  () => (document.querySelector('[data-keybinding-status]')?.textContent ?? '').includes('already belongs to'),
  undefined,
  { timeout: 4000 },
)
check('a chord another command owns is refused by the command that owns it',
  ((await keyboardStatus.textContent()) ?? '').includes('Open settings')
  && (await searchChord.textContent())?.trim() === defaultChord
  && await page.evaluate(() => localStorage.getItem('harness.keybindings.v1')) === null)

// Still recording, so the next press is a second attempt at the same row.
await page.keyboard.press('Meta+Shift+K')
await page.waitForFunction(
  () => (document.querySelector('[data-keybinding-row="thread.search"] [data-keybinding-chord]')?.textContent ?? '').trim() !== '',
  undefined,
  { timeout: 4000 },
)
const reboundChord = (await searchChord.textContent())?.trim() ?? ''
check('recording a free chord rebinds the command and stores only the override',
  (reboundChord === '⇧⌘K' || reboundChord === 'Ctrl+Shift+K')
  && await page.evaluate(() => localStorage.getItem('harness.keybindings.v1')) === '{"thread.search":"Mod+Shift+K"}'
  && !await searchRow.getByRole('button', { name: 'Reset' }).isDisabled())

// A second load of the same origin: the override is a stored preference, not
// island state.
const keyboardReload = await browserContext.newPage()
await keyboardReload.goto(new URL('/settings/keybindings', baseUrl).href)
const reloadedChord = keyboardReload.locator('[data-keybinding-row="thread.search"] [data-keybinding-chord]')
await keyboardReload.waitForFunction(
  () => (document.querySelector('[data-keybinding-row="thread.search"] [data-keybinding-chord]')?.textContent ?? '').includes('K'),
  undefined,
  { timeout: 4000 },
)
check('a rebind survives a fresh load of the same origin',
  ['⇧⌘K', 'Ctrl+Shift+K'].includes(((await reloadedChord.textContent()) ?? '').trim()))
await keyboardReload.close()

// The window answers the new chord and no longer answers the old one.
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(settingsReturn)
await page.keyboard.press('Meta+K')
await page.waitForTimeout(250)
const staleChordOpened = await searchDialogVisible()
await page.keyboard.press('Meta+Shift+K')
const reboundSearch = page.getByRole('dialog', { name: 'Search threads' })
await reboundSearch.waitFor({ state: 'visible', timeout: 4000 })
check('the window answers the rebound chord and ignores the original', !staleChordOpened)
await page.keyboard.press('Escape')
await reboundSearch.waitFor({ state: 'hidden', timeout: 4000 })

// Reset all, so the rest of the drive runs on the documented defaults.
await page.keyboard.press('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await settingsNavigation.getByRole('button', { name: 'Keyboard' }).click()
await page.getByRole('button', { name: 'Reset all shortcuts' }).click()
await page.waitForFunction(() => localStorage.getItem('harness.keybindings.v1') === null, undefined, { timeout: 4000 })
check('resetting every shortcut clears the stored overrides',
  (await searchChord.textContent())?.trim() === defaultChord
  && await page.getByRole('button', { name: 'Reset all shortcuts' }).isDisabled())

await settingsNavigation.getByRole('button', { name: 'Access' }).click()
await page.waitForURL(url => url.pathname === '/settings/access')
check('settings navigation moves keyboard focus to the selected section',
  await settingsDialog.getByRole('heading', { name: 'Access' }).evaluate(heading => document.activeElement === heading))

await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
await page.waitForURL(settingsReturn)
check('Esc closes settings and returns to its workspace URL', true)
await page.goForward()
await settingsDialog.getByRole('heading', { name: 'Access' }).waitFor()
check('browser Forward reopens the actual settings section', new URL(page.url()).pathname === '/settings/access')
await page.goBack()
await settingsDialog.waitFor({ state: 'hidden' })
await page.waitForURL(settingsReturn)
check('browser Back closes settings at the original thread URL', true)
const settingsDeepLink = await browserContext.newPage()
const deepLink = new URL('/settings', baseUrl)
deepLink.searchParams.set('from', new URL(settingsReturn).pathname)
await settingsDeepLink.goto(deepLink.href)
const directSettings = settingsDeepLink.getByRole('dialog', { name: 'Settings' })
await directSettings.getByRole('heading', { name: 'General', exact: true }).waitFor()
check('a direct settings URL opens its modal and canonicalizes the index',
  new URL(settingsDeepLink.url()).pathname === '/settings/general')
await directSettings.getByRole('button', { name: 'Close settings' }).click()
await settingsDeepLink.waitForURL(url => url.pathname === new URL(settingsReturn).pathname)
await settingsDeepLink.close()
await page.evaluate(() => localStorage.removeItem('harness.defaultDriver'))

// 10. The composer's agent picker: preselected with the session's driver,
// backed by live probes, and switching offers a fresh session honestly.
const pickerState = await page.evaluate(async () => ({
  value: (document.querySelector('[data-driver-picker]') as HTMLSelectElement | null)?.value,
  headerChip: document.querySelector('[data-session-driver]')?.textContent,
  probes: await fetch('/drivers').then(r => r.json()),
}))
check('picker shows the session driver', pickerState.value === 'claude' && pickerState.headerChip === 'claude')
check('driver probes answer for every kind', pickerState.probes.drivers.length === 5
  && pickerState.probes.drivers.every((d: any) => d.status === (d.kind === 'codex' ? 'unauthenticated' : 'ready')))
await page.selectOption('[data-driver-picker]', 'claude:1')
await page.click('[role="alertdialog"] button:has-text("OK")')
await page.waitForURL(url => url.pathname.startsWith('/s/') && url.pathname !== `/s/${sessionId}`, { timeout: 8000 })
await page.waitForFunction(() => (document.querySelector('[data-driver-picker]') as HTMLSelectElement)?.value === 'claude:1')
const sessionsAfterSwitch = [...harness.engine.current.sessions.values()]
check('switching accounts starts a fresh session with the selected account', sessionsAfterSwitch.length === 2
  && sessionsAfterSwitch.some(s => s.driverKind === 'claude' && s.providerInstanceId === 1))

// 11. Type-to-start: on a page with no session open, the empty state shows
// and a typed prompt creates a session, navigates to it, and sends itself.
await page.goto(`${baseUrl}/?workspace=${workspaceId}`)
const emptyStateShown = await page.evaluate(() => document.querySelector('[data-empty-state]') !== null)
check('no-session page shows the empty state', emptyStateShown)
await page.setViewportSize({ width: 390, height: 844 })
await workspaceActions.click()
await page.locator('[data-project-add]').click()
await page.locator('[data-project-browse]').click()
check('native Browse fills the selected host folder', await page.locator('[data-project-path]').inputValue() === secondProject)
await page.locator('[data-project-trust-checkbox]').check()
await capture('onboarding-mobile')
await page.locator('[data-project-submit]').click()
await page.waitForURL(url => {
  const workspace = url.searchParams.get('workspace')
  return Boolean(workspace && workspace !== String(workspaceId))
})
const secondWorkspaceId = [...harness.engine.current.workspaces.keys()].find(id => id !== workspaceId)!
check('adding a trusted second folder selects it without creating a session', harness.engine.current.workspaces.get(secondWorkspaceId)?.trusted === true
  && harness.engine.current.sessions.size === 2)
await page.locator('[data-draft-project]').selectOption(String(workspaceId))
await page.waitForURL(`**/?workspace=${workspaceId}`)
await page.locator('[data-draft-project]').selectOption(String(secondWorkspaceId))
await page.waitForURL(`**/?workspace=${secondWorkspaceId}`)
await capture('onboarding-selected-project')
await page.setViewportSize({ width: 1280, height: 800 })
await page.getByRole('button', { name: 'Choose agent and model' }).click()
await page.getByRole('button', { name: /Claude Code.*Personal/ }).click()
await page.getByRole('option', { name: 'Provider default' }).click()
await page.fill('[data-prompt]', 'typed with no session open')
await page.click('[data-send]')
await page.waitForURL(/\/s\/\d+/, { timeout: 8000 })
await page.waitForFunction(() => (document.body.textContent ?? '').includes('typed with no session open'), undefined, { timeout: 8000 })
const newSessionId = Number(new URL(page.url()).pathname.split('/').at(-1))
check('type-to-start delivers the prompt in the selected workspace', harness.engine.current.sessions.size === 3
  && harness.engine.current.sessions.get(newSessionId)?.workspaceId === secondWorkspaceId
  && harness.engine.current.sessions.get(newSessionId)?.providerInstanceId === 2)

// 12. The account corner: the header's person icon opens the same settings.
await page.click('[data-account-button]:visible')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
check('the account icon opens settings', true)
const backgroundCanFocus = await page.locator('[data-account-button]:visible').evaluate((button: HTMLElement) => {
  button.focus()
  return document.activeElement === button
})
check('modal settings make the background inert', !backgroundCanFocus)
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
check('closing settings returns focus to its trigger', await page.locator('[data-account-button]:visible').evaluate(button => document.activeElement === button))

// 13. The Providers section: each CLI's live status and native login.
await page.click('[data-account-button]:visible')
await settingsNavigation.getByRole('button', { name: 'Providers' }).click()
await page.waitForURL(url => url.pathname === '/settings/providers')
await page.waitForFunction(() => document.querySelector('[data-agent-row="claude"] [data-agent-state]')?.textContent === 'ready', undefined, { timeout: 4000 })
const agentRows = await page.evaluate(() => [...document.querySelectorAll('[data-agent-row]')].map(row => ({
  state: row.querySelector('[data-agent-state]')?.textContent,
  loginShown: !(row.querySelector('[data-agent-login]') as HTMLElement).hidden,
})))
check('login shows only for the signed-out CLI', agentRows.length === 5
  && agentRows.filter(r => r.state === 'signed out' && r.loginShown).length === 1
  && agentRows.filter(r => r.state === 'ready' && !r.loginShown).length === 4)
await page.getByRole('list', { name: 'Project provider accounts' }).getByText('Claude Code · Personal').waitFor()
await page.getByRole('list', { name: 'Project provider accounts' }).getByText('ChatGPT plan · Design Review').waitFor()
check('signed-out managed account offers host reconnection independently of Codex CLI',
  await page.getByRole('list', { name: 'Project provider accounts' }).getByText('Reconnect on host').count() === 1)
await capture('settings-provider-accounts')
await page.click('[data-agent-row="codex"] [data-agent-login]')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
await page.waitForFunction(() => document.querySelector('[data-terminal]')?.hasAttribute('hidden') === false, undefined, { timeout: 4000 })
await page.waitForFunction(() => (document.querySelector('[data-terminal-screen]')?.textContent ?? '').includes('Codex test sign-in'), undefined, { timeout: 8000 })
check('Log in opens the terminal and runs the fixture login command', true)

// 14. The desktop menu bar: the island declares it through craft's bridge
// (stubbed above), with an Edit menu of role items — the roles are what make
// Cmd+C/V work natively — and id items that come back as craft:menu:action
// events, which must land in the same handlers the buttons use.
const menuShape = await page.evaluate(() => {
  // The v0.0.67 contract: set() takes `{menus}` and passes it through raw.
  const menus = (((window as any).__menuSet as { menus?: unknown })?.menus ?? []) as Array<{ label: string, items?: Array<{ role?: string }> }>
  const edit = menus.find(m => m.label === 'Edit')
  return {
    labels: menus.map(m => m.label),
    editRoles: edit?.items?.filter(i => i.role).length ?? 0,
  }
})
check(
  'the page declares the menu bar with an Edit menu of roles',
  menuShape.labels.join(',') === 'harness,File,Edit,View,Window' && menuShape.editRoles >= 6,
)
await page.evaluate(() => window.dispatchEvent(new CustomEvent('craft:menu:action', { detail: { id: 'settings' } })))
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
check('a menu action routes to the page handler', true)
await settingsNavigation.getByRole('button', { name: 'Appearance' }).click()
await page.waitForURL(url => url.pathname === '/settings/appearance')
const appearancePicker = settingsDialog.getByRole('radiogroup', { name: 'Appearance' })
const systemAppearance = appearancePicker.getByRole('radio', { name: 'System' })
await systemAppearance.waitFor({ timeout: 4000 })
check('appearance defaults to the host’s system preference', await systemAppearance.getAttribute('aria-checked') === 'true')
const manualAppearance = colorScheme === 'light' ? 'dark' : 'light'
const manualLabel = manualAppearance === 'dark' ? 'Dark' : 'Light'
await appearancePicker.getByRole('radio', { name: manualLabel }).click()
await page.waitForFunction(mode => document.documentElement.classList.contains('dark') === (mode === 'dark'), manualAppearance)
check('manual appearance overrides the system and reaches the Craft bridge fixture', await page.evaluate(
  mode => (window as any).__windowAppearance === mode, manualAppearance,
))
await capture('settings-manual-appearance')

const prePaintPage = await browserContext.newPage()
await prePaintPage.route('**/_stx/**', route => route.request().resourceType() === 'script' ? route.abort() : route.continue())
await prePaintPage.goto(baseUrl, { waitUntil: 'domcontentloaded' })
check('appearance is restored before the stx runtime loads', await prePaintPage.evaluate(
  mode => document.documentElement.classList.contains('dark') === (mode === 'dark'), manualAppearance,
))
await prePaintPage.goto(baseUrl.replace('localhost', '127.0.0.1'), { waitUntil: 'domcontentloaded' })
check('another origin keeps its own appearance', await prePaintPage.evaluate(
  scheme => document.documentElement.classList.contains('dark') === (scheme === 'dark'), colorScheme,
))
await prePaintPage.evaluate(() => localStorage.setItem('stx-color-mode', 'fixture-invalid'))
await prePaintPage.reload({ waitUntil: 'domcontentloaded' })
check('an invalid stored appearance falls back to the system', await prePaintPage.evaluate(
  scheme => document.documentElement.classList.contains('dark') === (scheme === 'dark'), colorScheme,
))
await prePaintPage.close()

await page.reload()
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await appearancePicker.waitFor()
check('appearance route and selection survive reload', await appearancePicker.getByRole('radio', { name: manualLabel }).getAttribute('aria-checked') === 'true')
await appearancePicker.getByRole('radio', { name: manualLabel }).press('End')
await page.waitForFunction(scheme => document.documentElement.classList.contains('dark') === (scheme === 'dark'), colorScheme)
check('keyboard selection returns Craft to its inherited appearance', await systemAppearance.getAttribute('aria-checked') === 'true'
  && await page.evaluate(() => (window as any).__windowAppearance === 'system'))
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
await page.waitForURL(url => !url.pathname.startsWith('/settings'))

if (screenshotDir) {
  await capture('workspace-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('workspace-mobile')
  await page.locator('[data-account-button]:visible').click()
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width: width!, height: height! })
    check(`settings and its navigation fit at ${width}×${height}`, await settingsDialog.evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect()
      const pane = dialog.querySelector('[data-settings-panel]')
      const navigation = dialog.querySelector('[data-settings-navigation]')
      return Boolean(pane && navigation && bounds.left >= 0 && bounds.right <= innerWidth
        && bounds.bottom <= innerHeight && pane.scrollWidth <= pane.clientWidth + 1
        && navigation.scrollWidth <= navigation.clientWidth + 1)
    }))
    await capture(`settings-general-${width}x${height}`)
  }
  // The Keyboard section at a desktop and the narrowest width: its rows carry
  // a chord and two controls, which is the densest line in the whole sheet.
  await settingsNavigation.getByRole('button', { name: 'Keyboard' }).click()
  await page.waitForURL(url => url.pathname === '/settings/keybindings')
  for (const [width, height] of [[1280, 800], [360, 800]] as const) {
    await page.setViewportSize({ width, height })
    check(`the keyboard rows and their controls fit at ${width}×${height}`,
      await page.locator('[data-keybinding-list]').evaluate((list) => {
        const bounds = list.getBoundingClientRect()
        if (list.scrollWidth > list.clientWidth + 1 || bounds.left < 0 || bounds.right > innerWidth) return false
        return [...list.querySelectorAll('[data-keybinding-row] button, [data-keybinding-chord]')].every((control) => {
          const box = control.getBoundingClientRect()
          return box.width > 0 && box.left >= 0 && box.right <= innerWidth
        })
      }))
    await capture(`settings-keyboard-${width}x${height}`)
  }
  await settingsNavigation.getByRole('button', { name: 'General' }).click()
  await page.waitForURL(url => url.pathname === '/settings/general')
  await page.setViewportSize({ width: 360, height: 800 })
  await capture('settings-mobile')
  await page.keyboard.press('Escape')
  await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
}

const searchDialog = page.getByRole('dialog', { name: 'Search threads' })
const threadSearch = searchDialog.getByRole('combobox')
await page.setViewportSize({ width: 1280, height: 800 })
await page.keyboard.press('Control+k')
await searchDialog.waitFor({ state: 'visible', timeout: 4000 })
check('search shortcut focuses the search input', await threadSearch.evaluate(input => document.activeElement === input))
await threadSearch.fill('run the drive')
await searchDialog.getByRole('option', { name: /run the drive turn/ }).waitFor({ timeout: 4000 })
await capture('thread-search-desktop')
await threadSearch.fill('no fixture thread has this title')
await searchDialog.getByText('No matching threads.').waitFor({ timeout: 4000 })
await page.keyboard.press('Escape')
await searchDialog.waitFor({ state: 'hidden', timeout: 4000 })

await page.setViewportSize({ width: 390, height: 844 })
const searchButton = page.getByRole('button', { name: 'Search threads' })
await searchButton.click()
await threadSearch.press('Escape')
await searchDialog.waitFor({ state: 'hidden', timeout: 4000 })
check('closing thread search returns focus to the search button', await searchButton.evaluate(button => document.activeElement === button))
await searchButton.click()
await threadSearch.fill('thinking done')
const messageResults = searchDialog.getByRole('option', { name: /Thinking.*done/ })
await messageResults.nth(1).waitFor({ timeout: 4000 })
check('thread search finds matching messages in both projects', await messageResults.count() === 2)
const searchBounds = await searchDialog.boundingBox()
const phoneSearchFits = Boolean(searchBounds
  && searchBounds.y > 0 && searchBounds.y < 100 && searchBounds.x >= 0 && searchBounds.x + searchBounds.width <= 390)
if (!phoneSearchFits) console.log('Phone search bounds:', searchBounds)
check('phone search keeps results near the top and within the viewport', phoneSearchFits)
await capture('thread-search-mobile')
await threadSearch.press('ArrowDown')
const selectedResult = await messageResults.nth(1).getAttribute('aria-selected')
check('arrow keys select the next matching thread', selectedResult === 'true')
await threadSearch.press('Enter')
await page.waitForURL(url => url.pathname === `/s/${sessionId}` && url.hash.startsWith('#turn-'), { timeout: 8000 })
check('search opens the matching turn', await page.evaluate(() => Boolean(document.getElementById(location.hash.slice(1)))))

await page.keyboard.press('Control+Alt+n')
await page.waitForURL(url => url.searchParams.get('project') === 'none', { timeout: 8000 })
check('projectless draft keeps the profile and offers its registered projects', await page.locator('[data-draft-project]').inputValue() === 'none'
  && await page.locator('[data-draft-project] option').count() === 3)
await capture('projectless-draft-mobile')
await page.fill('[data-prompt]', 'write scratch fixture')
await page.click('[data-send]')
await page.waitForURL(/\/s\/\d+/, { timeout: 8000 })
await page.waitForFunction(() => (document.querySelector('[data-transcript]')?.textContent ?? '').includes('done.'), undefined, { timeout: 8000 })
const scratchSessionId = Number(new URL(page.url()).pathname.split('/').at(-1))
const scratch = harness.engine.current.workspaces.get(scratchSessionId)
check('the first projectless prompt uses its own scratch folder and hides Changes', Boolean(scratch?.scratch
  && scratch.profileId === providerProfileId && readFileSync(join(scratch.path, 'kept.txt'), 'utf8') === 'scratch fixture'
  && await page.locator('[data-diff-toggle]').count() === 0))
await capture('projectless-thread-mobile')
await workspaceActions.click()
await page.getByRole('button', { name: 'Turn into project' }).click()
await page.locator('[data-diff-toggle]').waitFor({ state: 'attached', timeout: 4000 })
check('turning a scratch folder into a project keeps the session and files in place', Boolean(scratch
  && !harness.engine.current.workspaces.get(scratchSessionId)?.scratch
  && harness.engine.current.sessions.get(scratchSessionId)?.workspaceId === scratchSessionId
  && readFileSync(join(scratch.path, 'kept.txt'), 'utf8') === 'scratch fixture'))

const promptBox = page.locator('[data-prompt]')
const scratchDraft = 'Draft for the scratch thread\nSecond line'
await promptBox.fill(scratchDraft)
await promptBox.evaluate((box: HTMLTextAreaElement) => {
  box.setSelectionRange(14, 21, 'backward')
  box.dispatchEvent(new Event('select', { bubbles: true }))
})
await page.goto(`${baseUrl}/s/${sessionId}`)
check('a different thread starts with its own empty composer', await promptBox.inputValue() === '')
await promptBox.fill('A separate draft in another project')
await page.goto(`${baseUrl}/s/${scratchSessionId}`)
await page.waitForFunction(text => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === text, scratchDraft)
check('switching threads restores the draft and selection', await promptBox.evaluate((box: HTMLTextAreaElement) =>
  box.selectionStart === 14 && box.selectionEnd === 21 && box.selectionDirection === 'backward'))
await page.reload()
await page.waitForFunction(text => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === text, scratchDraft)
check('the mobile composer restores the draft after reload', await promptBox.evaluate((box: HTMLTextAreaElement) =>
  box.selectionStart === 14 && box.selectionEnd === 21))
check('confirming either form of input composition leaves Enter to the editor', await promptBox.evaluate((box: HTMLTextAreaElement) =>
  [true, false].every((isComposing) => {
    const enter = new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true })
    if (!isComposing) Object.defineProperty(enter, 'keyCode', { value: 229 })
    return box.dispatchEvent(enter)
  })))
await capture('composer-draft-recovery-mobile')

const attemptedIds: string[] = []
const retryText = 'Retry a turn whose receipt was interrupted'
let droppedReceipt = false
await page.routeWebSocket('**/ws', (client) => {
  const upstream = client.connectToServer()
  client.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (frame?.t === 'dispatch' && frame.envelope?.command?.text === retryText)
      attemptedIds.push(frame.envelope.id)
    upstream.send(message)
  })
  upstream.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (!droppedReceipt && frame?.t === 'dispatched' && attemptedIds.includes(frame.id)) {
      droppedReceipt = true
      return
    }
    client.send(message)
  })
})
await page.reload()
await promptBox.fill(retryText)
await page.click('[data-send]')
await page.getByText('The server did not confirm the request. Try again.').waitFor({ timeout: 12_000 })
check('a dropped send receipt leaves the draft and stores one turn', droppedReceipt && await promptBox.inputValue() === retryText
  && harness.engine.current.sessions.get(scratchSessionId)?.turns.filter(turn => turn.prompt === retryText).length === 1)
await page.keyboard.press('Escape')
await page.click('[data-send]')
await page.waitForFunction(() => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === '')
check('retry uses the same id and clears the draft after receipt', attemptedIds.length === 2 && attemptedIds[0] === attemptedIds[1]
  && harness.engine.current.sessions.get(scratchSessionId)?.turns.filter(turn => turn.prompt === retryText).length === 1)

await page.addInitScript(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (value: string) => { document.body.dataset.fixtureClipboard = value },
      write: async (items: ClipboardItem[]) => {
        const html = await items[0]?.getType('text/html')
        document.body.dataset.fixtureClipboardHtml = html ? await html.text() : ''
      },
    },
  })
})
await page.reload()
await promptBox.fill('exercise streaming markdown')
await page.click('[data-send]')
const transcript = page.getByRole('region', { name: 'Conversation' })
await transcript.getByRole('heading', { name: 'Build result' }).waitFor()
await transcript.getByText('Encoded comparison:', { exact: false }).waitFor({ state: 'attached' })
await page.reload()
await transcript.getByText('Encoded comparison:', { exact: false }).waitFor({ state: 'attached' })
await page.waitForFunction(() => {
  const pane = document.querySelector('[data-transcript]')
  return pane && pane.scrollHeight > pane.clientHeight && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 16
})
await transcript.evaluate(element => { element.scrollTop = 0 })
const jump = page.getByRole('button', { name: 'Jump to latest' })
await jump.waitFor()
markdownGate.resolve()
await transcript.getByText(/const result = 42/).waitFor()
check('streaming Markdown preserves a reader’s scroll position', await transcript.evaluate(element => element.scrollTop) === 0)
check('assistant markup stays text while Markdown code renders',
  await transcript.locator('[data-fixture="literal"]').count() === 0
  && await transcript.getByText(/literal markup.*\{\{ 1 \+ 1 \}\}/).count() === 1)
check('reloading mid-turn preserves literal entities when streaming resumes',
  await transcript.locator('p code').last().textContent() === '&lt;')
await jump.click()
const copy = transcript.getByRole('button', { name: 'Copy code' })
await copy.click()
check('the copy action preserves the fenced code', await page.locator('body').getAttribute('data-fixture-clipboard') === 'const result = 42\nconst format = "{{ value }}"\n')
check('jump returns to the latest response', await jump.isHidden()
  && await transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight < 16))
await capture('transcript-markdown-mobile')
await page.setViewportSize({ width: 1280, height: 800 })
await page.reload()
await transcript.getByText(/const result = 42/).waitFor()
await page.waitForFunction(() => {
  const pane = document.querySelector('[data-transcript]')
  return pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 16
})
check('reloading uses the same Markdown history and preserves literal markup',
  await transcript.getByRole('heading', { name: 'Build result' }).count() === 1
  && await transcript.getByText(/literal markup.*\{\{ 1 \+ 1 \}\}/).count() === 1
  && await transcript.locator('[data-fixture="literal"]').count() === 0)
await capture('transcript-markdown-desktop')

await promptBox.fill('exercise parallel approvals')
await page.click('[data-send]')
const approval = page.locator('[data-approval]')
const approvalTool = approval.locator('[data-approval-tool]')
await page.waitForFunction(() => document.querySelector('[data-approval-tool]')?.textContent === 'Read')
await page.reload()
await approval.waitFor()
check('reloading restores the oldest outstanding approval', await approvalTool.textContent() === 'Read')
await approval.getByRole('button', { name: 'Allow', exact: true }).click()
await page.waitForFunction(() => document.querySelector('[data-approval-tool]')?.textContent === 'Write')
await approval.getByRole('button', { name: 'Deny', exact: true }).click()
await approval.waitFor({ state: 'hidden' })
check('parallel approvals advance in order and reach their matching callbacks',
  parallelDecisions.get('parallel_read') === true && parallelDecisions.get('parallel_write') === false)

await page.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
await promptBox.fill('exercise structured questions')
await page.click('[data-send]')
const question = page.getByRole('form', { name: 'Agent question' })
const firstQuestion = question.getByText('Should this fixture prefer strict schemas or UI flexibility?')
await firstQuestion.waitFor()
await page.reload()
await firstQuestion.waitFor()
check('question survives reload and reserves the composer until answered',
  await promptBox.isHidden() && await question.getByRole('button', { name: 'Next' }).isDisabled())
await capture('question-card-desktop')
await page.setViewportSize({ width: 390, height: 844 })
await capture('question-card-mobile')
const strictOption = question.getByRole('radio', { name: 'Strict schemas (Recommended)' })
await strictOption.focus()
await page.keyboard.press('1')
let failedUpload = false
await page.route('**/question-attachments?**', async (route) => {
  if (route.request().method() === 'POST' && !failedUpload) {
    failedUpload = true
    await route.fulfill({ status: 503, json: { error: 'Fixture upload interrupted.' } })
  }
  else await route.continue()
})
await question.locator('input[type="file"]').setInputFiles({
  name: 'fixture-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Safe attachment fixture.'),
})
await question.locator('[data-question-file-status="failed"]').waitFor()
await question.getByRole('button', { name: 'Retry', exact: true }).click()
await question.locator('[data-question-file-status="ready"]').waitFor()
check('a failed upload can retry without losing the selected answer', await strictOption.isChecked())
await page.reload()
await question.getByText('fixture-notes.txt', { exact: true }).waitFor()
check('ready question attachments reload while the answer is pending', await question.locator('[data-question-file-status="ready"]').count() === 1)
await strictOption.check()
await question.locator('input[type="file"]').setInputFiles({
  name: 'removed-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Removed attachment fixture.'),
})
await question.locator('[data-question-file-status="ready"]').nth(1).waitFor()
const removed = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/question-attachments/'))
await question.getByRole('button', { name: 'Remove removed-notes.txt' }).click()
check('removing a draft deletes its host copy', (await removed).status() === 204)
await capture('question-attachments-mobile')
await question.getByRole('button', { name: 'Next' }).click()
const privateInput = question.getByLabel('Answer', { exact: true })
check('sensitive questions mask the answer', await privateInput.getAttribute('type') === 'password')
check('sensitive questions hide attachment controls', !(await question.locator('input[type="file"]').isVisible()))
await privateInput.fill('fixture private answer')
await question.getByRole('button', { name: 'Back' }).click()
check('back keeps the selected answer', await strictOption.isChecked())
check('back keeps this question’s attachment', await question.getByText('fixture-notes.txt', { exact: true }).isVisible())
await question.getByRole('button', { name: 'Next' }).click()
check('next restores the unsent answer for this question', await privateInput.inputValue() === 'fixture private answer')
await question.getByRole('button', { name: 'Submit answer' }).click()
await transcript.getByText('Question fixture complete.', { exact: true }).waitFor()
const delivered = questionAnswers.get('fixture_schemas') as Array<{ questionId: string, values: string[] }>
const attachedPath = delivered?.[0]?.values[0]?.split('\n').at(-1)
check('the provider receives both answers and an openable host attachment',
  delivered?.[0]?.values[0]?.startsWith('strict\nAttached files:\n') === true
  && Boolean(attachedPath && readFileSync(JSON.parse(attachedPath), 'utf8') === 'Safe attachment fixture.')
  && delivered?.[1]?.values[0] === 'fixture private answer'
  && await transcript.getByText('Question answered', { exact: true }).isVisible())
await transcript.getByRole('link', { name: 'fixture-notes.txt', exact: true }).waitFor()
await page.reload()
await transcript.getByText('Question answered', { exact: true }).waitFor()
check('question answers stay out of the restored page', !((await page.content()).includes('fixture private answer')))
const savedFile = transcript.getByRole('link', { name: 'fixture-notes.txt', exact: true })
const savedFilePath = (await savedFile.getAttribute('href'))!
const savedFileResponse = await page.request.get(new URL(savedFilePath, baseUrl).href)
check('submitted attachment survives reload and downloads as safe data',
  await savedFile.isVisible() && await savedFileResponse.text() === 'Safe attachment fixture.'
  && savedFileResponse.headers()['content-disposition']?.startsWith('attachment;') === true)

await page.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
await promptBox.fill('exercise transcript controls')
await page.click('[data-send]')
const controlsTurn = transcript.locator('[data-turn]').last()
const wrap = controlsTurn.getByRole('button', { name: 'Wrap lines' })
const previewCode = controlsTurn.locator('pre')
await wrap.waitFor()
check('code wraps within the phone layout by default', await wrap.getAttribute('aria-pressed') === 'true'
  && await previewCode.evaluate(element => element.scrollWidth <= element.clientWidth))
await wrap.click()
check('turning wrap off gives the code its own horizontal scroll', await wrap.getAttribute('aria-pressed') === 'false'
  && await previewCode.evaluate(element => element.scrollWidth > element.clientWidth))
const streamingCode = controlsTurn.locator('code[data-code-language="ts"]')
await page.waitForFunction(() => {
  const code = [...document.querySelectorAll('code[data-code-language="ts"]')].at(-1)
  return [...(CSS.highlights.get('harness-syntax-keyword') ?? [])].some(range => code?.contains(range.startContainer))
})
check('TypeScript keywords are highlighted while the provider is still streaming', await streamingCode.evaluate((code) => {
  const keyword = [...(CSS.highlights.get('harness-syntax-keyword') ?? [])].find(candidate => code.contains(candidate.startContainer))
  if (!keyword || String(keyword) !== 'const') return false
  const selection = document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange((keyword as Range).cloneRange())
  return selection?.toString() === 'const'
}))
markdownControlsGate.resolve()
await controlsTurn.getByText('Checks recorded.', { exact: true }).waitFor()
check('code wrap choice survives a streamed update', await wrap.first().getAttribute('aria-pressed') === 'false')
check('streaming retains a selected code token', await streamingCode.evaluate(code =>
  document.getSelection()?.toString() === 'const' && code.contains(document.getSelection()?.anchorNode ?? null)))
await page.waitForFunction(() => {
  const code = [...document.querySelectorAll('code[data-code-language="ts"]')].at(-1)
  return [...(CSS.highlights.get('harness-syntax-value') ?? [])].some(range =>
    code?.contains(range.startContainer) && String(range) === '1')
})
check('later tokens are highlighted without re-rendering the existing selection', await streamingCode.evaluate((code) => {
  const selection = document.getSelection()
  const preserved = selection?.toString() === 'const' && code.contains(selection.anchorNode)
  selection?.removeAllRanges()
  return preserved
}))
const unknownCode = controlsTurn.locator('code[data-code-language="fixture-unknown-language"]')
check('unrecognized languages retain escaped plain text', await unknownCode.evaluate(code =>
  code.textContent === '<em>Plain fixture</em>\n' && code.querySelector('em') === null))
await capture('transcript-syntax-mobile')
const tableCopy = controlsTurn.locator('.transcript-table-actions summary')
await tableCopy.click()
await capture('transcript-table-copy-mobile')
await controlsTurn.getByRole('button', { name: 'Copy as Markdown' }).click()
check('table copies as Markdown and returns focus to its menu',
  await page.locator('body').getAttribute('data-fixture-clipboard') === '| Check | Result |\n| --- | --- |\n| Type check | Passed |\n| Formatting | Passed |'
  && await tableCopy.evaluate(element => element === element.ownerDocument.activeElement))
await tableCopy.click()
await controlsTurn.getByRole('button', { name: 'Copy as CSV' }).click()
check('table copies as CSV', await page.locator('body').getAttribute('data-fixture-clipboard') === 'Check,Result\nType check,Passed\nFormatting,Passed')
await tableCopy.click()
await controlsTurn.getByRole('button', { name: 'Copy as HTML' }).click()
await page.waitForFunction(() => document.body.dataset.fixtureClipboardHtml !== undefined)
check('table copies as rich HTML', (await page.locator('body').getAttribute('data-fixture-clipboard-html'))?.includes('<table>') === true)
await tableCopy.click()
await controlsTurn.getByRole('button', { name: 'Copy as Markdown' }).focus()
await page.keyboard.press('Escape')
check('Escape restores focus and closes the table copy menu',
  await tableCopy.evaluate(element => element === element.ownerDocument.activeElement && !element.closest('details')?.open))
if (screenshotDir) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await tableCopy.click()
  await capture('transcript-table-copy-desktop')
  await tableCopy.click()
  await capture('transcript-syntax-desktop')
}

await page.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
await promptBox.fill('exercise connector consent')
await page.click('[data-send]')
const connectorCard = page.getByRole('region', { name: 'Fixture Calendar requests access' })
const moreApprovalOptions = connectorCard.locator('summary[aria-label="More approval options"]')
const sessionChoice = connectorCard.getByRole('button', { name: 'Allow this session' })
await moreApprovalOptions.waitFor()
await page.reload()
await moreApprovalOptions.waitFor()
check('connector prompt and primary approval actions reload with the pending request',
  await connectorCard.getByText('Allow this fixture connector to read the calendar?').isVisible()
  && await connectorCard.getByRole('button', { name: 'Approve', exact: true }).isVisible()
  && await connectorCard.getByRole('button', { name: 'Decline', exact: true }).isVisible()
  && !await sessionChoice.isVisible()
  && !await page.locator('[data-approve]').isVisible())
await page.setViewportSize({ width: 1280, height: 800 })
await moreApprovalOptions.focus()
await page.keyboard.press('ArrowDown')
check('the connector options disclosure supports keyboard navigation',
  await connectorCard.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === element.ownerDocument.activeElement))
await page.keyboard.press('Escape')
check('Escape closes the scope choices and restores focus',
  !await sessionChoice.isVisible()
  && await moreApprovalOptions.evaluate(element => element === element.ownerDocument.activeElement))
await moreApprovalOptions.click()
await capture('connector-consent-desktop')
await page.setViewportSize({ width: 390, height: 844 })
await transcript.evaluate(element => { element.scrollTop = 0 })
const connectorBounds = await sessionChoice.boundingBox()
check('the session consent action fits on a phone',
  Boolean(connectorBounds && connectorBounds.x >= 0 && connectorBounds.y >= 0 && connectorBounds.x + connectorBounds.width <= 390
    && connectorBounds.y + connectorBounds.height <= 844))
await capture('connector-consent-mobile')
await sessionChoice.focus()
await page.keyboard.press('Enter')
await connectorCard.getByText('This fixture request will be withdrawn.').waitFor()
check('the exact scope from the selected choice reached the provider', connectorScope === 'session')
connectorWithdrawal.resolve()
await transcript.getByText('Connector consent fixture complete.').waitFor()
check('provider withdrawal closes the connector card', !await connectorCard.isVisible())

await page.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
await page.setViewportSize({ width: 1280, height: 800 })
await promptBox.fill('exercise follow-up queue')
await page.click('[data-send]')
await transcript.getByText('Waiting for queued messages.').waitFor()
const queue = page.getByRole('region', { name: 'Queued messages' })
const followUpRows = queue.locator('[data-follow-up]')
for (const text of ['Follow-up fixture: first task', 'Follow-up fixture: second task']) {
  await promptBox.fill(text)
  await page.getByRole('button', { name: 'Queue', exact: true }).click()
  await followUpRows.filter({ hasText: text }).getByRole('button', { name: 'Edit queued message' }).waitFor()
}
await followUpRows.nth(1).getByRole('button', { name: 'Move queued message up' }).click()
await page.waitForFunction(() => document.querySelector('[data-follow-up]')?.textContent.includes('second task'))
await promptBox.fill('Keep this draft in the composer.')
await promptBox.evaluate((box: HTMLTextAreaElement) => box.setSelectionRange(0, 0))
await promptBox.press('Alt+ArrowUp')
check('the queued edit shortcut opens the last message', await promptBox.inputValue() === 'Follow-up fixture: first task')
await promptBox.press('Escape')
await followUpRows.first().getByRole('button', { name: 'Edit queued message' }).click()
await promptBox.fill('Follow-up fixture: revised task')
await page.getByRole('button', { name: 'Save edit', exact: true }).click()
await followUpRows.first().getByText('Follow-up fixture: revised task').waitFor()
check('editing an item restores the pre-edit draft', await promptBox.inputValue() === 'Keep this draft in the composer.')
await capture('follow-ups-desktop')

const followUpClient = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme })
let routeOffline = false
let disconnectFollowUpClient = async () => {}
await followUpClient.routeWebSocket('**/ws', async (route) => {
  if (routeOffline) { await route.close({ code: 1001 }); return }
  route.connectToServer()
  disconnectFollowUpClient = () => route.close({ code: 1001 })
})
const phone = await followUpClient.newPage()
phone.on('pageerror', e => pageErrors.push(e.message))
await phone.goto(page.url())
await phone.locator('[data-composer][data-session-online="true"]').waitFor()
const phoneQueue = phone.getByRole('region', { name: 'Queued messages' })
await phoneQueue.getByText('Follow-up fixture: revised task').waitFor()
routeOffline = true
await disconnectFollowUpClient()
await phone.locator('[data-composer][data-session-online="false"]').waitFor()
await phone.locator('[data-prompt]').fill('Follow-up fixture: offline task')
await phone.getByRole('button', { name: 'Queue', exact: true }).click()
await phoneQueue.getByText('Waiting to sync').waitFor()
await phone.reload()
await phoneQueue.getByText('Follow-up fixture: offline task').waitFor()
check('offline text and host queue survive the browser closing and reopening',
  await phoneQueue.getByText('Waiting to sync').isVisible()
  && await phoneQueue.getByText('Follow-up fixture: revised task').isVisible())
await phone.locator('[data-prompt]').fill('Discard this unsynced message.')
await phone.getByRole('button', { name: 'Queue', exact: true }).click()
const unsynced = phoneQueue.locator('[data-follow-up]').filter({ hasText: 'Discard this unsynced message.' })
await unsynced.getByRole('button', { name: 'Remove unsynced message' }).click()
await unsynced.waitFor({ state: 'hidden' })
if (screenshotDir) {
  await phoneQueue.scrollIntoViewIfNeeded()
  await phone.screenshot({ path: join(screenshotDir, 'follow-ups-phone-offline.png'), animations: 'disabled' })
}
routeOffline = false
await phone.evaluate(() => globalThis.dispatchEvent(new Event('online')))
await queue.getByText('Follow-up fixture: offline task').waitFor()
await phoneQueue.getByText('Waiting to sync').waitFor({ state: 'hidden' })
await page.getByRole('button', { name: 'Stop', exact: true }).click()
await phoneQueue.getByText('Held', { exact: true }).waitFor()
check('Stop holds the saved queue without delivering another prompt', followUpDelivery.length === 0)
if (screenshotDir) {
  await phoneQueue.scrollIntoViewIfNeeded()
  await phone.screenshot({ path: join(screenshotDir, 'follow-ups-phone-held.png'), animations: 'disabled' })
}
await phone.getByRole('button', { name: 'Resume', exact: true }).click()
await phoneQueue.waitFor({ state: 'hidden' })
await phone.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
check('explicit resume drains the edited order once, including the offline message',
  JSON.stringify(followUpDelivery) === JSON.stringify(['Follow-up fixture: revised task', 'Follow-up fixture: first task', 'Follow-up fixture: offline task']))
await followUpClient.close()

fixtureCodexReady = true
const steerSessionIds = new Set(harness.engine.current.sessions.keys())
cmd('d_steer', { type: 'session.create', workspaceId, driverKind: 'codex', label: 'exercise active steering' })
let steerSessionId: number | undefined
for (let tries = 0; tries < 40 && steerSessionId === undefined; tries++) {
  steerSessionId = [...harness.engine.current.sessions.keys()].find(id => !steerSessionIds.has(id))
  if (steerSessionId === undefined) await Bun.sleep(25)
}
if (steerSessionId === undefined) throw new Error('Could not start the steering fixture session.')
await page.goto(`${baseUrl}/s/${steerSessionId}`)
await page.locator('[data-composer][data-session-online="true"]').waitFor()
await promptBox.fill('exercise active steering')
await page.click('[data-send]')
await transcript.getByText('Ready for active steering.').waitFor()
const steeringReady = page.locator('[data-composer][data-steer-ready="true"]')
try {
  await steeringReady.waitFor({ timeout: 5000 })
}
catch (error) {
  const turn = [...harness.engine.current.sessions.values()].find(item => item.turns.at(-1)?.prompt === 'exercise active steering')
  console.error('Steering readiness:', turn?.state, turn?.turns.at(-1),
    await page.locator('[data-composer]').evaluate(form => [form.getAttribute('data-steer-ready'), form.getAttribute('data-session-online'), form.getAttribute('hidden')]),
    pageErrors)
  throw error
}
await promptBox.fill('Steer from a queued row.')
await page.getByRole('button', { name: 'Queue', exact: true }).click()
const steerRow = followUpRows.filter({ hasText: 'Steer from a queued row.' })
await steerRow.waitFor()
const sendNow = steerRow.getByRole('button', { name: 'Send now', exact: true })
try {
  await sendNow.waitFor({ timeout: 5000 })
}
catch (error) {
  console.error('Steering row:', await steerRow.evaluate(row => row.outerHTML), 'page errors:', pageErrors)
  throw error
}
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await sendNow.scrollIntoViewIfNeeded()
    await capture(`steering-queued-${width}x${height}`)
  }
}
await page.setViewportSize({ width: 1280, height: 800 })
await sendNow.click()
const originalTurn = transcript.locator('[data-turn]').filter({ hasText: 'exercise active steering' })
await originalTurn.locator('[data-steered-message]').getByText('Steer from a queued row.').waitFor()
await steerRow.waitFor({ state: 'hidden' })
check('Send now steers the original turn exactly once', steeringCalls.join() === 'Steer from a queued row.')
await page.reload()
await steeringReady.waitFor()
await originalTurn.getByText('Steer from a queued row.').waitFor()
check('the original turn retains its steer after a reload', await originalTurn.locator('[data-steered-message]').count() === 1)
await page.keyboard.press('Control+,')
await page.locator('#settings-follow-up').selectOption('steer')
await page.keyboard.press('Escape')
await promptBox.focus()
await promptBox.press('Control+f')
const liveFind = page.getByRole('search', { name: 'Find in thread' })
await liveFind.getByRole('searchbox').fill('Steer directly from the composer.')
await liveFind.getByText('0/0', { exact: true }).waitFor()
await promptBox.fill('Steer directly from the composer.')
await page.getByRole('button', { name: 'Steer', exact: true }).click()
try {
  await originalTurn.getByText('Steer directly from the composer.').waitFor({ timeout: 5000 })
}
catch (error) {
  console.error('Direct steer:', steeringCalls, await originalTurn.innerText(), pageErrors)
  throw error
}
await liveFind.getByText('1/1', { exact: true }).waitFor()
check('find updates when an in-flight transcript receives a message', true)
await liveFind.getByRole('button', { name: 'Close find' }).click()
check('the find shortcut restores the composer focus when closed',
  await promptBox.evaluate(input => document.activeElement === input))
await promptBox.fill('Queue using the opposite shortcut.')
await promptBox.press('Control+Enter')
const oppositeQueuedRow = followUpRows.filter({ hasText: 'Queue using the opposite shortcut.' })
await oppositeQueuedRow.getByRole('button', { name: 'Send now', exact: true }).waitFor()
await promptBox.fill('Keep this draft while steering the oldest item.')
await promptBox.press('Control+Shift+Enter')
await originalTurn.getByText('Queue using the opposite shortcut.').waitFor()
check('steering the oldest queued item preserves the composer draft',
  await promptBox.inputValue() === 'Keep this draft while steering the oldest item.')
await page.setViewportSize({ width: 390, height: 844 })
await promptBox.fill('Queue using the touch action.')
const touchQueue = page.getByRole('button', { name: 'Queue', exact: true })
await touchQueue.click()
const touchRow = followUpRows.filter({ hasText: 'Queue using the touch action.' })
const touchSendNow = touchRow.getByRole('button', { name: 'Send now', exact: true })
await touchSendNow.waitFor()
check('the phone exposes the alternate action without horizontal page scrolling',
  await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await capture('steering-touch-alternate')
await touchSendNow.click()
await originalTurn.getByText('Queue using the touch action.').waitFor()
await page.setViewportSize({ width: 1280, height: 800 })
await promptBox.fill('Unconfirmed steering fixture.')
await page.getByRole('button', { name: 'Steer', exact: true }).click()
const unconfirmed = followUpRows.filter({ hasText: 'Unconfirmed steering fixture.' })
await unconfirmed.getByText('Delivery unconfirmed').waitFor()
await page.getByRole('button', { name: 'Stop', exact: true }).click()
await unconfirmed.getByRole('button', { name: 'Send again', exact: true }).waitFor()
check('an ambiguous steer needs an explicit resend', !await page.locator('[data-resume-queue]').isVisible()
  && steeringCalls.filter(text => text === 'Unconfirmed steering fixture.').length === 1)
await capture('steering-unconfirmed')


await page.goto(`${baseUrl}/s/${steerSessionId}`)
const threadActionsTrigger = page.locator('[data-thread-actions-trigger]')
const threadActions = page.getByRole('dialog', { name: 'Thread actions' })
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Rename thread', exact: true }).click()
await threadActions.getByRole('textbox', { name: 'Title' }).fill('Parity release review')
await threadActions.getByRole('button', { name: 'Rename', exact: true }).click()
await page.getByRole('button', { name: 'Parity release review', exact: true }).waitFor()
const pinnedThreads = page.locator('[data-section-id^="pinned-"] [data-sidebar-item]')
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Pin thread', exact: true }).click()
await pinnedThreads.getByText('Parity release review', { exact: true }).waitFor()
await capture('thread-pinned')

await page.goto(`${baseUrl}/s/${sessionId}`)
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Pin thread', exact: true }).click()
const otherPin = pinnedThreads.and(page.locator(`[href="/s/${sessionId}"]`))
await otherPin.waitFor()
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Move up', exact: true }).click()
await pinnedThreads.first().and(otherPin).waitFor()
check('pinning and moving a thread changes durable sidebar order', true)

await page.goto(`${baseUrl}/s/${steerSessionId}`)
await page.setViewportSize({ width: 390, height: 844 })
await threadActionsTrigger.click()
await threadActions.waitFor()
check('thread actions fit under the phone header without horizontal page scrolling', await page.evaluate(() => {
  const bounds = document.querySelector('#harness-thread-actions')?.getBoundingClientRect()
  const anchor = document.querySelector('[data-thread-actions-trigger]')?.getBoundingClientRect()
  return !!bounds && !!anchor && bounds.top >= anchor.bottom && bounds.left >= 0 && bounds.right <= innerWidth
    && document.documentElement.scrollWidth === innerWidth
}))
await capture('thread-actions-phone')
await page.keyboard.press('Escape')
await threadActions.waitFor({ state: 'hidden' })
check('closing thread actions returns focus to its button', await threadActionsTrigger.evaluate(button => button === document.activeElement))
await page.setViewportSize({ width: 1280, height: 800 })
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Snooze', exact: true }).click()
await threadActions.getByRole('button', { name: /^In 1 hour/ }).waitFor()
await threadActions.getByRole('button', { name: /^In 3 hours/ }).waitFor()
const snoozeChoices = threadActions.locator('#thread-snooze-form')
check('snooze opens beside the desktop thread menu', await snoozeChoices.evaluate(panel => {
  const menu = panel.closest('dialog')?.getBoundingClientRect()
  const bounds = panel.getBoundingClientRect()
  const choice = panel.querySelector('button')?.getBoundingClientRect()
  return Boolean(menu && choice && bounds.left >= menu.right - 2 && bounds.right <= innerWidth
    && panel.contains(document.elementFromPoint(choice.x + choice.width / 2, choice.y + choice.height / 2)))
}))
await capture('thread-snooze-presets')
await page.setViewportSize({ width: 360, height: 800 })
await page.waitForFunction(() => document.querySelector('#harness-thread-actions')?.getAttribute('data-snooze-side') === 'false')
check('snooze stays inside the thread menu on a phone', await snoozeChoices.evaluate(panel => {
  const menu = panel.closest('dialog')?.getBoundingClientRect()
  const bounds = panel.getBoundingClientRect()
  return Boolean(menu && bounds.left >= menu.left && bounds.right <= menu.right && bounds.right <= innerWidth)
}))
await capture('thread-snooze-phone')
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForFunction(() => document.querySelector('#harness-thread-actions')?.getAttribute('data-snooze-side') === 'true')
await threadActions.getByRole('button', { name: 'Custom wake time' }).click()
await threadActions.getByLabel('Wake after').selectOption('minutes')
await threadActions.getByRole('spinbutton', { name: 'Wake duration' }).fill('20')
const earliestWake = Date.now() + 20 * 60_000
await threadActions.getByRole('button', { name: 'Set wake time' }).click()
const snoozedThread = page.locator('[data-section-id^="snoozed-"]').getByText('Parity release review', { exact: true })
await snoozedThread.waitFor()
const wake = harness.engine.current.sessions.get(steerSessionId)?.navigation?.snoozedUntil
check('custom snooze duration starts when the wake is confirmed',
  typeof wake === 'number' && wake >= earliestWake && wake < earliestWake + 10000)
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Wake thread', exact: true }).click()
await pinnedThreads.getByText('Parity release review', { exact: true }).waitFor()
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Snooze', exact: true }).click()
await threadActions.getByRole('button', { name: /^In 1 hour/ }).click()
await snoozedThread.waitFor()
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Wake thread', exact: true }).click()
await pinnedThreads.getByText('Parity release review', { exact: true }).waitFor()
check('snooze and manual wake restore the original pin', true)

await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Archive thread', exact: true }).click()
await page.locator('[data-thread-archived]').waitFor()
await page.locator('[data-composer]').waitFor({ state: 'hidden' })
check('archiving keeps the old link readable and removes the thread from navigation',
  !await page.locator(`[data-sidebar-item][href="/s/${steerSessionId}"]`).count())
await page.keyboard.press('Control+k')
await searchDialog.waitFor()
await threadSearch.fill('Parity release review')
await searchDialog.getByText('No matching threads.').waitFor()
await page.keyboard.press('Escape')
await searchDialog.waitFor({ state: 'hidden' })
await page.keyboard.press('Meta+,')
await settingsDialog.waitFor()
await settingsNavigation.getByRole('button', { name: 'Archive' }).click()
const archivedThread = settingsDialog.locator(`[data-archived-thread="${steerSessionId}"]`)
await archivedThread.getByRole('link', { name: 'Parity release review' }).waitFor()
await capture('thread-archive-settings')
await archivedThread.getByRole('button', { name: 'Restore', exact: true }).click()
await archivedThread.waitFor({ state: 'hidden' })
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(url => url.pathname === `/s/${steerSessionId}`)
await page.locator('[data-thread-archived]').waitFor({ state: 'hidden' })
await page.locator('[data-composer]').waitFor()
await pinnedThreads.getByText('Parity release review', { exact: true }).waitFor()
check('search omits an archived thread and settings restores it to its old pin', true)

const conversationFind = page.getByRole('search', { name: 'Find in thread' })
const conversationQuery = conversationFind.getByRole('searchbox', { name: 'Find in thread' })
const findCount = conversationFind.locator('[data-find-counter]')
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Find in thread', exact: true }).click()
await page.waitForFunction(() => document.activeElement?.matches('[data-transcript-find] input[type="search"]') === true)
check('Find in thread opens from the title menu and focuses its input', true)
await conversationQuery.fill('ACTIVE STEERING')
await conversationFind.getByText('1/2', { exact: true }).waitFor()
check('the first result clears the find bar', await page.evaluate(() => {
  const bar = document.querySelector('[data-transcript-find]')?.getBoundingClientRect()
  const ranges = CSS.highlights?.get('harness-find-current')
  const active = ranges && [...ranges][0]?.getBoundingClientRect()
    || document.querySelector('[data-find-current]')?.getBoundingClientRect()
  return Boolean(bar && active && active.top >= bar.bottom)
}))
await conversationQuery.press('Enter')
await conversationFind.getByText('2/2', { exact: true }).waitFor()
await conversationFind.getByRole('button', { name: 'Next match' }).click()
await conversationFind.getByText('1/2', { exact: true }).waitFor()
await conversationQuery.press('Shift+Enter')
await conversationFind.getByText('2/2', { exact: true }).waitFor()
check('find counts the prompt and assistant match and wraps in both directions', true)
check('find paints the active result without changing text selection', await page.evaluate(() => {
  const selected = getSelection()?.toString() ?? ''
  return selected.length === 0 && (CSS.highlights?.get('harness-find-current')?.size === 1
    || Boolean(document.querySelector('[data-find-current]')))
}))
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width: width!, height: height! })
  check(`find controls fit at ${width}×${height}`, await conversationFind.evaluate(bar => {
    const bounds = bar.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth === innerWidth
  }))
  await capture(`find-in-thread-${width}x${height}`)
}
await conversationQuery.fill('[not a regular expression')
await conversationFind.getByText('0/0', { exact: true }).waitFor()
check('unmatched literal punctuation disables navigation',
  await conversationFind.getByRole('button', { name: 'Previous match' }).isDisabled())
await conversationQuery.press('Escape')
await conversationFind.waitFor({ state: 'hidden' })
check('closing find restores focus and removes its highlights',
  await threadActionsTrigger.evaluate(button => button === document.activeElement && !CSS.highlights?.has('harness-find-current')))
await page.keyboard.press('Control+f')
await conversationQuery.waitFor()
check('Control+F reopens find with cleared results', await findCount.textContent() === '')
await conversationFind.getByRole('button', { name: 'Close find' }).click()

{
  using db = new Database(databasePath)
  db.query('INSERT INTO provider_instances (id, profile_id, driver_kind, config, resolved_home) VALUES (?, ?, ?, ?, ?)')
    .run(4, providerProfileId, 'codex', '{"name":"Catalog fixture"}', 'model-fixture-home')
}
await page.goto(`${baseUrl}/?workspace=${workspaceId}`)
await page.setViewportSize({ width: 1280, height: 800 })
const draftPicker = page.getByRole('button', { name: 'Choose agent and model' })
const draftDialog = page.getByRole('dialog', { name: 'Agent and model' })
const draftSearch = draftDialog.getByRole('combobox', { name: 'Search models' })
await draftPicker.click()
await draftDialog.getByRole('button', { name: /Codex.*Catalog fixture/ }).click()
check('browsing a named account exposes its own model catalog',
  await draftDialog.getByRole('option', { name: 'Fixture Fast' }).isVisible()
  && await draftDialog.getByRole('option', { name: 'Fixture Default' }).count() === 0)
await draftSearch.fill('No such model')
await draftDialog.getByText('No matching models').waitFor()
await draftSearch.press('Escape')
await draftDialog.waitFor({ state: 'hidden' })
check('Escape returns focus after browsing and leaves the draft selection unchanged',
  await draftPicker.evaluate(button => button === document.activeElement && !button.textContent?.includes('Fixture Fast')))
await draftPicker.click()
await draftSearch.fill('fixture-fast')
await draftDialog.getByRole('option', { name: /Fixture Fast/ }).waitFor()
await draftSearch.press('ArrowDown')
check('model search keeps keyboard focus on the combobox and exposes the highlighted result',
  await draftSearch.evaluate(input => {
    const option = document.getElementById(input.getAttribute('aria-activedescendant') ?? '')
    return input === document.activeElement && option?.textContent?.includes('Fixture Fast') === true
  }))
await draftSearch.press('Enter')
await draftDialog.getByRole('button', { name: 'High', exact: true }).click()
await draftDialog.getByRole('button', { name: 'Fast', exact: true }).click()
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const fitted = await page.waitForFunction(() => {
    const box = document.querySelector('[data-draft-model-dialog]')?.getBoundingClientRect()
    return !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
  }, undefined, { timeout: 2000 }).then(() => true, () => false)
  check(`the model picker stays within the ${width}×${height} viewport`, fitted)
  if (width <= 390) {
    const accountVisible = await page.waitForFunction(() => {
      const strip = document.querySelector('[data-draft-model-accounts]')
      const account = strip?.querySelector('[data-draft-model-account][aria-pressed="true"]')
      if (!strip || !account) return false
      const bounds = strip.getBoundingClientRect()
      const selected = account.getBoundingClientRect()
      const left = bounds.left + strip.clientLeft
      return selected.left >= left - 1 && selected.right <= left + strip.clientWidth + 1
    }, undefined, { timeout: 2000 }).then(() => true, () => false)
    check(`the selected named account is visible at ${width}px`, accountVisible)
  }
  await capture(`model-picker-${width}x${height}`)
}
await page.setViewportSize({ width: 360, height: 470 })
check('the model search and dismissal stay reachable in a short phone viewport',
  await draftDialog.evaluate(dialog => {
    const search = dialog.querySelector('[role="combobox"]')?.getBoundingClientRect()
    const done = dialog.querySelector('footer button')?.getBoundingClientRect()
    return !!search && !!done && search.top >= 0 && done.bottom <= innerHeight
  }))
await page.setViewportSize({ width: 360, height: 800 })
await draftDialog.getByRole('button', { name: 'Done' }).click()
check('the selected model and send fit in the narrow composer', await page.evaluate(() => {
  const composer = document.querySelector('[data-composer]')?.getBoundingClientRect()
  return !!composer && [...document.querySelectorAll('[data-model-picker-trigger], [data-send]')].every((control) => {
    const bounds = control.getBoundingClientRect()
    return bounds.width > 0 && bounds.left >= composer.left && bounds.right <= composer.right
  }) && document.documentElement.scrollWidth === innerWidth
}))
check('the draft prompt, composer and project controls stay grouped on a phone', await page.evaluate(() => {
  const intro = document.querySelector('[data-empty-state]')?.getBoundingClientRect()
  const composer = document.querySelector('[data-composer]')?.getBoundingClientRect()
  const context = document.querySelector('[data-draft-context]')?.getBoundingClientRect()
  return Boolean(intro && composer && context && intro.bottom <= composer.top
    && composer.top - intro.bottom <= 32 && composer.bottom <= context.top && context.bottom < innerHeight * 0.8)
}))
await capture('named-model-draft-phone')
await page.setViewportSize({ width: 1280, height: 800 })
await capture('named-model-draft-desktop')
await page.locator('[data-prompt]').fill('Use the selected named model.')
await page.locator('[data-send]').click()
await page.waitForURL(/\/s\/\d+/, { timeout: 8000 })
await page.locator('[data-turn]').getByText('Use the selected named model.').waitFor()
const catalogSession = harness.engine.current.sessions.get(Number(new URL(page.url()).pathname.split('/').at(-1)))
check('a new thread launches with the selected account, model and turn options',
  catalogSession?.providerInstanceId === 4 && catalogSession.model === 'fixture-fast' && fixtureCodexLaunchModel === 'fixture-fast'
  && catalogSession.codexTurnOptions?.effort === 'high' && catalogSession.codexTurnOptions.serviceTier === 'fast'
  && fixtureCodexLaunchOptions?.effort === 'high' && fixtureCodexLaunchOptions.serviceTier === 'fast')

check('browser reported no script errors', pageErrors.length === 0)
for (const error of pageErrors) console.error('PAGEERROR:', error)
await browser.close()
harness.stop()

const failed = checks.filter(([, ok]) => !ok)
if (screenshotDir) {
  writeFileSync(join(screenshotDir, 'manifest.json'), JSON.stringify({
    fixture: 'project-onboarding-and-thread',
    evidence: 'browser fixture',
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    workingTreeModified: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    platform: process.platform,
    osRelease: release(),
    browser: browserName,
    browserVersion: browser.version(),
    colorScheme,
    reducedMotion,
    captures,
    checks: checks.map(([name, passed]) => ({ name, passed })),
  }, null, 2) + '\n')
}
console.log(failed.length === 0 ? 'PAGE DRIVE: PASS' : `PAGE DRIVE: FAIL (${failed.length})`)
process.exit(failed.length === 0 ? 0 : 1)
