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
import type { ConversationRewindInput, Driver, ForkInput, ProviderEvent, ProviderInstance, StartTurnInput } from '../packages/drivers/src/types'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import process from 'node:process'
import { chromium, webkit } from 'playwright-core'
import { decode, encode } from '../packages/contract/src/index'
import { PREVIEW_THREAD_ENV } from '../packages/drivers/src/index'
import { derivedId } from '../packages/engine/src/index'
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
const fixtureEditorArgs = join(fixtureBin, 'editor-args')
async function editorReceived(expected: string): Promise<boolean> {
  const deadline = Date.now() + 4_000
  do {
    if (existsSync(fixtureEditorArgs) && readFileSync(fixtureEditorArgs, 'utf8') === expected) return true
    await Bun.sleep(20)
  } while (Date.now() < deadline)
  return false
}
writeFileSync(join(fixtureBin, 'codex'), '#!/bin/sh\nprintf "Codex test sign-in\\n"\n', { mode: 0o755 })
writeFileSync(join(fixtureBin, 'code'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "${0%/*}/editor-args"\n', { mode: 0o755 })
writeFileSync(fixtureShell, '#!/bin/sh\nif [ "$#" -gt 0 ]; then exec /bin/sh "$@"; fi\nprintf "Harness test terminal\\n"\nexec /bin/sh -i\n', { mode: 0o755 })
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
const referenceLink = '[parity-notes (draft).md](fixture%20context/parity-notes%20%28draft%29.md)'
let fixtureMentionContents: string | undefined
const fixtureHandoffs: StartTurnInput[] = []
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
const idleClaudeDelivery: Array<[string, string | undefined]> = []
const freshClaudeCalls: StartTurnInput[] = []
const releaseFreshClaudeTurn = Promise.withResolvers<void>()
let freshClaudeConversation = 0
const claudeForks: ForkInput[] = []
const claudeForkTurns: StartTurnInput[] = []
const claudeRewindTurns: StartTurnInput[] = []
const claudeRewinds: ConversationRewindInput[] = []
const instance: ProviderInstance = {
  async rewind(input) {
    claudeRewinds.push(input)
    if (!input.providerSessionId.startsWith('fixture-claude-rewind-'))
      return { outcome: 'unchanged', message: 'The Claude fixture session does not own this cursor.' }
    return { outcome: 'rewound' }
  },
  async fork(input) {
    claudeForks.push(input)
    return { providerSessionId: `fixture-claude-fork-${claudeForks.length}`, copiedProviderTurnIds: { [input.providerTurnId!]: `copy-${claudeForks.length}` } }
  },
  async *compact(providerSessionId) {
    idleClaudeDelivery.push(['/compact', providerSessionId])
    yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, contextCompacted: true }
  },
  async *startTurn(input) {
    if (input.text.startsWith('Claude rewind fixture: ')) {
      const sequence = claudeRewindTurns.push(input)
      if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: `fixture-claude-rewind-${sequence}` }
      yield { type: 'assistant-delta', text: 'Claude reviewed the notes.' }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, providerTurnId: `claude-assistant-${sequence}` }
      return
    }
    if (input.text.startsWith('Claude fork fixture: ')) {
      claudeForkTurns.push(input)
      if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'fixture-claude-parent' }
      yield { type: 'assistant-delta', text: `Claude fork fixture response ${claudeForkTurns.length}.` }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, providerTurnId: `claude-turn-${claudeForkTurns.length}` }
      return
    }
    if (input.text.startsWith('Fresh session fixture: ')) {
      freshClaudeCalls.push(input)
      if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: `fresh-fixture-${++freshClaudeConversation}` }
      const phrase = input.text.slice('Fresh session fixture: '.length)
      if (phrase === 'hold the current turn') yield { type: 'steering-ready' }
      yield { type: 'assistant-delta', text: 'Fixture answer for ' + phrase }
      if (phrase === 'hold the current turn') await releaseFreshClaudeTurn.promise
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
    if (input.text.startsWith('Idle Claude fixture:')) {
      idleClaudeDelivery.push([input.text, input.providerSessionId])
      if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'idle-claude-fixture' }
      const warm = input.text === 'Idle Claude fixture: warm cache'
      const report = warm || input.text.startsWith('Idle Claude fixture: expired cache')
      yield { type: 'assistant-delta', text: report ? 'Fixture context recorded.' : 'Fixture continued.' }
      yield {
        type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0,
        ...(report ? { contextUsage: {
          usedTokens: 220_000, maxTokens: 1_000_000, promptCacheExpiresAt: Date.now() + (warm ? 1600 : -1000),
        } } : {}),
      }
      return
    }
    if (input.text.startsWith('Saved conversation history.')) {
      fixtureHandoffs.push(input)
      yield { type: 'session-bound', providerSessionId: `handoff-fixture-${fixtureHandoffs.length}` }
      yield { type: 'assistant-delta', text: 'I received the saved context.' }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
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
    if (input.text === 'exercise provider resume rejection') {
      yield { type: 'error', message: 'Codex could not resume this conversation. Check the selected account and retry. <div data-error-injection>' }
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
function importProjectFixture(workspace: string, name: string) {
  const source = join(driveRoot, 'api-import-source')
  writeFileSync(join(source, name), 'Only the upstream repository wrote this.\n')
  execFileSync('git', ['add', '--', name], { cwd: source })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', name], { cwd: source })
  execFileSync('git', ['pull', '-q', '--ff-only', 'fixture-upstream', 'review/fixture'], { cwd: join(workspace, 'api') })
}

const providerPreviewScript = join(driveRoot, 'provider-preview.ts')
const providerPreviewPort = join(driveRoot, 'provider-preview-port')
let providerPreviewProcess: Bun.Subprocess | undefined
const providerPreviewPrompt = 'Start the provider preview fixture.'

const driver: Driver = {
  kind: 'claude',
  async probe() { return { status: 'ready' } },
  async create(config) {
    if (config.workspacePath.startsWith(`${scratchDirectory}/`)) writeFileSync(join(config.workspacePath, 'kept.txt'), 'scratch fixture')
    return {
      ...instance,
      async *startTurn(input) {
        if (input.text === providerPreviewPrompt) {
          if (!config.previewOwner) throw new Error('Preview fixture did not get a thread tag')
          // Mirror a provider launching a separate command, with a shell that
          // can reap the listener on normal completion and test failure.
          const wrapper = 'trap \'kill "$child" 2>/dev/null\' TERM INT EXIT; "$@" & child=$!; wait "$child"'
          providerPreviewProcess = Bun.spawn(['/bin/sh', '-c', wrapper, 'provider-fixture', process.execPath, '--config=/dev/null', providerPreviewScript], {
            env: { ...process.env, [PREVIEW_THREAD_ENV]: config.previewOwner },
            stdout: 'ignore', stderr: 'inherit',
          })
          yield { type: 'assistant-delta', text: 'Started the development server.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          return
        }
        if (input.text === 'Import upstream changes without making edits.') {
          importProjectFixture(config.workspacePath, 'imported-only.txt')
          yield { type: 'assistant-delta', text: 'Upstream changes were imported without local edits.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          return
        }
        if (input.text === 'Verify the repositories without editing.') {
          yield { type: 'assistant-delta', text: 'The fixture was checked without edits.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          return
        }
        if (input.text.startsWith('Review both repositories in turn ')) {
          const sequence = input.text.slice(-1)
          if (sequence === '2') importProjectFixture(config.workspacePath, 'upstream [notes].txt')
          for (const [key, label] of [['api', 'API'], ['packages/web', 'Web']] as const) {
            const file = join(config.workspacePath, key, 'shared.txt')
            writeFileSync(file, `${readFileSync(file, 'utf8')}${label} edit from turn ${sequence}\n`)
          }
          yield { type: 'assistant-delta', text: `Recorded edits for turn ${sequence}.` }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
          return
        }
        if (input.text !== `Read ${referenceLink}`) {
          yield* instance.startTurn(input)
          return
        }
        const encodedPath = referenceLink.slice(referenceLink.lastIndexOf('](') + 2, -1)
        fixtureMentionContents = readFileSync(join(config.workspacePath, decodeURIComponent(encodedPath)), 'utf8')
        yield { type: 'assistant-delta', text: 'Referenced fixture read.' }
        yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      },
    }
  },
}
let fixtureCodexReady = false
const fixtureCodexTurns: StartTurnInput[] = []
const fixtureCodexCompactions: string[] = []
const releaseCodexCompaction = Promise.withResolvers<void>()
const fixtureCodexForks: ForkInput[] = []
const fixtureCodexRewinds: ConversationRewindInput[] = []
const releaseCodexFork = Promise.withResolvers<void>()
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
      }, ...(homeModel ? [{ id: 'fixture-balanced', name: 'Fixture Balanced', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'medium', speedTiers: [] }] : [])] } : {}),
    }
  },
  async create(config) {
    fixtureCodexLaunchModel = config.model
    fixtureCodexLaunchOptions = config.codexTurnOptions
    const created = await driver.create(config)
    let worktreeRewindTurns = 0
    return {
      ...created,
      async *startTurn(input) {
        const sequence = fixtureCodexTurns.push(input)
        if (input.text.startsWith('Rewind worktree fixture:')) {
          if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'rewind-worktree-fixture-thread' }
          worktreeRewindTurns++
          for (const key of ['api', 'packages/web']) {
            writeFileSync(join(config.workspacePath, key, 'shared.txt'), `Worktree fixture turn ${worktreeRewindTurns}\n`)
            if (worktreeRewindTurns === 2) writeFileSync(join(config.workspacePath, key, 'new-note.txt'), 'From the selected turn.\n')
          }
          yield { type: 'assistant-delta', text: 'Reviewed the checkout.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, providerTurnId: `fixture-turn-${sequence}` }
          return
        }
        if (input.text.startsWith('Rewind fixture:')) {
          if (!input.providerSessionId) yield { type: 'session-bound', providerSessionId: 'rewind-fixture-thread' }
          yield { type: 'assistant-delta', text: 'Reviewed the fixture.' }
          yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, providerTurnId: `fixture-turn-${sequence}` }
          return
        }
        for await (const event of created.startTurn(input)) {
          if (event.type === 'session-bound' && input.providerSessionId) continue
          if (event.type === 'turn-complete') {
            const nearlyFull = input.text === 'Record nearly full context usage.'
            yield {
              ...event, providerTurnId: `fixture-turn-${sequence}`,
              ...(nearlyFull ? { contextUsage: { usedTokens: 31_000, maxTokens: 32_000 } } : {}),
            }
          }
          else yield event
        }
      },
      async *compact(providerSessionId) {
        fixtureCodexCompactions.push(providerSessionId)
        await releaseCodexCompaction.promise
        yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0, contextCompacted: true }
      },
      async fork(input) {
        fixtureCodexForks.push(input)
        await releaseCodexFork.promise
        return { providerSessionId: 'ps-drive-fork' }
      },
      async rewind(input) {
        fixtureCodexRewinds.push(input)
        if (!['rewind-fixture-thread', 'rewind-worktree-fixture-thread'].includes(input.providerSessionId) || input.verifyOnly)
          return { outcome: 'uncertain', message: 'Unexpected fixture rewind.' }
        return { outcome: 'rewound' }
      },
    }
  },
}

const port = Number(process.env.HARNESS_DRIVE_PORT ?? 3973)
const startHarness = () => serve({
  port, databasePath, scratchDirectory, chatGptCredentialDirectory: join(driveRoot, 'credentials'),
  resolveDriver: kind => kind === 'codex' ? codexDriver : driver,
})
let harness = await startHarness()
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

async function capture(name: string, target = page): Promise<void> {
  if (!screenshotDir) return
  const viewport = target.viewportSize()
  if (!viewport) throw new Error('The screenshot drive requires an explicit viewport.')
  await target.screenshot({ path: join(screenshotDir, `${name}.png`), animations: 'disabled' })
  captures.push({ name, ...viewport })
}

const pageErrors: string[] = []
// Printed as it happens, not only counted at the end: an island that throws
// takes every later interaction with it down, and the drive then fails tens
// of checks later at something unrelated.
page.on('pageerror', (e) => {
  pageErrors.push(e.message)
  console.log('[pageerror]', e.message)
})

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
const headerChanges = page.locator('[data-header-pane][aria-controls="harness-changes"]')
const headerTerminal = page.locator('[data-header-terminal]')
check('mobile keeps the thread title and the two workspace tools in the header', await page.locator('[data-workspace-title]').isVisible()
  && await headerChanges.isVisible() && await headerTerminal.isVisible() && !await page.locator('[data-diff-toggle]').isVisible())
await workspaceActions.click()
check('mobile workspace actions expose Changes and Terminal and suspend the conversation controls',
  await page.locator('[data-diff-toggle]').isVisible() && await page.locator('[data-terminal-toggle]').isVisible()
  && await page.locator('[data-workspace-lane]').getAttribute('inert') !== null)
await capture('workspace-actions-mobile')
await page.keyboard.press('Escape')
check('Escape closes workspace actions and restores focus', await workspaceActions.getAttribute('aria-expanded') === 'false'
  && await workspaceActions.evaluate(el => el === document.activeElement))
await page.locator('[data-sidebar-toggle]').click()
await page.waitForFunction(() => document.querySelector('[data-harness-sidebar]')?.getAttribute('data-open') === 'true')
check('phone navigation drawer has search and Settings', await page.locator('[data-nav-search]').isVisible()
  && await page.locator('[data-nav-settings]').isVisible())
await capture('workspace-navigation-mobile')
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
const projectGroup = page.locator(`[data-section-id="project-${workspaceId}"]`)
const projectHeader = projectGroup.locator('[data-sidebar-section-header]')
const groupedThread = projectGroup.locator(`a[data-sidebar-item][href="/s/${sessionId}"]`)
check('the current thread is selected inside its project group', await projectHeader.isVisible() && await groupedThread.isVisible()
  && await groupedThread.getAttribute('aria-current') === 'page')
