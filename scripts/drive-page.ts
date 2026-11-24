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
import { encode } from '../packages/contract/src/index'
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
    for (const event of script) {
      if (event.type === 'approval-request' && input.text !== 'run the drive turn') continue
      // A beat before the first token, so the thinking indicator has a
      // deterministic window to be seen in.
      if (event.type === 'assistant-delta') await new Promise(r => setTimeout(r, 300))
      yield event
      if (event.type === 'approval-request') await gate
    }
  },
  async interrupt() {},
  async respondApproval(_id, allow) { if (allow) releaseGate() },
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
const signedOutDriver: Driver = { ...driver, kind: 'codex', async probe() { return { status: 'unauthenticated' } } }

const port = Number(process.env.HARNESS_DRIVE_PORT ?? 3973)
const harness = await serve({
  port, databasePath, scratchDirectory, chatGptCredentialDirectory: join(driveRoot, 'credentials'),
  resolveDriver: kind => kind === 'codex' ? signedOutDriver : driver,
})
const baseUrl = `http://localhost:${port}`
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
await page.keyboard.press('Escape')
check('mobile closes navigation and returns focus to its toggle', await page.locator('[data-sidebar-toggle]').evaluate(el => el === document.activeElement))
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
await page.keyboard.press('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
check('Cmd+, opens the settings modal', true)
await page.selectOption('#settings-driver', 'opencode')
await page.locator('[data-settings-modal]').getByRole('button', { name: 'Done' }).click()
const storedDriver = await page.evaluate(() => localStorage.getItem('harness.defaultDriver'))
check('driver choice persists', storedDriver === 'opencode')
await page.evaluate(() => window.dispatchEvent(new CustomEvent('craft:settings')))
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
const reopenedShowsChoice = await page.evaluate(() => (document.querySelector('#settings-driver') as HTMLSelectElement | null)?.value)
check('menu event reopens settings with the saved choice', reopenedShowsChoice === 'opencode')
const accessSection = await page.evaluate(() => document.querySelector('[data-settings-modal]')?.textContent ?? '')
check('settings shows the access section honestly', accessSection.includes('No devices are paired') && accessSection.includes('--remote'))
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
check('Esc closes the settings modal', true)
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
await page.selectOption('[data-driver-picker]', 'claude:2')
await page.fill('[data-prompt]', 'typed with no session open')
await page.click('[data-send]')
await page.waitForURL(/\/s\/\d+/, { timeout: 8000 })
await page.waitForFunction(() => (document.body.textContent ?? '').includes('typed with no session open'), undefined, { timeout: 8000 })
const newSessionId = Number(new URL(page.url()).pathname.split('/').at(-1))
check('type-to-start delivers the prompt in the selected workspace', harness.engine.current.sessions.size === 3
  && harness.engine.current.sessions.get(newSessionId)?.workspaceId === secondWorkspaceId
  && harness.engine.current.sessions.get(newSessionId)?.providerInstanceId === 2)

// 12. The account corner: the header's person icon opens the same settings.
await page.click('[data-account-button]')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
check('the account icon opens settings', true)
const backgroundCanFocus = await page.locator('[data-account-button]').evaluate((button: HTMLElement) => {
  button.focus()
  return document.activeElement === button
})
check('modal settings make the background inert', !backgroundCanFocus)
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
check('closing settings returns focus to its trigger', await page.locator('[data-account-button]').evaluate(button => document.activeElement === button))

// 13. The Agents section: each CLI's live status, and a Log in button that
// runs the CLI's login flow against the fixture executable in the terminal.
await page.click('[data-account-button]')
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
await page.locator('[data-account-button]').click()
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
check('appearance selection survives reload', await appearancePicker.getByRole('radio', { name: manualLabel }).getAttribute('aria-checked') === 'true')
await appearancePicker.getByRole('radio', { name: manualLabel }).press('End')
await page.waitForFunction(scheme => document.documentElement.classList.contains('dark') === (scheme === 'dark'), colorScheme)
check('keyboard selection returns Craft to its inherited appearance', await systemAppearance.getAttribute('aria-checked') === 'true'
  && await page.evaluate(() => (window as any).__windowAppearance === 'system'))
await page.keyboard.press('Escape')

if (screenshotDir) {
  await capture('workspace-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('workspace-mobile')
  await page.locator('[data-account-button]').click()
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
