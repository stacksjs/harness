/**
 * Desktop drive: the terminal in a real Craft window (M6's last open piece).
 *
 * Spawns the actual Zig-built craft binary on a live session page and drives
 * it with OS-level keystrokes (System Events, so this needs a GUI session and
 * Accessibility permission — it is a dev-machine check, not a CI job). The
 * proof is a side effect: Ctrl+` opens the terminal, a command typed through
 * the window writes a computed marker to disk, and the file appearing proves
 * the whole chain — WKWebView -> island -> socket -> PTY -> shell.
 *
 * Run from the repo root: bun --config=/dev/null scripts/drive-desktop.ts
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '/Users/glennmichaeltorregosa/Documents/Stacks/harness/packages/contract/src/index.ts'
import { serve } from '/Users/glennmichaeltorregosa/Documents/Stacks/harness/packages/server/src/index.ts'

const CRAFT = [
  process.env.CRAFT_BIN,
  join(homedir(), 'Documents/Projects/craft/packages/zig/zig-out/bin/craft'),
  join(homedir(), 'Code/Tools/craft/packages/zig/zig-out/bin/craft'),
].filter((c): c is string => Boolean(c)).find(c => existsSync(c))

if (!CRAFT) {
  console.error('No craft binary; set CRAFT_BIN or build the zig checkout.')
  process.exit(1)
}

function osascript(script: string): string {
  return execSync('osascript', { input: script, encoding: 'utf8' }).trim()
}

// --- workspace + db, the page drive's seeding
const dir = mkdtempSync(join(tmpdir(), 'harness-desktop-drive-'))
execSync('git init -q', { cwd: dir })
const { Database } = await import('bun:sqlite')
const db = new Database(join(dir, 'h.sqlite'))
db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE turns (id INTEGER PRIMARY KEY AUTOINCREMENT)')
db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, turn_id INTEGER, seq INTEGER NOT NULL, type TEXT NOT NULL, payload TEXT, command_id TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
db.exec('CREATE TABLE command_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE, seqs TEXT, at INTEGER, created_at TEXT, updated_at TEXT, uuid TEXT)')
db.close()

const port = 3981
const harness = await serve({ port, databasePath: join(dir, 'h.sqlite') })
const ws = new WebSocket(`ws://localhost:${port}/ws`)
ws.binaryType = 'arraybuffer'
await new Promise(r => (ws.onopen = r))
const cmd = (id: string, command: unknown) => ws.send(encode({ t: 'dispatch', envelope: { id, at: Date.now(), command } }))
cmd('p', { type: 'profile.create', name: 'Desk' }); await Bun.sleep(150)
const profileId = [...harness.engine.current.profiles.keys()][0]
cmd('w', { type: 'workspace.add', profileId, path: dir }); await Bun.sleep(150)
const workspaceId = [...harness.engine.current.workspaces.keys()][0]
cmd('t', { type: 'workspace.trust', workspaceId, trusted: true }); await Bun.sleep(150)
cmd('s', { type: 'session.create', workspaceId, driverKind: 'claude' }); await Bun.sleep(300)
const sessionId = [...harness.engine.current.sessions.keys()][0]

// --- the window
const marker = join(dir, 'desktop-terminal-proof.txt')
const child = spawn(CRAFT, [
  '--url', `http://127.0.0.1:${port}/s/${sessionId}`,
  '--title', 'harness-desktop-drive',
  '--width', '1100',
  '--height', '760',
], { stdio: 'ignore', detached: true })

const checks: Array<[string, boolean]> = []
function check(name: string, ok: boolean): void {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

try {
  // Window up and frontmost. The process name is the binary's.
  let appeared = false
  for (let i = 0; i < 40 && !appeared; i++) {
    await Bun.sleep(250)
    try {
      appeared = osascript('tell application "System Events" to (count of windows of process "craft") > 0') === 'true'
    }
    catch { /* process not there yet */ }
  }
  check('craft window appeared', appeared)

  if (appeared) {
    osascript('tell application "System Events" to set frontmost of process "craft" to true')
    // The page needs a moment past window-creation to hydrate the island.
    await Bun.sleep(2500)
    // Informational, not a check: this readback reports false on this craft
    // build even while keystrokes demonstrably land in the page — the two
    // checks below are the ground truth for delivery.
    const frontmost = osascript('tell application "System Events" to get frontmost of process "craft"')
    console.log(`  (frontmost readback: ${frontmost})`)

    // Ctrl+` — key code 50 is the backtick key.
    osascript('tell application "System Events" to key code 50 using control down')
    await Bun.sleep(1200)

    // The chord's first observable server-side effect: term-open spawns the
    // PTY, which runs the shell under script(1).
    let ptySpawned = false
    for (let i = 0; i < 12 && !ptySpawned; i++) {
      await Bun.sleep(250)
      try {
        execSync('pgrep -f "script -q /dev/null"', { stdio: 'pipe' })
        ptySpawned = true
      }
      catch { /* not yet */ }
    }
    check('Ctrl+` reached the page and opened a PTY', ptySpawned)

    // Typed into the focused terminal host; the value is computed by the
    // shell, so the file proves execution, not echo.
    osascript(`tell application "System Events" to keystroke "echo dt-$((40+5)) > ${marker}"`)
    await Bun.sleep(300)
    osascript('tell application "System Events" to key code 36') // Return

    let proven = false
    for (let i = 0; i < 40 && !proven; i++) {
      await Bun.sleep(250)
      proven = existsSync(marker) && readFileSync(marker, 'utf8').includes('dt-45')
    }
    check('terminal in the craft window executed through the PTY', proven)
  }
}
finally {
  try { process.kill(-child.pid!, 'SIGKILL') }
  catch { try { child.kill('SIGKILL') } catch {} }
  harness.stop()
}

const failed = checks.filter(([, ok]) => !ok)
console.log(failed.length === 0 ? 'DESKTOP DRIVE: PASS' : `DESKTOP DRIVE: FAIL (${failed.length})`)
process.exit(failed.length === 0 ? 0 : 1)