await projectHeader.click()
await groupedThread.waitFor({ state: 'hidden' })
await projectHeader.click()
await groupedThread.waitFor()
check('project disclosure removes and restores its child threads without navigating', page.url().endsWith(`/s/${sessionId}`))
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
    const elements = ['[data-workspace-header]', '[data-workspace-title]', '[data-composer]', '[data-send]']
    return document.documentElement.scrollWidth === innerWidth
      && elements.every((selector) => {
        const bounds = document.querySelector(selector)?.getBoundingClientRect()
        return Boolean(bounds && bounds.width > 0 && bounds.left >= 0 && bounds.right <= innerWidth + 1)
      })
  }))
  check(`the model and send controls sit together at ${width}×${height}`, await page.evaluate(() => {
    const provider = document.querySelector('[data-composer-provider-controls]')?.getBoundingClientRect()
    const send = document.querySelector('[data-send]')?.getBoundingClientRect()
    return Boolean(provider && send && provider.right <= send.left && send.left - provider.right <= 12
      && Math.abs((send.top + send.bottom) - (provider.top + provider.bottom)) <= 2)
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
check('desktop docks Changes beside the conversation', await page.evaluate(() => {
  const changes = document.querySelector('[data-diff]')?.getBoundingClientRect()
  const conversation = document.querySelector('[data-workspace-lane]')?.getBoundingClientRect()
  return Boolean(changes && conversation && conversation.width > 0 && changes.left >= conversation.right)
}))
await capture('changes-docked-desktop')
const changesPane = page.getByRole('region', { name: 'Changes', exact: true })
const changedNotes = changesPane.getByRole('region', { name: 'Patch for notes.txt', exact: true })
await changedNotes.getByText('hello from the drive', { exact: true }).waitFor()
const splitChanges = changesPane.getByRole('button', { name: 'Split', exact: true })
const stackedChanges = changesPane.getByRole('button', { name: 'Stacked', exact: true })
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-stacked-${width}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
await splitChanges.click()
const splitReplacement = changedNotes.locator('[data-diff-row]').filter({ hasText: 'hello from the drive' })
await splitReplacement.locator('[data-kind="deletion"]').waitFor()
check('split diff aligns the original and replacement with the same line number',
  await splitReplacement.locator('[data-kind="deletion"] [data-diff-line-number]:visible').innerText() === '1'
  && await splitReplacement.locator('[data-kind="addition"] [data-diff-line-number]:visible').innerText() === '1')
await changedNotes.press('ArrowDown')
const selectionBefore = changedNotes.getByRole('button', { name: 'Before line 1', pressed: true })
await selectionBefore.waitFor()
await selectionBefore.press('ArrowRight')
const selectionAfter = changedNotes.getByRole('button', { name: 'After line 1', pressed: true })
await selectionAfter.waitFor()
check('the diff keyboard selects either side of a replacement', await selectionAfter.evaluate(button => button === document.activeElement))
await changesPane.getByRole('button', { name: 'Collapse all' }).click()
await changesPane.getByRole('button', { name: 'Copy line link' }).waitFor({ state: 'hidden' })
await changesPane.locator('[data-diff-file-toggle]').click()
await changedNotes.getByText('hello from the drive', { exact: true }).waitFor()
check('changed lines have readable contrast against their backgrounds', await splitReplacement.evaluate((row) => {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')!
  function luminance(color: string): number {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const channels = Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3), component => component / 255)
    const weights = [0.2126, 0.7152, 0.0722]
    return channels.reduce((sum, channel, index) => sum + weights[index]! * (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ), 0)
  }
  return [...row.querySelectorAll('[data-diff-cell]')].every((cell) => {
    const foreground = luminance(getComputedStyle(cell.querySelector('code')!).color)
    const background = luminance(getComputedStyle(cell).backgroundColor)
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5
  })
}))
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-split-${width}`)
  }
}
const diffLayoutObserver = await browserContext.newPage()
await diffLayoutObserver.goto(page.url())
await diffLayoutObserver.getByRole('button', { name: 'Show changes' }).click()
await diffLayoutObserver.locator('[data-diff-layout="split"]').waitFor()
await diffLayoutObserver.close()
check('the split layout preference carries to a new client tab', true)
await page.setViewportSize({ width: 390, height: 844 })
const wrapLines = changesPane.getByRole('button', { name: 'Wrap diff lines' })
await wrapLines.click()
await page.waitForFunction(() => {
  const patch = document.querySelector('[data-diff-lines]')
  return Boolean(patch && patch.scrollWidth > patch.clientWidth)
})
check('an unwrapped split patch scrolls locally on a phone',
  await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await wrapLines.click()
await stackedChanges.click()
await changedNotes.press('ArrowDown')
await selectionBefore.press('ArrowDown')
await selectionAfter.waitFor()
check('stacked keyboard navigation moves from a removed line to its replacement', true)
const collapseChanges = changesPane.getByRole('button', { name: 'Collapse all' })
await collapseChanges.focus()
await collapseChanges.press('Enter')
await changedNotes.waitFor({ state: 'hidden' })
check('collapsing the files leaves focus on the control',
  await collapseChanges.evaluate(button => button === document.activeElement && button.getAttribute('aria-disabled') === 'true'))
await changesPane.locator('[data-diff-file-toggle]').click()
await changedNotes.waitFor()
writeFileSync(join(dir, 'notes.txt'), 'hello after refreshing the patch\n')
await changesPane.getByRole('button', { name: 'Refresh changes' }).click()
await changedNotes.getByText('hello after refreshing the patch', { exact: true }).waitFor()
check('a manual refresh reloads in-place edits and keeps the file expanded', true)
writeFileSync(join(dir, 'notes.txt'), 'hello from the drive\n')
const reviewComparison = changesPane.getByRole('combobox', { name: 'Git comparison' })
await reviewComparison.selectOption('turn')
await changesPane.getByRole('status').getByText('No changes in turn 1.', { exact: true }).waitFor()
check('recorded turn review excludes a file edit made after completion', await changedNotes.isHidden())
check('the comparison picker has a full touch target at phone width', (await reviewComparison.boundingBox())!.height >= 44)
await capture('changes-recorded-turn-phone')
await reviewComparison.selectOption('session')
await changedNotes.getByText('hello from the drive', { exact: true }).waitFor()
const closeChanges = page.getByRole('button', { name: 'Close changes' })
await closeChanges.waitFor()
check('phone Changes owns the workspace while the patch stays visible', await page.locator('[data-diff-patch]').isVisible()
  && !await page.locator('[data-composer]').isVisible()
  && !await workspaceActions.isVisible()
  && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await capture('changes-workspace-phone')
await closeChanges.click()
await page.waitForFunction(() => document.activeElement?.matches('[data-workspace-actions-toggle]'))
await headerChanges.click()
await closeChanges.waitFor()
await closeChanges.click()
await page.waitForFunction(() => document.activeElement?.matches('[data-header-pane][aria-controls="harness-changes"]'))
check('closing Changes restores the phone composer and returns focus to the phone header',
  await page.locator('[data-composer]').isVisible() && await headerChanges.evaluate(button => button === document.activeElement))
await headerTerminal.click()
const phoneTerminal = page.locator('[data-terminal]')
await phoneTerminal.waitFor()
await page.waitForFunction(() => document.querySelector('[data-terminal-screen]')?.textContent?.includes('Harness test terminal'))
await page.keyboard.type('echo "phone-$(stty size | tr \' \' x)"')
await page.keyboard.press('Enter')
await page.waitForFunction(() => /phone-\d+x\d+/.test(document.querySelector('[data-terminal-screen]')?.textContent ?? ''))
const phoneColumns = await phoneTerminal.evaluate(el => Number(el.textContent?.match(/phone-\d+x(\d+)/)?.[1]))
await capture('workspace-terminal-phone')
await phoneTerminal.getByRole('button', { name: 'Hide terminal dock' }).click()
await page.waitForFunction(() => document.activeElement?.matches('[data-header-terminal]'))
check('phone Terminal opens directly and returns focus to the header', !await phoneTerminal.isVisible())
await page.setViewportSize({ width: 1280, height: 800 })

// 4. Terminal.
await page.click('[data-terminal-toggle]')
await page.waitForFunction(() => document.activeElement?.matches('[data-terminal-host]')
  && document.querySelector('[data-terminal-screen]')?.textContent?.includes('Harness test terminal'), undefined, { timeout: 8000 })
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
check('reopening the same PTY on desktop applies the desktop width', phoneColumns > 0 && colsBefore > phoneColumns)
if (!(colsAfter > 0 && colsAfter < colsBefore)) console.log('resize readings:', sizeBefore?.[0], '->', sizeAfter?.[0])
check('shrinking the window resizes the live PTY', colsAfter > 0 && colsAfter < colsBefore)
await page.setViewportSize({ width: 1280, height: 720 })
await page.keyboard.type('n=42; echo "kept-$n"')
await page.keyboard.press('Enter')
const terminalScreen = page.locator('[data-terminal-screen]')
const waitForTerminalLine = (line: string) => page.waitForFunction(expected =>
  document.querySelector('[data-terminal-screen]')?.textContent?.split('\n').some(row => row.trim() === expected), line)
await waitForTerminalLine('kept-42')
await page.reload()
await waitForTerminalLine('kept-42')
await page.locator('[data-terminal-host]').focus()
await page.keyboard.type('echo "still-$((n+2))"')
await page.keyboard.press('Enter')
await waitForTerminalLine('still-44')
check('terminal restores scrollback and the running shell on reload', true)
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await page.waitForFunction(() => {
      const host = document.querySelector('[data-terminal-host]')
      return host && host.scrollHeight - host.clientHeight - host.scrollTop < 25
    })
    await capture(`terminal-reconnected-${width}`)
  }
}
await page.setViewportSize({ width: 1280, height: 720 })
await page.keyboard.type('for i in $(seq 1 35); do echo "history-$i"; done')
await page.keyboard.press('Enter')
await waitForTerminalLine('history-35')
const terminalHost = page.locator('[data-terminal-host]')
const terminalShortcut = async (label: string): Promise<string> => {
  const chord = (await page.getByRole('button', { name: label, exact: true }).getAttribute('aria-keyshortcuts'))?.split(' ')[0]
  if (!chord) throw new Error(`Missing advertised shortcut for ${label}`)
  return chord
}
await page.keyboard.press('Control+Shift+Home')
await page.keyboard.type('echo "latest-$((40+5))"')
await page.keyboard.press('Enter')
await waitForTerminalLine('latest-45')
check('terminal preserves the reading position when new output arrives', await terminalHost.evaluate(host => host.scrollTop === 0))
await page.keyboard.press('Control+Shift+End')
check('terminal history shortcut returns to the newest output', await terminalHost.evaluate(host =>
  host.scrollHeight - host.clientHeight - host.scrollTop < 25))

// Reopen a storage entry from before tabs shipped, then run two live shells.
await page.evaluate(() => {
  const thread = location.pathname.split('/').at(-1)
  const key = `harness.terminal-tabs:${thread}`
  const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
  localStorage.setItem(`harness.terminal-session:${thread}`, JSON.stringify({ key: saved.activeKey, started: true }))
  localStorage.removeItem(key)
})
await page.reload()
await waitForTerminalLine('latest-45')
const firstTerminalTab = page.getByRole('tab', { name: 'Terminal 1', exact: true })
const secondTerminalTab = page.getByRole('tab', { name: 'Terminal 2', exact: true })
check('a terminal saved before tabs reopens as the first tab', await firstTerminalTab.getAttribute('aria-selected') === 'true')
await terminalHost.focus()
await page.keyboard.type('sleep 1; echo "away-$n"')
await page.keyboard.press('Enter')
await terminalHost.press(await terminalShortcut('New terminal'))
await waitForTerminalLine('Harness test terminal')
await page.keyboard.type('n=73; echo "second-$n"')
await page.keyboard.press('Enter')
await waitForTerminalLine('second-73')
check('the new-terminal shortcut opens a tab with its own output', await secondTerminalTab.getAttribute('aria-selected') === 'true'
  && !(await terminalScreen.textContent())?.includes('still-44'))
await page.reload()
await waitForTerminalLine('second-73')
check('terminal tabs restore the active shell on reload', await secondTerminalTab.getAttribute('aria-selected') === 'true')
await secondTerminalTab.press('ArrowLeft')
check('arrow keys move focus between terminal tabs', await firstTerminalTab.evaluate(tab => tab === document.activeElement))
await page.keyboard.press('Enter')
await waitForTerminalLine('away-42')
check('an inactive terminal keeps running and resumes its own output', await firstTerminalTab.getAttribute('aria-selected') === 'true'
  && !(await terminalScreen.textContent())?.includes('second-73'))
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`terminal-tabs-${width}`)
  }
}
await page.setViewportSize({ width: 1280, height: 720 })
await secondTerminalTab.click()
await waitForTerminalLine('second-73')
const endTerminal = page.getByRole('button', { name: 'End terminal session' })
const terminalCloseDialog = page.getByRole('alertdialog')
await endTerminal.click()
await terminalCloseDialog.getByRole('button', { name: 'Keep terminal', exact: true }).click()
await terminalCloseDialog.waitFor({ state: 'hidden' })
check('cancelling terminal close keeps the tab selected', await secondTerminalTab.getAttribute('aria-selected') === 'true')
await endTerminal.click()
await terminalCloseDialog.getByRole('button', { name: 'End terminal', exact: true }).click()
await terminalCloseDialog.waitFor({ state: 'hidden' })
await waitForTerminalLine('away-42')
check('ending one terminal selects the remaining live tab', await secondTerminalTab.count() === 0
  && await firstTerminalTab.getAttribute('aria-selected') === 'true')

const splitOutput = page.locator('[data-terminal-output]')
const terminalGroupPicker = page.getByRole('group', { name: 'Terminals in split' })
const splitColumns = page.getByRole('button', { name: 'Split terminal side by side' })
const splitRows = page.getByRole('button', { name: 'Split terminal top and bottom' })
const paneHost = (number: number) => page.getByLabel(`Terminal ${number} input and output`, { exact: true })
const typeInPane = async (number: number, command: string) => {
  await paneHost(number).focus()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}
const waitForPaneLine = (number: number, line: string) => page.waitForFunction(({ label, line }) =>
  Array.from(document.querySelectorAll('[data-terminal-host]')).some(host =>
    host.getAttribute('aria-label') === label && host.querySelector('[data-terminal-screen]')?.textContent?.includes(line)),
{ label: `Terminal ${number} input and output`, line })

await page.setViewportSize({ width: 1280, height: 800 })
const columnsKey = await terminalShortcut('Split terminal side by side')
await headerTerminal.press(columnsKey)
check('the split shortcut is scoped to terminal input', await paneHost(2).count() === 0)
await paneHost(1).press(columnsKey)
await waitForPaneLine(2, 'Harness test terminal')
await typeInPane(2, 'n=73; echo "split-$n"')
await waitForPaneLine(2, 'split-73')
await typeInPane(1, 'echo "left-$n"')
await waitForPaneLine(1, 'left-42')
const leftPane = await paneHost(1).boundingBox()
const rightPane = await paneHost(2).boundingBox()
check('side-by-side split panes have independent live shells and input', Boolean(leftPane && rightPane && leftPane.x + leftPane.width <= rightPane.x + 1)
  && !(await paneHost(2).textContent())?.includes('left-42') && !(await paneHost(1).textContent())?.includes('split-73'))
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`terminal-split-side-by-side-${width}`)
  }
  await page.setViewportSize({ width: 1280, height: 800 })
}

await page.reload()
await waitForPaneLine(1, 'left-42')
await waitForPaneLine(2, 'split-73')
check('reload restores both split PTYs and the active pane', await splitOutput.getAttribute('data-direction') === 'columns'
  && await terminalGroupPicker.getByRole('button', { name: 'Terminal 1' }).getAttribute('aria-pressed') === 'true')

await page.setViewportSize({ width: 360, height: 800 })
await terminalGroupPicker.getByRole('button', { name: 'Terminal 2' }).click()
await paneHost(2).waitFor({ state: 'visible' })
check('phone shows one full-width pane and keeps the other usable', !await paneHost(1).isVisible()
  && await paneHost(2).evaluate(host => host.clientWidth >= 320 && document.documentElement.scrollWidth <= innerWidth))
await typeInPane(2, 'echo "phone-$n"')
await waitForPaneLine(2, 'phone-73')
await capture('terminal-split-phone-360')

await page.setViewportSize({ width: 1280, height: 800 })
await paneHost(2).press(await terminalShortcut('Split terminal top and bottom'))
await waitForPaneLine(3, 'Harness test terminal')
const topPane = await paneHost(1).boundingBox()
const bottomPane = await paneHost(3).boundingBox()
check('top-and-bottom split keeps the existing panes and changes the group direction', await splitOutput.getAttribute('data-direction') === 'rows'
  && Boolean(topPane && bottomPane && topPane.y + topPane.height <= bottomPane.y + 1))
const terminalGrip = page.getByRole('separator', { name: 'Resize terminal dock' })
const terminalHeightBefore = (await phoneTerminal.boundingBox())?.height ?? 0
const grip = await terminalGrip.boundingBox()
if (!grip) throw new Error('Terminal resize handle was not visible')
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
await page.mouse.down()
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 136, { steps: 5 })
await page.mouse.up()
await terminalGrip.press('ArrowUp')
check('the terminal dock resizes by pointer and keyboard', (await terminalGrip.getAttribute('aria-valuenow')) === '51'
  && ((await phoneTerminal.boundingBox())?.height ?? 0) > terminalHeightBefore + 140)
await terminalGrip.press('End')
const enlargedHeight = await terminalGrip.getAttribute('aria-valuenow')
await page.waitForFunction(height => {
  const terminal = document.querySelector('[data-terminal]')
  return Boolean(terminal && terminal.getBoundingClientRect().height > height + 200)
}, terminalHeightBefore)
await typeInPane(3, 'set -- $(stty size); echo "tty-rows-$1"')
const paneRows = await page.waitForFunction(() => {
  const pane = document.querySelector('[aria-label="Terminal 3 input and output"] [data-terminal-screen]')
  return Number(pane?.textContent?.match(/tty-rows-(\d+)/)?.[1]) || false
})
check('enlarging the dock resizes the PTY inside its split pane', Number(await paneRows.jsonValue()) > 5)
await page.reload()
await waitForPaneLine(3, 'tty-rows-')
check('resized dock height and stacked orientation survive reload', await terminalGrip.getAttribute('aria-valuenow') === enlargedHeight
  && await splitOutput.getAttribute('data-direction') === 'rows')
await capture('terminal-split-stacked-1280')
await splitRows.click()
await waitForPaneLine(4, 'Harness test terminal')
check('the fifth pane is refused without disabling standalone tabs', await splitRows.isDisabled() && await splitColumns.isDisabled()
  && await page.getByRole('button', { name: 'New terminal', exact: true }).isEnabled())

await paneHost(4).focus()
await page.waitForFunction(() => {
  const file = (window as any).__menuSet?.menus?.find((menu: { label: string }) => menu.label === 'File')
  return file?.items?.some((item: { id?: string, shortcut?: string }) => item.id === 'terminal.close' && item.shortcut)
})
check('while terminal input is focused, the Craft menu routes close to the terminal', await page.evaluate(() => {
  const items = (window as any).__menuSet?.menus?.find((menu: { label: string }) => menu.label === 'File')?.items
  return !items?.find((item: { id?: string }) => item.id === 'close-window')?.shortcut
    && !items?.find((item: { id?: string }) => item.id === 'new-session')?.shortcut
}))
for (const number of [4, 3, 2]) {
  await paneHost(number).focus()
  if (number === 4) await page.evaluate(() => window.dispatchEvent(new CustomEvent('craft:menu:action', { detail: { id: 'terminal.close' } })))
  else await paneHost(number).press(await terminalShortcut('End terminal session'))
  await terminalCloseDialog.getByRole('button', { name: 'End terminal', exact: true }).click()
  await terminalCloseDialog.waitFor({ state: 'hidden' })
  await paneHost(number).waitFor({ state: 'detached' })
}
await waitForPaneLine(1, 'left-42')
check('closing split panes leaves the first PTY and its scrollback running', await firstTerminalTab.getAttribute('aria-selected') === 'true'
  && !await terminalGroupPicker.isVisible())

await paneHost(1).press('Control+D')
const restartTerminal = page.getByRole('button', { name: 'Restart terminal' })
await restartTerminal.waitFor({ state: 'visible' })
check('Control+D reaches the shell and exits a focused pane', await paneHost(1).count() === 1)
await restartTerminal.click()
await page.waitForFunction(() => document.activeElement?.matches('[data-terminal-host]')
  && document.querySelector('[data-terminal-screen]')?.textContent?.includes('Harness test terminal')
  && !document.querySelector('[data-terminal-screen]')?.textContent?.includes('[exited'))
check('an exited terminal can be restarted from its pane', !await restartTerminal.isVisible())
await endTerminal.click()
await terminalCloseDialog.getByRole('button', { name: 'End terminal', exact: true }).click()
await phoneTerminal.waitFor({ state: 'hidden' })
await page.waitForFunction(() => document.activeElement?.matches('[data-header-terminal]'))
await page.click('[data-terminal-toggle]')
await waitForTerminalLine('Harness test terminal')
check('ending a terminal clears its scrollback before the next launch', !(await terminalScreen.textContent())?.includes('still-44'))

// 9. Settings: the Cmd+, chord opens the modal, the driver choice persists,
// and the desktop menu's `craft:settings` event reaches the same modal.
const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
const settingsReturn = page.url()
/**
 * Press a window chord, once the page can answer one.
 *
 * The island reads the chords from a module it imports, so for the first
 * moments after a load there is a painted page that ignores them. A person
 * presses the chord again; a drive pressed it once, 30 seconds before failing
 * at something unrelated.
 */
async function pressChord(keys: string, target = page): Promise<void> {
  await target.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready', undefined, { timeout: 10000 })
  await target.keyboard.press(keys)
}

/** Wait for a host setting to land in the log, which the UI writes through. */
async function waitForHostSetting(driver: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.engine.current.settings.defaultDriver === driver) return true
    await page.waitForTimeout(50)
  }
  return false
}

/** Whether the thread search sheet is open right now, without waiting for it. */
const searchDialogVisible = (): Promise<boolean> =>
  page.evaluate(() => document.querySelector('[data-thread-search]')?.hasAttribute('open') === true)
await pressChord('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await page.waitForURL(url => url.pathname === '/settings/general')
check('Cmd+, opens the settings modal at its General route', true)
const terminalShellSetting = settingsDialog.getByLabel('Terminal shell')
check('new terminals default to the system shell', await terminalShellSetting.inputValue() === 'system')
await terminalShellSetting.selectOption('den')
await page.waitForFunction(async () => /terminalShell\\?["']\s*:\s*\\?["']den/.test(await fetch('/').then(response => response.text())))
await terminalShellSetting.selectOption('system')
await page.waitForFunction(async () => /terminalShell\\?["']\s*:\s*\\?["']system/.test(await fetch('/').then(response => response.text())))
check('terminal shell preference reaches the host and can be reset', await terminalShellSetting.inputValue() === 'system')
await page.selectOption('#settings-driver', 'opencode')
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(settingsReturn)
// The driver choice is the host's, not this browser's: it reaches the event
// log, so a client that was never told about it still reads it.
check('the driver choice reaches the host rather than this browser',
  await waitForHostSetting('opencode')
  && await page.evaluate(() => localStorage.getItem('harness.defaultDriver')) === null)
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
await pressChord('Meta+Shift+K')
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
await headerTerminal.focus()
await pressChord('Meta+K')
await page.waitForTimeout(250)
const staleChordOpened = await searchDialogVisible()
await pressChord('Meta+Shift+K')
const reboundSearch = page.getByRole('dialog', { name: 'Search threads' })
await reboundSearch.waitFor({ state: 'visible', timeout: 4000 })
check('the window answers the rebound chord and ignores the original', !staleChordOpened)
await page.keyboard.press('Escape')
await reboundSearch.waitFor({ state: 'hidden', timeout: 4000 })

// Reset all, so the rest of the drive runs on the documented defaults.
await pressChord('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await settingsNavigation.getByRole('button', { name: 'Keyboard' }).click()
await page.getByRole('button', { name: 'Reset all shortcuts' }).click()
await page.waitForFunction(() => localStorage.getItem('harness.keybindings.v1') === null, undefined, { timeout: 4000 })
check('resetting every shortcut clears the stored overrides',
  (await searchChord.textContent())?.trim() === defaultChord
  && await page.getByRole('button', { name: 'Reset all shortcuts' }).isDisabled())

const splitKeyRow = page.locator('[data-keybinding-row="terminal.split"]')
await splitKeyRow.getByRole('button', { name: 'Change' }).click()
await pressChord('Alt+Shift+H')
await page.waitForFunction(() => localStorage.getItem('harness.keybindings.v1') === '{"terminal.split":"Alt+Shift+H"}')
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(settingsReturn)
await page.reload()
await waitForTerminalLine('Harness test terminal')
await terminalHost.press(columnsKey)
check('rebinding a split replaces its default and updates the toolbar announcement',
  await paneHost(2).count() === 0 && await terminalShortcut('Split terminal side by side') === 'Alt+Shift+H')
await terminalHost.press('Alt+Shift+H')
await waitForPaneLine(2, 'Harness test terminal')
check('the rebound split works from terminal input after reload', await paneHost(1).isVisible())
await paneHost(2).press(await terminalShortcut('End terminal session'))
await terminalCloseDialog.getByRole('button', { name: 'End terminal', exact: true }).click()
await terminalCloseDialog.waitFor({ state: 'hidden' })
await paneHost(2).waitFor({ state: 'detached' })
await pressChord('Meta+,')
await settingsDialog.waitFor({ state: 'visible' })
await settingsNavigation.getByRole('button', { name: 'Keyboard' }).click()
await splitKeyRow.getByRole('button', { name: 'Reset' }).click()

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
check('a second client is served the host setting, not its own default',
  await settingsDeepLink.evaluate(() => (document.querySelector('#settings-driver') as HTMLSelectElement | null)?.value) === 'opencode')
await directSettings.getByRole('button', { name: 'Close settings' }).click()
await settingsDeepLink.waitForURL(url => url.pathname === new URL(settingsReturn).pathname)
await settingsDeepLink.close()

// Put the host back to the documented default, the way a person would, and
// confirm the client-scoped preferences did not follow the host setting into
// the log.
await pressChord('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await page.selectOption('#settings-driver', 'claude')
const hostReset = await waitForHostSetting('claude')
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(settingsReturn)
check('settings scope splits host preferences from this browser',
  hostReset
  && await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('harness.')).some(key => key.includes('defaultDriver'))) === false)

// 10. A named account can continue a thread without discarding its history.
const pickerState = await page.evaluate(async () => ({
  headerChip: document.querySelector('[data-session-driver]')?.textContent,
  probes: await fetch('/drivers').then(r => r.json()),
}))
check('header shows the session driver', pickerState.headerChip === 'claude')
check('driver probes answer for every kind', pickerState.probes.drivers.length === 5
  && pickerState.probes.drivers.every((d: any) => d.status === (d.kind === 'codex' ? 'unauthenticated' : 'ready')))
const sessionCountBeforeHandoff = harness.engine.current.sessions.size
const handoffDialog = page.getByRole('dialog', { name: 'Agent and model' })
const handoffPicker = page.locator('[data-model-picker-trigger]')
await handoffPicker.click()
await handoffDialog.getByRole('button', { name: /Claude Code.*Personal/ }).click()
await handoffDialog.getByRole('button', { name: 'Provider default', exact: true }).click()
await page.locator('[data-handoff-hint]').waitFor()
check('picking a different account stages the selection', harness.engine.current.sessions.get(sessionId)?.providerInstanceId === undefined)
await page.locator('[data-prompt]').fill('Continue with my named account.')
await page.reload()
await page.locator('[data-handoff-hint]').waitFor()
await page.locator('[data-send]').click()
await page.getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('sending the staged switch keeps the URL and opens a fresh provider conversation', new URL(page.url()).pathname === `/s/${sessionId}`
  && harness.engine.current.sessions.size === sessionCountBeforeHandoff
  && harness.engine.current.sessions.get(sessionId)?.providerInstanceId === 2
  && harness.engine.current.sessions.get(sessionId)?.providerSessionId === 'handoff-fixture-1'
  && fixtureHandoffs[0]?.providerSessionId === undefined && fixtureHandoffs[0]?.text.includes('run the drive turn'))

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
  && harness.engine.current.sessions.size === sessionCountBeforeHandoff)
await page.locator('[data-draft-project]').selectOption(String(workspaceId))
await page.waitForURL(`**/?workspace=${workspaceId}`)
await page.locator('[data-draft-project]').selectOption(String(secondWorkspaceId))
await page.waitForURL(`**/?workspace=${secondWorkspaceId}`)
await capture('onboarding-selected-project')
await page.setViewportSize({ width: 1280, height: 800 })
await page.getByRole('button', { name: 'Choose agent and model' }).click()
await page.getByRole('button', { name: /Claude Code.*Personal/ }).click()
await page.getByRole('grid', { name: 'Models' }).getByRole('button', { name: 'Provider default' }).click()
await page.fill('[data-prompt]', 'typed with no session open')
await page.click('[data-send]')
await page.waitForURL(/\/s\/\d+/, { timeout: 8000 })
await page.waitForFunction(() => (document.body.textContent ?? '').includes('typed with no session open'), undefined, { timeout: 8000 })
const newSessionId = Number(new URL(page.url()).pathname.split('/').at(-1))
check('type-to-start delivers the prompt in the selected workspace', harness.engine.current.sessions.size === sessionCountBeforeHandoff + 1
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
const showContextWindow = settingsDialog.getByRole('checkbox', { name: 'Context window' })
check('context window details are an opt-in appearance preference', !await showContextWindow.isChecked())
await showContextWindow.check()
await page.keyboard.press('Escape')
await settingsDialog.waitFor({ state: 'hidden', timeout: 4000 })
await page.waitForURL(url => !url.pathname.startsWith('/settings'))

if (screenshotDir) {
  await capture('workspace-desktop')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('workspace-mobile')
  await page.locator('[data-sidebar-toggle]').click()
  await page.locator('[data-nav-settings]').click()
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
  const settingsSearch = settingsDialog.getByRole('searchbox', { name: 'Search settings sections' })
  await settingsSearch.fill('not present')
  await settingsNavigation.getByText('No sections found').waitFor()
  await settingsSearch.fill('key')
  check('settings search filters the available sections', await settingsNavigation.getByRole('button').count() === 1)
  await settingsSearch.press('Enter')
  await page.waitForURL(url => url.pathname === '/settings/keybindings')
  check('Enter opens the matching settings section and clears search', await settingsSearch.inputValue() === ''
    && await settingsNavigation.getByRole('button').count() === 6)
  // The Keyboard section at a desktop and the narrowest width: its rows carry
  // a chord and two controls, which is the densest line in the whole sheet.
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
await pressChord('Control+k')
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

await pressChord('Control+Alt+n')
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

const draftSidebar = page.locator('[data-harness-sidebar]')
const discardSidebarDraft = (id: number) => draftSidebar.locator(`[data-item-id="${id}"] > [data-draft-discard-row]`)
await page.locator('[data-sidebar-toggle]').click()
await discardSidebarDraft(sessionId).click()
check('discarding another thread’s draft from the sidebar keeps the current editor intact', await promptBox.inputValue() === scratchDraft)
await discardSidebarDraft(scratchSessionId).click()
const sidebarDraftUndo = draftSidebar.locator('[data-thread-undo]')
await sidebarDraftUndo.getByText('2 drafts discarded', { exact: true }).waitFor()
await capture('composer-discard-sidebar-mobile')
await sidebarDraftUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await page.locator('[data-sidebar-close]').click()
check('one sidebar Undo restores both scoped drafts and the current text selection',
  await promptBox.evaluate((box: HTMLTextAreaElement) => box.selectionStart === 14 && box.selectionEnd === 21 && box.selectionDirection === 'backward')
  && await promptBox.inputValue() === scratchDraft)
await page.goto(`${baseUrl}/s/${sessionId}`)
await page.waitForFunction(() => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === 'A separate draft in another project')
await page.goto(`${baseUrl}/s/${scratchSessionId}`)
const discardComposer = page.locator('[data-discard-composer]')
await discardComposer.click()
const compactDraftUndo = page.locator('[data-compact-thread-undo] [data-thread-undo]')
await compactDraftUndo.getByText('Draft discarded', { exact: true }).waitFor()
await page.reload()
await compactDraftUndo.getByText('Draft discarded', { exact: true }).waitFor()
await capture('composer-discard-undo-mobile')
await pressChord('Meta+z')
check('discard Undo survives reload and restores the exact draft from the composer shortcut', await promptBox.inputValue() === scratchDraft)

const draftWriter = await browserContext.newPage()
try {
  await draftWriter.goto(`${baseUrl}/s/${scratchSessionId}`)
  await discardComposer.click()
  await compactDraftUndo.getByText('Draft discarded', { exact: true }).waitFor()
  await draftWriter.locator('[data-prompt]').fill('Newer draft from a second tab')
  await compactDraftUndo.getByRole('button', { name: 'Undo', exact: true }).click()
  await page.reload()
  await page.waitForFunction(() => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === 'Newer draft from a second tab')
  check('discard Undo preserves text saved by a second tab', true)
}
finally {
  await draftWriter.close()
}

const mixedDraft = 'Draft saved before a thread action'
await promptBox.fill(mixedDraft)
await discardComposer.click()
await compactDraftUndo.getByText('Draft discarded', { exact: true }).waitFor()
const draftThreadActions = page.locator('[data-thread-actions-trigger]')
await draftThreadActions.click()
await page.getByRole('dialog', { name: 'Thread actions' }).getByRole('button', { name: 'Settle thread', exact: true }).click()
await compactDraftUndo.getByText('Thread settled', { exact: true }).waitFor()
await compactDraftUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await compactDraftUndo.getByText('Draft discarded', { exact: true }).waitFor()
await compactDraftUndo.getByRole('button', { name: 'Undo', exact: true }).click()
check('thread Undo reveals the preceding draft Undo in order', await promptBox.inputValue() === mixedDraft)

await page.evaluate(() => {
  const write = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    if (this === sessionStorage && key === 'harness.draft-undo.v2') throw new DOMException('Storage full', 'QuotaExceededError')
    return write.call(this, key, value)
  }
})
await discardComposer.click()
check('discard leaves the draft intact when its recovery copy cannot be persisted', await promptBox.inputValue() === mixedDraft)
await page.reload()
await page.waitForFunction(text => (document.querySelector('[data-prompt]') as HTMLTextAreaElement)?.value === text, mixedDraft)

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
await discardSidebarDraft(scratchSessionId).waitFor({ state: 'detached' })
check('retry uses the same id and clears the draft after receipt', attemptedIds.length === 2 && attemptedIds[0] === attemptedIds[1]
  && harness.engine.current.sessions.get(scratchSessionId)?.turns.filter(turn => turn.prompt === retryText).length === 1)

const attachmentPicker = page.locator('[data-composer-file-input]')
const draftFiles = page.locator('[data-composer-file]')
const fileFixture = { name: 'notes <draft>.txt', mimeType: 'text/plain', buffer: Buffer.from('Harness attachment fixture') }
const imageFixture = {
  name: 'reference-pattern.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAQklEQVR4nGMoPrsTK7Iq2oYVkaqeYdSCUQuGgAXUMgiX+lELRi0YChZQyyBc6kctGLVgKFhALYNwqR+1YNSCIWABAEpwtlu9JLzZAAAAAElFTkSuQmCC', 'base64'),
}
let failAttachmentOnce = true
await page.route('**/composer-attachments?**', async (route) => {
  if (route.request().method() === 'POST' && failAttachmentOnce) {
    failAttachmentOnce = false
    await route.fulfill({ status: 503, json: { error: 'Fixture upload interrupted.' } })
  }
  else await route.continue()
})
await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-attach-composer]')?.disabled)
await attachmentPicker.setInputFiles(fileFixture)
const failedFile = draftFiles.filter({ hasText: 'Fixture upload interrupted.' })
await failedFile.waitFor()
check('failed upload keeps the file visible and prevents sending', await page.locator('[data-send]').isDisabled())
await failedFile.getByRole('button', { name: 'Retry' }).click()
await page.locator('[data-composer-file][data-status="ready"]').waitFor()
await page.unroute('**/composer-attachments?**')
await promptBox.evaluate((editor, { name, mimeType, bytes }) => {
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([new Uint8Array(bytes)], name, { type: mimeType }))
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
}, { name: imageFixture.name, mimeType: imageFixture.mimeType, bytes: Array.from(imageFixture.buffer) })
await page.waitForFunction(() => document.querySelectorAll('[data-composer-file][data-status="ready"]').length === 2)
await page.waitForFunction(() => ((document.querySelector('[data-composer-file] img:not([hidden])') as HTMLImageElement | null)?.naturalWidth ?? 0) > 0)
await page.locator('[data-composer]').evaluate((composer) => {
  const transfer = new DataTransfer()
  transfer.items.add(new File(['Dropped file fixture'], 'dropped.txt', { type: 'text/plain' }))
  composer.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
})
const dropped = draftFiles.filter({ hasText: 'dropped.txt' })
await dropped.and(page.locator('[data-status="ready"]')).waitFor()
await dropped.getByRole('button', { name: 'Remove dropped.txt' }).click()
check('a pasted image decodes and a dropped file can be removed', await draftFiles.count() === 2)
await promptBox.fill('Review these fixture files')
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`composer-attachments-${width}`)
  }
}
await page.setViewportSize({ width: 390, height: 844 })
await page.reload()
await page.waitForFunction(() => document.querySelectorAll('[data-composer-file][data-status="ready"]').length === 2)
check('attachment names and text persist after reloading', await draftFiles.count() === 2
  && await promptBox.inputValue() === 'Review these fixture files'
  && (await draftFiles.first().textContent())?.includes('notes _draft_.txt') === true)
await discardComposer.click()
await compactDraftUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await page.waitForFunction(() => document.querySelectorAll('[data-composer-file][data-status="ready"]').length === 2)
check('discard and Undo restore the uploaded files and prompt', await promptBox.inputValue() === 'Review these fixture files')
await page.locator('[data-send]').click()
const sentFile = page.locator('[data-sent-attachment]').filter({ hasText: 'notes _draft_.txt' })
await sentFile.waitFor()
const sentFileUrl = new URL((await sentFile.getAttribute('href'))!, baseUrl).href
const sentFileResponse = await page.request.get(sentFileUrl)
check('sent file links return the exact committed bytes', sentFileResponse.ok() && await sentFileResponse.text() === 'Harness attachment fixture')
const sentImage = page.getByRole('button', { name: 'Preview reference-pattern.png' })
const attachmentDialog = page.getByRole('dialog', { name: 'reference-pattern.png' })
await sentImage.click()
await attachmentDialog.waitFor()
await attachmentDialog.getByRole('img', { name: 'reference-pattern.png' }).evaluate(async (img: HTMLImageElement) => img.decode())
const imageDownload = new URL((await attachmentDialog.getByRole('link', { name: 'Download' }).getAttribute('href'))!, baseUrl)
check('the sent-image dialog decodes the image and preserves the original download',
  Buffer.compare(await (await page.request.get(imageDownload.href)).body(), imageFixture.buffer) === 0)
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`composer-sent-image-${width}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
}
await page.keyboard.press('Escape')
await attachmentDialog.waitFor({ state: 'hidden' })
check('Escape closes the image preview and restores focus to its trigger',
  await sentImage.evaluate(button => button === document.activeElement))
