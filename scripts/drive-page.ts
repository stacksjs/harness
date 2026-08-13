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
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { chromium } from 'playwright-core'
import { encode } from '../packages/contract/src/index'
import { serve } from '../packages/server/src/index'

const checks: Array<[string, boolean]> = []
function check(name: string, ok: boolean): void {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

// --- workspace: a real repo with an uncommitted change, so the diff has content
const dir = mkdtempSync(join(tmpdir(), 'harness-page-drive-'))
writeFileSync(join(dir, 'notes.txt'), 'original\n')
execSync('git init -q && git add notes.txt && git -c user.email=t@t -c user.name=t commit -q -m init', { cwd: dir })

// --- db schema
const { Database } = await import('bun:sqlite')
const db = new Database(join(dir, 'h.sqlite'))
db.exec('PRAGMA foreign_keys = ON')
db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
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
  async *startTurn() {
    for (const event of script) {
      yield event
      if (event.type === 'approval-request') await gate
    }
  },
  async interrupt() {},
  async respondApproval(_id, allow) { if (allow) releaseGate() },
  async stop() {},
}
const driver: Driver = { kind: 'claude', async probe() { return { status: 'ready' } }, async create() { return instance } }

const port = 3973
const harness = await serve({ port, databasePath: join(dir, 'h.sqlite'), resolveDriver: () => driver })

// --- seed over the socket
const ws = new WebSocket(`ws://localhost:${port}/ws`)
ws.binaryType = 'arraybuffer'
await new Promise(r => (ws.onopen = r))
const cmd = (id: string, command: unknown) => ws.send(encode({ t: 'dispatch', envelope: { id, at: Date.now(), command } }))
cmd('d_p', { type: 'profile.create', name: 'Drive' })
await Bun.sleep(150)
const profileId = [...harness.engine.current.profiles.keys()][0]
cmd('d_w', { type: 'workspace.add', profileId, path: dir })
await Bun.sleep(150)
const workspaceId = [...harness.engine.current.workspaces.keys()][0]
cmd('d_t', { type: 'workspace.trust', workspaceId, trusted: true })
await Bun.sleep(150)
cmd('d_s', { type: 'session.create', workspaceId, driverKind: 'claude' })
await Bun.sleep(300)
const sessionId = [...harness.engine.current.sessions.keys()][0]

// --- browser
const executablePath = process.env.PLAYWRIGHT_CHROMIUM
  ?? join(homedir(), 'Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage()
page.on('dialog', async d => d.accept())
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)))
await page.goto(`http://localhost:${port}/s/${sessionId}`)

// 1. Composer: type a prompt, send, watch the turn stream in.
await page.fill('[data-prompt]', 'run the drive turn')
await page.click('[data-send]')
await page.waitForFunction(() => document.querySelector('[data-approval]')?.hasAttribute('hidden') === false, undefined, { timeout: 8000 })
check('composer starts a turn and the approval surfaces', true)
const tool = await page.textContent('[data-approval-tool]')
check('approval names the tool', (tool ?? '').includes('Bash'))

// 2. Approve: the gated turn resumes, streams, and completes.
await page.click('[data-approve]')
await page.waitForFunction(() => (document.querySelector('[data-live-response]')?.textContent ?? '').includes('done.'), undefined, { timeout: 8000 })
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

await page.screenshot({ path: join(import.meta.dir, 'page-drive.png') })
await browser.close()
harness.stop()

const failed = checks.filter(([, ok]) => !ok)
console.log(failed.length === 0 ? 'PAGE DRIVE: PASS' : `PAGE DRIVE: FAIL (${failed.length})`)
process.exit(failed.length === 0 ? 0 : 1)