await page.reload()
await sentFile.waitFor()
await sentImage.click()
await attachmentDialog.waitFor()
await attachmentDialog.getByRole('button', { name: 'Close image preview' }).click()
check('sent attachments remain usable from history after reload', await sentFile.isVisible() && await draftFiles.count() === 0)

await promptBox.evaluate((editor) => {
  const clipboard = new DataTransfer()
  clipboard.setData('text/plain', 'Text fixture. '.repeat(4096))
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }))
})
const longPaste = draftFiles.filter({ hasText: 'pasted-text.txt' })
await longPaste.and(page.locator('[data-status="ready"]')).waitFor()
check('a large plain-text paste becomes a file and leaves the editor usable', await promptBox.inputValue() === '')
await longPaste.getByRole('button', { name: 'Remove pasted-text.txt' }).click()

const projectAttachmentDraft = await browserContext.newPage()
await projectAttachmentDraft.goto(`${baseUrl}/?workspace=${workspaceId}`)
await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-attach-composer]')?.disabled)
const mentionDirectory = join(dir, 'fixture context')
mkdirSync(mentionDirectory)
writeFileSync(join(mentionDirectory, 'parity-notes (draft).md'), 'Synthetic workspace context\n')
writeFileSync(join(mentionDirectory, 'parity-notes-extra.md'), 'Another workspace file\n')
writeFileSync(join(mentionDirectory, 'report.html'), '<main><h1>Workspace report</h1><p>Read-only document</p></main>')
const mentionEditor = projectAttachmentDraft.getByRole('textbox', { name: 'Message', exact: true })
const workspaceFiles = projectAttachmentDraft.getByRole('listbox', { name: 'Workspace files' })
const mentionOption = workspaceFiles.getByRole('option', { name: /parity-notes \(draft\)\.md/ })
await mentionEditor.fill('Review @parity-notes')
await mentionOption.waitFor()
check('the project draft lists matching workspace files and their folders', await workspaceFiles.getByRole('option').count() === 2
  && await mentionOption.getByText('fixture context').isVisible())
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await projectAttachmentDraft.setViewportSize({ width, height })
    check(`the composer file menu fits at ${width}×${height}`, await workspaceFiles.evaluate(list => {
      const box = list.getBoundingClientRect()
      return box.top >= 0 && box.left >= 0 && box.right <= innerWidth
    }))
    await capture(`composer-file-menu-${width}`, projectAttachmentDraft)
  }
  await projectAttachmentDraft.setViewportSize({ width: 390, height: 844 })
}
const initialFile = await mentionEditor.getAttribute('aria-activedescendant')
await mentionEditor.press('ArrowDown')
check('arrow keys move the active file while focus stays in the editor', initialFile !== await mentionEditor.getAttribute('aria-activedescendant')
  && await mentionEditor.evaluate(input => input === document.activeElement))
await mentionEditor.press('Escape')
await workspaceFiles.waitFor({ state: 'hidden' })
check('Escape keeps the typed mention without sending a prompt', await mentionEditor.inputValue() === 'Review @parity-notes')
await mentionEditor.fill('Review @parity-notes before changing it')
await mentionEditor.evaluate((input: HTMLTextAreaElement) => {
  const pos = 'Review @parity-notes'.length
  input.setSelectionRange(pos, pos)
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }))
})
await mentionOption.click()
check('choosing a workspace file preserves surrounding text and encodes spaces and parentheses',
  await mentionEditor.inputValue() === `Review ${referenceLink} before changing it`)
await projectAttachmentDraft.reload()
await projectAttachmentDraft.waitForFunction(expected => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === expected,
  `Review ${referenceLink} before changing it`)
await mentionEditor.fill('')
await projectAttachmentDraft.locator('[data-composer-file-input]').setInputFiles(fileFixture)
await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').waitFor()
await projectAttachmentDraft.locator('[data-send]').click()
await projectAttachmentDraft.waitForURL('**/s/*')
await projectAttachmentDraft.locator('[data-sent-attachment]').filter({ hasText: 'notes _draft_.txt' }).waitFor()
const attachmentOnlyThread = Number(new URL(projectAttachmentDraft.url()).pathname.split('/').at(-1))
const attachmentOnlyTurn = harness.engine.current.sessions.get(attachmentOnlyThread)?.turns[0]
check('starting a project thread carries an attachment-only draft into the first message',
  attachmentOnlyTurn?.prompt === '' && attachmentOnlyTurn.attachments?.[0]?.name === 'notes _draft_.txt')
const recallEditor = projectAttachmentDraft.getByRole('textbox', { name: 'Message', exact: true })
await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-attach-composer]')?.disabled)
await recallEditor.press('ArrowUp')
check('prompt recall skips an attachment-only message', await recallEditor.inputValue() === '')
const earlierPrompt = 'First prompt for recall'
const wrappedPrompt = 'Review the rendering and exact file names '.repeat(4) + 'before changing anything.'
for (const text of [earlierPrompt, earlierPrompt, wrappedPrompt]) {
  const turnsBefore = await projectAttachmentDraft.locator('[data-user-prompt]').count()
  await recallEditor.fill(text)
  await recallEditor.press('Enter')
  await projectAttachmentDraft.waitForFunction(count => document.querySelectorAll('[data-user-prompt]').length > count, turnsBefore)
  await projectAttachmentDraft.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
}
await recallEditor.press('ArrowUp')
check('prompt recall sees a turn sent on this page', await recallEditor.inputValue() === wrappedPrompt)
await recallEditor.press('ArrowDown')
await projectAttachmentDraft.setViewportSize({ width: 390, height: 844 })
await projectAttachmentDraft.reload()
await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-attach-composer]')?.disabled)
await recallEditor.press('ArrowUp')
check('Up on an empty composer recalls the latest exact prompt after reload', await recallEditor.inputValue() === wrappedPrompt)
check('the caret and the last visual line are visible after recalling a long prompt',
  await recallEditor.evaluate(editor => editor.scrollTop > 0 && editor.scrollHeight - editor.scrollTop - editor.clientHeight <= 1))
await capture('composer-recalled-prompt-mobile', projectAttachmentDraft)
await recallEditor.press('ArrowUp')
check('Up moves the caret within a wrapped recalled prompt before stepping history',
  await recallEditor.inputValue() === wrappedPrompt && await recallEditor.evaluate(editor => (editor as HTMLTextAreaElement).selectionStart < (editor as HTMLTextAreaElement).value.length))
await recallEditor.evaluate(editor => (editor as HTMLTextAreaElement).setSelectionRange(4, 4))
await recallEditor.press('ArrowUp')
check('Up on the first visual line recalls the preceding prompt', await recallEditor.inputValue() === earlierPrompt)
await recallEditor.press('ArrowUp')
check('consecutive exact repeats occupy one recall step', await recallEditor.inputValue() === earlierPrompt)
await recallEditor.press('ArrowDown')
check('Down moves towards the latest prompt', await recallEditor.inputValue() === wrappedPrompt)
await recallEditor.press('ArrowDown')
check('Down past the latest prompt returns to an empty composer', await recallEditor.inputValue() === '')
await recallEditor.press('ArrowUp')
await recallEditor.press('x')
await recallEditor.evaluate(editor => (editor as HTMLTextAreaElement).setSelectionRange(0, 0))
await recallEditor.press('ArrowUp')
check('editing a recalled prompt makes it an ordinary draft', await recallEditor.inputValue() === wrappedPrompt + 'x')
await recallEditor.fill('')
await projectAttachmentDraft.locator('[data-composer-file-input]').setInputFiles(fileFixture)
await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').waitFor()
await recallEditor.press('ArrowUp')
check('prompt recall leaves an unsent attachment draft intact', await recallEditor.inputValue() === ''
  && await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').count() === 1)
const stashChord = process.platform === 'darwin' ? 'Meta+s' : 'Control+s'
const stashDialog = projectAttachmentDraft.getByRole('dialog', { name: 'Stashed prompts' })
const stashLauncher = projectAttachmentDraft.locator('[data-open-stash]')
await recallEditor.fill('Review the stashed file')
await recallEditor.press(stashChord)
await projectAttachmentDraft.getByRole('button', { name: 'Stashed prompts (1)' }).waitFor()
await projectAttachmentDraft.locator('[data-composer-file]').first().waitFor({ state: 'detached' })
check('the stash shortcut clears a durably saved prompt and attachment', await recallEditor.inputValue() === '')
await recallEditor.fill('Standalone stashed text')
await recallEditor.press(stashChord)
await projectAttachmentDraft.getByRole('button', { name: 'Stashed prompts (2)' }).waitFor()
await projectAttachmentDraft.reload()
await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-open-stash]')?.disabled)
await recallEditor.press(stashChord)
await stashDialog.waitFor()
check('multiple saved prompts open the stash after reload', await stashDialog.locator('[data-stashed-prompt]').count() === 2)
const stashDraftButton = stashDialog.getByRole('button', { name: 'Stash draft', exact: true })
check('the empty composer clearly disables Stash draft', await stashDraftButton.isDisabled()
  && await stashDraftButton.evaluate(button => Number(getComputedStyle(button).opacity) < 1))
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await projectAttachmentDraft.setViewportSize({ width, height })
    check(`the stash fits and is modal at ${width}×${height}`, await stashDialog.evaluate(dialog =>
      dialog.matches(':modal') && dialog.getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth === innerWidth))
    await capture(`composer-prompt-stash-${width}`, projectAttachmentDraft)
  }
  await projectAttachmentDraft.setViewportSize({ width: 390, height: 844 })
}
await stashDialog.getByRole('button', { name: 'Restore Standalone stashed text', exact: true }).click()
await stashDialog.waitFor({ state: 'hidden' })
check('restoring text closes the stash and restores composer focus', await recallEditor.inputValue() === 'Standalone stashed text'
  && await recallEditor.evaluate(box => box === document.activeElement))
await recallEditor.fill('')

await projectAttachmentDraft.goto(`${baseUrl}/?workspace=${workspaceId}`)
await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-open-stash]')?.disabled)
await recallEditor.fill('Keep this draft')
await stashLauncher.click()
await stashDialog.getByRole('button', { name: 'Restore Review the stashed file', exact: true }).click()
await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').waitFor()
check('restoring in another thread appends text and transfers the file', await recallEditor.inputValue() === 'Keep this draft\n\nReview the stashed file')
await projectAttachmentDraft.locator('[data-send]').click()
await projectAttachmentDraft.waitForURL('**/s/*')
const stashedLink = projectAttachmentDraft.locator('[data-sent-attachment]').filter({ hasText: 'notes _draft_.txt' })
await stashedLink.waitFor()
const movedFile = await projectAttachmentDraft.request.get(new URL((await stashedLink.getAttribute('href'))!, baseUrl).href)
check('the restored cross-thread attachment delivers the original bytes', movedFile.ok() && await movedFile.text() === 'Harness attachment fixture')

await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-open-stash]')?.disabled)
await recallEditor.fill('Restore an expired file')
await projectAttachmentDraft.locator('[data-composer-file-input]').setInputFiles(fileFixture)
await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').waitFor()
await recallEditor.press(stashChord)
await projectAttachmentDraft.getByRole('button', { name: 'Stashed prompts (1)' }).waitFor()
await projectAttachmentDraft.route('**/composer-attachments/stash/**', async (route) => {
  if (route.request().method() === 'PUT') await route.fulfill({ json: [] })
  else await route.continue()
})
await recallEditor.press(stashChord)
const expiredFile = projectAttachmentDraft.locator('[data-composer-file][data-status="failed"]')
await expiredFile.waitFor()
check('an expired file restores as a replaceable row and blocks sending', await expiredFile.getByText('Upload expired.').isVisible()
  && await projectAttachmentDraft.locator('[data-send]').isDisabled())
const replacement = projectAttachmentDraft.waitForEvent('filechooser')
await expiredFile.getByRole('button', { name: 'Attach again' }).click()
await (await replacement).setFiles(fileFixture)
await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').waitFor()
check('Attach again replaces the expired row', await projectAttachmentDraft.locator('[data-composer-file]').count() === 1)
await projectAttachmentDraft.evaluate(() => {
  const write = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    if (this === localStorage && key === 'harness.prompt-stash.v1') throw new DOMException('Fixture storage is full.', 'QuotaExceededError')
    return write.call(this, key, value)
  }
})
await recallEditor.press(stashChord)
await projectAttachmentDraft.locator('[data-prompt-stash-error]').getByText('Fixture storage is full.').waitFor()
check('a storage failure keeps both the draft and its uploaded file',
  await recallEditor.inputValue() === 'Restore an expired file'
  && await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').count() === 1)


const stashRoute = '**/composer-attachments/stash/**'
await projectAttachmentDraft.unroute(stashRoute)
const stashWriter = await browserContext.newPage()
try {
  for (const operation of ['POST', 'PUT'] as const) {
    const newerDraft = operation === 'POST' ? 'Keep the newer draft during stash save' : 'Keep the newer draft during stash restore'
    const outcome = operation === 'POST' ? 'Your saved prompt is in the stash.' : 'Your saved prompt is still in the stash.'
    await projectAttachmentDraft.reload()
    await stashWriter.goto(projectAttachmentDraft.url())
    const writerEditor = stashWriter.locator('[data-prompt]')
    await projectAttachmentDraft.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-open-stash]')?.disabled)
    const resumeTransfer = Promise.withResolvers<void>()
    await projectAttachmentDraft.route(stashRoute, async (route) => {
      if (route.request().method() !== operation) return route.continue()
      const response = await route.fetch()
      await resumeTransfer.promise
      await route.fulfill({ response })
    })
    try {
      const requested = projectAttachmentDraft.waitForRequest(request => request.method() === operation
        && request.url().includes('/composer-attachments/stash/'))
      if (operation === 'POST') await recallEditor.press(stashChord)
      else {
        await stashLauncher.click()
        await stashDialog.getByRole('button', { name: 'Restore Restore an expired file', exact: true }).click()
      }
      await requested
      await writerEditor.fill(newerDraft)
      resumeTransfer.resolve()
      await (operation === 'POST' ? projectAttachmentDraft.locator('[data-prompt-stash-error]') : stashDialog)
        .getByText(outcome, { exact: false }).waitFor()
      if (operation === 'PUT') await capture('composer-prompt-stash-conflict', projectAttachmentDraft)
      await stashWriter.reload()
      await stashWriter.waitForFunction((expected) => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === expected, newerDraft)
      check(`${operation === 'POST' ? 'saving' : 'restoring'} a stash keeps the newer draft, its ready file, and the stash entry`,
        await stashWriter.locator('[data-composer-file][data-status="ready"]').count() === 1
        && await projectAttachmentDraft.getByRole('button', { name: 'Stashed prompts (1)', exact: true, includeHidden: true }).count() === 1)
    }
    finally {
      resumeTransfer.resolve()
      await projectAttachmentDraft.unroute(stashRoute)
    }
  }
}
finally {
  await stashWriter.close()
}
await projectAttachmentDraft.reload()
await stashLauncher.click()
await stashDialog.getByRole('button', { name: 'Restore Restore an expired file', exact: true }).click()
await stashDialog.waitFor({ state: 'hidden' })
check('reloading lets a conflicting stash restore append to the newer draft without duplicating its file',
  await recallEditor.inputValue() === 'Keep the newer draft during stash restore\n\nRestore an expired file'
  && await projectAttachmentDraft.locator('[data-composer-file][data-status="ready"]').count() === 1)

await projectAttachmentDraft.locator('[data-composer-file]').getByRole('button', { name: 'Remove notes _draft_.txt' }).click()
await mentionEditor.fill('Read @parity-notes')
await mentionOption.waitFor()
await capture('composer-file-menu-active-thread', projectAttachmentDraft)
if (await mentionOption.getAttribute('aria-selected') !== 'true') await mentionEditor.press('ArrowDown')
await mentionEditor.press('Enter')
check('Enter inserts the highlighted file instead of sending the prompt', await mentionEditor.inputValue() === `Read ${referenceLink} `)
const filePromptThread = Number(new URL(projectAttachmentDraft.url()).pathname.split('/').at(-1))
await projectAttachmentDraft.locator('[data-send]').click()
await projectAttachmentDraft.waitForFunction(expected => Array.from(document.querySelectorAll('[data-user-prompt]')).some(row => row.textContent?.includes(expected)),
  `Read ${referenceLink}`)
await projectAttachmentDraft.getByText('Referenced fixture read.', { exact: true }).waitFor()
check('the provider receives the relative link and can open the original workspace file',
  harness.engine.current.sessions.get(filePromptThread)?.turns.at(-1)?.prompt === `Read ${referenceLink}`
  && fixtureMentionContents === 'Synthetic workspace context\n')
const previewFile = 'syntax [draft] #1.txt'
const previewPath = `fixture context/${previewFile}`
const previewText = Array.from({ length: 160 }, (_, index) => `Source line ${index + 1}\n`).join('')
writeFileSync(join(mentionDirectory, previewFile), previewText)
await projectAttachmentDraft.setViewportSize({ width: 1440, height: 900 })
const filesPane = projectAttachmentDraft.getByRole('region', { name: 'Files', exact: true })
const filesToggle = projectAttachmentDraft.getByRole('button', { name: 'Workspace files', exact: true })
await filesToggle.click()
await filesPane.getByRole('button', { name: 'fixture context', exact: true }).click()
await filesPane.getByRole('button', { name: previewFile, exact: true }).click()
const sourceView = filesPane.getByRole('region', { name: 'File source' })
await sourceView.waitFor()
await filesPane.getByRole('spinbutton', { name: 'Line number' }).fill('125')
await filesPane.getByRole('button', { name: 'Go', exact: true }).click()
await projectAttachmentDraft.waitForFunction(() => {
  const source = document.querySelector('[data-workspace-source]')
  return source?.getAttribute('data-view-line') === '125' && source.scrollTop > 0
})
check('the Files pane reveals the requested source line and preserves special characters in the title',
  await filesPane.getByRole('heading', { name: previewFile, exact: true }).isVisible())
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await projectAttachmentDraft.setViewportSize({ width, height })
    check(`the file preview and its actions fit at ${width}×${height}`, await filesPane.evaluate((pane) => {
      const box = pane.getBoundingClientRect()
      const actions = pane.querySelectorAll('[data-workspace-file-link], [data-workspace-file-download]')
      return box.width > 0 && box.right <= innerWidth && box.bottom <= innerHeight
        && [...actions].every(action => action.getBoundingClientRect().right <= box.right)
        && document.documentElement.scrollWidth <= innerWidth
    }))
    await capture(`workspace-file-source-${width}`, projectAttachmentDraft)
  }
}
await projectAttachmentDraft.setViewportSize({ width: 1440, height: 900 })
await projectAttachmentDraft.evaluate(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { sessionStorage.setItem('workspace-file-test-link', text) } },
  })
})
await filesPane.getByRole('button', { name: 'Copy file link' }).click()
await filesPane.getByText('Link copied.').waitFor()
const copiedFileLink = new URL(await projectAttachmentDraft.evaluate(() => sessionStorage.getItem('workspace-file-test-link')) ?? '')
check('the copied link preserves the workspace path and selected line',
  copiedFileLink.searchParams.get('file') === previewPath && copiedFileLink.searchParams.get('line') === '125')
const fileLinkPage = await browserContext.newPage()
await fileLinkPage.goto(copiedFileLink.href)
await fileLinkPage.waitForFunction(() => document.querySelector('[data-workspace-source]')?.getAttribute('data-view-line') === '125')
const fileDownloadLink = fileLinkPage.getByRole('link', { name: 'Download file' })
check('the download link supplies the exact workspace filename', await fileDownloadLink.getAttribute('download') === previewFile)
const [downloaded] = await Promise.all([
  fileLinkPage.waitForEvent('download'),
  fileDownloadLink.click(),
])
const downloadedName = downloaded.suggestedFilename()
// Bundled libsoup can substitute underscores for spaces on Linux WebKit.
// https://github.com/microsoft/playwright/issues/44130
const normalizedWebKitName = process.platform === 'linux' && browserName === 'webkit'
  && downloadedName === previewFile.replaceAll(' ', '_')
check(`the browser suggests the workspace filename (received ${JSON.stringify(downloadedName)})`,
  downloadedName === previewFile || normalizedWebKitName)
check('a fresh page opens the shared line and downloads the original bytes',
  readFileSync((await downloaded.path())!, 'utf8') === previewText)
const fileEditorButton = fileLinkPage.getByRole('button', { name: 'Open file in editor', exact: true })
const fileEditorDialog = fileLinkPage.getByRole('dialog', { name: 'Open in editor' })
await fileEditorButton.click()
await fileEditorDialog.getByText(`fixture context/${previewFile}:125`, { exact: true }).waitFor()
const fixtureEditor = fileEditorDialog.getByRole('button', { name: /^VS Code/u })
await fixtureEditor.waitFor()
await capture('workspace-editor-file', fileLinkPage)
await fileEditorDialog.getByRole('button', { name: 'Close editor chooser' }).press('Escape')
await fileEditorDialog.waitFor({ state: 'hidden', timeout: 4000 })
await fileLinkPage.waitForFunction(() => document.activeElement?.hasAttribute('data-workspace-file-editor'))
await fileEditorButton.click()
const [editorResponse] = await Promise.all([
  fileLinkPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/workspace-editor', { timeout: 4000 }),
  fixtureEditor.click(),
])
if (!editorResponse.ok()) throw new Error(`The editor launch returned ${editorResponse.status()}: ${await editorResponse.text()}`)
await fileEditorDialog.waitFor({ state: 'hidden', timeout: 4000 })
const projectFolder = realpathSync(dir)
check('a linked file opens its exact working file and line, and the chooser returns focus',
  await editorReceived(`${projectFolder}\n--goto\n${join(projectFolder, 'fixture context', previewFile)}:125\n`))
await fileEditorButton.click()
await fixtureEditor.getByText('Preferred', { exact: true }).waitFor()
const [shortcutLaunch] = await Promise.all([
  fileLinkPage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/workspace-editor', { timeout: 4000 }),
  fileEditorDialog.evaluate((element, apple) => {
    (element as HTMLDialogElement).close()
    element.ownerDocument.activeElement?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'o', code: 'KeyO', bubbles: true, cancelable: true, metaKey: apple, ctrlKey: !apple,
    }))
  }, process.platform === 'darwin'),
])
await fileEditorDialog.waitFor({ state: 'hidden' })
check('opening the preferred editor immediately after closing the chooser keeps the new request',
  shortcutLaunch.status() === 204 && await editorReceived(`${projectFolder}\n--new-window\n${projectFolder}\n`))
await fileLinkPage.close()
const fileTools = projectAttachmentDraft.getByRole('button', { name: 'Workspace actions' })
await fileTools.click()
await filesPane.waitFor({ state: 'hidden' })
await projectAttachmentDraft.locator('[data-files-toggle]').click()
await sourceView.waitFor()
await projectAttachmentDraft.setViewportSize({ width: 390, height: 844 })
await filesPane.getByRole('button', { name: 'Back to files' }).click()
const searchFiles = filesPane.getByRole('searchbox', { name: 'Search workspace files' })
const [workspaceSearch] = await Promise.all([
  projectAttachmentDraft.waitForResponse(response => new URL(response.url()).pathname === '/workspace-files/search'),
  searchFiles.fill('report.html'),
])
const workspaceSearchResult = await workspaceSearch.json()
if (!workspaceSearchResult.results?.includes('fixture context/report.html'))
  throw new Error(`The Files pane search did not find the HTML fixture: ${JSON.stringify(workspaceSearchResult)}`)
writeFileSync(join(mentionDirectory, 'new-report.html'), '<p>New file</p>')
await filesPane.getByRole('button', { name: 'Refresh workspace files' }).click()
await filesPane.locator('[data-file-path="fixture context/new-report.html"]').waitFor()
check('refresh updates the running search after a new file is written',
  await filesPane.locator('[data-file-path="fixture context/report.html"]').isVisible())
await filesPane.locator('[data-file-path="fixture context/report.html"]').click()
await filesPane.frameLocator('iframe[title="HTML file preview"]').getByText('Workspace report').waitFor()
await capture('workspace-file-html-phone', projectAttachmentDraft)
await filesPane.getByRole('button', { name: 'Source', exact: true }).click()
await sourceView.waitFor()
check('a phone can return to file search, open rendered HTML, and switch to source',
  (await sourceView.innerText()).includes('<h1>Workspace report</h1>'))
await filesPane.getByRole('button', { name: 'Close workspace files' }).press('Escape')
await filesPane.waitFor({ state: 'hidden' })
await projectAttachmentDraft.waitForFunction(() => document.activeElement?.hasAttribute('data-workspace-actions-toggle'))
check('closing on a phone restores focus to Workspace actions',
  await fileTools.evaluate(element => element === document.activeElement))
await fileTools.click()
await projectAttachmentDraft.locator('[data-files-toggle]').click()
await filesPane.waitFor()
await filesPane.getByRole('button', { name: 'Close workspace files' }).click()
const touchFilesContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme, reducedMotion })
const touchFilesPage = await touchFilesContext.newPage()
await touchFilesPage.goto(`${baseUrl}/?workspace=${workspaceId}`)
await touchFilesPage.getByRole('button', { name: 'Workspace actions' }).tap()
await touchFilesPage.locator('[data-files-toggle]').tap()
await touchFilesPage.getByRole('button', { name: 'fixture context', exact: true }).tap()
await touchFilesPage.getByRole('button', { name: previewFile, exact: true }).tap()
const touchSource = touchFilesPage.getByRole('region', { name: 'File source' })
await touchSource.waitFor()
await capture('workspace-file-touch-portrait', touchFilesPage)
await touchFilesPage.getByRole('button', { name: 'Open file in editor', exact: true }).tap()
const touchEditor = touchFilesPage.getByRole('dialog', { name: 'Open in editor' })
await touchEditor.getByRole('button', { name: /^VS Code/u }).waitFor()
check('the editor chooser fits the phone and offers touch-sized options', await touchEditor.evaluate((element) => {
  const bounds = element.getBoundingClientRect()
  const choice = element.querySelector('[data-workspace-editor-choice]')?.getBoundingClientRect()
  return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight && (choice?.height ?? 0) >= 44
}))
await capture('workspace-editor-touch', touchFilesPage)
await touchEditor.getByRole('button', { name: 'Close editor chooser' }).tap()
await touchEditor.waitFor({ state: 'hidden' })
await touchFilesPage.setViewportSize({ width: 820, height: 390 })
check('touch can browse files from a project draft and keep the file open after rotation',
  await touchSource.getByText('Source line 125', { exact: false }).isVisible()
  && await touchSource.evaluate(source => source.getBoundingClientRect().right <= innerWidth))
await capture('workspace-file-touch-landscape', touchFilesPage)
await touchFilesContext.close()
rmSync(mentionDirectory, { recursive: true })
await projectAttachmentDraft.close()

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
await jump.waitFor({ state: 'hidden' })
await page.waitForFunction(() => {
  const pane = document.querySelector('[data-transcript]')
  return pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 16
})
check('jump returns to the latest response and restores transcript focus', await transcript.evaluate(element => element.ownerDocument.activeElement === element))
const copy = transcript.getByRole('button', { name: 'Copy code' })
await copy.click()
check('the copy action preserves the fenced code', await page.locator('body').getAttribute('data-fixture-clipboard') === 'const result = 42\nconst format = "{{ value }}"\n')
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
await pressChord('Control+,')
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
await originalTurn.getByText('Response interrupted', { exact: true }).waitFor()
check('an ambiguous steer needs an explicit resend', !await page.locator('[data-resume-queue]').isVisible()
  && steeringCalls.filter(text => text === 'Unconfirmed steering fixture.').length === 1)
await capture('steering-unconfirmed')


await page.goto(`${baseUrl}/s/${steerSessionId}`)
await originalTurn.getByText('Response interrupted', { exact: true }).waitFor()
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

const pinObserver = await browserContext.newPage()
try {
  await page.setViewportSize({ width: 1280, height: 800 })
  await pinObserver.goto(`${baseUrl}/?workspace=${workspaceId}`)
  const observerPins = pinObserver.locator('[data-pin-order-ready] [data-sidebar-item]')
  await observerPins.nth(1).waitFor()
  const reviewPin = pinnedThreads.getByText('Parity release review', { exact: true })
  const source = await reviewPin.boundingBox()
  const destination = await otherPin.boundingBox()
  if (!source || !destination) throw new Error('Pinned drag rows are not visible')
  const startPinDrag = async () => {
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(destination.x + destination.width / 2, destination.y + 4, { steps: 8 })
    await page.locator('[data-pin-insertion="before"]').waitFor()
  }
  await startPinDrag()
  await capture('thread-pin-drag-desktop')
  await page.keyboard.press('Escape')
  await page.mouse.up()
  check('Escape cancels pin dragging without opening the dragged thread', await pinnedThreads.first().getAttribute('href') === `/s/${sessionId}`
    && new URL(page.url()).pathname === `/s/${sessionId}` && await page.locator('[data-pin-insertion]').count() === 0)
  await observerPins.nth(1).focus()
  await startPinDrag()
  await page.mouse.up()
  await pinnedThreads.first().getByText('Parity release review', { exact: true }).waitFor()
  await observerPins.first().getByText('Parity release review', { exact: true }).waitFor()
  check('a pinned drag saves the order for a second open client and preserves its focus', await observerPins.first().evaluate(el => el === document.activeElement)
    && new URL(pinObserver.url()).pathname === '/' && new URL(page.url()).pathname === `/s/${sessionId}`)
  await capture('thread-pins-reordered-desktop')
  await pinObserver.reload()
  await observerPins.first().getByText('Parity release review', { exact: true }).waitFor()
  check('the dragged pin order survives a reload', true)

  const reviewRoute = `/s/${steerSessionId}`
  const reviewRow = page.locator(`[data-sidebar-item][href="${reviewRoute}"]`)
  const observerRow = pinObserver.locator(`[data-sidebar-item][href="${reviewRoute}"]`)
  const activeSection = `[data-section-id="project-${workspaceId}"]`
  const settledSection = '[data-section-id^="settled-"]'
  const pinnedSection = '[data-section-id^="pinned-"]'
  const moveReview = async (target: typeof reviewRow, action: string, name?: string) => {
    const row = await reviewRow.boundingBox()
    if (!row) throw new Error('The thread to move is hidden')
    await page.mouse.move(row.x + 60, row.y + row.height / 2)
    await page.mouse.down()
    await page.mouse.move(row.x + 70, row.y + row.height / 2)
    await target.waitFor({ state: 'visible' })
    const bounds = await target.boundingBox()
    if (!bounds) throw new Error('The thread destination is hidden')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 5, { steps: 10 })
    await page.locator(`[data-shelf-action="${action}"]`).waitFor()
    if (name) await capture(name)
    await page.mouse.up()
  }
  const observeReviewIn = (shelf: string) => observerRow.and(pinObserver.locator(`${shelf} [data-sidebar-item]`)).waitFor()
  const pickShelfHeader = (shelf: string) => page.locator(`${shelf} [data-sidebar-section-header]`).first()
  await observerRow.focus()
  await moveReview(pickShelfHeader(activeSection), 'Unpin', 'thread-shelf-unpin')
  await observeReviewIn(activeSection)
  check('unpinning by drag moves a focused link to its project on both clients', await observerRow.evaluate(row => row === document.activeElement))
  cmd('d_shelf_snooze', { type: 'session.organize', sessionId: steerSessionId, action: 'snooze', until: Date.now() + 3_600_000 })
  const snoozedShelf = '[data-section-id^="snoozed-"]'
  await reviewRow.and(page.locator(`${snoozedShelf} [data-sidebar-item]`)).waitFor()
  await observeReviewIn(snoozedShelf)
  await moveReview(pickShelfHeader(activeSection), 'Wake', 'thread-shelf-wake')
  await observeReviewIn(activeSection)
  check('dragging out of Snoozed wakes the thread on both clients before its timer', harness.engine.current.sessions.get(steerSessionId)?.navigation?.snoozedUntil === null)
  await moveReview(pickShelfHeader(settledSection), 'Settle', 'thread-shelf-settle')
  await observeReviewIn(settledSection)
  await moveReview(pickShelfHeader(activeSection), 'Un-settle')
  await observeReviewIn(activeSection)
  await moveReview(otherPin, 'Pin')
  await observeReviewIn(pinnedSection)
  await pinObserver.reload()
  await observeReviewIn(pinnedSection)
  check('settle, un-settle and pin drops save their actions without changing the active thread', new URL(page.url()).pathname === `/s/${sessionId}`
    && await observerPins.first().getAttribute('href') === reviewRoute)
  await capture('thread-shelves-restored')
}
finally { await pinObserver.close() }

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

const arrangement = page.getByRole('dialog', { name: 'Arrange threads' })
const openArrangement = async () => {
  await threadActionsTrigger.click()
  await threadActions.getByRole('button', { name: 'Arrange threads', exact: true }).click()
  await page.locator('[data-thread-arrangement][data-thread-order-ready]').waitFor()
}
await openArrangement()
const arrangementPin = arrangement.locator('[data-section-id^="pinned-"] [data-arrangement-row]').filter({ hasText: 'Parity release review' })
const arrangementSettled = arrangement.locator('[data-section-id^="settled-"]')
const arrangementGrip = arrangementPin.getByRole('button', { name: 'Reorder Parity release review' })
await arrangementGrip.waitFor()
check('Arrange threads covers the phone viewport and starts with a named drag handle', await arrangement.evaluate((dialog) => {
  const bounds = dialog.getBoundingClientRect()
  const handle = dialog.querySelector('[data-arrangement-grip]')
  return bounds.width === innerWidth && bounds.height === innerHeight && document.documentElement.scrollWidth === innerWidth
    && handle?.getBoundingClientRect().width === 44 && getComputedStyle(handle).touchAction === 'none'
}))
await capture('thread-arrangement-phone')
const arrangementTouch = browserName === 'chromium' ? await browserContext.newCDPSession(page) : null
const beginArrangeDrop = async () => {
  const from = await arrangementGrip.boundingBox()
  const to = await arrangementSettled.locator('button[data-arrangement-header]').boundingBox()
  if (!from || !to) throw new Error('The phone arrangement controls are not visible')
  const origin = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const destination = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  if (arrangementTouch) {
    await arrangementTouch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [origin] })
    for (let step = 1; step <= 10; step++) {
      const fraction = step / 10
      const x = origin.x + (destination.x - origin.x) * fraction
      const y = origin.y + (destination.y - origin.y) * fraction
      await arrangementTouch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
    }
  }
  else {
    await page.mouse.move(origin.x, origin.y)
    await page.mouse.down()
    await page.mouse.move(destination.x, destination.y, { steps: 10 })
  }
  await arrangement.locator('[data-arrangement-preview-action]').getByText('Settle', { exact: true }).waitFor()
}
const endArrangeDrop = async (cancel: boolean) => {
  if (arrangementTouch) await arrangementTouch.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] })
  else {
    if (cancel) await page.keyboard.press('Escape')
    await page.mouse.up()
  }
}
await beginArrangeDrop()
await capture('thread-arrangement-phone-drop')
await endArrangeDrop(true)
await arrangementGrip.waitFor()
check('canceling a phone arrangement drop keeps the sheet and saved pin', await arrangement.isVisible()
  && await arrangement.locator('[data-arrangement-preview]').isHidden())
await beginArrangeDrop()
await endArrangeDrop(false)
await arrangementPin.waitFor({ state: 'detached' })
const arrangementUndo = arrangement.locator('[data-thread-undo]')
await arrangementUndo.getByText('Thread settled').waitFor()
await capture('thread-undo-arrangement')
await arrangementUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await arrangementGrip.waitFor()
check('phone Undo restores a settled pin without closing Arrange threads', harness.engine.current.sessions.get(steerSessionId)?.navigation?.pinnedOrder != null
  && await arrangement.isVisible())
const arrangementOtherPin = arrangement.locator(`[data-section-id^="pinned-"] [data-arrangement-row][data-item-id="${sessionId}"]`)
const groupedRanks = [steerSessionId, sessionId].map(id => harness.engine.current.sessions.get(id)?.navigation?.pinnedOrder)
for (const row of [arrangementPin, arrangementOtherPin]) {
  await row.locator('[data-arrangement-grip]').click()
  await row.getByRole('button', { name: 'Settle', exact: true }).click()
  await row.waitFor({ state: 'detached' })
}
await arrangementUndo.getByText('2 threads settled', { exact: true }).waitFor()
await capture('thread-undo-grouped-phone')
if (browserName === 'webkit') await pressChord('Meta+z')
else await arrangementUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await arrangementPin.waitFor()
await arrangementOtherPin.waitFor()
check('one phone Undo restores both settled threads to their original ranks', [steerSessionId, sessionId]
  .every((id, index) => harness.engine.current.sessions.get(id)?.navigation?.pinnedOrder === groupedRanks[index]))
await beginArrangeDrop()
await endArrangeDrop(false)
await arrangementTouch?.detach()
await arrangementPin.waitFor({ state: 'detached' })
const arrangedParked = arrangementSettled.getByRole('button', { name: 'Reorder Parity release review' })
await arrangementSettled.locator('button[data-arrangement-header]').click()
await arrangedParked.focus()
await page.keyboard.press('Enter')
await arrangementSettled.getByRole('button', { name: 'Pin', exact: true }).press('Enter')
await arrangementGrip.waitFor()
await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reorder Parity release review')
await arrangement.getByRole('button', { name: 'Done' }).click()
await arrangement.waitFor({ state: 'hidden' })
await page.waitForFunction(() => document.activeElement?.hasAttribute('data-thread-actions-trigger'))
await page.reload()
await openArrangement()
await arrangementGrip.waitFor()
check('the phone sheet saves drag and keyboard moves across reload and restores focus', harness.engine.current.sessions.get(steerSessionId)?.navigation?.settledAt === null)
await arrangement.getByRole('button', { name: 'Done' }).click()
await arrangement.waitFor({ state: 'hidden' })
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
const desktopUndo = page.locator('[data-navigation-undo] [data-thread-undo]')
await desktopUndo.getByText('Thread snoozed').waitFor()
await capture('thread-undo-desktop')
await page.locator('[data-prompt]').focus()
await pressChord('Meta+z')
await pinnedThreads.getByText('Parity release review', { exact: true }).waitFor()
await desktopUndo.waitFor({ state: 'hidden' })
check('manual wake and keyboard Undo from the composer restore the original pin', true)

const previousPin = harness.engine.current.sessions.get(steerSessionId)?.navigation?.pinnedOrder
await page.setViewportSize({ width: 390, height: 844 })
await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Unpin thread', exact: true }).click()
const compactUndo = page.locator('[data-compact-thread-undo] [data-thread-undo]')
await compactUndo.getByText('Thread unpinned').waitFor()
check('the action menu releases the phone Undo control as soon as it appears', !await threadActions.isVisible())
await capture('thread-undo-phone')
const undoPrompt = page.locator('[data-prompt]')
await undoPrompt.press('x')
await pressChord(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
check('typing hands the shortcut back to the editor while the thread Undo button stays available',
  !await undoPrompt.inputValue() && await compactUndo.isVisible())
await compactUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await compactUndo.waitFor({ state: 'hidden' })
check('phone Undo restores the exact pin position', harness.engine.current.sessions.get(steerSessionId)?.navigation?.pinnedOrder === previousPin)
await page.setViewportSize({ width: 1280, height: 800 })

await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Archive thread', exact: true }).click()
await page.waitForURL(url => url.pathname === '/' && url.searchParams.has('workspace'))
await desktopUndo.getByText('Thread archived').waitFor()
await capture('thread-undo-archive')
await desktopUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await page.waitForURL(url => url.pathname === `/s/${steerSessionId}`)
await page.locator('[data-composer]').waitFor()
check('Undo archive restores the previously viewed thread and original pin', harness.engine.current.sessions.get(steerSessionId)?.navigation?.pinnedOrder === previousPin)

await threadActionsTrigger.click()
await threadActions.getByRole('button', { name: 'Archive thread', exact: true }).click()
await page.waitForURL(url => url.pathname === '/' && url.searchParams.has('workspace'))
await page.goto(`${baseUrl}/s/${steerSessionId}`)
await page.locator('[data-thread-archived]').waitFor()
await page.locator('[data-composer]').waitFor({ state: 'hidden' })
check('archiving keeps the old link readable and removes the thread from navigation',
  !await page.locator(`[data-sidebar-item][href="/s/${steerSessionId}"]`).count())
await pressChord('Control+k')
await searchDialog.waitFor()
await threadSearch.fill('Parity release review')
await searchDialog.getByText('No matching threads.').waitFor()
await page.keyboard.press('Escape')
await searchDialog.waitFor({ state: 'hidden' })
await pressChord('Meta+,')
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
await pressChord('Control+f')
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
const modelGrid = draftDialog.getByRole('grid', { name: 'Models' })
const fastModel = modelGrid.locator('[data-draft-model-option]').filter({ hasText: 'Fixture Fast' })
await draftPicker.click()
await draftDialog.getByRole('button', { name: /Codex.*Catalog fixture/ }).click()
check('browsing a named account exposes its own model catalog',
  await fastModel.isVisible()
  && await modelGrid.getByRole('button', { name: 'Fixture Default', exact: true }).count() === 0)
const favoriteFast = modelGrid.getByRole('button', { name: /^Favorite Fixture Fast on Codex/ })
await favoriteFast.press('Space')
await page.waitForFunction(() => document.querySelector('[data-draft-model-star][aria-pressed="true"]') !== null)
check('favoriting a model keeps the draft selection and scopes the flag to its account',
  (await draftPicker.textContent())?.includes('Fixture Fast') === false
  && harness.engine.current.profiles.get(providerProfileId)?.modelFavorites?.some(model => model.model === 'fixture-fast' && model.providerInstanceId === 4) === true)
await draftDialog.getByRole('button', { name: 'Favorites', exact: true }).click()
check('the Favorites filter shows the starred account and model',
  await fastModel.isVisible() && await modelGrid.getByRole('button', { name: 'Provider default', exact: true }).count() === 0)
await capture('model-favorites-desktop')
const favoritesClient = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme, reducedMotion })
try {
  const phoneFavorites = await favoritesClient.newPage()
  await phoneFavorites.goto(`${baseUrl}/?workspace=${workspaceId}`)
  await phoneFavorites.getByRole('button', { name: 'Choose agent and model' }).click()
  await phoneFavorites.getByRole('button', { name: 'Favorites', exact: true }).click()
  const phoneStar = phoneFavorites.locator('[data-draft-model-star][aria-pressed="true"]')
  await phoneStar.waitFor()
  check('another client sees the saved model and a visible star on a narrow screen', await phoneStar.evaluate(star => {
    const rect = star.getBoundingClientRect()
    const glyph = star.querySelector('.i-f7-star-fill')
    return rect.left >= 0 && rect.right <= innerWidth && Boolean(glyph && getComputedStyle(glyph).maskImage !== 'none')
  }))
  await capture('model-favorites-phone', phoneFavorites)
}
finally {
  await favoritesClient.close()
}
await page.reload()
await draftPicker.click()
await draftDialog.getByRole('button', { name: 'Favorites', exact: true }).click()
await fastModel.waitFor()
check('favorites reload from the host', await favoriteFast.getAttribute('aria-pressed') === 'true')
await favoriteFast.click()
await draftDialog.getByText('No favorite models available.').waitFor()
check('removing a favorite leaves focus in the picker and clears the saved flag',
  await draftSearch.evaluate(input => input === document.activeElement)
  && harness.engine.current.profiles.get(providerProfileId)?.modelFavorites?.length === 0)
await draftDialog.getByRole('button', { name: /Codex.*Catalog fixture/ }).click()
await draftSearch.fill('No such model')
await draftDialog.getByText('No matching models').waitFor()
await draftSearch.press('Escape')
await draftDialog.waitFor({ state: 'hidden' })
check('Escape returns focus after browsing and leaves the draft selection unchanged',
  await draftPicker.evaluate(button => button === document.activeElement && !button.textContent?.includes('Fixture Fast')))
await draftPicker.click()
await draftSearch.fill('fixture-fast')
await fastModel.waitFor()
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

await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
await page.locator('[data-prompt]').fill('exercise provider resume rejection')
await page.locator('[data-send]').click()
const providerError = page.locator('[data-session-error]')
await providerError.waitFor()
check('resume errors give a recovery action in the active thread', await providerError.evaluate(element =>
  element.getAttribute('role') === 'alert' && element.textContent?.includes('Check the selected account and retry') === true))
await capture('provider-resume-error-desktop')
await page.setViewportSize({ width: 390, height: 844 })
await page.reload()
await providerError.waitFor()
check('the resume error survives reload as plain text with a usable composer', await page.evaluate(() => {
  const error = document.querySelector('[data-session-error]')
  const alertBounds = error?.getBoundingClientRect()
  const composer = document.querySelector('[data-composer]')?.getBoundingClientRect()
  const send = document.querySelector('[data-send]')?.getBoundingClientRect()
  return error?.textContent?.includes('<div data-error-injection>') === true && !error.querySelector('[data-error-injection]')
    && !!alertBounds && !!composer && Math.abs(alertBounds.left - composer.left) < 1 && Math.abs(alertBounds.right - composer.right) < 1
    && !!send && send.top >= 0 && send.bottom <= innerHeight
}))
await capture('provider-resume-error-phone')
await page.locator('[data-prompt]').fill('Retry in the original thread.')
await page.locator('[data-send]').click()
await page.locator('[data-turn]').getByText('Retry in the original thread.').waitFor()
check('retry accepts a new turn in the same thread and clears the previous error', await providerError.isHidden()
  && Number(new URL(page.url()).pathname.split('/').at(-1)) === catalogSession?.id)

await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const activePicker = page.getByRole('button', { name: 'Choose model for the next message' })
await page.setViewportSize({ width: 1280, height: 800 })
await activePicker.click()
await draftDialog.getByRole('button', { name: 'Fixture Balanced', exact: true }).click()
await draftDialog.getByRole('button', { name: 'Low', exact: true }).click()
check('the active picker retains the named account and exposes alternate providers',
  await draftDialog.locator('[data-draft-model-account]').count() > 2)
check('the desktop picker opens alongside the composer without covering the sidebar', await draftDialog.evaluate(dialog => {
  const sidebar = document.querySelector('[data-harness-sidebar]')?.getBoundingClientRect()
  const trigger = document.querySelector('[data-model-picker-trigger]')?.getBoundingClientRect()
  const picker = dialog.getBoundingClientRect()
  return !!sidebar && !!trigger && picker.left >= sidebar.right && Math.abs(picker.right - trigger.right) <= 1
}))
await capture('active-codex-model-desktop')
await draftDialog.getByRole('button', { name: 'Done' }).click()
await page.locator('[data-prompt]').fill('Send with the balanced model.')
await page.reload()
await page.waitForFunction(() => document.querySelector('[data-prompt]')?.value === 'Send with the balanced model.')
check('an unsent model choice reloads alongside the draft', (await activePicker.innerText()).includes('fixture-balanced · Low'))
await page.locator('[data-send]').click()
await page.locator('[data-model-change]').filter({ hasText: 'fixture-balanced · Low' }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const activeInput = fixtureCodexTurns.find(turn => turn.text === 'Send with the balanced model.')
check('an active model switch reaches the original provider conversation',
  activeInput?.providerSessionId === 'ps-drive' && activeInput.codexSelection?.model === 'fixture-balanced'
  && activeInput.codexSelection.effort === 'low' && activeInput.codexSelection.serviceTier === undefined)

await page.locator('[data-prompt]').fill('exercise active steering')
await page.locator('[data-send]').click()
await page.getByText('Ready for active steering.', { exact: true }).waitFor()
await page.setViewportSize({ width: 390, height: 844 })
await activePicker.click()
await draftDialog.getByRole('button', { name: 'Fixture Fast', exact: true }).click()
await draftDialog.getByRole('button', { name: 'High', exact: true }).click()
await draftDialog.getByRole('button', { name: 'Fast', exact: true }).click()
await capture('active-codex-model-phone')
await draftDialog.getByRole('button', { name: 'Done' }).click()
await page.locator('[data-prompt]').fill('Queue with the fast model.')
await page.locator('[data-send]').click()
const switchedQueue = page.locator('[data-follow-up]').filter({ hasText: 'Queue with the fast model.' })
await switchedQueue.locator('[data-queued-model]').waitFor()
check('a queued model change cannot steer the in-flight model', await switchedQueue.getByRole('button', { name: 'Send now' }).isHidden())
await page.reload()
await switchedQueue.locator('[data-queued-model]').waitFor()
releaseSteering?.()
await page.locator('[data-model-change]').filter({ hasText: 'fixture-fast · High · Fast' }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const switchedInput = fixtureCodexTurns.find(turn => turn.text === 'Queue with the fast model.')
check('a queued model change survives reload and runs with the saved options',
  switchedInput?.providerSessionId === 'ps-drive' && switchedInput.codexSelection?.model === 'fixture-fast'
  && switchedInput.codexSelection.effort === 'high' && switchedInput.codexSelection.serviceTier === 'fast')
await capture('active-codex-queued-transition')
const sourceId = catalogSession!.id
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(`${baseUrl}/s/${sourceId}`)
const firstReply = page.locator('[data-turn="1"]')
const forkButton = firstReply.getByRole('button', { name: 'Fork from this response' })
await forkButton.scrollIntoViewIfNeeded()
await capture('fork-source-desktop')
await forkButton.click()
await page.waitForURL(url => url.pathname.startsWith('/s/') && url.pathname !== `/s/${sourceId}`)
const forkId = Number(new URL(page.url()).pathname.split('/').at(-1))
const forkBanner = page.locator('[data-fork-banner]')
await forkBanner.getByText('Creating fork…').waitFor()
check('the fork waits for provider verification before exposing the composer', !(await page.locator('[data-composer]').isVisible()))
await page.reload()
await forkBanner.getByText('Creating fork…').waitFor()
releaseCodexFork.resolve()
await forkBanner.getByText('Forked conversation').waitFor()
await page.locator('[data-composer]').waitFor()
check('the fork contains only the selected transcript prefix', await page.locator('[data-turn]').count() === 1
  && await firstReply.getByText('Thinking… done.').isVisible()
  && await forkBanner.getByRole('link', { name: 'Source response' }).getAttribute('href') === `/s/${sourceId}#turn-1`)
check('the host forks once with the native response boundary and preserves the source', fixtureCodexForks.length === 1
  && fixtureCodexForks[0]?.providerSessionId === 'ps-drive'
  && fixtureCodexForks[0]?.providerTurnId === harness.engine.current.sessions.get(sourceId)?.turns[0]?.providerTurnId
  && Boolean(fixtureCodexForks[0]?.providerTurnId)
  && (harness.engine.current.sessions.get(sourceId)?.turns.length ?? 0) > 1)
await page.setViewportSize({ width: 390, height: 844 })
check('the phone fork controls stay visible and fit the workspace', await page.evaluate(() =>
  document.documentElement.scrollWidth === innerWidth && !!document.querySelector('[data-fork-source]')?.getClientRects().length))
await capture('fork-ready-phone')
await page.locator('[data-prompt]').fill('Continue only in the fork.')
await page.locator('[data-send]').click()
await page.locator('[data-turn="2"]').getByText('Continue only in the fork.').waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('a follow-up continues on the new native thread and leaves the source unchanged',
  fixtureCodexTurns.find(turn => turn.text === 'Continue only in the fork.')?.providerSessionId === 'ps-drive-fork'
  && harness.engine.current.sessions.get(forkId)?.providerSessionId === 'ps-drive-fork'
  && !harness.engine.current.sessions.get(sourceId)?.turns.some(turn => turn.prompt === 'Continue only in the fork.'))
check('the fork source stays attached to the copied response after continuation', await forkBanner.evaluate(marker =>
  marker.previousElementSibling?.getAttribute('data-turn') === '1'
  && Boolean(marker.compareDocumentPosition(document.querySelector('[data-turn="2"]')!) & Node.DOCUMENT_POSITION_FOLLOWING)))
await page.setViewportSize({ width: 1280, height: 800 })
await capture('fork-continued-desktop')
await page.reload()
const sourceResponseLink = forkBanner.getByRole('link', { name: 'Source response' })
await sourceResponseLink.waitFor()
check('the lineage marker survives reload between the two responses', await forkBanner.evaluate(marker =>
  marker.previousElementSibling?.getAttribute('data-turn') === '1'
  && marker.nextElementSibling?.getAttribute('data-turn') === '2'))
await sourceResponseLink.click()
await page.waitForURL(url => url.pathname === `/s/${sourceId}` && url.hash === '#turn-1')
check('the source link returns to the originating response', await page.locator('[data-turn="1"]').isVisible()
  && !(await page.getByText('Continue only in the fork.', { exact: true }).count()))
await page.goto(`${baseUrl}/s/${sourceId}`)
await page.setViewportSize({ width: 390, height: 844 })
await handoffPicker.click()
await handoffDialog.getByRole('combobox', { name: 'Search models' }).fill('Claude Personal')
await handoffDialog.getByRole('button', { name: /Provider default.*Claude Code.*Personal/ }).waitFor()
await capture('handoff-picker-phone')
await handoffDialog.getByRole('button', { name: /Provider default.*Claude Code.*Personal/ }).click()
await page.locator('[data-handoff-hint]').waitFor()
await page.locator('[data-prompt]').fill('Continue the Codex work with Claude.')
await capture('handoff-staged-phone')
const previousTurnCount = harness.engine.current.sessions.get(sourceId)!.turns.length
await page.locator('[data-send]').click()
const handedOff = page.locator('[data-turn]').filter({ hasText: 'Continue the Codex work with Claude.' })
await handedOff.locator('[data-provider-switch]').getByText('Continued with Claude Code').waitFor()
await handedOff.getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const context = fixtureHandoffs.at(-1)
check('the cross-provider continuation transfers attributed history and keeps the new request separate',
  context?.providerSessionId === undefined && context?.text.includes('\"role\":\"assistant\"')
  && context?.text.includes('Queue with the fast model.') && context?.text.endsWith('New user request:\nContinue the Codex work with Claude.')
  && harness.engine.current.sessions.get(sourceId)?.turns.length === previousTurnCount + 1)
check('switching the source keeps the fork on its own Codex conversation', harness.engine.current.sessions.get(forkId)?.providerSessionId === 'ps-drive-fork')
await page.reload()
await handedOff.locator('[data-provider-switch]').getByText('Continued with Claude Code').waitFor()
check('the provider switch boundary survives a page reload', await page.locator('[data-session-driver]').textContent() === 'claude'
  && await handedOff.locator('[data-user-prompt]').textContent() === 'Continue the Codex work with Claude.'
  && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await capture('handoff-completed-phone')
await page.setViewportSize({ width: 1280, height: 800 })
await capture('handoff-completed-desktop')
await page.setViewportSize({ width: 390, height: 844 })
const historicalFork = page.locator('[data-turn="1"]').getByRole('button', { name: 'Fork from this response' })
await historicalFork.scrollIntoViewIfNeeded()
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await historicalFork.scrollIntoViewIfNeeded()
    await capture(`historical-fork-source-${width}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
}
check('the current and historical responses offer the Fork action after a provider switch',
  await historicalFork.isVisible() && await handedOff.getByRole('button', { name: 'Fork from this response' }).isVisible())
await historicalFork.click()
await page.waitForURL(url => url.pathname.startsWith('/s/') && ![`/s/${sourceId}`, `/s/${forkId}`].includes(url.pathname))
const historicalId = Number(new URL(page.url()).pathname.split('/').at(-1))
await page.getByText('Forked conversation', { exact: true }).waitFor()
check('a portable historical fork selects the current account and copies only its prefix',
  harness.engine.current.sessions.get(historicalId)?.driverKind === 'claude'
  && harness.engine.current.sessions.get(historicalId)?.providerInstanceId === 2
  && harness.engine.current.sessions.get(historicalId)?.providerSessionId === ''
  && fixtureCodexForks.length === 1
  && await page.locator('[data-turn]').count() === 1)
await capture('historical-fork-completed-phone')
await page.locator('[data-prompt]').fill('Continue from the historical response only.')
await page.locator('[data-send]').click()
await page.locator('[data-turn="2"]').getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const forkContext = fixtureHandoffs.at(-1)
check('the portable fork imports the selected history into one fresh conversation',
  forkContext?.providerSessionId === undefined
  && forkContext?.text.includes('Thinking… done.')
  && !forkContext?.text.includes('Queue with the fast model.')
  && !forkContext?.text.includes('Continue the Codex work with Claude.')
  && forkContext?.text.endsWith('Continue from the historical response only.')
  && harness.engine.current.sessions.get(sourceId)?.driverKind === 'claude')
await capture('historical-fork-continued-phone')
await page.goto(`${baseUrl}/s/${sourceId}`)
await page.setViewportSize({ width: 390, height: 844 })
await handoffPicker.click()
await handoffDialog.getByRole('combobox', { name: 'Search models' }).fill('Fixture Fast Catalog fixture')
await handoffDialog.getByRole('button', { name: /^Fixture Fast.*Codex.*Catalog fixture$/ }).click()
await handoffDialog.getByRole('button', { name: 'Done' }).click()
const returnPrompt = 'Return to the original Codex account.'
await page.locator('[data-prompt]').fill(returnPrompt)
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await capture(`handoff-return-staged-${width}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
}
await page.locator('[data-send]').click()
const returned = page.locator('[data-turn]').filter({ hasText: returnPrompt })
await returned.locator('[data-provider-switch]').getByText('Continued with Codex').waitFor()
await returned.getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const resumedInput = fixtureCodexTurns.at(-1)
check('returning to a named account resumes its native conversation with only the missing history',
  resumedInput?.providerSessionId === 'ps-drive' && resumedInput.requireResume === true
  && resumedInput.text.includes('Continue the Codex work with Claude.')
  && !resumedInput.text.includes('Queue with the fast model.')
  && resumedInput.text.endsWith(returnPrompt)
  && harness.engine.current.sessions.get(sourceId)?.providerInstanceId === 4
  && new URL(page.url()).pathname === `/s/${sourceId}`)
await capture('handoff-return-completed-phone')
await page.locator('[data-prompt]').fill('/compact')
await page.locator('[data-send]').click()
const compactTurn = page.locator('[data-turn]').filter({ has: page.locator('[data-user-prompt]').getByText('/compact', { exact: true }) })
await compactTurn.waitFor()
check('the compact command does not claim success before a provider boundary',
  await compactTurn.locator('[data-context-compacted]').isHidden()
  && !fixtureCodexTurns.some(input => input.text === '/compact'))
await capture('compaction-running-phone')
releaseCodexCompaction.resolve()
await compactTurn.getByText('Context compacted', { exact: true }).waitFor()
await page.reload()
await compactTurn.getByText('Context compacted', { exact: true }).waitFor()
check('compaction is recorded once on the existing provider conversation and survives reload',
  fixtureCodexCompactions.length === 1 && fixtureCodexCompactions[0] === 'ps-drive'
  && await page.getByText('Continue the Codex work with Claude.', { exact: true }).isVisible()
  && await compactTurn.getByRole('button', { name: 'Fork from this response' }).isHidden())
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await compactTurn.scrollIntoViewIfNeeded()
    await capture(`compaction-completed-${width}`)
  }
}
const afterCompaction = 'Continue after context compaction.'
await page.locator('[data-prompt]').fill(afterCompaction)
await page.locator('[data-send]').click()
await page.getByText(afterCompaction, { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('the next prompt resumes the compacted provider thread',
  fixtureCodexTurns.find(input => input.text === afterCompaction)?.providerSessionId === 'ps-drive')
await page.setViewportSize({ width: 1280, height: 800 })
const contextWindow = page.locator('[data-context-window]')
check('threads without a provider sample have no context row', await contextWindow.isHidden())
await page.locator('[data-prompt]').fill('Record nearly full context usage.')
await page.locator('[data-send]').click()
await page.getByText('Record nearly full context usage.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
await contextWindow.getByText('31,000 / 32,000 tokens', { exact: true }).waitFor()
const usageMeter = contextWindow.getByRole('meter', { name: 'Context window usage' })
check('the context rail announces the latest count and capacity without a reload',
  await usageMeter.getAttribute('aria-valuetext') === '31,000 / 32,000 tokens'
  && await usageMeter.evaluate((meter: HTMLMeterElement) => meter.value === 31000 && meter.max === 32000))
await capture('context-window-desktop')
await page.reload()
await contextWindow.getByText('31,000 / 32,000 tokens', { exact: true }).waitFor()
check('context data and the appearance preference survive reload', true)
await page.setViewportSize({ width: 390, height: 844 })
await page.locator('[data-workspace-actions-toggle]').click()
await contextWindow.waitFor({ state: 'visible' })
await capture('context-window-phone')
await page.keyboard.press('Escape')
await contextWindow.waitFor({ state: 'hidden' })
await page.setViewportSize({ width: 1280, height: 800 })
await handoffPicker.click()
await handoffDialog.getByRole('combobox', { name: 'Search models' }).fill('Claude Personal')
await handoffDialog.getByRole('button', { name: /Provider default.*Claude Code.*Personal/ }).click()
await page.locator('[data-prompt]').fill('Bring this new constraint from Claude.')
await page.locator('[data-send]').click()
const extraClaude = page.locator('[data-turn]').filter({ hasText: 'Bring this new constraint from Claude.' })
await extraClaude.getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('switching providers clears the old account’s context sample', await contextWindow.isHidden())
await page.setViewportSize({ width: 360, height: 800 })
await handoffPicker.click()
await handoffDialog.getByRole('combobox', { name: 'Search models' }).fill('Fixture Fast Catalog fixture')
await handoffDialog.getByRole('button', { name: /^Fixture Fast.*Codex.*Catalog fixture$/ }).click()
await handoffDialog.getByRole('button', { name: 'Done' }).click()
const fallbackPrompt = 'Continue with the retained history on Codex.'
await page.locator('[data-prompt]').fill(fallbackPrompt)
await page.locator('[data-send]').click()
const capacityFallback = page.locator('[data-turn]').filter({ hasText: fallbackPrompt })
await capacityFallback.getByText('I received the saved context.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const capacityInput = fixtureCodexTurns.find(input => input.text.endsWith(fallbackPrompt))
check('an occupied provider window starts one fresh continuation in the same thread',
  capacityInput?.providerSessionId === undefined
  && capacityInput?.text.includes('Record nearly full context usage.')
  && capacityInput?.text.includes('Bring this new constraint from Claude.')
  && fixtureCodexTurns.filter(input => input.text.endsWith(fallbackPrompt)).length === 1
  && new URL(page.url()).pathname === `/s/${sourceId}`)
await capacityFallback.scrollIntoViewIfNeeded()
await capture('handoff-capacity-fallback-phone')



const idleFixtureId = 'claude-idle-browser'
await harness.engine.dispatch({
  id: idleFixtureId, at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude' },
})
const idleUrl = new URL(`/s/${derivedId(idleFixtureId)}`, baseUrl)
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(idleUrl.href)
const compactChoice = page.locator('[data-idle-compaction]')
const idlePrompt = page.getByRole('textbox', { name: 'Message', exact: true })
await idlePrompt.fill('Idle Claude fixture: warm cache')
await idlePrompt.press('Enter')
await page.getByText('Fixture context recorded.', { exact: true }).last().waitFor()
check('Claude does not offer prompt compaction while the cache is warm', await compactChoice.isHidden())
await compactChoice.waitFor({ state: 'visible', timeout: 5000 })
check('an expiring cache reveals the Compact choice without a reload',
  await compactChoice.getAttribute('aria-pressed') === 'true'
  && /220K/i.test(await compactChoice.textContent() ?? ''))
await compactChoice.click()
await page.getByRole('button', { name: /Keep full context/ }).waitFor()
await capture('idle-compaction-keep-desktop')
await idlePrompt.fill('Idle Claude fixture: follow-up with full context')
await idlePrompt.press('Enter')
await page.getByText('Fixture continued.', { exact: true }).last().waitFor()
check('Keep delivers the user message without running compaction',
  !idleClaudeDelivery.some(([message]) => message === '/compact'))
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
await idlePrompt.fill('Idle Claude fixture: expired cache')
await idlePrompt.press('Enter')
await compactChoice.waitFor({ state: 'visible' })
await page.reload()
await compactChoice.waitFor({ state: 'visible' })
check('an eligible Claude conversation keeps its Compact choice after reload', await compactChoice.getAttribute('aria-pressed') === 'true')
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await capture(`idle-compaction-compact-${width}`)
  }
}
await page.setViewportSize({ width: 390, height: 844 })
await idlePrompt.fill('Idle Claude fixture: follow-up after compaction')
await idlePrompt.press('Enter')
const automaticCompaction = page.locator('[data-context-compacted]:visible')
await automaticCompaction.waitFor()
await page.locator('[data-turn]').filter({ hasText: 'Idle Claude fixture: follow-up after compaction' })
  .getByText('Fixture continued.', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('Compact sends the queued follow-up once after marking the native compaction',
  JSON.stringify(idleClaudeDelivery.slice(-2)) === JSON.stringify([
    ['/compact', 'idle-claude-fixture'],
    ['Idle Claude fixture: follow-up after compaction', 'idle-claude-fixture'],
  ]) && await page.locator('[data-automatic-compaction]:visible').count() === 1)
await automaticCompaction.scrollIntoViewIfNeeded()
await capture('idle-compaction-completed-phone')

const providerPreferences = new URL('/settings/providers', baseUrl)
providerPreferences.searchParams.set('from', idleUrl.pathname)
await page.goto(providerPreferences.href)
await settingsDialog.getByText('Advanced', { exact: true }).click()
const idleSetting = settingsDialog.locator('[data-host-compaction-settings]').getByLabel('Compact idle threads')
check('the host defaults to compacting idle Claude threads on return', await idleSetting.inputValue() === 'whenReturning')
await idleSetting.selectOption('off')
await page.waitForFunction(() => document.querySelector('#settings-claude-idle-compaction')?.value === 'off')
await capture('idle-compaction-settings-phone')
const autoCompactWindow = settingsDialog.locator('[data-host-compaction-settings]').getByRole('spinbutton', { name: 'Auto-compact after' })
check('Claude starts with its own automatic compaction window', await autoCompactWindow.inputValue() === '')
await autoCompactWindow.fill('99999')
await autoCompactWindow.press('Tab')
await settingsDialog.getByRole('alert').filter({ hasText: /Enter a whole number/ }).waitFor()
check('the provider setting refuses a threshold below its supported range', harness.engine.current.settings.claudeAutoCompactAfter === null)
await autoCompactWindow.fill('300000')
await autoCompactWindow.press('Tab')
for (let attempts = 0; attempts < 100 && harness.engine.current.settings.claudeAutoCompactAfter !== 300_000; attempts++)
  await Bun.sleep(20)
await capture('automatic-compaction-window-phone')
await page.reload()
await settingsDialog.getByText('Advanced', { exact: true }).click()
check('Never is saved as a host provider setting', await idleSetting.inputValue() === 'off')
check('Claude’s automatic compaction window survives reload', await autoCompactWindow.inputValue() === '300000')
await autoCompactWindow.fill('')
await autoCompactWindow.press('Tab')
for (let attempts = 0; attempts < 100 && harness.engine.current.settings.claudeAutoCompactAfter !== null; attempts++)
  await Bun.sleep(20)
check('clearing the automatic window restores the provider default', harness.engine.current.settings.claudeAutoCompactAfter === null)
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
await page.waitForURL(idleUrl.href)
await idlePrompt.fill('Idle Claude fixture: expired cache with Never selected')
await idlePrompt.press('Enter')
await page.locator('[data-turn]').filter({ hasText: 'Idle Claude fixture: expired cache with Never selected' })
  .getByText('Fixture context recorded.', { exact: true }).waitFor()
check('Never suppresses the Compact choice for a fresh high-usage sample', await compactChoice.isHidden())


await page.goto(providerPreferences.href)
const workCompaction = page.locator('[data-claude-account="1"]')
const personalCompaction = page.locator('[data-claude-account="2"]')
await workCompaction.locator('summary').click()
const workMode = workCompaction.locator('[data-claude-account-idle]')
const workWindow = workCompaction.locator('[data-claude-account-window]')
check('named Claude accounts inherit before edits', await workMode.inputValue() === '' && await workWindow.inputValue() === '')
await workMode.selectOption('whenReturning')
await workWindow.fill('300000')
await workWindow.press('Tab')
for (let attempts = 0; attempts < 100 && harness.engine.current.profiles.get(providerProfileId)?.claudeCompactionByAccount?.[1]?.autoCompactAfter !== 300_000; attempts++)
  await Bun.sleep(20)
await page.reload()
await workCompaction.locator('summary').click()
check('the named account’s independent mode and threshold survive reload',
  await workMode.inputValue() === 'whenReturning' && await workWindow.inputValue() === '300000')
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await workWindow.scrollIntoViewIfNeeded()
    await capture(`claude-account-compaction-${width}`)
  }
}
await personalCompaction.locator('summary').click()
const personalMode = personalCompaction.locator('[data-claude-account-idle]')
const personalWindow = personalCompaction.locator('[data-claude-account-window]')
await personalCompaction.locator('[data-claude-account-default]').check()
await personalWindow.waitFor({ state: 'visible' })
check('choosing the Claude default leaves the other account intact',
  await personalWindow.isDisabled() && await personalMode.inputValue() === '' && await workWindow.inputValue() === '300000')

for (const [id, label] of [[1, 'Work'], [2, 'Personal']] as const) {
  const key = `claude-account-browser-${id}`
  await harness.engine.dispatch({
    id: key, at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude', providerInstanceId: id },
  })
  await page.goto(new URL(`/s/${derivedId(key)}`, baseUrl).href)
  await idlePrompt.fill(`Idle Claude fixture: expired cache on ${label}`)
  await idlePrompt.press('Enter')
  await page.getByText('Fixture context recorded.', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
  if (id === 1) await compactChoice.waitFor({ state: 'visible' })
  check(`the ${label} account uses its effective idle setting`, await compactChoice.isVisible() === (id === 1))
}


const freshFixtureKey = 'fresh-session-browser'
await harness.engine.dispatch({
  id: freshFixtureKey, at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude' },
})
const freshSessionId = derivedId(freshFixtureKey)
const freshUrl = new URL(`/s/${freshSessionId}`, baseUrl)
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(freshUrl.href)
const freshPromptBox = page.getByRole('textbox', { name: 'Message', exact: true })
const freshBanner = page.locator('[data-fresh-session-banner]')
const freshMenu = page.locator('[data-clear-command]')
const freshBoundary = page.locator('[data-fresh-context]:visible')
const firstFreshPrompt = 'Fresh session fixture: remember the first draft'
await freshPromptBox.fill(firstFreshPrompt)
await freshPromptBox.press('Enter')
await page.getByText('Fixture answer for remember the first draft', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
const originalConversation = harness.engine.current.sessions.get(freshSessionId)?.providerSessionId

await freshPromptBox.fill('/cl')
await freshMenu.waitFor({ state: 'visible' })
await freshPromptBox.press('ArrowDown')
check('the slash command is reachable from the composer keyboard', await freshMenu.evaluate(element => element === document.activeElement))
await freshMenu.press('Enter')
await freshBanner.waitFor()
check('arming a fresh session keeps the current provider until the next send',
  await freshPromptBox.inputValue() === '' && harness.engine.current.sessions.get(freshSessionId)?.providerSessionId === originalConversation)
await page.reload()
await freshBanner.waitFor()
await freshBanner.getByRole('button', { name: 'Keep current session' }).click()
await freshBanner.waitFor({ state: 'hidden' })
await freshPromptBox.fill('Fresh session fixture: continue the original')
await freshPromptBox.press('Enter')
await page.getByText('Fixture answer for continue the original', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('Keep current session resumes the existing native conversation',
  freshClaudeCalls.at(-1)?.providerSessionId === originalConversation)

writeFileSync(join(dir, 'fresh-session-evidence.txt'), 'This workspace change survives the conversation reset.\n')
await freshPromptBox.fill('/clear')
await freshPromptBox.press('Enter')
await freshBanner.waitFor()
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await capture(`fresh-session-armed-${width}`)
  }
}
await page.setViewportSize({ width: 390, height: 844 })
await freshPromptBox.fill('Fresh session fixture: give an independent answer')
await freshPromptBox.press('Enter')
await freshBoundary.waitFor()
await page.getByText('Fixture answer for give an independent answer', { exact: true }).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
check('a fresh session sends the new message alone and leaves prior turns visible',
  freshClaudeCalls.at(-1)?.text === 'Fresh session fixture: give an independent answer'
  && freshClaudeCalls.at(-1)?.providerSessionId === undefined
  && freshClaudeCalls.at(-1)?.historicalContext === undefined
  && harness.engine.current.sessions.get(freshSessionId)?.providerSessionId !== originalConversation
  && await page.locator('[data-transcript]').getByText(firstFreshPrompt, { exact: true }).isVisible()
  && new URL(page.url()).pathname === freshUrl.pathname)
const freshSessionDiff = await page.request.get(new URL(`/s/${freshSessionId}/diff`, baseUrl).href)
check('workspace changes remain available after the context reset',
  freshSessionDiff.ok() && JSON.stringify(await freshSessionDiff.json()).includes('fresh-session-evidence.txt'))
await freshBoundary.scrollIntoViewIfNeeded()
await capture('fresh-session-boundary-phone')
await page.reload()
await freshBoundary.waitFor()
check('the New session boundary survives reload', await freshBoundary.count() === 1)

await freshPromptBox.fill('Fresh session fixture: hold the current turn')
await freshPromptBox.press('Enter')
await page.getByText('Fixture answer for hold the current turn', { exact: true }).waitFor()
await freshPromptBox.fill('/clear')
await freshPromptBox.press('Enter')
await freshBanner.waitFor()
const queuedFreshPrompt = 'Fresh session fixture: start fresh after waiting'
await freshPromptBox.fill(queuedFreshPrompt)
await freshPromptBox.press('Enter')
const queuedFresh = page.locator('[data-follow-up]').filter({ hasText: queuedFreshPrompt })
await queuedFresh.locator('[data-queued-fresh-session]').waitFor()
check('a fresh message stays queued while the current native turn is active', await queuedFresh.getByRole('button', { name: 'Send now' }).isHidden())
releaseFreshClaudeTurn.resolve()
await page.getByText('Fixture answer for start fresh after waiting', { exact: true }).waitFor()
check('the queued fresh message starts one new native context',
  freshClaudeCalls.filter(call => call.text === queuedFreshPrompt).length === 1
  && freshClaudeCalls.at(-1)?.providerSessionId === undefined
  && await freshBoundary.count() === 2)

const claudeForkSource = 'claude-historical-fork-browser'
await harness.engine.dispatch({
  id: claudeForkSource, at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude', isolate: true },
})
const claudeForkSourceUrl = new URL(`/s/${derivedId(claudeForkSource)}`, baseUrl)
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(claudeForkSourceUrl.href)
const claudeForkPrompt = page.getByRole('textbox', { name: 'Message', exact: true })
for (const [ordinal, text] of [[1, 'first prompt'], [2, 'later parent prompt']] as const) {
  await claudeForkPrompt.fill(`Claude fork fixture: ${text}`)
  await claudeForkPrompt.press('Enter')
  await page.getByText(`Claude fork fixture response ${ordinal}.`, { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
}
await page.locator('[data-turn="1"]').getByRole('button', { name: 'Fork from this response' }).click()
await page.waitForURL(url => url.pathname !== claudeForkSourceUrl.pathname)
await page.locator('[data-fork-banner]').getByText('Forked conversation', { exact: true }).waitFor()
const claudeForkId = Number(new URL(page.url()).pathname.split('/').at(-1))
await page.locator('[data-workspace-branch]').filter({ hasText: `harness/session-${claudeForkId}` }).waitFor()
check('Claude forks at the earlier response and records its copied native boundary',
  claudeForks.length === 1 && claudeForks[0]?.providerTurnId === 'claude-turn-1'
  && claudeForks[0]?.providerSessionId === 'fixture-claude-parent'
  && await page.locator('[data-turn]').count() === 1)
if (screenshotDir) {
  for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
    await page.setViewportSize({ width, height })
    await capture(`claude-fork-ready-${width}`)
  }
}
await claudeForkPrompt.fill('Claude fork fixture: continue in the fork')
await claudeForkPrompt.press('Enter')
await page.getByText('Claude fork fixture response 3.', { exact: true }).waitFor()
check('the Claude fork resumes its own native conversation with an unmodified prompt',
  claudeForkTurns.at(-1)?.providerSessionId === 'fixture-claude-fork-1'
  && claudeForkTurns.at(-1)?.text === 'Claude fork fixture: continue in the fork'
  && claudeForkTurns.at(-1)?.requireResume === true
  && harness.engine.current.sessions.get(derivedId(claudeForkSource))?.turns.length === 2)

// A commit from the terminal clears working-tree changes without reopening the pane.
const ledgerRepo = join(driveRoot, 'terminal-ledger')
mkdirSync(ledgerRepo)
writeFileSync(join(ledgerRepo, 'ledger.txt'), 'Ledger\n')
execSync('git init -qb main && git add ledger.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm Initial', { cwd: ledgerRepo })
execFileSync('git', ['switch', '-qc', 'review/ledger'], { cwd: ledgerRepo })
writeFileSync(join(ledgerRepo, 'branch-only.txt'), 'Branch evidence\n')
execFileSync('git', ['add', '--', 'branch-only.txt'], { cwd: ledgerRepo })
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Branch-only marker'], { cwd: ledgerRepo })
writeFileSync(join(ledgerRepo, 'ledger.txt'), 'Ledger\nSigned\n')
const ledgerWorkspace = 'commit-from-terminal-workspace'
const ledgerThread = 'commit-from-terminal-thread'
const ledgerProfile = 'commit-from-terminal-profile'
await harness.engine.dispatch({ id: ledgerProfile, at: Date.now(), command: { type: 'profile.create', name: 'Terminal review' } })
await harness.engine.dispatch({ id: ledgerWorkspace, at: Date.now(), command: { type: 'workspace.add', profileId: derivedId(ledgerProfile), path: ledgerRepo } })
await harness.engine.dispatch({ id: `${ledgerWorkspace}-trust`, at: Date.now(), command: { type: 'workspace.trust', workspaceId: derivedId(ledgerWorkspace), trusted: true } })
await harness.engine.dispatch({ id: ledgerThread, at: Date.now(), command: { type: 'session.create', workspaceId: derivedId(ledgerWorkspace), driverKind: 'claude' } })
const ledgerPath = `/s/${derivedId(ledgerThread)}`
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(new URL(ledgerPath, baseUrl).href)
const previewSite = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/counter.js') return new Response("const button = document.querySelector('button'); button.disabled = false; button.addEventListener('click', () => { button.textContent = 'Updated' })", { headers: { 'content-type': 'text/javascript' } })
    const heading = path === '/second' ? 'Second preview page' : 'Local development preview'
    return new Response(`<h1>${heading}</h1><button disabled>Update</button><script type="module" src="/counter.js"></script>`, { headers: { 'content-type': 'text/html' } })
  },
})
try {
  const browserPane = page.getByRole('region', { name: 'Browser', exact: true })
  const previewTrigger = page.getByRole('button', { name: 'Open workspace browser' })
  const previewAddress = browserPane.getByRole('textbox', { name: 'Preview address' })
  const activeFrame = browserPane.frameLocator('iframe:not([hidden])')
  const loopback = `127.0.0.1:${previewSite.port}`
  const visitPreview = async (address: string) => {
    await previewAddress.fill(address)
    await previewAddress.press('Enter')
  }
  await previewTrigger.click()
  await previewAddress.waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Preview address')
  check('the preview address uses the active Harness appearance',
    await previewAddress.evaluate(input => getComputedStyle(input).backgroundColor === 'rgba(0, 0, 0, 0)'))
  await capture('workspace-browser-empty')
  await visitPreview(loopback)
  await activeFrame.getByRole('heading', { name: 'Local development preview' }).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') !== 'Preview address')
  await activeFrame.getByRole('button', { name: 'Update' }).click()
  await activeFrame.getByRole('button', { name: 'Updated' }).waitFor()
  check('a live local app can run its own frontend modules in the Browser pane', true)
  await browserPane.getByRole('button', { name: 'New browser tab' }).click()
  await visitPreview(`${loopback}/second`)
  await activeFrame.getByRole('heading', { name: 'Second preview page' }).waitFor()
  await browserPane.locator('[data-preview-select="1"]').click()
  await activeFrame.getByRole('button', { name: 'Updated' }).waitFor()
  check('switching browser tabs preserves the first page’s runtime', true)
  await visitPreview(`${loopback}/second`)
  await activeFrame.getByRole('heading', { name: 'Second preview page' }).waitFor()
  await browserPane.getByRole('button', { name: 'Browser back' }).click()
  await activeFrame.getByRole('heading', { name: 'Local development preview' }).waitFor()
  await browserPane.getByRole('button', { name: 'Browser forward' }).click()
  await activeFrame.getByRole('heading', { name: 'Second preview page' }).waitFor()
  const openExternally = browserPane.getByRole('link', { name: 'Open preview in browser' })
  check('browser back and forward restore entered addresses with an isolated pop-out link',
    await openExternally.getAttribute('href') === `http://${loopback}/second` && await openExternally.getAttribute('rel') === 'noopener noreferrer')
  await visitPreview(new URL(ledgerPath, baseUrl).href)
  await browserPane.getByRole('alert').getByText('Open Harness in its main window.').waitFor()
  check('the browser pane rejects Harness itself and leaves the current preview in place',
    await activeFrame.getByRole('heading', { name: 'Second preview page' }).isVisible())
  await capture('workspace-browser-address-error')
  await browserPane.getByRole('button', { name: 'Reload preview' }).click()
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    check(`browser controls and preview fit at ${width}×${height}`, await browserPane.evaluate((pane) => {
      const bounds = pane.getBoundingClientRect()
      const input = pane.querySelector('input')?.getBoundingClientRect()
      const exit = pane.querySelector('[aria-label="Close browser pane"]')?.getBoundingClientRect()
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.height > 200 && document.documentElement.scrollWidth === innerWidth
        && Boolean(input && exit && input.width >= 60 && exit.right <= innerWidth)
    }))
    const transcript = page.locator('[data-workspace-lane]')
    check(`the preview and transcript use the available workspace width at ${width}×${height}`,
      (await transcript.isVisible()) === (width >= 1024))
    await capture(`workspace-browser-${width}x${height}`)
  }
  const restoredPage = await page.reload()
  await page.getByRole('button', { name: 'Workspace actions' }).click()
  await page.locator('[data-preview-toggle]').click()
  await activeFrame.getByRole('heading', { name: 'Second preview page' }).waitFor()
  check('phone workspace actions restore both browser tabs after reloading the thread',
    await browserPane.locator('[data-preview-select]').count() === 2
    && restoredPage?.headers()['x-frame-options'] === 'DENY'
    && restoredPage?.headers()['content-security-policy'] === "frame-ancestors 'none'")
  await browserPane.getByRole('button', { name: /^Close tab:/u }).last().click()
  check('closing a saved browser tab keeps the selected page available', await browserPane.locator('[data-preview-select]').count() === 1)
  await page.keyboard.press('Escape')
  await browserPane.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.hasAttribute('data-workspace-actions-toggle'))
  check('closing the phone browser returns focus to Workspace actions', true)
  await page.setViewportSize({ width: 1440, height: 900 })

  const ownedPreviewScript = join(driveRoot, 'terminal-preview.ts')
  const ownedPreviewPort = join(driveRoot, 'terminal-preview-port')
  writeFileSync(ownedPreviewScript, `const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Terminal development server</h1>', { headers: { 'content-type': 'text/html' } }) })\nawait Bun.write(${JSON.stringify(ownedPreviewPort)}, String(site.port))\n`)
  await headerTerminal.click()
  await waitForTerminalLine('Harness test terminal')
  await terminalHost.focus()
  await page.keyboard.type(`"${process.execPath}" --config=/dev/null "${ownedPreviewScript}"`)
  await page.keyboard.press('Enter')
  for (let attempt = 0; attempt < 100 && !existsSync(ownedPreviewPort); attempt++) await Bun.sleep(50)
  const ownedAddress = `http://127.0.0.1:${readFileSync(ownedPreviewPort, 'utf8')}/`
  await previewTrigger.click()
  const newPreview = browserPane.getByRole('button', { name: 'New browser tab' })
  await newPreview.click()
  const ownedCard = browserPane.locator(`[data-preview-server="${ownedAddress}"]`)
  await ownedCard.waitFor()
  check('the browser lists a real terminal listener and omits an unrelated development server',
    await browserPane.locator('[data-preview-server]').count() === 1 && await ownedCard.isVisible())
  const otherThread = await page.request.get(`${baseUrl}/s/${derivedId(claudeForkSource)}/preview-servers`)
  const crossSite = await page.request.get(`${baseUrl}${ledgerPath}/preview-servers`, { headers: { 'sec-fetch-site': 'same-site' } })
  check('preview discovery is scoped to the thread and rejects other origins',
    otherThread.ok() && (await otherThread.json()).servers.length === 0 && crossSite.status() === 403)
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`workspace-browser-local-servers-${width}x${height}`)
  }
  await ownedCard.click()
  await activeFrame.getByRole('heading', { name: 'Terminal development server' }).waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Reload preview')
  check('opening a discovered server loads it and leaves focus in the browser toolbar', true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await newPreview.click()
  await ownedCard.waitFor()
  await terminalHost.focus()
  await page.keyboard.press('Control+c')
  await ownedCard.waitFor({ state: 'hidden' })
  check('the discovered server disappears when its terminal command exits', true)
  await browserPane.getByRole('button', { name: 'Close browser pane' }).click()
  await headerTerminal.click()

  writeFileSync(providerPreviewScript, `const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Provider development server</h1>', { headers: { 'content-type': 'text/html' } }) })\nawait Bun.write(${JSON.stringify(providerPreviewPort)}, String(site.port))\n`)
  const providerThread = 'provider-preview-thread'
  const providerSession = derivedId(providerThread)
  await harness.engine.dispatch({
    id: providerThread,
    at: Date.now(),
    command: { type: 'session.create', workspaceId: derivedId(ledgerWorkspace), driverKind: 'claude' },
  })
  const providerPath = `/s/${providerSession}`
  await page.goto(new URL(providerPath, baseUrl).href)
  const providerComposer = page.getByRole('textbox', { name: 'Message', exact: true })
  await providerComposer.fill(providerPreviewPrompt)
  await providerComposer.press('Enter')
  await page.getByText('Started the development server.', { exact: true }).waitFor()
  await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
  for (let attempt = 0; attempt < 100 && !existsSync(providerPreviewPort); attempt++) await Bun.sleep(50)
  const providerAddress = `http://127.0.0.1:${readFileSync(providerPreviewPort, 'utf8')}/`
  await previewTrigger.click()
  const providerCard = browserPane.locator(`[data-preview-server="${providerAddress}"]`)
  await providerCard.waitFor()
  const sibling = await page.request.get(`${baseUrl}${ledgerPath}/preview-servers`)
  check('a settled provider’s development listener appears without a terminal and stays with its thread',
    !await terminalHost.isVisible() && sibling.ok() && (await sibling.json()).servers.length === 0)
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`workspace-browser-provider-server-${width}x${height}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await providerCard.click()
  await activeFrame.getByRole('heading', { name: 'Provider development server' }).waitFor()
  check('the provider’s discovered server opens in the Browser pane', true)
  await page.goto(new URL(ledgerPath, baseUrl).href)
}
finally {
  providerPreviewProcess?.kill()
  await providerPreviewProcess?.exited
  previewSite.stop(true)
}
let ledgerReads = 0
page.on('request', (request) => {
  if (new URL(request.url()).pathname === `${ledgerPath}/diff`) ledgerReads++
})
const unchangedLedger = page.waitForResponse(response => new URL(response.url()).pathname === `${ledgerPath}/diff` && response.status() === 204)
await headerChanges.click()
const ledgerChanges = page.locator('[data-diff-status]')
await ledgerChanges.getByText('1 changed file in the working tree · +1 −0', { exact: true }).waitFor()
const ledgerPanel = page.getByRole('region', { name: 'Changes', exact: true })
const ledgerComparison = ledgerPanel.getByRole('combobox', { name: 'Git comparison' })
await ledgerComparison.selectOption('branch')
const ledgerBase = ledgerPanel.getByRole('combobox', { name: 'Base branch' })
await ledgerBase.getByRole('option', { name: 'Automatic' }).waitFor({ state: 'attached' })
await ledgerBase.selectOption('refs/heads/review/ledger')
await ledgerChanges.getByText('1 changed file against review/ledger · +1 −0', { exact: true }).waitFor()
await ledgerBase.selectOption('refs/heads/main')
await ledgerChanges.getByText('2 changed files against main · +2 −0', { exact: true }).waitFor()
check('branch review changes with the selected base', await ledgerPanel.getByText('branch-only.txt', { exact: true }).isVisible())
const branchFile = ledgerPanel.locator('[data-diff-file="branch-only.txt"]')
const branchFileToggle = branchFile.locator('[data-diff-file-toggle]')
if (await branchFileToggle.getAttribute('aria-expanded') === 'false') await branchFileToggle.click()
await branchFile.getByRole('button', { name: 'After line 1', exact: true }).click()
await ledgerPanel.getByRole('button', { name: 'Open line in editor', exact: true }).click()
const branchEditorDialog = page.getByRole('dialog', { name: 'Open in editor' })
await branchEditorDialog.getByText('branch-only.txt:1', { exact: true }).waitFor()
const [branchEditorResponse] = await Promise.all([
  page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/workspace-editor', { timeout: 4000 }),
  branchEditorDialog.getByRole('button', { name: /^VS Code/u }).click(),
])
await branchEditorDialog.waitFor({ state: 'hidden' })
const ledgerFolder = realpathSync(ledgerRepo)
check('a branch comparison opens the after line in the working checkout', branchEditorResponse.status() === 204
  && await editorReceived(`${ledgerFolder}\n--goto\n${join(ledgerFolder, 'branch-only.txt')}:1\n`))
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-branch-comparison-${width}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
await ledgerComparison.selectOption('commit')
await ledgerPanel.getByRole('option', { name: /Branch-only marker/ }).waitFor({ state: 'attached' })
await ledgerPanel.getByText('Branch evidence', { exact: true }).waitFor()
check('commit review excludes a dirty file while rendering the selected patch',
  await ledgerPanel.locator('[data-diff-file="ledger.txt"]').count() === 0)
const readsWhileCommitOpen = ledgerReads
await page.waitForTimeout(2200)
check('a fixed commit remains visible without periodic Git requests', ledgerReads === readsWhileCommitOpen)
await page.evaluate(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { sessionStorage.setItem('harness-test-diff-link', text) } },
  })
})
await ledgerPanel.getByRole('button', { name: 'After line 1', exact: true }).click()
await ledgerPanel.getByRole('button', { name: 'Copy line link' }).click()
await ledgerPanel.getByText('Line link copied.', { exact: true }).waitFor()
const commitLine = new URL((await page.evaluate(() => sessionStorage.getItem('harness-test-diff-link')))!)
const commitLinkFields = new URLSearchParams(commitLine.hash.slice('#diff?'.length))
check('the copied link identifies the displayed commit with its full SHA',
  commitLine.pathname === ledgerPath && commitLine.search === '' && commitLinkFields.get('mode') === 'commit'
  && /^[\da-f]{40}$/u.test(commitLinkFields.get('target') ?? '') && commitLinkFields.get('file') === 'branch-only.txt')
const linkedPatch = await browserContext.newPage()
await linkedPatch.setViewportSize({ width: 390, height: 844 })
await linkedPatch.goto(commitLine.href)
const linkedLine = linkedPatch.getByRole('button', { name: 'After line 1', pressed: true })
await linkedLine.waitFor()
check('opening the copied link selects and focuses the right line on a fresh phone viewport',
  await linkedLine.evaluate(button => button === document.activeElement) && !await linkedPatch.locator('[data-composer]').isVisible())
await capture('changes-linked-commit-phone', linkedPatch)
commitLinkFields.set('line', '9999')
await linkedPatch.evaluate(hash => { location.hash = hash }, `diff?${commitLinkFields}`)
await linkedPatch.getByText('The selected line is no longer in this comparison.', { exact: true }).waitFor()
check('a stale diff line shows a recovery state without offering a link to the wrong text',
  await linkedPatch.getByRole('button', { name: 'Copy line link' }).isHidden())
const longDiffFile = 'long [draft] #sample.txt'
const longDiffPath = join(ledgerRepo, longDiffFile)
writeFileSync(longDiffPath, Array.from({ length: 560 }, (_, index) => `Fixture review row ${index + 1}`).join('\n') + '\n')
try {
  const selection = new URLSearchParams({ file: longDiffFile, side: 'after', line: '532', mode: 'uncommitted' })
  await linkedPatch.evaluate(hash => { location.hash = hash }, `diff?${selection}`)
  const longPatch = linkedPatch.getByRole('region', { name: `Patch for ${longDiffFile}`, exact: true })
  const longLine = longPatch.getByRole('button', { name: 'After line 532', pressed: true })
  await longLine.waitFor()
  await linkedPatch.getByRole('button', { name: 'Split', exact: true }).click()
  await linkedPatch.waitForFunction(() => {
    const line = document.querySelector('[data-diff-layout="split"] [data-diff-side="after"][data-diff-number="532"][aria-pressed="true"]')
    const panel = line?.closest('[data-diff-body]')?.getBoundingClientRect()
    const header = document.querySelector('[data-workspace-header]')?.getBoundingClientRect()
    const bounds = line?.getBoundingClientRect()
    return Boolean(panel && header && bounds && header.top >= 0 && bounds.top >= panel.top && bounds.bottom <= panel.bottom)
  })
  check('a late diff line stays visible after switching layouts without scrolling the workspace', true)
  check('the linked view renders only a page around a late diff line',
    await longPatch.locator('[data-diff-row]:not([hidden])').count() <= 200)
  await capture('changes-linked-late-line-phone', linkedPatch)
  await linkedPatch.getByRole('button', { name: 'Stacked', exact: true }).click()
}
finally { rmSync(longDiffPath) }
await linkedPatch.close()
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-commit-comparison-${width}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
await ledgerComparison.selectOption('uncommitted')
await ledgerChanges.getByText('1 changed file in the working tree · +1 −0', { exact: true }).waitFor()
check('uncommitted review excludes the branch commit',
  await ledgerPanel.locator('[data-diff-file="branch-only.txt"]').count() === 0)
await ledgerComparison.selectOption('session')
await ledgerChanges.getByText('1 changed file in the working tree · +1 −0', { exact: true }).waitFor()
await headerTerminal.click()
await waitForTerminalLine('Harness test terminal')
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-before-terminal-commit-${width}`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
}
check('visible Changes checks an unchanged Git revision without rebuilding its patch',
  (await unchangedLedger).headers()['cache-control'] === 'private, no-store')
await terminalHost.focus()
await page.keyboard.type('git add ledger.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm Signed-ledger')
await page.keyboard.press('Enter')
await ledgerChanges.getByText('No uncommitted changes.', { exact: true }).waitFor()
check('a terminal Git commit automatically updates the open Changes totals',
  await page.locator('[data-diff-file]').count() === 0
  && execFileSync('git', ['log', '-1', '--format=%s'], { cwd: ledgerRepo, encoding: 'utf8' }).trim() === 'Signed-ledger')
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`changes-after-terminal-commit-${width}`)
  }
}
await page.evaluate(() => globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
const readsWhileCached = ledgerReads
await page.waitForTimeout(2200)
check('a cached page pauses its Changes poll', ledgerReads === readsWhileCached)
const resumedLedger = page.waitForResponse(response => new URL(response.url()).pathname === `${ledgerPath}/diff`)
await page.evaluate(() => globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
check('restoring a cached page reloads its Changes poll', (await resumedLedger).ok())
await page.getByRole('button', { name: 'Close changes' }).click()
const readsAfterClose = ledgerReads
await page.waitForTimeout(2300)
check('closing Changes stops Git revision checks', ledgerReads === readsAfterClose)

// Leave the browser running while the host flushes history and opens the same database again.
await page.setViewportSize({ width: 1280, height: 800 })
await terminalHost.focus()
await page.keyboard.type('export HARNESS_RESTART_VALUE=42; printf "saved-%d\\n" "$HARNESS_RESTART_VALUE"')
await page.keyboard.press('Enter')
await waitForTerminalLine('saved-42')
harness.stop()
harness = await startHarness()
await waitForTerminalLine('[Host restarted. Previous output restored.]')
await waitForTerminalLine('saved-42')
await terminalHost.focus()
await page.keyboard.type('printf "fresh-%s\\n" "${HARNESS_RESTART_VALUE:-empty}"')
await page.keyboard.press('Enter')
await waitForTerminalLine('fresh-empty')
check('browser reattaches a terminal after a host restart with saved output and a fresh shell',
  await page.locator('[data-terminal]').isVisible() && (await terminalScreen.textContent())?.includes('saved-42') === true)
if (screenshotDir) {
  for (const [width, height] of workspaceViewports) {
    await page.setViewportSize({ width, height })
    await capture(`terminal-host-restarted-${width}`)
  }
}

const contextFile = 'context-example [draft].txt'
const contextPath = join(ledgerRepo, contextFile)
const oldContext = Array.from({ length: 160 }, (_, index) => `Context row ${index + 1}`).join('\n') + '\n'
writeFileSync(contextPath, oldContext)
execFileSync('git', ['add', '--', contextFile], { cwd: ledgerRepo })
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Context fixture baseline'], { cwd: ledgerRepo })
writeFileSync(contextPath, oldContext.replace('Context row 8\n', 'Changed at top\n').replace('Context row 151\n', 'Changed at bottom\n'))
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'Context final markers'], { cwd: ledgerRepo })
// The commit comparison must read the immutable context even with later edits on disk.
writeFileSync(contextPath, oldContext.replace('Context row 80\n', 'Later working copy edit\n'))
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(new URL(ledgerPath, baseUrl).href)
await headerChanges.click()
await ledgerComparison.selectOption('commit')
const contextPatch = ledgerPanel.getByRole('region', { name: `Patch for ${contextFile}`, exact: true })
const middleGap = contextPatch.locator('[data-diff-gap]').filter({ has: page.getByRole('button', { name: 'Show all 136 unchanged lines' }) })
await middleGap.waitFor()
check('context controls identify the leading, middle, and trailing gaps',
  await contextPatch.getByRole('button', { name: 'Show all 4 unchanged lines' }).isVisible()
  && await contextPatch.getByRole('button', { name: 'Show all 6 unchanged lines' }).isVisible())
await capture('changes-context-collapsed')
await middleGap.getByRole('button', { name: 'Show unchanged lines below' }).press('Enter')
const smallerGap = contextPatch.locator('[data-diff-gap]').filter({ has: page.getByRole('button', { name: 'Show all 116 unchanged lines' }) })
await smallerGap.waitFor()
check('one action expands twenty lines from the preceding hunk',
  await contextPatch.getByText('Context row 31', { exact: true }).isVisible()
  && await contextPatch.getByText('Context row 32', { exact: true }).isHidden())
await smallerGap.getByRole('button', { name: 'Show unchanged lines above' }).click()
const remainingContext = contextPatch.getByRole('button', { name: 'Show all 96 unchanged lines' })
await remainingContext.waitFor()
await capture('changes-context-partial')
await remainingContext.click()
await contextPatch.getByText('Context row 80', { exact: true }).waitFor()
check('commit context excludes later working-tree edits', await contextPatch.getByText('Later working copy edit', { exact: true }).isHidden())
await ledgerPanel.getByRole('button', { name: 'Split', exact: true }).click()
await ledgerPanel.getByRole('button', { name: 'Refresh changes' }).click()
await contextPatch.getByRole('button', { name: 'After line 80', exact: true }).click()
check('expanded context survives layout switching and a patch refresh',
  await contextPatch.getByRole('button', { name: 'After line 80', pressed: true }).isVisible())
const contextCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ledgerRepo, encoding: 'utf8' }).trim()
const contextLink = new URL(ledgerPath, baseUrl)
contextLink.hash = `diff?${new URLSearchParams({ file: contextFile, side: 'after', line: '80', mode: 'commit', target: contextCommit })}`
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(contextLink.href)
const linkedContext = contextPatch.getByRole('button', { name: 'After line 80', pressed: true })
await linkedContext.waitFor()
await page.waitForFunction(() => document.activeElement?.matches('[data-diff-side="after"][data-diff-number="80"][aria-pressed="true"]'))
check('a linked unchanged line expands its gap and receives focus', true)
await capture('changes-context-linked-phone')

// Both repositories use the same path so a stale patch or link cannot pass by filename.
const multiRepoProject = join(driveRoot, 'project-repositories')
const multiRepoGit = {
  ...process.env,
  GIT_AUTHOR_DATE: '2026-06-01T12:00:00Z',
  GIT_COMMITTER_DATE: '2026-06-01T12:00:00Z',
}
for (const [folder, label] of [['api', 'API'], ['packages/web', 'Web']] as const) {
  const path = join(multiRepoProject, folder)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'shared.txt'), 'Shared baseline\n')
  execFileSync('git', ['init', '-qb', 'main'], { cwd: path })
  execFileSync('git', ['add', 'shared.txt'], { cwd: path })
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Shared baseline'], { cwd: path, env: multiRepoGit })
  execFileSync('git', ['switch', '-qc', 'review/fixture'], { cwd: path })
  writeFileSync(join(path, 'shared.txt'), `Shared baseline\n${label} in commit\n`)
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', `${label} review fixture`], { cwd: path, env: multiRepoGit })
  writeFileSync(join(path, 'shared.txt'), `Shared baseline\n${label} in commit\n${label} working copy\n`)
}
execFileSync('git', ['clone', '-q', join(multiRepoProject, 'api'), join(driveRoot, 'api-import-source')])
execFileSync('git', ['remote', 'add', 'fixture-upstream', join(driveRoot, 'api-import-source')], { cwd: join(multiRepoProject, 'api') })
writeFileSync(join(multiRepoProject, 'fixture.code-workspace'), '{"folders":[{"name":"API service","path":"api"},{"name":"Web frontend","path":"packages/web"}]}')
const multiRepoId = 'project-repositories'
const multiRepoWorkspace = derivedId(multiRepoId)
await harness.engine.dispatch({ id: multiRepoId, at: Date.now(), command: { type: 'workspace.add', profileId: derivedId(ledgerProfile), path: multiRepoProject } })
await harness.engine.dispatch({ id: 'project-repositories-trust', at: Date.now(), command: { type: 'workspace.trust', workspaceId: multiRepoWorkspace, trusted: true } })
await harness.engine.dispatch({ id: 'project-repositories-thread', at: Date.now(), command: { type: 'session.create', workspaceId: multiRepoWorkspace, driverKind: 'claude' } })
const multiRepoPath = `/s/${derivedId('project-repositories-thread')}`
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(new URL(multiRepoPath, baseUrl).href)
await headerChanges.click()
const repoPicker = ledgerPanel.getByRole('combobox', { name: 'Git repository' })
await ledgerPanel.getByText('API working copy', { exact: true }).waitFor()
check('a plain project opens Changes in its first discovered repository and lists only available choices',
  await repoPicker.inputValue() === 'api'
  && await repoPicker.locator('option').count() === 2
  && await ledgerComparison.locator('option[value="session"], option[value="turn"]').count() === 0)
await repoPicker.selectOption('packages/web')
await ledgerPanel.getByText('Web working copy', { exact: true }).waitFor()
check('switching repositories replaces the patch even when files share a path',
  await ledgerPanel.getByText('API working copy', { exact: true }).isHidden())
await ledgerComparison.selectOption('commit')
await ledgerPanel.getByText('Web in commit', { exact: true }).waitFor()
check('commit review uses the selected repository and excludes its working copy',
  await ledgerPanel.getByText('Web working copy', { exact: true }).isHidden()
  && await ledgerPanel.getByRole('option', { name: /Web review fixture/ }).count() === 1)
await capture('project-repositories-review-desktop')
await page.evaluate(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { sessionStorage.setItem('harness-test-diff-link', text) } },
  })
})
await ledgerPanel.getByRole('button', { name: 'After line 2', exact: true }).click()
await ledgerPanel.getByRole('button', { name: 'Copy line link' }).click()
await ledgerPanel.getByText('Line link copied.', { exact: true }).waitFor()
const repositoryLine = new URL((await page.evaluate(() => sessionStorage.getItem('harness-test-diff-link')))!)
check('the copied line link identifies the selected project repository',
  new URLSearchParams(repositoryLine.hash.slice('#diff?'.length)).get('repository') === 'packages/web')
await page.setViewportSize({ width: 390, height: 844 })
await page.goto(repositoryLine.href)
await ledgerPanel.getByRole('button', { name: 'After line 2', pressed: true }).waitFor()
check('the repository link restores the right line and selection on phones',
  await repoPicker.inputValue() === 'packages/web'
  && await repoPicker.evaluate(element => element.getBoundingClientRect().height >= 44)
  && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await capture('project-repositories-linked-phone')
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const picker = await repoPicker.boundingBox()
  check(`the project repository picker stays usable at ${width}×${height}`,
    Boolean(picker && picker.x >= 0 && picker.x + picker.width <= width
      && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth)))
  await capture(`project-repositories-linked-${width}x${height}`)
}

await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(new URL(multiRepoPath, baseUrl).href)
const repoTurnPrompt = page.getByRole('textbox', { name: 'Message', exact: true })
for (const sequence of [1, 2]) {
  await repoTurnPrompt.fill(`Review both repositories in turn ${sequence}`)
  await repoTurnPrompt.press('Enter')
  await page.getByText(`Recorded edits for turn ${sequence}.`, { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
}
const recentTurnDiffs = page.getByRole('button', { name: 'Open diff', exact: true })
await recentTurnDiffs.nth(1).waitFor()
await recentTurnDiffs.nth(1).press('Enter')
await ledgerPanel.getByText('API edit from turn 2', { exact: true }).waitFor()
check('the streamed transcript action opens exactly the second turn',
  await recentTurnDiffs.nth(1).getAttribute('aria-expanded') === 'true'
  && await ledgerComparison.inputValue() === 'turn')
check('the turn patch omits a fetched file that remains in the repository',
  existsSync(join(multiRepoProject, 'api', 'upstream [notes].txt'))
  && await ledgerPanel.getByText('upstream [notes].txt', { exact: true }).count() === 0)
await ledgerComparison.selectOption('uncommitted')
check('a transcript action reports collapsed in another comparison mode', await recentTurnDiffs.nth(1).getAttribute('aria-expanded') === 'false')
await recentTurnDiffs.nth(1).press('Enter')
await ledgerPanel.getByText('API edit from turn 2', { exact: true }).waitFor()
await ledgerPanel.getByRole('button', { name: 'Close changes' }).click()
await page.waitForFunction(() => document.activeElement?.matches('[data-open-turn-diff]'))
check('closing a transcript diff gives its trigger focus', await recentTurnDiffs.nth(1).evaluate(button => document.activeElement === button))
const changedFilesForTurn = page.locator('[data-turn="2"] [data-turn-file-summary]')
await changedFilesForTurn.getByText(/2 changed files/u).waitFor()
const webChange = changedFilesForTurn.getByRole('button', { name: 'Review shared.txt in packages/web' })
check('the streamed turn lists each repository and the recorded line counts', await webChange.isVisible()
  && await changedFilesForTurn.getByRole('button', { name: 'Review shared.txt in api' }).isVisible()
  && await changedFilesForTurn.locator('[data-turn-file-insertions]:visible').count() === 2)
check('file totals have readable contrast against the active appearance', await webChange.evaluate(button => {
  const shell = button.closest('[data-harness-shell]')
  if (!shell) return false
  const luminance = (color: string) => {
    const rgb = color.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
    if (!rgb || rgb.length !== 3) return NaN
    const channels = rgb.map(channel => channel / 255).map(channel =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const background = luminance(getComputedStyle(shell).backgroundColor)
  const totals = [...button.querySelectorAll('[data-turn-file-insertions], [data-turn-file-deletions]')]
  return totals.length === 2 && totals.every((total) => {
    const foreground = luminance(getComputedStyle(total).color)
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) >= 4.5
  })
}))
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  await changedFilesForTurn.scrollIntoViewIfNeeded()
  await webChange.scrollIntoViewIfNeeded()
  check(`transcript file rows fit at ${width}×${height}`, await webChange.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const transcript = el.closest('[data-transcript]')?.getBoundingClientRect()
    const jump = document.querySelector('[data-jump-to-latest]:not([hidden])')?.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth === innerWidth
      && Boolean(transcript && bounds.top >= transcript.top && bounds.bottom <= transcript.bottom + 1
        && (!jump || jump.top >= transcript.bottom))
  }))
  await capture(`turn-changed-files-${width}x${height}`)
}
await page.setViewportSize({ width: 1440, height: 900 })
await webChange.press('Enter')
await ledgerPanel.getByText('Web edit from turn 2', { exact: true }).waitFor()
const selectedTurnFile = ledgerPanel.locator('[data-diff-file="shared.txt"] [data-diff-file-toggle]')
await page.waitForFunction(() => document.activeElement?.matches('[data-diff-file="shared.txt"] [data-diff-file-toggle]'))
check('the file row opens and focuses its own recorded patch in the selected repository',
  await repoPicker.inputValue() === 'packages/web' && await selectedTurnFile.getAttribute('aria-expanded') === 'true')
await ledgerPanel.getByRole('button', { name: 'Close changes' }).click()
await page.waitForFunction(() => document.activeElement?.matches('[data-turn-file]'))
check('closing the file patch returns keyboard focus to its transcript row', await webChange.evaluate(button => button.ownerDocument.activeElement === button))
await repoTurnPrompt.fill('Verify the repositories without editing.')
await repoTurnPrompt.press('Enter')
await page.getByText('The fixture was checked without edits.', { exact: true }).waitFor()
await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
check('an unchanged turn does not add a transcript diff action', await recentTurnDiffs.count() === 2)
await repoTurnPrompt.fill('Import upstream changes without making edits.')
const importedTurnSummary = page.waitForResponse(response => {
  const url = new URL(response.url())
  return url.pathname.endsWith('/diff/turn-files') && url.searchParams.get('target') === '4' && response.ok()
})
await repoTurnPrompt.press('Enter')
const importedTurnResponse = page.getByText('Upstream changes were imported without local edits.', { exact: true })
await importedTurnResponse.scrollIntoViewIfNeeded()
await page.locator('[data-turn="4"] [data-turn-file-review="4"]').evaluate((button) => {
  if (!(button as HTMLButtonElement).hidden) button.scrollIntoView({ block: 'nearest' })
})
const importOnlyResult = await (await importedTurnSummary).json()
await page.locator('[data-turn="4"] [data-open-turn-diff]').waitFor({ state: 'hidden' })
check('an import-only turn does not add a transcript diff action', existsSync(join(multiRepoProject, 'api', 'imported-only.txt'))
  && importOnlyResult.repositories.some((repository: { key: string, summary: { total: number } | null }) => repository.key === 'api' && repository.summary?.total === 0)
  && await recentTurnDiffs.count() === 2)
await page.reload()
await recentTurnDiffs.first().scrollIntoViewIfNeeded()
await page.locator('[data-turn="1"] [data-turn-file-summary]').getByText(/2 changed files/u).waitFor()
check('the first turn lists its recorded files again after reload', await page.locator('[data-turn="1"] [data-turn-file]:visible').count() === 2)
await recentTurnDiffs.first().click()
const recordedTurnPicker = ledgerPanel.getByRole('combobox', { name: 'Recorded turn' })
await recordedTurnPicker.locator('option', { hasText: 'Turn 1' }).waitFor({ state: 'attached' })
await ledgerPanel.getByText('API edit from turn 1', { exact: true }).waitFor()
check('Turn review preserves the earlier patch after subsequent edits',
  !(await ledgerPanel.getByText('API edit from turn 2', { exact: true }).count()))
const firstRecordedTurn = await recordedTurnPicker.inputValue()
await repoPicker.selectOption('packages/web')
await ledgerPanel.getByText('Web edit from turn 1', { exact: true }).waitFor()
await page.waitForFunction(turn => document.querySelector<HTMLSelectElement>('select[aria-label="Recorded turn"]')?.value === turn, firstRecordedTurn)
check('switching repository keeps the selected turn and shows its independent patch',
  await recordedTurnPicker.inputValue() === firstRecordedTurn
  && await ledgerComparison.inputValue() === 'turn'
  && !(await ledgerPanel.getByText('API edit from turn 1', { exact: true }).count()))
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const controls = await Promise.all([repoPicker.boundingBox(), ledgerComparison.boundingBox(), recordedTurnPicker.boundingBox()])
  check(`repository, comparison, and turn controls stay in view at ${width}×${height}`,
    controls.every(control => control && control.x >= 0 && control.x + control.width <= width)
    && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
  await capture(`project-recorded-turn-${width}x${height}`)
}

const apiCheckout = join(multiRepoProject, 'api')
writeFileSync(join(apiCheckout, 'shared.txt'), 'A staged change after the first turn.\n')
execFileSync('git', ['add', 'shared.txt'], { cwd: apiCheckout })
const lateRepository = join(multiRepoProject, 'late[repo]')
mkdirSync(lateRepository)
execFileSync('git', ['init', '-qb', 'main'], { cwd: lateRepository })
writeFileSync(join(lateRepository, 'late.txt'), 'Keep the repository without a checkpoint.')
await ledgerPanel.getByRole('button', { name: 'Close changes' }).click()
const rewindFirstTurn = page.getByRole('button', { name: 'Revert this turn', exact: true }).first()
await rewindFirstTurn.click()
await page.getByText(/Git staging will reset in the recorded repositories/u).waitFor()
await capture('project-rewind-confirm-phone')
const cancelRewind = page.getByRole('button', { name: 'Keep my files', exact: true })
await cancelRewind.click()
await cancelRewind.waitFor({ state: 'hidden' })
check('cancelling rewind keeps the staged change', execFileSync('git', ['show', ':shared.txt'], { cwd: apiCheckout, encoding: 'utf8' }).includes('A staged change'))
await page.setViewportSize({ width: 1440, height: 900 })
await rewindFirstTurn.click()
await capture('project-rewind-confirm-desktop')
await page.getByRole('button', { name: 'Revert', exact: true }).click()
await page.locator('[data-rewind-status]').filter({ hasText: 'Rewind finished. No earlier checkpoint for late[repo].' }).waitFor()
check('rewind restores both working copies, resets the selected index, and reports the new repository',
  readFileSync(join(apiCheckout, 'shared.txt'), 'utf8') === 'Shared baseline\nAPI in commit\nAPI working copy\n'
  && readFileSync(join(multiRepoProject, 'packages/web/shared.txt'), 'utf8') === 'Shared baseline\nWeb in commit\nWeb working copy\n'
  && execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: apiCheckout, encoding: 'utf8' }) === ''
  && readFileSync(join(lateRepository, 'late.txt'), 'utf8') === 'Keep the repository without a checkpoint.')
await capture('project-rewind-finished-desktop')
rmSync(lateRepository, { recursive: true })

if (process.platform !== 'win32') {
  writeFileSync(join(multiRepoProject, 't3.json'), JSON.stringify({
    worktreeLayout: {
      create: [
        'while [ ! -f "$T3_PROJECT_ROOT/finish-setup" ]; do sleep 0.05; done',
        'mkdir -p "$T3_WORKTREE_PROJECT_PATH/packages"',
        'git -C "$T3_PROJECT_ROOT/api" worktree add -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH/api" "$T3_WORKTREE_BASE"',
        'git -C "$T3_PROJECT_ROOT/packages/web" worktree add -b "$T3_WORKTREE_BRANCH" "$T3_WORKTREE_PROJECT_PATH/packages/web" "$T3_WORKTREE_BASE"',
        'touch "$T3_WORKTREE_ROOT/setup-complete"',
      ].join(' && '),
    },
  }))
}
const worktreeDraft = new URL(`/?workspace=${multiRepoWorkspace}`, baseUrl)
await page.goto(worktreeDraft.href)
const worktreeControls = page.locator('[data-draft-worktree]')
await worktreeControls.locator('summary').click()
const worktreeMode = worktreeControls.getByRole('combobox', { name: 'Run in' })
await worktreeMode.selectOption('worktree')
const selectedApi = worktreeControls.getByRole('checkbox', { name: 'API service' })
const selectedWeb = worktreeControls.getByRole('checkbox', { name: 'Web frontend' })
check('worktree drafts select both available repositories by default', await selectedApi.isChecked() && await selectedWeb.isChecked())
await selectedWeb.uncheck()
check('the worktree draft supports choosing a subset', await selectedApi.isChecked() && !await selectedWeb.isChecked())
await selectedWeb.check()
await worktreeControls.getByRole('textbox', { name: 'Base branch' }).fill('review/fixture')
check('the worktree controls fit on a 360px phone', await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
await capture('combined-worktree-draft-phone')
await page.setViewportSize({ width: 1440, height: 900 })
await capture('combined-worktree-draft-desktop')
const isolatedPrompt = page.getByRole('textbox', { name: 'Message', exact: true })
await isolatedPrompt.fill('Open the combined worktree fixture.')
await isolatedPrompt.press('Enter')
await page.waitForURL(url => url.pathname.startsWith('/s/'))
const combinedId = Number(new URL(page.url()).pathname.split('/').at(-1))
if (process.platform !== 'win32') {
  try {
    await page.getByRole('status').filter({ hasText: 'Preparing the project worktree' }).waitFor({ timeout: 4000 })
    await capture('project-layout-running')
  }
  finally { writeFileSync(join(multiRepoProject, 'finish-setup'), '') }
}
await page.locator('[data-workspace-branch]').filter({ hasText: `harness/session-${combinedId}` }).waitFor()
const combined = harness.engine.current.sessions.get(combinedId)?.combinedWorktree
check('the first browser turn uses the selected repositories on one isolated branch',
  Boolean(combined && combined.checkouts.length === 2 && combined.checkouts.every(checkout =>
    checkout.branch === combined.branch && !readFileSync(join(checkout.path, 'shared.txt'), 'utf8').includes('working copy'))))
await capture('combined-worktree-thread-desktop')
await page.goto(worktreeDraft.href)
await worktreeControls.locator('summary').click()
await worktreeMode.selectOption('worktree')
check('new worktree drafts remember the last repository and base selections for this project',
  await selectedApi.isChecked() && await selectedWeb.isChecked()
  && await worktreeControls.getByRole('textbox', { name: 'Base branch' }).inputValue() === 'review/fixture')

const conversationRewindId = 'conversation-rewind-thread'
await harness.engine.dispatch({ id: conversationRewindId, at: Date.now(), command: { type: 'session.create', workspaceId: multiRepoWorkspace, driverKind: 'codex' } })
await page.goto(`${baseUrl}/s/${derivedId(conversationRewindId)}`)
const rewindPrompt = page.locator('[data-prompt]')
const rewindMessage = (id: number) => page.locator(`[data-turn="${id}"]`)
const codexTurnsBeforeRewind = fixtureCodexTurns.length
for (const [index, text] of ['Keep the first exchange.', 'Edit the review notes.', 'Remove the last exchange.'].entries()) {
  if (index === 1) await page.locator('[data-composer-file-input]').setInputFiles({ name: 'rewind-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep these notes.') })
  await rewindPrompt.fill(`Rewind fixture: ${text}`)
  await page.locator('[data-send]').click()
  await rewindMessage(index + 1).locator('[data-edit-earlier-prompt]').waitFor()
}
await rewindPrompt.fill('Rewind fixture: Keep this draft.')
const editEarlier = rewindMessage(2).locator('[data-edit-earlier-prompt]')
const rewindDialog = page.getByRole('alertdialog', { name: 'Edit from here?' })
const cancelEdit = rewindDialog.getByRole('button', { name: 'Cancel' })
const confirmEdit = rewindDialog.getByRole('button', { name: 'Revert and keep changes' })
const revertConversationFiles = rewindDialog.locator('[data-rewind-with-files]')
await editEarlier.click()
await cancelEdit.waitFor()
check('project-folder conversations cannot restore files from this dialog', await revertConversationFiles.isDisabled())
check('conversation rewind confirmation focuses Cancel initially', await cancelEdit.evaluate(el => el === el.ownerDocument.activeElement))
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const button = await confirmEdit.boundingBox()
  check(`conversation rewind confirms within the viewport at ${width}×${height}`, Boolean(button
    && button.x >= 0 && button.x + button.width <= width && button.y + button.height <= height)
    && await page.evaluate(() => document.documentElement.scrollWidth === innerWidth))
  await capture(`conversation-rewind-confirm-${width}x${height}`)
}
await page.keyboard.press('Escape')
await rewindDialog.waitFor({ state: 'hidden' })
check('Escape keeps every turn and returns focus to the selected prompt action', await rewindMessage(3).isVisible()
  && !fixtureCodexRewinds.length && await editEarlier.evaluate(el => el === el.ownerDocument.activeElement))
await editEarlier.click()
const workingFileBeforeConversationRewind = readFileSync(join(apiCheckout, 'shared.txt'), 'utf8')
await confirmEdit.click()
const restoredText = 'Rewind fixture: Keep this draft.\n\nRewind fixture: Edit the review notes.'
await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, restoredText)
check('rewind removes the selected and later turns and retains workspace edits', await rewindMessage(1).isVisible()
  && await rewindMessage(2).count() === 0 && await rewindMessage(3).count() === 0
  && readFileSync(join(apiCheckout, 'shared.txt'), 'utf8') === workingFileBeforeConversationRewind)
await page.getByText('rewind-notes.txt', { exact: true }).waitFor()
check('the restored multiline draft and its attachment fit the phone composer', await rewindPrompt.evaluate((el: HTMLTextAreaElement) =>
  el.scrollHeight <= el.clientHeight + 1))
await capture('conversation-rewind-composer-phone')
await page.setViewportSize({ width: 1440, height: 900 })
await capture('conversation-rewind-composer-desktop')
await page.reload()
await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, restoredText)
await page.locator('[data-send]').click()
await rewindMessage(4).locator('[data-edit-earlier-prompt]').waitFor()
check('rewind runs once, restores the draft once, and sends in the same Codex conversation', fixtureCodexRewinds.length === 1
  && fixtureCodexRewinds[0]?.beforeTurnId === `fixture-turn-${codexTurnsBeforeRewind + 2}`
  && fixtureCodexRewinds[0]?.retainedTurnId === `fixture-turn-${codexTurnsBeforeRewind + 1}`
  && fixtureCodexRewinds[0]?.newestTurnId === `fixture-turn-${codexTurnsBeforeRewind + 3}`
  && fixtureCodexTurns.at(-1)?.providerSessionId === 'rewind-fixture-thread')

const worktreeRewindId = 'conversation-and-files-rewind-thread'
const worktreeRewindSession = derivedId(worktreeRewindId)
await harness.engine.dispatch({ id: worktreeRewindId, at: Date.now(), command: {
  type: 'session.create', workspaceId: multiRepoWorkspace, driverKind: 'codex', isolate: true,
  worktree: { repositories: ['api', 'packages/web'], baseBranch: 'main' },
} })
await page.goto(`${baseUrl}/s/${worktreeRewindSession}`)
for (const [index, text] of ['Keep this worktree change.', 'Rewrite these notes.', 'Discard this exchange.'].entries()) {
  await rewindPrompt.fill(`Rewind worktree fixture: ${text}`)
  await page.locator('[data-send]').click()
  await rewindMessage(index + 1).locator('[data-edit-earlier-prompt]').waitFor()
}
const worktrees = harness.engine.current.sessions.get(worktreeRewindSession)?.combinedWorktree?.checkouts ?? []
const sourceContents = worktrees.map(checkout => readFileSync(join(checkout.repository, 'shared.txt'), 'utf8'))
const checkoutHeads = worktrees.map(checkout => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout.path, encoding: 'utf8' }))
for (const checkout of worktrees) {
  const file = join(checkout.path, 'shared.txt')
  writeFileSync(file, 'Staged local worktree edit.\n')
  execFileSync('git', ['add', 'shared.txt'], { cwd: checkout.path })
  writeFileSync(file, 'Unstaged local worktree edit.\n')
}
await editEarlier.click()
await revertConversationFiles.waitFor()
check('an isolated multi-repository thread offers its repository worktrees', await revertConversationFiles.isEnabled()
  && await revertConversationFiles.textContent() === 'Revert repositories too')
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const bounds = await rewindDialog.boundingBox()
  check(`the combined rewind confirmation stays onscreen at ${width}×${height}`, Boolean(bounds
    && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= height + 1
    && (width >= 640 || Math.abs(bounds.y + bounds.height - height) <= 1))
    && await rewindDialog.evaluate(el => el.matches(':modal')))
  await capture(`combined-conversation-rewind-confirm-${width}x${height}`)
}
const deletedCheckout = worktrees.find(checkout => checkout.key === 'packages/web')
if (!deletedCheckout || !deletedCheckout.path.startsWith(realpathSync(driveRoot) + sep)) throw new Error('Could not identify the fixture worktree')
rmSync(deletedCheckout.path, { recursive: true })
await revertConversationFiles.click()
await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Rewind worktree fixture: Rewrite these notes.')
check('combined rewind recreates the missing checkout, restores both working trees, and keeps their branches and source files', worktrees.length === 2
  && worktrees.every((checkout, i) => readFileSync(join(checkout.path, 'shared.txt'), 'utf8') === 'Worktree fixture turn 1\n'
    && !existsSync(join(checkout.path, 'new-note.txt'))
    && !execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: checkout.path, encoding: 'utf8' })
    && execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout.path, encoding: 'utf8' }) === checkoutHeads[i]
    && readFileSync(join(checkout.repository, 'shared.txt'), 'utf8') === sourceContents[i])
  && await rewindMessage(1).isVisible() && await rewindMessage(2).count() === 0 && await rewindMessage(3).count() === 0
  && fixtureCodexRewinds.length === 2 && fixtureCodexRewinds.at(-1)?.providerSessionId === 'rewind-worktree-fixture-thread')
await capture('combined-conversation-rewind-restored-phone')

const resumeBases = worktrees.map((checkout, index) => {
  if (!checkout.path.startsWith(realpathSync(driveRoot) + sep)) throw new Error('Could not identify the fixture worktree')
  const cachedBranch = checkout.key === 'api'
  if (cachedBranch) {
    execFileSync('git', ['remote', 'add', 'origin', join(driveRoot, 'unreachable.git')], { cwd: checkout.repository })
    execFileSync('git', ['update-ref', `refs/remotes/origin/${checkout.branch}`, checkoutHeads[index]!.trim()], { cwd: checkout.repository })
  }
  rmSync(checkout.path, { recursive: true })
  execFileSync('git', ['update-ref', '-d', `refs/heads/${checkout.branch}`], { cwd: checkout.repository })
  return cachedBranch ? checkoutHeads[index] : execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout.repository, encoding: 'utf8' })
})
await rewindPrompt.fill('Rewind worktree fixture: Continue after branch recovery.')
await page.locator('[data-send]').click()
await rewindMessage(4).locator('[data-edit-earlier-prompt]').waitFor()
check('sending rebuilds missing branches from their cached remote or the project checkout and resumes the same thread',
  worktrees.length === 2 && worktrees.every((checkout, index) =>
    execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: checkout.path, encoding: 'utf8' }) === resumeBases[index]
    && readFileSync(join(checkout.repository, 'shared.txt'), 'utf8') === sourceContents[index])
  && fixtureCodexTurns.at(-1)?.providerSessionId === 'rewind-worktree-fixture-thread')
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  await capture(`worktree-branch-recovery-${width}x${height}`)
}
await page.setViewportSize({ width: 1440, height: 900 })

const claudeRewindId = 'claude-rewind-thread'
const claudeRewindSession = derivedId(claudeRewindId)
await harness.engine.dispatch({ id: claudeRewindId, at: Date.now(), command: {
  type: 'session.create', workspaceId: multiRepoWorkspace, driverKind: 'claude',
} })
await page.goto(`${baseUrl}/s/${claudeRewindSession}`)
for (const [index, draft] of ['Keep this response.', 'Revise this explanation.', 'Discard this follow-up.'].entries()) {
  await rewindPrompt.fill(`Claude rewind fixture: ${draft}`)
  await page.locator('[data-send]').click()
  await rewindMessage(index + 1).locator('[data-edit-earlier-prompt]').waitFor()
}
await rewindPrompt.fill('Claude rewind fixture: Keep these notes.')
await editEarlier.click()
await confirmEdit.waitFor()
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  const bounds = await rewindDialog.boundingBox()
  check(`the Claude rewind confirmation fits at ${width}×${height}`, Boolean(bounds
    && bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= height + 1))
  await capture(`claude-rewind-confirm-${width}x${height}`)
}
await confirmEdit.click()
const pinnedDraft = 'Claude rewind fixture: Keep these notes.\n\nClaude rewind fixture: Revise this explanation.'
await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, pinnedDraft)
check('Claude rewind returns the selected prompt and keeps only the earlier exchange', await rewindMessage(1).isVisible()
  && await rewindMessage(2).count() === 0 && await rewindMessage(3).count() === 0)
await capture('claude-rewind-restored-phone')
await page.reload()
await page.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, pinnedDraft)
await page.locator('[data-send]').click()
await rewindMessage(4).locator('[data-edit-earlier-prompt]').waitFor()
check('Claude sends the edited prompt with the retained native assistant cursor', claudeRewinds.length === 1
  && claudeRewinds[0]?.retainedTurnId === 'claude-assistant-1'
  && claudeRewindTurns.at(-1)?.providerSessionId === 'fixture-claude-rewind-1'
  && claudeRewindTurns.at(-1)?.resumeSessionAt === 'claude-assistant-1')
await rewindMessage(1).locator('[data-edit-earlier-prompt]').click()
await confirmEdit.click()
await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Claude rewind fixture: Keep this response.')
await page.locator('[data-send]').click()
await rewindMessage(5).locator('[data-edit-earlier-prompt]').waitFor()
check('rewinding the first Claude prompt starts fresh within the same Harness thread', claudeRewinds.length === 2
  && claudeRewindTurns.at(-1)?.providerSessionId === undefined
  && harness.engine.current.sessions.get(claudeRewindSession)?.providerSessionId === 'fixture-claude-rewind-5')

const projectScriptFolder = join(driveRoot, 'project-script-fixture')
mkdirSync(projectScriptFolder)
const projectScriptSource = join(driveRoot, 'project-script-site.ts')
const projectScriptMarker = join(projectScriptFolder, 'launched.txt')
const reservedScriptPort = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
const projectScriptPort = reservedScriptPort.port
reservedScriptPort.stop(true)
writeFileSync(projectScriptSource, `
await Bun.sleep(750)
const site = Bun.serve({ hostname: '127.0.0.1', port: ${projectScriptPort}, fetch: request => {
  const url = new URL(request.url)
  const heading = url.pathname === '/specific' && url.searchParams.get('view') === 'script' ? 'Configured preview path' : 'Wrong preview path'
  return new Response('<h1>' + heading + '</h1>', { headers: { 'content-type': 'text/html' } })
} })
await Bun.write('launched.txt', process.cwd())
console.log(site.url.href)
`)
const projectScriptAddress = `http://127.0.0.1:${projectScriptPort}/specific?view=script`
writeFileSync(join(projectScriptFolder, 't3.json'), JSON.stringify({ scripts: [{
  name: 'Development server', command: `"${process.execPath}" --config=/dev/null "${projectScriptSource}"`,
  previewUrl: projectScriptAddress, autoOpenPreview: true,
}] }))
const scriptWorkspace = derivedId('project-script-workspace')
await harness.engine.dispatch({ id: 'project-script-workspace', at: Date.now(), command: { type: 'workspace.add', profileId: derivedId(ledgerProfile), path: projectScriptFolder } })
await harness.engine.dispatch({ id: 'project-script-trust', at: Date.now(), command: { type: 'workspace.trust', workspaceId: scriptWorkspace, trusted: true } })
await harness.engine.dispatch({ id: 'project-script-thread', at: Date.now(), command: { type: 'session.create', workspaceId: scriptWorkspace, driverKind: 'claude' } })
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(`${baseUrl}/s/${derivedId('project-script-thread')}`)
const scriptDialog = page.getByRole('dialog', { name: 'Project scripts' })
await page.locator('[data-header-project-scripts]').click()
await scriptDialog.getByRole('button', { name: 'Import Development server' }).click()
const runProjectScript = scriptDialog.getByRole('button', { name: 'Run Development server' })
await runProjectScript.waitFor()
check('importing an action saves it without starting its terminal', !existsSync(projectScriptMarker))
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await capture(`workspace-project-scripts-${width}x${height}`)
}
await page.keyboard.press('Escape')
await scriptDialog.waitFor({ state: 'hidden' })
await page.getByRole('button', { name: 'Workspace actions' }).click()
await page.locator('[data-project-scripts-toggle]').click()
await runProjectScript.waitFor()
await page.setViewportSize({ width: 1440, height: 900 })
await runProjectScript.click()
await page.frameLocator('iframe:visible').getByRole('heading', { name: 'Configured preview path' }).waitFor()
check('a project action runs in its thread checkout and opens the configured preview after the listener starts',
  realpathSync(readFileSync(projectScriptMarker, 'utf8')) === realpathSync(projectScriptFolder))
await capture('workspace-project-script-configured-preview')

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
