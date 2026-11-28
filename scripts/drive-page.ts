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
import { fixtureGitRepository, fixturePullRequest, serveFixtureGit } from '../packages/server/test/fixtures/git-http'
import { fixtureGitHubCli } from '../packages/server/test/fixtures/github-cli'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { delimiter, join, sep } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { chromium, webkit } from 'playwright-core'
import { decode, encode } from '../packages/contract/src/index'
import { PREVIEW_THREAD_ENV } from '../packages/drivers/src/index'
import { derivedId } from '../packages/engine/src/index'
import { serve } from '../packages/server/src/index'
import { settingsSections } from '../packages/server/src/settings-location'

const checks: Array<[string, boolean]> = []
function check(name: string, ok: boolean): void {
  checks.push([name, ok])
  console.log(`${ok ? '✓' : '✗'} ${name}`)
}

// Use a stable shell with no user startup files. The provider command exercises
// terminal input without starting an actual sign-in on the developer's machine.
const fixtureBin = mkdtempSync(join(tmpdir(), 'harness-page-bin-'))
process.once('exit', () => rmSync(fixtureBin, { force: true, recursive: true }))
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
process.once('exit', () => rmSync(driveRoot, { force: true, recursive: true }))
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
let parallelReadScope: string | undefined
const parallelDecisions = new Map<string, boolean>()
const questionGate = Promise.withResolvers<void>()
const questionAnswers = new Map<string, unknown>()
const markdownControlsGate = Promise.withResolvers<void>()
const connectorGate = Promise.withResolvers<void>()
const connectorWithdrawal = Promise.withResolvers<void>()
const followUpGate = Promise.withResolvers<void>()
const followUpDelivery: string[] = []
const liveSidebarPrompt = 'Verify the sidebar updates on another client.'
const liveSidebarTurn = Promise.withResolvers<void>()
const backgroundLaunches: StartTurnInput[] = []
const backgroundSourceGate = Promise.withResolvers<void>()
const referenceLink = '[parity-notes (draft).md](fixture%20context/parity-notes%20%28draft%29.md)'
let fixtureMentionContents: string | undefined
const fixtureHandoffs: StartTurnInput[] = []
let releaseSteering: (() => void) | undefined
const steeringCalls: string[] = []
let connectorScope: string | undefined
const script: ProviderEvent[] = [
  { type: 'session-bound', providerSessionId: 'ps-drive' },
  { type: 'assistant-delta', text: 'Thinking… ' },
  { type: 'approval-request', requestId: 'apr_1', toolName: 'Bash', args: { command: 'ls <notes.txt', privateFixture: 'hidden provider fixture field' } },
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
    if (input.text.startsWith('Background fixture:')) {
      const count = backgroundLaunches.push(input)
      yield { type: 'session-bound', providerSessionId: `background-fixture-${count}` }
      if (input.text === 'Background fixture: keep source busy') {
        yield { type: 'assistant-delta', text: 'Holding the source turn.' }
        await backgroundSourceGate.promise
      }
      yield { type: 'assistant-delta', text: 'Background turn finished.' }
      yield { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 0 }
      return
    }
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
      yield {
        type: 'approval-request', requestId: 'parallel_read', toolName: 'Read', args: { path: 'notes.txt' },
        choices: [
          { id: 'allow-once', decision: 'allowed', scope: 'once', label: 'Allow' },
          { id: 'deny-once', decision: 'denied', scope: 'once', label: 'Deny' },
          { id: 'allow-notes', decision: 'allowed', scope: 'session', label: 'Allow for this session', detail: 'Read(notes.txt)' },
          { id: 'cancel', decision: 'cancelled', scope: 'once', label: 'Cancel' },
        ],
      }
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
      if (id === 'parallel_read' && choice?.choiceId === 'allow-notes') parallelReadScope = choice.scope
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
  execFileSync('git', ['pull', '-q', '--no-rebase', '--ff-only', 'fixture-upstream', 'review/fixture'], { cwd: join(workspace, 'api') })
}

const providerPreviewScript = join(driveRoot, 'provider-preview.ts')
const providerPreviewPort = join(driveRoot, 'provider-preview-port')
let providerPreviewProcess: Bun.Subprocess | undefined
const providerPreviewPrompt = 'Start the provider preview fixture.'
let rejectCommitGeneration = false
const commitGenerationPatches: string[] = []

const driver: Driver = {
  kind: 'claude',
  async probe() { return { status: 'ready' } },
  async generateCommitMessage(_config, input) {
    commitGenerationPatches.push(input.patch)
    if (rejectCommitGeneration) throw new Error('Fixture provider disconnected')
    if (input.patch.includes('Combined action reviewed note'))
      return { subject: 'Publish selected working files', body: '', branch: 'feature/publish-selected-working-files' }
    return { subject: 'Summarize the reviewed edit', body: '', branch: 'feature/generated-review' }
  },
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
        if (input.text === liveSidebarPrompt) {
          await liveSidebarTurn.promise
          yield { type: 'assistant-delta', text: 'Sidebar fixture completed.' }
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
const actionPreview = page.locator('[data-approval-detail]')
await actionPreview.waitFor({ state: 'visible' })
check('the approval previews only the selected action as text',
  await actionPreview.textContent() === 'ls <notes.txt' && !(await page.locator('[data-approval]').textContent())?.includes('hidden provider fixture field'))
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  check(`approval details and actions fit at ${width}×${height}`, await page.evaluate(() => {
    const buttons = ['[data-approve]', '[data-deny]'].map(selector => document.querySelector(selector)?.getBoundingClientRect())
    return buttons.every(button => button && button.height >= 44 && button.left >= 0 && button.right <= innerWidth && button.bottom <= innerHeight)
      && document.documentElement.scrollWidth <= innerWidth
  }))
  await capture(`pending-tool-approval-${width}x${height}`)
}
await page.reload()
await actionPreview.waitFor({ state: 'visible' })
check('reloading a pending approval keeps its action details', await actionPreview.textContent() === 'ls <notes.txt')
await actionPreview.focus()
await page.keyboard.press('Tab')
check('keyboard focus reaches Allow from the action preview', await page.locator('[data-approve]').evaluate(element => document.activeElement === element))
await page.setViewportSize({ width: 1280, height: 800 })

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
const gitStatus = page.getByRole('region', { name: 'Repository status' })
await gitStatus.getByText('1 unstaged', { exact: true }).waitFor()
check('Changes shows the repository branch and worktree status', await gitStatus.getByText('No upstream', { exact: true }).isVisible())
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

// A second browser context uses real touch events and the IME edit path.
const terminalTouchContext = await browser.newContext({ colorScheme, hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
try {
  const touch = await terminalTouchContext.newPage()
  await touch.goto(page.url())
  await touch.locator('[data-header-terminal]').tap()
  const screen = touch.locator('[data-terminal-screen]')
  await screen.filter({ hasText: 'Harness test terminal' }).waitFor()
  const keyboard = touch.getByRole('button', { name: 'Terminal keyboard', exact: true })
  await capture('terminal-touch-keyboard-closed', touch)
  await keyboard.tap()
  const input = touch.getByRole('textbox', { name: 'Terminal input', exact: true })
  const enter = touch.getByRole('button', { name: 'Return', exact: true })
  await enter.waitFor()
  check('touch terminal opens the editable keyboard input', await input.evaluate(element => element === document.activeElement))
  await touch.keyboard.insertText('echo "touch-$((15+9))"x')
  await touch.keyboard.press('Backspace')
  await enter.tap()
  await touch.waitForFunction(() => document.querySelector('[data-terminal-screen]')?.textContent?.split('\n').some(row => row.trim() === 'touch-24'))
  check('touch terminal Return runs the edited line and keeps keyboard focus', await input.evaluate(element => element === document.activeElement))
  await capture('terminal-touch-keyboard-open', touch)
  await keyboard.tap()
  check('closing the touch keyboard restores terminal scrollback focus', !await enter.isVisible()
    && await touch.locator('[data-terminal-host]').evaluate(element => element === document.activeElement))
  await keyboard.tap()
  await touch.evaluate(() => {
    const view = window.visualViewport!
    Object.defineProperty(view, 'height', { configurable: true, value: 510 })
    view.dispatchEvent(new Event('resize'))
  })
  await touch.locator('[data-terminal-keyboard-visible="true"]').waitFor()
  check('touch terminal keeps the keys and output inside the keyboard viewport', await enter.evaluate(element =>
    element.getBoundingClientRect().bottom <= (element.ownerDocument.defaultView?.visualViewport?.height ?? 0) + 1)
    && await screen.isVisible() && !await touch.locator('[data-composer]').isVisible())
  await capture('terminal-touch-keyboard-short-viewport', touch)
  await touch.evaluate(() => {
    const view = window.visualViewport!
    Reflect.deleteProperty(view, 'height')
    view.dispatchEvent(new Event('resize'))
  })
  await enter.waitFor({ state: 'hidden' })
  check('dismissing the system keyboard restores the thread composer', await touch.locator('[data-composer]').isVisible())

  // Some mobile bridges answer with an empty string when they cannot read
  // another app's clipboard. The system edit menu can still paste explicitly.
  await touch.evaluate(() => Object.defineProperty(window, 'craft', { configurable: true, value: { clipboard: { read: () => '' } } }))
  const actions = touch.getByRole('button', { name: 'Terminal actions', exact: true })
  const paste = touch.getByRole('menuitem', { name: 'Paste', exact: true })
  const pasteDialog = touch.getByRole('dialog', { name: 'Paste into terminal', exact: true })
  const pasteText = pasteDialog.getByRole('textbox', { name: 'Terminal paste text', exact: true })
  const insert = pasteDialog.getByRole('button', { name: 'Paste text', exact: true })
  await actions.tap()
  await paste.tap()
  await pasteText.fill('echo discarded-input')
  await pasteDialog.getByRole('button', { name: 'Cancel', exact: true }).tap()
  await pasteDialog.waitFor({ state: 'hidden' })
  await actions.tap()
  await paste.tap()
  check('terminal paste recovery clears cancelled input', await pasteText.inputValue() === '' && await insert.isDisabled())
  const recoveredPaste = 'echo "paste-$((40+2))" # This comment makes the preview wrap at narrow phone widths.'
  await pasteText.fill(recoveredPaste)
  check('system paste preview wraps long lines without changing the text', await pasteText.inputValue() === recoveredPaste
    && await pasteText.evaluate(element => element.scrollWidth <= element.clientWidth + 1))
  await capture('terminal-touch-system-paste', touch)
  await insert.tap()
  await pasteDialog.waitFor({ state: 'hidden' })
  check('system paste stages the line without executing it', !await screen.evaluate(element =>
    element.textContent?.split('\n').some(row => row.trim() === 'paste-42')))
  await touch.keyboard.press('Enter')
  await touch.waitForFunction(() => document.querySelector('[data-terminal-screen]')?.textContent?.split('\n').some(row => row.trim() === 'paste-42'))
  check('shell Return submits the recovered paste in the same terminal', !(await screen.textContent())?.includes('discarded-input'))
}
finally { await terminalTouchContext.close() }
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
await terminalHost.press('Shift+PageUp')
const terminalActions = page.getByRole('menu', { name: 'Terminal actions', exact: true })
const terminalActionsToggle = page.getByRole('button', { name: 'Terminal actions', exact: true })
await terminalActionsToggle.click()
await terminalActions.waitFor()
await capture('workspace-terminal-actions-1280x720')
await terminalActions.getByRole('menuitem', { name: 'Select all', exact: true }).click()
check('terminal Select all scopes the selection to its retained output',
  await terminalHost.evaluate(host => {
    const selection = host.ownerDocument.getSelection()
    return Boolean(selection && host.contains(selection.anchorNode) && host.contains(selection.focusNode)
      && selection.toString().includes('history-1') && selection.toString().includes('latest-45'))
  }))
await terminalActionsToggle.click()
await terminalActions.getByRole('menuitem', { name: 'Select visible text', exact: true }).click()
const terminalTextDialog = page.getByRole('dialog', { name: 'Visible terminal output', exact: true })
check('terminal selection reader exposes visible output in a read-only control',
  (await terminalTextDialog.getByRole('textbox').inputValue()).includes('history-')
  && await terminalTextDialog.getByRole('textbox').getAttribute('readonly') !== null)
await capture('workspace-terminal-output-reader-1280x720')
await terminalTextDialog.getByRole('button', { name: 'Done', exact: true }).click()
await terminalActionsToggle.click()
await terminalActions.getByRole('menuitem', { name: 'Jump to latest', exact: true }).click()
check('terminal actions return to the live output and focus its input',
  await terminalHost.evaluate(host => host === host.ownerDocument.activeElement
    && host.scrollHeight - host.clientHeight - host.scrollTop < 25))

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
  const settingsButtons = settingsNavigation.getByRole('button')
  const initialSettingsSections = await settingsButtons.allTextContents()
  // The restore check below compares against this snapshot, so it would pass a
  // rail that never offered a section at all. Hold the rail to the source of
  // truth once, here, rather than to a count that a new section would break.
  check('the rail offers every settings section the host defines',
    JSON.stringify(initialSettingsSections.map(label => label.trim()))
    === JSON.stringify(settingsSections.map(section => section.label)))
  await settingsSearch.fill('not present')
  await settingsNavigation.getByText('No sections found').waitFor()
  await settingsSearch.fill('key')
  check('settings search filters the available sections', await settingsButtons.count() === 1)
  await settingsSearch.press('Enter')
  await page.waitForURL(url => url.pathname === '/settings/keybindings')
  check('Enter opens the matching settings section and clears search', await settingsSearch.inputValue() === ''
    && JSON.stringify(await settingsButtons.allTextContents()) === JSON.stringify(initialSettingsSections))
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
const searchButton = page.locator('[data-nav-search]')
if (!await searchButton.isVisible()) await page.locator('[data-sidebar-toggle]').click()
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
const toolChoiceMenu = approval.locator('[data-tool-approval-options]')
const moreToolChoices = toolChoiceMenu.getByLabel('More approval options')
const allowThisSession = toolChoiceMenu.getByRole('button', { name: 'Allow for this session', exact: true })
await moreToolChoices.waitFor({ state: 'visible' })
await moreToolChoices.focus()
await page.keyboard.press('ArrowDown')
check('the tool approval disclosure focuses its first offered extra choice', await allowThisSession.evaluate(element => element.ownerDocument.activeElement === element))
await page.keyboard.press('Escape')
check('Escape closes tool approval choices and restores focus', await moreToolChoices.evaluate(element => element.ownerDocument.activeElement === element && !element.closest('details')?.open))
for (const [width, height] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180], [390, 844], [360, 800]]) {
  await page.setViewportSize({ width, height })
  await moreToolChoices.click()
  check(`offered tool choices fit at ${width}×${height}`, await allowThisSession.evaluate(element => {
    const { left, right, top, bottom, height } = element.getBoundingClientRect()
    const menu = element.closest('[data-tool-approval-option-list]')?.getBoundingClientRect()
    const card = element.closest('[data-approval]')?.getBoundingClientRect()
    return left >= 0 && right <= innerWidth && top >= 0 && bottom <= innerHeight && height >= 44
      && menu && card && menu.bottom <= card.top && element.textContent?.includes('Read(notes.txt)')
  }))
  await capture(`tool-approval-options-${width}x${height}`)
  await moreToolChoices.click()
}
await moreToolChoices.click()
await allowThisSession.click()
await page.setViewportSize({ width: 1280, height: 800 })
await page.waitForFunction(() => document.querySelector('[data-approval-tool]')?.textContent === 'Write')
await approval.getByRole('button', { name: 'Deny', exact: true }).click()
await approval.waitFor({ state: 'hidden' })
check('parallel approvals advance in order and reach their matching callbacks',
  parallelDecisions.get('parallel_read') === true && parallelReadScope === 'session' && parallelDecisions.get('parallel_write') === false)

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
await page.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready')
await page.locator('#settings-follow-up').selectOption('steer')
const followUpSaveDeadline = performance.now() + 10_000
while (harness.engine.current.settings.followUpBehavior !== 'steer' && performance.now() < followUpSaveDeadline) await Bun.sleep(50)
if (harness.engine.current.settings.followUpBehavior !== 'steer') {
  const error = await page.locator('[data-settings-error]').textContent()
  throw new Error('The host did not save the steering preference.' + (error ? ' ' + error : ''))
}
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
const wrappedPreviewPath = `/${'project-'.repeat(27)}wrapped-destination`
const previewSite = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/counter.js') return new Response("const button = document.querySelector('button'); button.disabled = false; button.addEventListener('click', () => { button.textContent = 'Updated' })", { headers: { 'content-type': 'text/javascript' } })
    const heading = path === wrappedPreviewPath ? 'Wrapped destination reached'
      : path === '/second' ? 'Second preview page' : 'Local development preview'
    return new Response(`<h1>${heading}</h1><button disabled>Update</button><script type="module" src="/counter.js"></script>`, { headers: { 'content-type': 'text/html' } })
  },
})
try {
  const browserPane = page.getByRole('region', { name: 'Browser', exact: true })
  const previewTrigger = page.getByRole('button', { name: 'Open workspace browser' })
  const previewAddress = browserPane.getByRole('textbox', { name: 'Preview address' })
  const activeFrame = browserPane.frameLocator('iframe:not([hidden])')
  const loopback = `127.0.0.1:${previewSite.port}`
  const legacyAndroidPage = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme, reducedMotion })
  try {
    await legacyAndroidPage.addInitScript(() => Object.defineProperty(globalThis, 'CraftAndroid', { value: {} }))
    let embeddedRequests = 0
    legacyAndroidPage.on('request', (request) => {
      if (new URL(request.url()).host === loopback) embeddedRequests++
    })
    await legacyAndroidPage.goto(new URL(ledgerPath, baseUrl).href)
    await legacyAndroidPage.getByRole('button', { name: 'Workspace actions' }).click()
    await legacyAndroidPage.locator('[data-preview-toggle]').click()
    const nativePreview = legacyAndroidPage.getByRole('region', { name: 'Browser', exact: true })
    const address = nativePreview.getByRole('textbox', { name: 'Preview address' })
    await address.fill(loopback)
    await address.press('Enter')
    const external = nativePreview.getByRole('link', { name: 'Open in browser', exact: true })
    await external.waitFor()
    check('Android hosts with a frame-wide native interface offer an isolated browser action',
      await external.getAttribute('href') === `http://${loopback}/` && await external.getAttribute('rel') === 'noopener noreferrer'
      && await nativePreview.locator('iframe').count() === 0 && embeddedRequests === 0)
    await capture('workspace-browser-android-external', legacyAndroidPage)
  }
  finally {
    await legacyAndroidPage.close()
  }
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
  const localTerminalUrl = `http://${loopback}/`
  const linkedTerminalUrl = `http://${loopback}/second`
  await page.keyboard.type(`printf '%s\\n' '${localTerminalUrl}'; printf '\\033]8;;${linkedTerminalUrl}\\007Preview build\\033]8;;\\007\\n'`)
  await page.keyboard.press('Enter')
  const printedLink = terminalHost.getByRole('link', { name: localTerminalUrl, exact: true }).last()
  const linkedLabel = terminalHost.getByRole('link', { name: 'Preview build', exact: true })
  await linkedLabel.waitFor()
  check('terminal output links use the printed target or the OSC 8 destination',
    await printedLink.getAttribute('href') === localTerminalUrl && await linkedLabel.getAttribute('href') === linkedTerminalUrl
    && await linkedLabel.getAttribute('rel') === 'noopener noreferrer')
  await capture('workspace-terminal-links-desktop')
  await linkedLabel.focus()
  const [externalLinkPage] = await Promise.all([
    page.context().waitForEvent('page', { timeout: 12_000 }),
    linkedLabel.click({ modifiers: ['ControlOrMeta'] }),
  ])
  await externalLinkPage.getByRole('heading', { name: 'Second preview page' }).waitFor()
  check('a modified terminal link opens in a separate browser tab', !await browserPane.isVisible())
  await externalLinkPage.close()
  await linkedLabel.focus()
  await page.keyboard.press('Enter')
  await activeFrame.getByRole('heading', { name: 'Second preview page' }).waitFor()
  check('keyboard activation opens an OSC 8 terminal link in the workspace Browser', true)
  await browserPane.getByRole('button', { name: 'Close browser pane' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await printedLink.click()
  await activeFrame.getByRole('heading', { name: 'Local development preview' }).waitFor()
  await capture('workspace-terminal-link-preview-phone')
  await browserPane.getByRole('button', { name: 'Close browser pane' }).click()
  check('closing a phone terminal-link preview returns to the same terminal', await printedLink.isVisible())
  const fileLinkScript = join(driveRoot, 'print-terminal-file-links.ts')
  const ledgerFileUri = pathToFileURL(join(ledgerRepo, 'ledger.txt'))
  ledgerFileUri.hash = 'L1C2'
  const fileLinkOutput = `ledger.txt:2:3: fixture\n\x1b]8;;${ledgerFileUri.href}\x07Ledger source\x1b]8;;\x07\n`
  writeFileSync(fileLinkScript, `process.stdout.write(${JSON.stringify(fileLinkOutput)})\n`)
  await terminalHost.focus()
  await page.keyboard.type(`"${process.execPath}" --config=/dev/null "${fileLinkScript}"`)
  await page.keyboard.press('Enter')
  const terminalFile = terminalHost.locator('[data-terminal-file="ledger.txt:2:3"]')
  const filePanel = page.getByRole('region', { name: 'Files', exact: true })
  await terminalFile.focus()
  await page.keyboard.press('Enter')
  await filePanel.locator('[data-view-line="2"]').waitFor()
  check('keyboard activation opens a terminal source location inside the thread',
    !(await terminalFile.getAttribute('href')) && await filePanel.getByText('Column 3', { exact: true }).isVisible())
  await capture('workspace-terminal-file-link-phone')
  await filePanel.getByRole('button', { name: 'Close workspace files' }).click()
  await page.waitForFunction(() => document.activeElement?.closest('[data-terminal-host]'))
  await terminalHost.getByRole('link', { name: 'Ledger source', exact: true }).press('Enter')
  await filePanel.locator('[data-view-line="1"]').waitFor()
  check('OSC 8 file links carry their exact line and column', await filePanel.getByText('Column 2', { exact: true }).isVisible())
  await filePanel.getByRole('button', { name: 'Close workspace files' }).click()
  await filePanel.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.closest('[data-terminal-host]'))
  const nestedSource = join(ledgerRepo, 'compiler output & notes')
  mkdirSync(nestedSource)
  writeFileSync(join(nestedSource, 'ledger.txt'), 'Nested ledger source\n')
  const nestedMarker = pathToFileURL(nestedSource).href
  const restoredMarker = pathToFileURL(ledgerRepo).href
  const nestedLinkScript = join(driveRoot, 'print-directory-file-link.ts')
  const nestedLinkOutput = '\x1b]7;' + nestedMarker + '\x07ledger.txt:1:4: nested fixture\n\x1b]7;' + restoredMarker + '\x07'
  writeFileSync(nestedLinkScript, `process.stdout.write(${JSON.stringify(nestedLinkOutput)})\n`)
  await terminalHost.focus()
  await page.keyboard.type(`"${process.execPath}" --config=/dev/null "${nestedLinkScript}"`)
  await page.keyboard.press('Enter')
  const nestedTerminalFile = terminalHost.locator(`[data-terminal-file="ledger.txt:1:4"][data-terminal-cwd="${nestedMarker}"]`)
  await nestedTerminalFile.evaluate(link => link.dispatchEvent(new PointerEvent('click', {
    bubbles: true, cancelable: true, pointerType: 'touch', detail: 2,
  })))
  await filePanel.getByText('Nested ledger source', { exact: true }).waitFor()
  check('a touch click with a repeated click count opens the recorded directory', await filePanel.getByText('Column 4', { exact: true }).isVisible())
  await capture('workspace-terminal-directory-file-phone')
  await filePanel.getByRole('button', { name: 'Close workspace files' }).click()
  await filePanel.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.closest('[data-terminal-host]'))
  await page.setViewportSize({ width: 1440, height: 900 })
  const editorLaunched = () => page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/workspace-editor')
  const [terminalEditor] = await Promise.all([editorLaunched(), nestedTerminalFile.click()])
  const terminalRoot = realpathSync(ledgerRepo)
  check('clicking a terminal file opens the preferred editor at its recorded location',
    terminalEditor.status() === 204 && await editorReceived(`${terminalRoot}\n--goto\n${join(terminalRoot, 'compiler output & notes', 'ledger.txt')}:1:4\n`)
      && !await page.locator('dialog[data-workspace-editor]').isVisible() && !await filePanel.isVisible())
  const [terminalKeyboardEditor] = await Promise.all([editorLaunched(), terminalFile.press('ControlOrMeta+Enter')])
  check('the terminal editor shortcut opens the same file and leaves focus on the link',
    terminalKeyboardEditor.status() === 204 && await editorReceived(`${terminalRoot}\n--goto\n${join(terminalRoot, 'ledger.txt')}:2:3\n`)
      && await terminalFile.evaluate(link => link === link.ownerDocument.activeElement))
  await nestedTerminalFile.click({ modifiers: ['Alt'] })
  await filePanel.getByText('Nested ledger source', { exact: true }).waitFor()
  check('Alt-click keeps the terminal file in the workspace Files pane', await filePanel.isVisible())
  await capture('workspace-terminal-file-open-in-files')
  await filePanel.getByRole('button', { name: 'Close workspace files' }).click()
  await filePanel.waitFor({ state: 'hidden' })
  await page.waitForFunction(() => document.activeElement?.closest('[data-terminal-host]'))
  await page.setViewportSize({ width: 390, height: 844 })
  rmSync(nestedSource, { recursive: true })
  const wrappedUrl = `http://${loopback}${wrappedPreviewPath}`
  const printWrapped = join(driveRoot, 'print-wrapped-terminal-url.ts')
  writeFileSync(printWrapped, `process.stdout.write(${JSON.stringify(wrappedUrl + '  \n')})\n`)
  await terminalHost.focus()
  await page.keyboard.type(`"${process.execPath}" --config=/dev/null "${printWrapped}"`)
  await page.keyboard.press('Enter')
  const wrappedLink = terminalHost.getByRole('link', { name: wrappedUrl, exact: true })
  await wrappedLink.waitFor()
  await page.reload()
  await wrappedLink.waitFor()
  check('reattaching to the live terminal preserves the wrapped link', await wrappedLink.getAttribute('href') === wrappedUrl)
  await wrappedLink.focus()
  const phoneSize = page.viewportSize()!
  const narrowLinkRows = await wrappedLink.evaluate(element => [...element.getClientRects()].filter(rect => rect.width > 0).length)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(({ url, segments }) => {
    const link = document.activeElement
    return link?.getAttribute('href') === url
      && [...link.getClientRects()].filter(rect => rect.width > 0).length < segments
  }, { url: wrappedUrl, segments: narrowLinkRows })
  await capture('workspace-terminal-reflow-wide')
  await page.setViewportSize(phoneSize)
  await page.waitForFunction(({ url, segments }) => {
    const link = document.activeElement
    return link?.getAttribute('href') === url
      && [...link.getClientRects()].filter(rect => rect.width > 0).length === segments
  }, { url: wrappedUrl, segments: narrowLinkRows })
  check('the live terminal reflows the URL while preserving keyboard focus', true)
  await capture('workspace-terminal-wrapped-url-phone')
  const continuation = await wrappedLink.evaluate((element) => {
    const rows = [...element.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
    const points = rows.slice(1).reverse().map(rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }))
    return points.find(({ x, y }) => element.contains(element.ownerDocument.elementFromPoint(x, y)))
  })
  check('soft-wrapped terminal output is one accessible link with the full destination',
    await wrappedLink.count() === 1 && await wrappedLink.getAttribute('href') === wrappedUrl && Boolean(continuation))
  await page.mouse.click(continuation!.x, continuation!.y)
  await activeFrame.getByRole('heading', { name: 'Wrapped destination reached' }).waitFor()
  check('activating a continuation row opens the full wrapped URL', true)
  await browserPane.getByRole('button', { name: 'Close browser pane' }).click()
  await terminalHost.focus()
  await page.keyboard.type("printf '%s\\n' 'reflow-terminal-ready'")
  await page.keyboard.press('Enter')
  await waitForTerminalLine('reflow-terminal-ready')
  check('the original shell accepts commands after reflow and preview', true)
  await page.setViewportSize({ width: 1440, height: 900 })
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
await ledgerPanel.getByRole('region', { name: 'Repository status' }).getByText('Clean working tree', { exact: true }).waitFor()
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

// 15. The Projects section: what this project covers on this host, read from
// its folder when the section opens rather than from anything the page was
// rendered with.
await page.setViewportSize({ width: 1280, height: 800 })
await page.goto(new URL(multiRepoPath, baseUrl).href)
await pressChord('Meta+,')
await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
await settingsNavigation.getByRole('button', { name: 'Projects' }).click()
await page.waitForURL(url => url.pathname === '/settings/projects')
const repositoryRows = page.locator('[data-repository-row]')
const repositoryNames = (): Promise<string[]> =>
  repositoryRows.locator('[data-repository-name]').allTextContents().then(names => names.map(name => name.trim()))
await repositoryRows.nth(1).waitFor({ state: 'visible', timeout: 4000 })
check('the Projects section lists every repository the project covers',
  (await repositoryNames()).join() === 'API service,Web frontend'
  && (await repositoryRows.nth(1).textContent())?.includes('packages/web') === true
  && await page.locator('[data-repository-layout]').isHidden())
await capture('settings-projects-desktop')

// Read from the folder, not from the render: a repository cloned into the
// project belongs to it with no command run and no event written.
const clonedRepository = join(multiRepoProject, 'tools')
mkdirSync(clonedRepository, { recursive: true })
writeFileSync(join(clonedRepository, 'build.sh'), 'echo build\n')
execFileSync('git', ['init', '-qb', 'main'], { cwd: clonedRepository })
execFileSync('git', ['add', 'build.sh'], { cwd: clonedRepository })
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Tools'], { cwd: clonedRepository, env: multiRepoGit })
await settingsNavigation.getByRole('button', { name: 'General' }).click()
await settingsNavigation.getByRole('button', { name: 'Projects' }).click()
await repositoryRows.nth(2).waitFor({ state: 'visible', timeout: 4000 })
check('a repository cloned into the project folder belongs to it at once',
  (await repositoryNames()).join() === 'API service,Web frontend,tools')
await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
// Closing the sheet navigates back to the thread. Waiting for that to land
// keeps the next navigation from aborting this one.
await settingsDialog.waitFor({ state: 'hidden' })
await page.waitForURL(url => url.pathname === multiRepoPath)
rmSync(clonedRepository, { recursive: true, force: true })

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
// The same section says when the project lays its own worktrees out, because
// that is what decides whether a thread can start one from this client.
if (process.platform !== 'win32') {
  await pressChord('Meta+,')
  await settingsDialog.waitFor({ state: 'visible', timeout: 4000 })
  await settingsNavigation.getByRole('button', { name: 'Projects' }).click()
  await page.locator('[data-repository-layout]').waitFor({ state: 'visible', timeout: 4000 })
  check('the Projects section says when the project lays out its own worktrees', true)
  await settingsDialog.getByRole('button', { name: 'Close settings' }).click()
  await settingsDialog.waitFor({ state: 'hidden' })
  await page.waitForURL(url => url.pathname === multiRepoPath)
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

execFileSync('git', ['init', '-qb', 'main'], { cwd: projectScriptFolder })
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Baseline'], { cwd: projectScriptFolder })
const setupGate = join(driveRoot, 'finish-project-setup')
const setupCommand = `printf 'Preparing the fixture checkout\\n'; while /bin/test ! -f "${setupGate}"; do sleep 0.1; done; exit 7`
writeFileSync(join(projectScriptFolder, 't3.json'), JSON.stringify({ scripts: [{
  name: 'Prepare checkout', command: setupCommand, runOnWorktreeCreate: true, async: false,
}] }))
const setupThread = derivedId('project-setup-thread')
await harness.engine.dispatch({ id: 'project-setup-thread', at: Date.now(), command: { type: 'session.create', workspaceId: scriptWorkspace, driverKind: 'claude', isolate: true } })
await page.clock.setFixedTime(new Date('2026-11-26T17:00:00Z'))
await page.goto(`${baseUrl}/s/${setupThread}`)
await page.locator('[data-header-project-scripts]').click()
await scriptDialog.getByRole('button', { name: 'Import Prepare checkout' }).click()
await scriptDialog.getByRole('button', { name: 'Run Prepare checkout' }).waitFor()
await scriptDialog.getByRole('button', { name: 'Edit Prepare checkout' }).click()
const setupWait = scriptDialog.getByLabel('Wait for setup before starting the provider')
check('imported setup keeps the reference wait flag', await setupWait.isChecked())
await capture('workspace-worktree-setup-settings')
await page.keyboard.press('Escape')
await scriptDialog.waitFor({ state: 'hidden' })
const setupPrompt = () => page.locator('[data-prompt]').fill('Verify the repositories without editing.')
await setupPrompt()
await page.locator('[data-send]').click()
const setupStatus = page.locator('[data-project-setup-status]')
await setupStatus.getByText('Running worktree setup…').waitFor()
await setupStatus.getByText('Preparing the fixture checkout').waitFor()
await page.locator('[data-thinking]:visible').waitFor({ state: 'hidden' })
await capture('workspace-worktree-setup-running')
check('the first provider turn waits for setup', !harness.engine.current.sessions.get(setupThread)?.providerSessionId)
writeFileSync(setupGate, '')
await setupStatus.getByText('Worktree setup exited with code 7.').waitFor()
await setupStatus.getByRole('button', { name: 'Setup details' }).click()
const recovery = scriptDialog.getByRole('button', { name: 'Retry on next message' })
await recovery.waitFor()
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await capture(`workspace-worktree-setup-failed-${width}x${height}`)
}
check('phone setup recovery actions are reachable without horizontal overflow', await recovery.evaluate((button) => {
  const rect = button.getBoundingClientRect()
  return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
}))
await scriptDialog.getByRole('button', { name: 'View setup terminal' }).click()
await page.getByRole('tab', { name: 'Prepare checkout' }).waitFor()
await page.locator('[data-terminal-screen]').getByText('Preparing the fixture checkout', { exact: false }).waitFor()
await capture('workspace-worktree-setup-terminal-mobile')
await page.setViewportSize({ width: 1440, height: 900 })
await setupStatus.getByRole('button', { name: 'Setup details' }).click()
await scriptDialog.getByRole('button', { name: 'Edit Prepare checkout' }).click()
await scriptDialog.getByLabel('Command', { exact: true }).fill("printf 'Setup repaired\\n'")
await scriptDialog.getByRole('button', { name: 'Save script' }).click()
await recovery.click()
await scriptDialog.getByText('Worktree setup will run with the next message.').waitFor()
await scriptDialog.getByRole('button', { name: 'Close project scripts' }).click()
await setupPrompt()
await page.locator('[data-send]').click()
await page.getByText('The fixture was checked without edits.').waitFor()
await setupStatus.waitFor({ state: 'hidden' })
check('setup failure can be repaired and retried from the thread', !await setupStatus.isVisible())
await page.getByRole('button', { name: 'Hide terminal dock' }).click()

const restoredSetupGate = join(driveRoot, 'finish-restored-setup')
const restoredSetupReplies = page.getByText('The fixture was checked without edits.', { exact: true })
const responsesBeforeRestore = await restoredSetupReplies.count()
const checkoutBeforeRestore = harness.engine.current.sessions.get(setupThread)!.worktreePath
const originalSetup = await (await fetch(`${baseUrl}/s/${setupThread}/project-setup`)).json()
await page.locator('[data-header-project-scripts]').click()
await scriptDialog.getByRole('button', { name: 'Edit Prepare checkout' }).click()
await scriptDialog.getByLabel('Command', { exact: true }).fill(
  `printf 'Preparing the restored checkout\\n'; while /bin/test ! -f "${restoredSetupGate}"; do sleep 0.1; done`,
)
await scriptDialog.getByRole('button', { name: 'Save script' }).click()
await scriptDialog.getByRole('button', { name: 'Close project scripts' }).click()
rmSync(checkoutBeforeRestore, { recursive: true })
await setupPrompt()
await page.locator('[data-send]').click()
await setupStatus.getByText('Running worktree setup…').waitFor({ timeout: 12_000 })
await setupStatus.getByText('Preparing the restored checkout').waitFor()
const restoredSetup = await (await fetch(`${baseUrl}/s/${setupThread}/project-setup`)).json()
check('recreating the checkout starts a fresh blocking setup before the provider',
  restoredSetup.resumeKey !== originalSetup.resumeKey && restoredSetup.blocking
  && existsSync(join(checkoutBeforeRestore, '.git')) && !harness.engine.current.sessions.get(setupThread)?.turns.at(-1)?.response)
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await capture(`workspace-restored-setup-${width}x${height}`)
}
writeFileSync(restoredSetupGate, '')
await setupStatus.waitFor({ state: 'hidden', timeout: 12_000 })
await restoredSetupReplies.nth(responsesBeforeRestore).waitFor()
await page.waitForFunction(() => document.querySelector('[data-session-state]')?.textContent === 'idle')
await page.setViewportSize({ width: 1440, height: 900 })

const settlementContext = await browser.newContext({ colorScheme, reducedMotion })
const settlementPage = await settlementContext.newPage()
settlementPage.on('pageerror', error => pageErrors.push(error.message))
const settlementAddress = page.url()
const settlementRequests = new URL(new URL(settlementAddress).pathname + '/project-settlement', settlementAddress).href
const releaseSettlementRead = Promise.withResolvers<void>()
const firstSettlementRead = Promise.withResolvers<void>()
let settlementReads = 0
await settlementPage.route(settlementRequests, async (route) => {
  settlementReads++
  if (settlementReads === 1) {
    firstSettlementRead.resolve()
    await releaseSettlementRead.promise
  }
  await route.continue()
})
try {
  await Promise.all([
    settlementPage.waitForRequest(settlementRequests),
    settlementPage.goto(settlementAddress),
  ])
  await firstSettlementRead.promise
  const [scriptList] = await Promise.all([
    settlementPage.waitForResponse(response => response.url() === settlementRequests.replace(/project-settlement$/, 'project-scripts')),
    settlementPage.locator('[data-header-project-scripts]').click(),
  ])
  await scriptList.finished()
  await settlementPage.getByRole('dialog', { name: 'Project scripts' }).getByRole('button', { name: 'Close project scripts' }).click()
  check('opening project scripts leaves an in-flight settlement status request intact', settlementReads === 1)
  const followUpRead = settlementPage.waitForResponse(response => response.url() === settlementRequests && settlementReads === 2)
  releaseSettlementRead.resolve()
  const response = await followUpRead
  check('settlement status refreshes once more after the pending read', response.ok())
  await response.finished()
}
finally {
  releaseSettlementRead.resolve()
  await settlementContext.close()
}

const failedCleanupGate = join(driveRoot, 'finish-failed-cleanup')
const successfulCleanupGate = join(driveRoot, 'finish-successful-cleanup')
const cleanupCommand = (gate: string, code: number) => `printf 'Cleaning the fixture checkout\\n'; while /bin/test ! -f "${gate}"; do sleep 0.1; done; exit ${code}`
await page.locator('[data-header-project-scripts]').click()
await scriptDialog.getByRole('button', { name: 'Add script', exact: true }).click()
const cleanupName = scriptDialog.getByLabel('Name', { exact: true })
const cleanupBody = scriptDialog.getByLabel('Command', { exact: true })
await page.waitForFunction(() => document.activeElement === document.querySelector('[data-stx-ref="projectScriptName"]'))
await cleanupName.fill('Clean checkout')
const failedCleanup = cleanupCommand(failedCleanupGate, 7)
await cleanupBody.fill(failedCleanup)
check('project script focus stays in Command while typing the cleanup script',
  await cleanupBody.evaluate(element => element === document.activeElement)
  && await cleanupName.inputValue() === 'Clean checkout' && await cleanupBody.inputValue() === failedCleanup)
await scriptDialog.getByLabel('Run when the host settles a worktree thread').check()
await capture('workspace-settlement-script-setting')
await scriptDialog.getByRole('button', { name: 'Save script' }).click()
await scriptDialog.getByRole('button', { name: 'Run Clean checkout' }).waitFor()
await scriptDialog.getByRole('button', { name: 'Close project scripts' }).click()
const changeSettlement = async (name: string) => {
  await page.locator('[data-thread-actions-trigger]').click()
  await page.getByRole('dialog', { name: 'Thread actions' }).getByRole('button', { name, exact: true }).click()
}
const settlementCard = page.locator('[data-project-settlement-status]')
await page.evaluate(() => { document.documentElement.dataset.settlementDrive = 'active' })
await changeSettlement('Settle thread')
await settlementCard.getByText('Running settlement script…').waitFor()
check('settling an open thread keeps its page mounted',
  await page.locator('html').getAttribute('data-settlement-drive') === 'active')
await settlementCard.getByText('Cleaning the fixture checkout').waitFor()
await capture('workspace-settlement-script-running')
writeFileSync(failedCleanupGate, '')
await settlementCard.getByText('Settlement script exited with code 7.').waitFor()
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await capture(`workspace-settlement-script-failed-${width}x${height}`)
}
const openCleanupTerminal = settlementCard.getByRole('button', { name: 'Open settlement terminal' })
check('settlement output and its terminal action fit the phone viewport', await openCleanupTerminal.evaluate(button => {
  const rect = button.getBoundingClientRect()
  return rect.height >= 44 && rect.left >= 0 && rect.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth
}))
await openCleanupTerminal.click()
const cleanupTab = page.getByRole('tab', { name: 'Clean checkout', exact: true })
await cleanupTab.waitFor()
await page.locator('[data-terminal-screen]').getByText('Cleaning the fixture checkout', { exact: false }).waitFor()
await page.waitForFunction(() => {
  const tab = document.querySelector('[data-terminal-tabs] [aria-selected="true"]')
  if (!(tab instanceof HTMLElement)) return false
  const bounds = tab.getBoundingClientRect()
  const strip = tab.parentElement!.getBoundingClientRect()
  return bounds.left >= strip.left - 1 && bounds.right <= strip.right + 1
})
check('the active cleanup tab fits beside the phone terminal controls', await cleanupTab.getAttribute('aria-selected') === 'true')
await capture('workspace-settlement-script-terminal-mobile')
await page.setViewportSize({ width: 1440, height: 900 })
await page.locator('[data-header-project-scripts]').click()
await scriptDialog.getByRole('button', { name: 'Edit Clean checkout' }).click()
check('the settlement preference persists through editing', await scriptDialog.getByLabel('Run when the host settles a worktree thread').isChecked())
await scriptDialog.getByLabel('Command', { exact: true }).fill(cleanupCommand(successfulCleanupGate, 0))
await scriptDialog.getByRole('button', { name: 'Save script' }).click()
await scriptDialog.getByRole('button', { name: 'Run Clean checkout' }).waitFor()
await scriptDialog.getByRole('button', { name: 'Close project scripts' }).click()
const settledNote = page.locator('[data-thread-settled-note]')
await settledNote.getByRole('button', { name: 'Un-settle', exact: true }).click()
await settledNote.waitFor({ state: 'hidden' })
await changeSettlement('Settle thread')
await settlementCard.getByText('Running settlement script…').waitFor()
await openCleanupTerminal.click()
await cleanupTab.nth(1).waitFor()
await page.locator('[data-terminal-screen]').getByText('Cleaning the fixture checkout', { exact: false }).waitFor()
writeFileSync(successfulCleanupGate, '')
await cleanupTab.nth(1).waitFor({ state: 'hidden' })
await settlementCard.waitFor({ state: 'hidden' })
check('successful cleanup closes its terminal and failed cleanup stays available', await cleanupTab.count() === 1)

const staleThread = derivedId('auto-settle-stale')
const retainedThread = derivedId('auto-settle-retained')
for (const id of ['auto-settle-stale', 'auto-settle-retained'])
  await harness.engine.dispatch({ id, at: Date.now(), command: { type: 'session.create', workspaceId: scriptWorkspace, driverKind: 'claude' } })
await page.goto(`${baseUrl}/settings/threads`)
const settingsThreadPane = page.locator('[data-settings-section="threads"]').locator('..')
const autoSettleSwitch = settingsThreadPane.getByLabel('Auto-settle inactive threads')
const autoSettleDays = settingsThreadPane.getByLabel('Days before auto-settle')
await autoSettleDays.waitFor()
await page.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready', undefined, { timeout: 10_000 })
check('inactive threads default to seven days on the host', await autoSettleSwitch.isChecked() && await autoSettleDays.inputValue() === '7')
await autoSettleDays.fill('14')
await autoSettleDays.press('Tab')
await page.waitForFunction(() => document.activeElement?.id !== 'settings-auto-settle-days', undefined, { timeout: 5_000 })
const durationSaveDeadline = performance.now() + 12_000
while (performance.now() < durationSaveDeadline && harness.engine.current.settings.autoSettleAfterDays !== 14) await Bun.sleep(50)
if (harness.engine.current.settings.autoSettleAfterDays !== 14) {
  console.error('Auto-settle settings fixture', {
    host: harness.engine.current.settings.autoSettleAfterDays,
    input: await autoSettleDays.inputValue(),
    status: await settingsThreadPane.getByRole('alert').allTextContents(),
  })
}
check('the inactivity duration is stored on the host', harness.engine.current.settings.autoSettleAfterDays === 14)
await page.reload()
await page.waitForFunction(() => (document.querySelector('#settings-auto-settle-days') as HTMLInputElement)?.value === '14')
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await capture(`settings-auto-settle-${width}x${height}`)
}
check('thread settings fit the phone viewport', await autoSettleDays.evaluate(input => {
  const rect = input.getBoundingClientRect()
  return rect.left >= 0 && rect.right <= innerWidth
}))

// Keep the same-day calendar option elapsed so it cannot hide the test's
// duration when the two options happen to resolve to the same minute.
const snoozeFixturePresets = harness.engine.current.settings.snoozePresets.map(preset =>
  preset.kind === 'at' && preset.day === 'today' ? { ...preset, time: '00:00' } : preset)
await harness.engine.dispatch({ id: 'snooze-editor-fixture', at: Date.now(),
  command: { type: 'settings.update', changes: { snoozePresets: snoozeFixturePresets } } })
await page.reload()
const snoozeObserverContext = await browser.newContext({ colorScheme, reducedMotion })
const snoozeObserver = await snoozeObserverContext.newPage()
await snoozeObserver.goto(`${baseUrl}/settings/threads`)
const snoozePanel = page.getByRole('region', { name: 'Snooze options' })
const snoozeRows = snoozePanel.locator('[data-snooze-row]')
const observeSnoozeRows = snoozeObserver.locator('[data-snooze-row]')
await snoozeRows.nth(4).waitFor()
await observeSnoozeRows.nth(4).waitFor()
await snoozePanel.getByRole('button', { name: 'Add option', exact: true }).click()
const addedSnoozeId = await snoozeRows.nth(5).getAttribute('data-snooze-id')
const addedSnooze = snoozeRows.and(page.locator(`[data-snooze-id="${addedSnoozeId}"]`))
const observedFortyFive = observeSnoozeRows.getByText(/In 45 minutes/)
await observeSnoozeRows.nth(5).waitFor()
await page.waitForFunction(() => document.activeElement?.matches('[data-snooze-row]:last-of-type select'))
const snoozeWhen = addedSnooze.getByLabel('When', { exact: true })
await snoozeWhen.selectOption('after')
const snoozeAmount = addedSnooze.getByLabel('Amount', { exact: true })
await snoozeAmount.fill('2')
await snoozeAmount.press('Enter')
await addedSnooze.getByLabel('Unit', { exact: true }).selectOption('hours')
await observeSnoozeRows.getByText(/In 2 hours/).waitFor()
await addedSnooze.getByLabel('Unit', { exact: true }).selectOption('minutes')
await snoozeAmount.fill('0')
await snoozeAmount.press('Tab')
await snoozePanel.getByRole('alert').filter({ hasText: /Enter a whole number/ }).waitFor()
check('invalid snooze amounts restore the last valid value', await snoozeAmount.inputValue() === '2')
await snoozeAmount.fill('45')
await snoozeAmount.press('Tab')
await observedFortyFive.waitFor()
await snoozeWhen.focus()
await snoozeWhen.selectOption('friday')
await addedSnooze.getByLabel('Time').fill('16:15')
await addedSnooze.getByLabel('Time').press('Tab')
await snoozeObserver.waitForFunction(() => {
  return [...document.querySelectorAll('[data-snooze-row]')].some(row =>
    row.querySelector('select')?.value === 'friday' && row.querySelector('input[type="time"]')?.value === '16:15')
})
await snoozeWhen.focus()
await snoozeWhen.selectOption('after')
await observedFortyFive.waitFor()
check('snooze settings edit durations and weekdays on two clients without reloading',
  await addedSnooze.getByLabel('Amount').inputValue() === '45')
await snoozeObserver.reload()
await observedFortyFive.waitFor()
for (const [width, height] of workspaceViewports) {
  await page.setViewportSize({ width, height })
  await snoozePanel.getByRole('heading').scrollIntoViewIfNeeded()
  await capture(`settings-snooze-${width}x${height}`)
}
check('snooze controls stay inside the phone viewport', await snoozePanel.evaluate(panel =>
  [...panel.querySelectorAll<HTMLElement>('button, select, input')].every((control) => {
    const rect = control.getBoundingClientRect()
    return rect.width === 0 || (rect.left >= 0 && rect.right <= innerWidth)
  })))

await snoozeObserver.goto(`${baseUrl}/s/${staleThread}`)
await snoozeObserver.locator('[data-thread-actions-trigger]').click()
const snoozeMenu = snoozeObserver.getByRole('dialog', { name: 'Thread actions' })
await snoozeMenu.getByRole('button', { name: 'Snooze', exact: true }).click()
const fortyFive = snoozeMenu.getByRole('button', { name: /^In 45 minutes/ })
await fortyFive.waitFor()
const clickedAt = Date.now()
await fortyFive.click()
await snoozeMenu.waitFor({ state: 'hidden' })
const wakeAt = harness.engine.current.sessions.get(staleThread)?.navigation?.snoozedUntil ?? 0
check('choosing a snooze duration starts it at selection', wakeAt >= clickedAt + 45 * 60_000 - 1000 && wakeAt <= Date.now() + 45 * 60_000 + 1000)
await snoozeObserver.locator('[data-thread-actions-trigger]').click()
await snoozeMenu.getByRole('button', { name: 'Wake thread', exact: true }).click()
await snoozeMenu.waitFor({ state: 'hidden' })
while (await snoozeRows.count()) await snoozeRows.first().getByRole('button', { name: 'Remove snooze option' }).click()
await snoozeObserver.goto(`${baseUrl}/settings/threads`)
await snoozeObserver.getByText('0 of 8 options').waitFor()
await snoozeObserver.goto(`${baseUrl}/s/${retainedThread}`)
await snoozeObserver.locator('[data-thread-actions-trigger]').click()
await snoozeMenu.getByRole('button', { name: 'Snooze', exact: true }).click()
await snoozeMenu.getByRole('button', { name: 'Custom wake time' }).waitFor()
check('an empty snooze list offers only a custom date', await snoozeMenu.locator('[data-snooze-label]').count() === 0)
await snoozeMenu.getByRole('button', { name: 'Custom wake time' }).click()
await snoozeMenu.getByRole('button', { name: 'Edit snooze options' }).click()
await snoozeObserver.waitForFunction(() => document.activeElement?.id === 'settings-snooze-heading')
check('the custom snooze form opens settings at the preset editor', new URL(snoozeObserver.url()).pathname === '/settings/threads')
await snoozePanel.getByRole('button', { name: 'Reset defaults' }).click()
await observeSnoozeRows.nth(4).waitFor()
check('reset restores the five default presets on the host', await observeSnoozeRows.count() === 5)
await snoozeObserverContext.close()

await page.goto(`${baseUrl}/s/${retainedThread}`)
const autoSettleMenu = page.getByRole('dialog', { name: 'Thread actions' })
const openAutoSettleMenu = async () => {
  await page.locator('[data-thread-actions-trigger]').click()
  await autoSettleMenu.getByRole('button', { name: 'Auto-settle behavior' }).click()
}
await openAutoSettleMenu()
await autoSettleMenu.getByRole('button', { name: 'Never', exact: true }).click()
for (let attempt = 0; attempt < 80 && harness.engine.current.sessions.get(retainedThread)?.navigation?.autoSettle !== 'never'; attempt++) await Bun.sleep(50)
await page.reload()
await openAutoSettleMenu()
check('the per-thread opt-out survives reload', await autoSettleMenu.getByRole('button', { name: 'Never', exact: true }).getAttribute('aria-pressed') === 'true')
await capture('workspace-auto-settle-never-mobile')
await page.keyboard.press('Escape')
await autoSettleMenu.waitFor({ state: 'hidden' })

harness.stop()
{
  using aged = new Database(databasePath)
  aged.query("UPDATE events SET created_at = datetime('now', '-8 days') WHERE session_id IN (?, ?)").run(staleThread, retainedThread)
}
harness = await startHarness()
await page.setViewportSize({ width: 1440, height: 900 })
await page.goto(`${baseUrl}/settings/threads`)
await autoSettleSwitch.uncheck()
for (let attempt = 0; attempt < 80 && harness.engine.current.settings.autoSettleAfterDays !== null; attempt++) await Bun.sleep(50)
check('auto-settle can be disabled from thread settings', harness.engine.current.settings.autoSettleAfterDays === null)
await autoSettleDays.waitFor({ state: 'hidden' })
await autoSettleSwitch.check()
for (let attempt = 0; attempt < 80 && harness.engine.current.settings.autoSettleAfterDays !== 7; attempt++) await Bun.sleep(50)
await page.goto(`${baseUrl}/s/${staleThread}`)
const automaticallySettled = page.locator('[data-thread-settled-note]')
await automaticallySettled.getByText('Settled after inactivity', { exact: true }).waitFor()
check('only a thread following the host policy settles after inactivity', !harness.engine.current.sessions.get(retainedThread)?.navigation?.settledAt)
await capture('workspace-settled-after-inactivity')
await automaticallySettled.getByRole('button', { name: 'Un-settle', exact: true }).click()
await automaticallySettled.waitFor({ state: 'hidden' })
await page.reload()
check('manually reopened inactive work stays active through reload', !await automaticallySettled.isVisible())

const sidebarProfile = derivedId('live-sidebar-profile')
const sidebarFirstProject = derivedId('live-sidebar-first-project')
const sidebarAnchor = derivedId('live-sidebar-anchor')
const sidebarNewProject = derivedId('live-sidebar-new-project')
const sidebarNewThread = derivedId('live-sidebar-new-thread')
const sidebarFolder = join(driveRoot, 'sidebar-fixture')
const sidebarNewFolder = join(driveRoot, 'new-sidebar-project')
mkdirSync(sidebarFolder)
mkdirSync(sidebarNewFolder)
await harness.engine.dispatch({ id: 'live-sidebar-profile', at: Date.now(), command: { type: 'profile.create', name: 'Sidebar fixture' } })
await harness.engine.dispatch({ id: 'live-sidebar-first-project', at: Date.now(), command: { type: 'workspace.add', profileId: sidebarProfile, path: sidebarFolder } })
await harness.engine.dispatch({ id: 'live-sidebar-first-trust', at: Date.now(), command: { type: 'workspace.trust', workspaceId: sidebarFirstProject, trusted: true } })
await harness.engine.dispatch({ id: 'live-sidebar-anchor', at: Date.now(), command: { type: 'session.create', workspaceId: sidebarFirstProject, driverKind: 'claude' } })
const sidebarPhone = await browserContext.newPage()
sidebarPhone.on('pageerror', error => pageErrors.push(error.message))
await page.setViewportSize({ width: 1440, height: 900 })
await sidebarPhone.setViewportSize({ width: 390, height: 844 })
await Promise.all([page.goto(`${baseUrl}/s/${sidebarAnchor}`), sidebarPhone.goto(`${baseUrl}/s/${sidebarAnchor}`)])
await sidebarPhone.locator('[data-sidebar-toggle]').click()
const watchedSidebar = `[data-space-id="${sidebarProfile}"][data-thread-order-ready]`
await Promise.all([page.locator(watchedSidebar).waitFor(), sidebarPhone.locator(watchedSidebar).waitFor()])
const initialSidebarLink = page.locator(`${watchedSidebar} a[href="/s/${sidebarAnchor}"]`)
await initialSidebarLink.focus()

const sidebarWriter = new WebSocket(`ws://localhost:${port}/ws`)
await new Promise<void>((resolve, reject) => {
  sidebarWriter.addEventListener('open', () => resolve(), { once: true })
  sidebarWriter.addEventListener('error', reject, { once: true })
})
const sidebarDispatch = (id: string, command: unknown) => sidebarWriter.send(encode({ t: 'dispatch', envelope: { id, at: Date.now(), command } }))
sidebarDispatch('live-sidebar-new-project', { type: 'workspace.add', profileId: sidebarProfile, path: sidebarNewFolder })
sidebarDispatch('live-sidebar-new-trust', { type: 'workspace.trust', workspaceId: sidebarNewProject, trusted: true })
const newSidebarSection = `${watchedSidebar} [data-section-id="project-${sidebarNewProject}"]`
const newSidebarHeader = page.locator(newSidebarSection).getByRole('button', { name: 'new-sidebar-project' })
await newSidebarHeader.waitFor()
const newSidebarCompose = page.locator(newSidebarSection).getByRole('link', { name: 'New thread' })
check('an open sidebar discovers a newly registered project and its compose link',
  await newSidebarCompose.getAttribute('href') === `/?workspace=${sidebarNewProject}`)
await newSidebarHeader.click()
sidebarDispatch('live-sidebar-new-thread', { type: 'session.create', workspaceId: sidebarNewProject, driverKind: 'claude' })
const newSidebarLink = page.locator(`${watchedSidebar} a[href="/s/${sidebarNewThread}"]`)
const newPhoneLink = sidebarPhone.locator(`${watchedSidebar} a[href="/s/${sidebarNewThread}"]`)
await newPhoneLink.waitFor()
await newSidebarLink.waitFor({ state: 'attached' })
check('a thread added to a collapsed project starts hidden and inert',
  await newSidebarLink.isHidden() && await newSidebarLink.locator('..').getAttribute('inert') !== null)
await newSidebarHeader.click()
await newSidebarLink.waitFor()
await initialSidebarLink.focus()
sidebarDispatch('live-sidebar-first-turn', { type: 'session.turn.start', sessionId: sidebarNewThread, text: liveSidebarPrompt })
const workingSidebarLink = page.locator(`${watchedSidebar} [data-section-id^="working-"] a[href="/s/${sidebarNewThread}"]`)
await workingSidebarLink.getByText(liveSidebarPrompt, { exact: true }).waitFor()
await newPhoneLink.getByText(liveSidebarPrompt, { exact: true }).waitFor()
check('desktop and phone receive the first prompt title and working icon without a reload',
  await workingSidebarLink.locator('.i-hugeicons-loading-03').count() === 1
  && await initialSidebarLink.evaluate(link => link === link.ownerDocument.activeElement))
await capture('workspace-live-sidebar-working-phone', sidebarPhone)
liveSidebarTurn.resolve()
await page.locator(`${newSidebarSection} a[href="/s/${sidebarNewThread}"]`).getByText(liveSidebarPrompt, { exact: true }).waitFor()
const renamedSidebarTitle = 'Review the new project'
await newPhoneLink.press('F2')
const sidebarTitleInput = sidebarPhone.getByRole('textbox', { name: 'Thread title' })
await sidebarTitleInput.fill('Discard this title')
await sidebarTitleInput.press('Escape')
await newPhoneLink.waitFor()
check('Escape cancels the inline rename and restores focus',
  await newPhoneLink.getByText(liveSidebarPrompt, { exact: true }).isVisible()
  && await newPhoneLink.evaluate(link => link === link.ownerDocument.activeElement))
await newPhoneLink.press('F2')
await sidebarTitleInput.fill(renamedSidebarTitle)
check('the inline title editor fits inside phone navigation', await sidebarTitleInput.evaluate(input => {
  const bounds = input.getBoundingClientRect()
  const sidebar = input.closest('[data-harness-sidebar]')?.getBoundingClientRect()
  return Boolean(sidebar && bounds.left >= sidebar.left && bounds.right <= sidebar.right)
}))
await capture('workspace-live-sidebar-inline-rename', sidebarPhone)
await sidebarTitleInput.press('Enter')
await newSidebarLink.getByText(renamedSidebarTitle, { exact: true }).waitFor()
await newPhoneLink.getByText(renamedSidebarTitle, { exact: true }).waitFor()
check('a rename from another client preserves the route, focus, and title tooltip',
  page.url().endsWith(`/s/${sidebarAnchor}`) && await newSidebarLink.getAttribute('title') === renamedSidebarTitle
  && await initialSidebarLink.evaluate(link => link === link.ownerDocument.activeElement))
await capture('workspace-live-sidebar-renamed')
for (const [width, height] of workspaceViewports) {
  const target = width < 768 ? sidebarPhone : page
  await target.setViewportSize({ width, height })
  await capture(`workspace-live-sidebar-${width}x${height}`, target)
}
await newSidebarLink.focus()
sidebarDispatch('live-sidebar-archive', { type: 'session.organize', sessionId: sidebarNewThread, action: 'archive' })
await Promise.all([newSidebarLink.waitFor({ state: 'detached' }), newPhoneLink.waitFor({ state: 'detached' })])
check('archiving the focused row returns focus to the project header',
  await newSidebarHeader.evaluate(header => header === header.ownerDocument.activeElement))
sidebarDispatch('live-sidebar-restore', { type: 'session.organize', sessionId: sidebarNewThread, action: 'restore' })
await newPhoneLink.getByText(renamedSidebarTitle, { exact: true }).waitFor()
await newSidebarLink.press('Enter')
await page.waitForURL(url => url.pathname === `/s/${sidebarNewThread}`)
await page.locator('[data-workspace-title]').getByText(renamedSidebarTitle, { exact: true }).waitFor()
check('the restored live row supports keyboard navigation', true)
let delayedArrangementFrames = false
await sidebarPhone.routeWebSocket('**/ws', (route) => {
  const upstream = route.connectToServer()
  upstream.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(new Uint8Array(message)) as { t?: string } | null
    if (delayedArrangementFrames && frame?.t === 'sidebar-order') setTimeout(() => route.send(message), 250)
    else route.send(message)
  })
})
await sidebarPhone.goto(`${baseUrl}/s/${sidebarNewThread}`)
await sidebarPhone.locator('[data-thread-actions-trigger]').click()
await sidebarPhone.getByRole('dialog', { name: 'Thread actions' }).getByRole('button', { name: 'Arrange threads' }).click()
const liveArrangement = sidebarPhone.getByRole('dialog', { name: 'Arrange threads' })
const liveGrip = liveArrangement.getByRole('button', { name: `Reorder ${renamedSidebarTitle}` })
await liveGrip.press('Enter')
delayedArrangementFrames = true
await liveArrangement.getByRole('button', { name: 'Pin', exact: true }).press('Enter')
const delayedGrip = liveArrangement.locator('[data-section-id^="pinned-"]').getByRole('button', { name: `Reorder ${renamedSidebarTitle}` })
await delayedGrip.waitFor()
await sidebarPhone.waitForFunction(() => document.activeElement?.matches('[data-section-id^="pinned-"] [data-arrangement-grip]'))
check('keyboard movement restores focus after a delayed sidebar snapshot', true)
sidebarWriter.close()
await sidebarPhone.close()

if (harness.engine.current.settings.defaultDriver !== 'claude')
  await harness.engine.dispatch({ id: 'background-fixture-agent', at: Date.now(), command: { type: 'settings.update', changes: { defaultDriver: 'claude' } } })
execFileSync('git', ['branch', 'background-fixture-base'], { cwd: dir })
const backgroundContext = await browser.newContext({ colorScheme, reducedMotion })
const backgroundPage = await backgroundContext.newPage()
backgroundPage.on('pageerror', error => pageErrors.push(error.message))
const backgroundDraftUrl = `${baseUrl}/?workspace=${workspaceId}`
const backgroundMessage = backgroundPage.getByRole('textbox', { name: 'Message', exact: true })
const backgroundNotice = backgroundPage.locator('[data-background-thread]')
const backgroundLink = backgroundNotice.getByRole('link', { name: 'Open thread' })
await backgroundPage.goto(backgroundDraftUrl)
await backgroundPage.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready')
await backgroundPage.clock.setFixedTime(new Date('2026-11-26T17:00:00Z'))
await backgroundPage.locator('[data-draft-worktree] summary').click()
const backgroundMode = backgroundPage.getByLabel('Run in', { exact: true })
await backgroundMode.selectOption('worktree')
const backgroundBase = backgroundPage.getByRole('textbox', { name: 'Base branch', exact: true })
await backgroundBase.fill('background-fixture-base')
const priorSessions = new Set(harness.engine.current.sessions.keys())
const firstBackgroundText = 'Background fixture: first isolated thread'
const secondBackgroundText = 'Background fixture: second isolated thread'
await backgroundMessage.fill(firstBackgroundText)
await backgroundPage.locator('[data-composer-file-input]').setInputFiles({
  name: 'background-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Background attachment fixture.'),
})
await backgroundPage.locator('[data-send]:enabled').waitFor()
await backgroundMessage.press('Control+Enter')
await backgroundLink.waitFor()
const firstBackgroundLink = await backgroundLink.getAttribute('href')
check('background start stays on the draft and returns its composer focus',
  backgroundPage.url() === backgroundDraftUrl && await backgroundMessage.inputValue() === ''
  && await backgroundMessage.evaluate(editor => editor === document.activeElement))
check('background start retains the selected worktree and base branch',
  await backgroundMode.inputValue() === 'worktree' && await backgroundBase.inputValue() === 'background-fixture-base')
await backgroundNotice.getByRole('button', { name: 'Dismiss background notification' }).press('Enter')
await backgroundNotice.waitFor({ state: 'hidden' })
check('dismissing a background notification returns focus to the composer',
  await backgroundMessage.evaluate(editor => editor === document.activeElement))
await backgroundMessage.fill(secondBackgroundText)
const backgroundBefore = await backgroundMessage.boundingBox()
await backgroundMessage.press('Control+Enter')
await backgroundLink.waitFor()
await backgroundPage.waitForFunction(first => document.querySelector('[data-background-thread] a')?.getAttribute('href') !== first, firstBackgroundLink)
const backgroundAfter = await backgroundMessage.boundingBox()
check('the background notification does not move the composer',
  Boolean(backgroundBefore && backgroundAfter && Math.abs(backgroundBefore.y - backgroundAfter.y) < 1))
for (let attempt = 0; attempt < 160 && backgroundLaunches.length < 2; attempt++) await Bun.sleep(50)
const backgroundThreads = [...harness.engine.current.sessions.values()].filter(thread => !priorSessions.has(thread.id))
check('repeated background sends start separate threads and isolated checkouts',
  backgroundThreads.length === 2 && backgroundLaunches.length === 2
  && backgroundThreads.every(thread => thread.turns.length === 1 && Boolean(thread.worktreePath))
  && new Set(backgroundThreads.map(thread => thread.worktreePath)).size === 2)
check('background start transfers its attachment to the launched thread',
  backgroundThreads.find(thread => thread.turns[0]?.prompt === firstBackgroundText)?.turns[0]?.attachments?.[0]?.name === 'background-notes.txt')
for (const [width, height] of workspaceViewports) {
  await backgroundPage.setViewportSize({ width, height })
  await capture(`workspace-background-thread-${width}x${height}`, backgroundPage)
}
async function waitForWorktreeStatusReads(pathname: string | null): Promise<void> {
  const responses = await Promise.all([
    backgroundPage.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/drivers' && !url.searchParams.has('models') && response.ok()
    }),
    ...['project-setup', 'project-settlement'].map(endpoint =>
      backgroundPage.waitForResponse(response => new URL(response.url()).pathname === `${pathname}/${endpoint}` && response.ok())),
  ])
  await Promise.all(responses.map(response => response.finished()))
}

const openedBackgroundPath = await backgroundLink.getAttribute('href')
await Promise.all([waitForWorktreeStatusReads(openedBackgroundPath), backgroundLink.click()])
await backgroundPage.getByText('Background turn finished.', { exact: true }).waitFor()
check('the background notification opens the correct conversation',
  harness.engine.current.sessions.get(Number(new URL(backgroundPage.url()).pathname.split('/').at(-1)))?.turns[0]?.prompt === secondBackgroundText)

// An existing thread submits before leaving. The regular project draft and
// the newly opened draft can both retain their own text.
const sourceThreadUrl = backgroundPage.url()
const sourceThreadId = Number(new URL(sourceThreadUrl).pathname.split('/').at(-1))
const savedProjectText = 'Keep this unsent project draft.'
await backgroundPage.goto(backgroundDraftUrl)
await backgroundMessage.fill(savedProjectText)
await backgroundPage.waitForFunction(text => Object.entries(localStorage)
  .some(([key, value]) => key.startsWith('harness.composer.v1:') && value.includes(text)), savedProjectText)
await Promise.all([waitForWorktreeStatusReads(new URL(sourceThreadUrl).pathname), backgroundPage.goto(sourceThreadUrl)])
await backgroundPage.locator('[data-session-state][data-state="idle"]').waitFor({ state: 'attached' })
await backgroundMessage.fill('Background fixture: keep source busy')
await backgroundPage.locator('[data-send]:enabled').waitFor()
await backgroundMessage.press('Alt+Enter')
check('Alt+Enter alone preserves the existing-thread prompt',
  (await backgroundMessage.inputValue()).includes('Background fixture: keep source busy'))
await backgroundMessage.fill('Background fixture: keep source busy')
await pressChord('Control+Alt+Enter', backgroundPage)
const freshProjectDraft = (url: URL) => url.pathname === '/' && url.searchParams.get('workspace') === String(workspaceId)
  && Boolean(url.searchParams.get('draft'))
await backgroundPage.waitForURL(freshProjectDraft)
await backgroundPage.waitForFunction(() => document.activeElement?.matches('textarea[aria-label="Message"]'))
const firstFreshUrl = backgroundPage.url()
check('sending from an existing thread opens an empty focused draft in the same project', await backgroundMessage.inputValue() === '')
check('the existing thread continues running after the composer opens a draft',
  harness.engine.current.sessions.get(sourceThreadId)?.turns.at(-1)?.prompt === 'Background fixture: keep source busy')
for (const [width, height] of workspaceViewports) {
  await backgroundPage.setViewportSize({ width, height })
  const composer = await backgroundMessage.boundingBox()
  const send = await backgroundPage.locator('[data-send]').boundingBox()
  check(`the fresh draft composer and send action fit at ${width}×${height}`,
    Boolean(composer && send && composer.x >= 0 && composer.x + composer.width <= width
      && send.y >= 0 && send.y + send.height <= height
      && await backgroundPage.evaluate(() => document.documentElement.scrollWidth === innerWidth)))
  await capture(`workspace-send-and-new-${width}x${height}`, backgroundPage)
}
await backgroundMessage.fill('Keep this separate fresh draft.')
await backgroundPage.reload()
await backgroundPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === 'Keep this separate fresh draft.')
await backgroundPage.goto(backgroundDraftUrl)
await backgroundPage.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.value === text, savedProjectText)
check('a fresh draft survives reload and preserves the project draft', true)

await Promise.all([waitForWorktreeStatusReads(new URL(sourceThreadUrl).pathname), backgroundPage.goto(sourceThreadUrl)])
await backgroundPage.getByText('Holding the source turn.', { exact: true }).waitFor()
const queuedBackgroundText = 'Background fixture: wait behind the source'
await backgroundMessage.fill(queuedBackgroundText)
await backgroundPage.getByRole('button', { name: 'Queue', exact: true }).waitFor()
await pressChord('Control+Alt+Enter', backgroundPage)
await backgroundPage.waitForURL(url => freshProjectDraft(url) && url.href !== firstFreshUrl)
check('a background queue entry is accepted before leaving the running thread',
  harness.engine.current.sessions.get(sourceThreadId)?.followUps?.entries.some(entry => entry.text === queuedBackgroundText) === true)
backgroundSourceGate.resolve()
for (let attempt = 0; attempt < 160 && !backgroundLaunches.some(launch => launch.text === queuedBackgroundText); attempt++) await Bun.sleep(50)
check('the background queue delivers once without revisiting the source thread',
  backgroundLaunches.filter(launch => launch.text === queuedBackgroundText).length === 1 && await backgroundMessage.inputValue() === '')

const backgroundRetryText = 'Background fixture: first turn with a lost receipt'
const scratchFollowUp = 'Background fixture: send and reset the scratch draft'
const backgroundAttemptIds: string[] = []
const scratchAttemptIds: string[] = []
const droppedReceipts = new Set<string>()
await backgroundPage.routeWebSocket('**/ws', (client) => {
  const upstream = client.connectToServer()
  client.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (frame?.t === 'dispatch' && frame.envelope?.command?.text === backgroundRetryText)
      backgroundAttemptIds.push(frame.envelope.id)
    if (frame?.t === 'dispatch' && frame.envelope?.command?.text === scratchFollowUp)
      scratchAttemptIds.push(frame.envelope.id)
    upstream.send(message)
  })
  upstream.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (frame?.t === 'dispatched' && !droppedReceipts.has(frame.id)
      && (backgroundAttemptIds.includes(frame.id) || scratchAttemptIds.includes(frame.id))) {
      droppedReceipts.add(frame.id)
      return
    }
    client.send(message)
  })
})
await backgroundPage.setViewportSize({ width: 1280, height: 800 })
await backgroundPage.goto(`${baseUrl}/?project=none&profile=${providerProfileId}`)
await backgroundPage.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready')
const countBeforeBackgroundRetry = harness.engine.current.sessions.size
await backgroundMessage.fill(backgroundRetryText)
await backgroundMessage.press('Control+Enter')
await backgroundPage.getByText('The server did not confirm the request. Try again.').waitFor({ timeout: 12_000 })
check('a lost first-turn receipt keeps the projectless draft available', droppedReceipts.size === 1 && await backgroundMessage.inputValue() === backgroundRetryText)
await backgroundPage.keyboard.press('Escape')
await backgroundMessage.press('Enter')
await backgroundPage.waitForURL(/\/s\/\d+/)
await backgroundPage.getByText('Background turn finished.', { exact: true }).waitFor()
const resumedBackgroundId = Number(new URL(backgroundPage.url()).pathname.split('/').at(-1))
const resumedBackground = harness.engine.current.sessions.get(resumedBackgroundId)
check('a foreground retry reuses the projectless session and first-turn receipt',
  backgroundAttemptIds.length === 2 && backgroundAttemptIds[0] === backgroundAttemptIds[1]
  && harness.engine.current.sessions.size === countBeforeBackgroundRetry + 1
  && resumedBackground?.turns.length === 1 && harness.engine.current.workspaces.get(resumedBackground.workspaceId)?.scratch === true)
await backgroundMessage.fill(scratchFollowUp)
await backgroundPage.locator('[data-send]:enabled').waitFor()
await pressChord('Control+Alt+Enter', backgroundPage)
await backgroundPage.getByText('The server did not confirm the request. Try again.').waitFor({ timeout: 12_000 })
check('an unconfirmed send keeps the source thread and its prompt open',
  new URL(backgroundPage.url()).pathname === `/s/${resumedBackgroundId}`
  && await backgroundMessage.inputValue() === scratchFollowUp)
await backgroundPage.keyboard.press('Escape')
await backgroundMessage.focus()
await pressChord('Control+Alt+Enter', backgroundPage)
await backgroundPage.waitForURL(url => url.pathname === '/' && url.searchParams.get('project') === 'none'
  && url.searchParams.get('profile') === String(providerProfileId) && Boolean(url.searchParams.get('draft')))
check('sending from a scratch thread keeps the fresh draft projectless and on the same profile',
  await backgroundMessage.inputValue() === ''
  && scratchAttemptIds.length === 2 && scratchAttemptIds[0] === scratchAttemptIds[1]
  && harness.engine.current.sessions.get(resumedBackgroundId)?.turns.filter(turn => turn.prompt === scratchFollowUp).length === 1)
await backgroundContext.close()

const modelBatchContext = await browser.newContext({ colorScheme, reducedMotion })
const modelBatchPage = await modelBatchContext.newPage()
modelBatchPage.on('pageerror', error => pageErrors.push(error.message))
const batchEditor = modelBatchPage.getByRole('textbox', { name: 'Message', exact: true })
const batchPicker = modelBatchPage.locator('[data-model-picker-trigger]')
const batchDialog = modelBatchPage.getByRole('dialog', { name: 'Agent and model' })
const batchNotice = modelBatchPage.locator('[data-model-batch]')
const batchText = 'Background fixture: compare two models'
const modelBatchIds = new Map<string, string>()
const modelBatchTurns = new Map<number, string[]>()
let lostBatchReceipt = false
await modelBatchPage.routeWebSocket('**/ws', (client) => {
  const upstream = client.connectToServer()
  client.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (frame?.t === 'dispatch') {
      const { command, id } = frame.envelope
      if (command.type === 'session.create' && ['fixture-fast', 'fixture-balanced'].includes(command.model))
        modelBatchIds.set(command.model, id)
      if (command.type === 'session.turn.start' && command.text === batchText) {
        const attempts = modelBatchTurns.get(command.sessionId) ?? []
        modelBatchTurns.set(command.sessionId, [...attempts, id])
      }
    }
    upstream.send(message)
  })
  upstream.onMessage((message) => {
    const frame = typeof message === 'string' ? null : decode(message) as any
    if (!lostBatchReceipt && frame?.t === 'dispatched' && frame.id === modelBatchIds.get('fixture-balanced') + '_first') {
      lostBatchReceipt = true
      return
    }
    client.send(message)
  })
})
await modelBatchPage.setViewportSize({ width: 1440, height: 900 })
await modelBatchPage.clock.setFixedTime(new Date('2026-11-26T17:00:00Z'))
await modelBatchPage.goto(backgroundDraftUrl)
await batchPicker.click()
await batchDialog.getByRole('button', { name: 'Codex · Catalog fixture', exact: true }).click()
const batchFast = batchDialog.getByRole('button', { name: 'Fixture Fast', exact: true })
const batchBalanced = batchDialog.getByRole('button', { name: 'Fixture Balanced', exact: true })
const batchCompare = batchDialog.getByRole('button', { name: 'Compare with Fixture Balanced' })
await batchCompare.waitFor()
await batchFast.click()
await batchDialog.getByRole('button', { name: 'High', exact: true }).click()
await batchBalanced.click({ modifiers: ['Shift'] })
await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').nth(1).waitFor()
check('Shift-click selects two models in a Git project', await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').count() === 2)
await batchCompare.click()
await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').first().waitFor()
check('the compare button removes the second model', await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').count() === 1)
await batchCompare.click()
await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').nth(1).waitFor()
const batchSearch = batchDialog.getByRole('combobox', { name: 'Search models' })
await batchSearch.fill('Fixture Balanced')
await batchSearch.press('Shift+Enter')
await batchDialog.locator('[data-draft-model-row][aria-selected="false"]').waitFor()
check('Shift+Enter toggles a comparison without moving focus out of the model search',
  await batchSearch.evaluate(search => search === document.activeElement))
await batchCompare.click()
await batchSearch.fill('')
await batchDialog.locator('[data-draft-model-row][aria-selected="true"]').nth(1).waitFor()
for (const [width, height] of workspaceViewports) {
  await modelBatchPage.setViewportSize({ width, height })
  const fitted = await modelBatchPage.waitForFunction(() => {
    const box = document.querySelector('[data-draft-model-dialog]')?.getBoundingClientRect()
    return !!box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight
  }, undefined, { timeout: 2000 }).then(() => true, () => false)
  check(`multi-model selection fits at ${width}×${height}`, fitted)
  await capture(`workspace-model-batch-picker-${width}x${height}`, modelBatchPage)
}
await batchDialog.getByRole('button', { name: 'Done', exact: true }).click()
check('the mobile composer shows the compact model count with both names accessible',
  await batchPicker.getByText('2 models', { exact: true }).isVisible()
  && await batchPicker.getAttribute('aria-label') === 'Choose agent and model'
  && await batchPicker.getAttribute('aria-describedby') === 'draft-model-comparison-description'
  && await modelBatchPage.locator('#draft-model-comparison-description').textContent() === 'Fixture Fast, Fixture Balanced')
await modelBatchPage.locator('[data-draft-worktree] summary').click()
const batchMode = modelBatchPage.getByLabel('Run in', { exact: true })
await batchMode.locator('option[value="worktree"]').waitFor({ state: 'attached' })
check('a comparison forces one new worktree per model', await batchMode.inputValue() === 'worktree' && await batchMode.isDisabled())
await modelBatchPage.getByRole('textbox', { name: 'Base branch', exact: true }).fill('background-fixture-base')
await modelBatchPage.locator('[data-draft-worktree] summary').click()
await batchEditor.fill(batchText)
await modelBatchPage.locator('[data-composer-file-input]').setInputFiles({
  name: 'comparison-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Both model turns receive this attachment.'),
})
await modelBatchPage.locator('[data-send]:enabled').waitFor()
await batchEditor.press('Enter')
await modelBatchPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === '')
check('the composer stays open and accepts a new message during multi-model send', modelBatchPage.url() === backgroundDraftUrl)
await batchEditor.fill('Keep this next draft.')
await batchNotice.getByRole('button', { name: 'Retry pending' }).waitFor({ timeout: 12_000 })
check('a lost receipt keeps only the affected model pending', lostBatchReceipt
  && await batchNotice.getByRole('link', { name: 'Fixture Fast' }).count() === 1
  && await batchNotice.getByRole('link', { name: 'Fixture Balanced' }).count() === 0)
await modelBatchPage.reload()
await modelBatchPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Keep this next draft.')
await batchNotice.getByRole('button', { name: 'Retry pending' }).click()
await batchNotice.getByRole('link', { name: 'Fixture Balanced' }).waitFor()
const batchThreads = () => [...harness.engine.current.sessions.values()].filter(thread => thread.turns.some(turn => turn.prompt === batchText))
const batchCompletionDeadline = performance.now() + 20_000
while (performance.now() < batchCompletionDeadline && batchThreads().filter(thread => thread.turns.at(-1)?.status === 'complete').length < 2)
  await Bun.sleep(50)
const finishedBatchThreads = batchThreads()
const independentBatchThreads =
  finishedBatchThreads.length === 2
  && finishedBatchThreads.every(thread => thread.turns.length === 1 && thread.turns[0]?.status === 'complete'
    && thread.turns[0].attachments?.[0]?.name === 'comparison-notes.txt' && thread.providerInstanceId === 4 && thread.worktreePath)
  && new Set(finishedBatchThreads.map(thread => thread.worktreePath)).size === 2
  && finishedBatchThreads.find(thread => thread.model === 'fixture-fast')?.codexTurnOptions?.effort === 'high'
  && finishedBatchThreads.some(thread => thread.model === 'fixture-balanced')
if (!independentBatchThreads) {
  console.error('Model comparison fixture', finishedBatchThreads.map(thread => ({
    model: thread.model, status: thread.turns.at(-1)?.status, turns: thread.turns.length,
    provider: thread.providerInstanceId, isolated: Boolean(thread.worktreePath), attachments: thread.turns[0]?.attachments?.length,
  })))
}
check('the two models run the same prompt and file in independent checkouts', independentBatchThreads)
const batchFiles = await Promise.all(finishedBatchThreads.map(thread => {
  const file = thread.turns[0]?.attachments?.[0]
  return file ? fetch(`${baseUrl}/composer-attachments/${file.id}?session=${thread.id}`).then(response => response.text()) : null
}))
check('both threads can download the original attachment bytes',
  batchFiles.length === 2 && batchFiles.every(contents => contents === 'Both model turns receive this attachment.'))
check('only the pending model retries and the new draft survives',
  await batchEditor.inputValue() === 'Keep this next draft.'
  && await batchNotice.getByRole('link').count() === 2
  && [...modelBatchTurns.values()].map(attempts => attempts.length).sort().join(',') === '1,2'
  && [...modelBatchTurns.values()].every(attempts => new Set(attempts).size === 1))
for (const [width, height] of workspaceViewports) {
  await modelBatchPage.setViewportSize({ width, height })
  await capture(`workspace-model-batch-result-${width}x${height}`, modelBatchPage)
}
await batchPicker.click()
await batchDialog.getByRole('button', { name: 'Codex · Catalog fixture', exact: true }).click()
await batchFast.click()
await batchDialog.getByRole('button', { name: 'Done', exact: true }).click()
await modelBatchPage.locator('[data-draft-worktree] summary').click()
check('a regular model click exits comparison and restores the selected checkout mode',
  await batchMode.inputValue() === 'project' && await batchMode.isEnabled())
await modelBatchPage.goto(`${baseUrl}/?project=none&profile=${providerProfileId}`)
await batchPicker.click()
await batchDialog.getByRole('button', { name: 'Provider default', exact: true }).waitFor()
check('projectless drafts offer single-model sends', await batchDialog.locator('[data-compare-model]:visible').count() === 0)
await modelBatchContext.close()

const savedDraftContext = await browser.newContext({ colorScheme, reducedMotion })
const savedDraftPage = await savedDraftContext.newPage()
savedDraftPage.on('pageerror', error => {
  console.error('Saved draft page error at', new URL(savedDraftPage.url()).pathname, error.message)
  pageErrors.push(error.message)
})
await savedDraftPage.setViewportSize({ width: 1440, height: 900 })
await savedDraftPage.clock.setFixedTime(new Date('2026-11-26T17:00:00Z'))
const savedEditor = savedDraftPage.getByRole('textbox', { name: 'Message', exact: true })
const savedList = savedDraftPage.getByRole('region', { name: 'Unsent drafts' })
const savedLink = (title: string) => savedList.getByRole('link', { name: new RegExp('^' + title + ', Unsent draft') })
const savedCheck = (url: URL) => url.pathname === '/' && url.searchParams.get('workspace') === String(workspaceId)
  && Boolean(url.searchParams.get('draft'))
await savedDraftPage.goto(backgroundDraftUrl)
await savedEditor.fill('Saved legacy draft')
await savedDraftPage.locator('[data-nav-new-thread]').click()
await savedDraftPage.waitForURL(savedCheck)
await savedLink('Saved legacy draft').waitFor()
const savedFirstUrl = savedDraftPage.url()
await savedDraftPage.clock.setFixedTime(new Date('2026-11-26T17:00:01Z'))
await savedEditor.fill('Saved draft one\nKeep this second line.')
const savedWorktree = savedDraftPage.locator('[data-draft-worktree] summary')
await savedWorktree.click()
const savedMode = savedDraftPage.getByLabel('Run in', { exact: true })
await savedMode.locator('option[value="worktree"]').waitFor({ state: 'attached' })
await savedMode.selectOption('worktree')
await savedDraftPage.getByRole('textbox', { name: 'Base branch', exact: true }).fill('background-fixture-base')
const savedModelPicker = savedDraftPage.getByRole('button', { name: 'Choose agent and model', exact: true })
const savedModelDialog = savedDraftPage.getByRole('dialog', { name: 'Agent and model' })
await savedModelPicker.click()
await savedModelDialog.getByRole('button', { name: 'Codex · Catalog fixture', exact: true }).click()
await savedModelDialog.getByRole('button', { name: 'Fixture Fast', exact: true }).click()
await savedModelDialog.getByRole('button', { name: 'High', exact: true }).click()
await savedModelDialog.getByRole('button', { name: 'Done', exact: true }).click()
check('a new draft stays out of the list while its initial editor is open', await savedLink('Saved draft one').count() === 0)
const newProjectDraft = savedDraftPage.locator(`[data-section-id="project-${workspaceId}"]`).getByRole('link', { name: 'New thread' })
await newProjectDraft.click()
await savedDraftPage.waitForURL(url => savedCheck(url) && url.href !== savedFirstUrl)
await savedLink('Saved draft one').waitFor()
const savedSecondUrl = savedDraftPage.url()
await savedDraftPage.clock.setFixedTime(new Date('2026-11-26T17:00:02Z'))
await savedEditor.fill('Saved draft two')
await savedDraftPage.locator('[data-nav-new-thread]').click()
await savedDraftPage.waitForURL(url => savedCheck(url) && url.href !== savedSecondUrl && url.href !== savedFirstUrl)
await savedLink('Saved draft two').waitFor()
check('new-thread actions create distinct drafts and keep previous project drafts above the thread list',
  await savedList.getByRole('link').count() === 3
  && (await savedList.getByRole('link').first().getAttribute('aria-label'))?.startsWith('Saved draft two,') === true)
await savedDraftPage.locator('[data-composer-file-input]').setInputFiles({
  name: 'unsent-notes.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Keep this draft attachment.'),
})
await savedDraftPage.locator('[data-send]:enabled').waitFor()
const savedFileUrl = savedDraftPage.url()
await pressChord('Control+Alt+n', savedDraftPage)
await savedDraftPage.waitForURL(url => url.searchParams.get('project') === 'none' && Boolean(url.searchParams.get('draft')))
await savedLink('1 attachment').waitFor()
await savedDraftPage.clock.setFixedTime(new Date('2026-11-26T17:00:03Z'))
await savedEditor.fill('Saved scratch draft')
await savedDraftPage.goto(backgroundDraftUrl)
await savedLink('Saved scratch draft').waitFor()
await savedDraftPage.reload()
await savedLink('Saved draft two').waitFor()
check('legacy, independent project, file-only, and scratch drafts can all be reopened after reload',
  await savedList.getByRole('link').count() === 5
  && await savedLink('Saved legacy draft').getAttribute('href') === `/?workspace=${workspaceId}`
  && new URL(await savedLink('1 attachment').getAttribute('href') || '', baseUrl).href === savedFileUrl)
for (const [width, height] of workspaceViewports) {
  await savedDraftPage.setViewportSize({ width, height })
  const toggle = savedDraftPage.locator('[data-sidebar-toggle]')
  if (await toggle.isVisible() && !await savedList.isVisible()) await toggle.click()
  await savedLink('Saved draft two').waitFor()
  check(`saved drafts fit at ${width}×${height}`, await savedList.evaluate(list => {
    const bounds = list.getBoundingClientRect()
    return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth === innerWidth
  }))
  await capture(`workspace-saved-drafts-${width}x${height}`, savedDraftPage)
  const close = savedDraftPage.locator('[data-sidebar-close]')
  if (width <= 600 && await close.isVisible()) await close.click()
}
await savedDraftPage.setViewportSize({ width: 1440, height: 900 })
if (!await savedList.isVisible()) await savedDraftPage.locator('[data-sidebar-toggle]').click()
await savedLink('Saved draft one').focus()
await savedLink('Saved draft one').press('ArrowUp')
check('the saved draft group supports keyboard focus between rows',
  await savedLink('Saved draft two').evaluate(link => link === document.activeElement))
await savedLink('Saved draft one').press('Enter')
await savedDraftPage.waitForURL(savedFirstUrl)
await savedDraftPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Saved draft one\nKeep this second line.')
check('opening a saved row restores its exact draft and identifies the active link',
  await savedLink('Saved draft one').getAttribute('aria-current') === 'page')
await savedWorktree.click()
await savedMode.locator('option[value="worktree"]').waitFor({ state: 'attached' })
check('opening a saved draft restores its own worktree mode and base',
  await savedMode.inputValue() === 'worktree'
  && await savedDraftPage.getByRole('textbox', { name: 'Base branch', exact: true }).inputValue() === 'background-fixture-base')
await savedModelPicker.getByText('Fixture Fast · High', { exact: true }).waitFor()
await savedModelPicker.click()
check('opening a saved draft restores its named account and model options',
  await savedModelDialog.getByRole('button', { name: 'Codex · Catalog fixture', exact: true }).getAttribute('aria-pressed') === 'true'
  && await savedModelDialog.getByRole('button', { name: 'High', exact: true }).getAttribute('aria-pressed') === 'true')
await savedModelDialog.getByRole('button', { name: 'Done', exact: true }).click()
await savedEditor.fill('Edited draft one')
check('the active saved row keeps its arrival preview while editing', await savedLink('Saved draft one').isVisible())
await savedLink('Saved draft two').click()
await savedDraftPage.waitForURL(savedSecondUrl)
await savedDraftPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Saved draft two')
await savedLink('Edited draft one').waitFor()
const discardSaved = savedList.getByRole('button', { name: 'Discard draft for Edited draft one', exact: true })
await discardSaved.press('Enter')
await savedLink('Edited draft one').waitFor({ state: 'hidden' })
check('discarding one saved draft leaves the current draft intact', await savedEditor.inputValue() === 'Saved draft two')
const savedUndo = savedDraftPage.locator('[data-navigation-undo]')
await savedUndo.getByRole('button', { name: 'Undo', exact: true }).click()
await savedLink('Edited draft one').waitFor()
const sharedDraftWriter = await savedDraftContext.newPage()
try {
  await sharedDraftWriter.goto(savedFirstUrl)
  const writerEditor = sharedDraftWriter.getByRole('textbox', { name: 'Message', exact: true })
  await sharedDraftWriter.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Edited draft one')
  await writerEditor.fill('Draft changed in another tab')
  await savedLink('Draft changed in another tab').waitFor()
  check('the sidebar reflects a saved draft edit from another tab', true)
}
finally {
  await sharedDraftWriter.waitForLoadState('networkidle')
  await sharedDraftWriter.close()
}
await savedLink('1 attachment').click()
await savedDraftPage.waitForURL(savedFileUrl)
await savedDraftPage.getByText('unsent-notes.txt', { exact: true }).waitFor()
check('the file-only draft restores its attachment', await savedEditor.inputValue() === '')

const sendNumber = (number: number) => savedDraftPage.evaluate(number => !window.dispatchEvent(new KeyboardEvent('keydown', {
  key: String(number), code: 'Digit' + number, metaKey: true, bubbles: true, cancelable: true,
})), number)
await savedDraftPage.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready')
check('the browser keeps its numbered tab shortcuts by default', !await sendNumber(1) && savedDraftPage.url() === savedFileUrl)
await savedDraftPage.getByRole('button', { name: 'Settings', exact: true }).click()
const jumpSettings = savedDraftPage.getByRole('dialog', { name: 'Settings', exact: true })
await jumpSettings.getByRole('button', { name: 'Keyboard', exact: true }).click()
const jumpRow = jumpSettings.locator('[data-keybinding-row="thread.jump.1"]')
check('the keyboard pane shows unassigned browser jump shortcuts',
  await jumpRow.locator('[data-keybinding-chord]').textContent() === 'Unassigned')
await jumpRow.getByRole('button', { name: 'Change', exact: true }).click()
await pressChord('Meta+1', savedDraftPage)
await jumpRow.getByRole('button', { name: 'Reset', exact: true }).waitFor()
check('a browser can opt into the reserved chord explicitly',
  (await jumpRow.locator('[data-keybinding-chord]').textContent())?.endsWith('1') === true)
await savedDraftPage.keyboard.press('Escape')
await savedDraftPage.waitForURL(savedFileUrl)
const scratchHref = await savedLink('Saved scratch draft').getAttribute('href') || ''
const scratchDraftUrl = new URL(scratchHref, baseUrl).href
const scratchKey = await savedLink('Saved scratch draft').locator('xpath=..').getAttribute('data-saved-draft')
if (!scratchKey) throw new Error('The scratch draft storage key is unavailable')
await savedDraftPage.addInitScript((target) => {
  if (location.href !== target) return
  const frame = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = callback => frame((now) => {
    const editor = document.querySelector<HTMLTextAreaElement>('[data-prompt]')
    if (editor && !editor.value) {
      document.documentElement.dataset.fixtureEarlySelection = 'yes'
      editor.dispatchEvent(new Event('select', { bubbles: true }))
    }
    callback(now)
  })
}, scratchDraftUrl)
await pressChord('Meta+1', savedDraftPage)
await savedDraftPage.waitForURL(scratchDraftUrl)
await savedDraftPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Saved scratch draft')
check('sidebar position one opens the newest saved draft', true)
check('an empty selection event before the first restore preserves the saved draft',
  await savedDraftPage.evaluate(() => document.documentElement.dataset.fixtureEarlySelection === 'yes'))
await pressChord('Meta+Shift+]', savedDraftPage)
await savedDraftPage.waitForURL(savedFileUrl)
await pressChord('Meta+Shift+[', savedDraftPage)
await savedDraftPage.waitForURL(scratchDraftUrl)
check('previous and next move in sidebar order across saved drafts', true)
const topBeforePrevious = savedDraftPage.url()
await pressChord('Meta+Shift+[', savedDraftPage)
check('previous stays at the first visible item', savedDraftPage.url() === topBeforePrevious)

// The bridge fixture activates desktop defaults. The actual Craft input drive
// verifies the same route changes without a bridge fixture.
await savedDraftPage.addInitScript(() => {
  Object.assign(window, { craft: { menu: { set: () => { document.documentElement.dataset.fixtureDesktopMenu = 'ready' } } } })
})
await savedDraftPage.waitForLoadState('networkidle')
await savedDraftPage.goto(backgroundDraftUrl)
await savedDraftPage.bringToFront()
await savedDraftPage.waitForFunction(() => {
  const { harnessKeyboard, fixtureDesktopMenu } = document.documentElement.dataset
  return harnessKeyboard === 'ready' && fixtureDesktopMenu === 'ready'
})
await savedLink('Saved draft two').waitFor()
await savedLink('Saved scratch draft').waitFor()
await savedDraftPage.waitForLoadState('networkidle')
const primaryModifier = await savedDraftPage.evaluate(() =>
  /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent) ? 'Meta' : 'Control')
// Screenshots exercise the held hint through the same events after the simulated
// menu is ready. Shortcut navigation below still uses Playwright keyboard input.
const setFixtureModifier = (down: boolean) => savedDraftPage.evaluate(({ down, key }) => {
  window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
    key, code: key + 'Left', metaKey: down && key === 'Meta', ctrlKey: down && key === 'Control',
  }))
}, { down, key: primaryModifier })
for (const [width, height] of workspaceViewports) {
  await savedDraftPage.setViewportSize({ width, height })
  const toggle = savedDraftPage.locator('[data-sidebar-toggle]')
  if (await toggle.isVisible() && !await savedList.isVisible()) await toggle.click()
  const scratchHint = savedLink('Saved scratch draft').locator('xpath=self::*[@data-sidebar-jump]')
  // Resizing or presenting the sidebar can briefly blur the headless window.
  // Keep the fixture's modifier engaged until the numbered hint is visible.
  for (let attempt = 0; ; attempt++) {
    await setFixtureModifier(true)
    if (await scratchHint.waitFor({ timeout: 1200 }).then(() => true).catch(() => false)) break
    if (attempt === 3) throw new Error(`Sidebar hint unavailable at ${width}×${height}`)
  }
  check(`numbered sidebar hints fit at ${width}×${height}`, await savedList.evaluate(list => {
    const bounds = list.getBoundingClientRect()
    const link = list.querySelector('[data-sidebar-jump]')
    const discard = link?.parentElement?.querySelector('[data-draft-discard-row]')
    const gutter = link ? Number.parseFloat(getComputedStyle(link).paddingInlineEnd) : 0
    const discardSpace = discard && link ? link.getBoundingClientRect().right - discard.getBoundingClientRect().left : Infinity
    return gutter > discardSpace && bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth === innerWidth
  }))
  await capture(`workspace-sidebar-jump-${width}x${height}`, savedDraftPage)
  await setFixtureModifier(false)
  await savedDraftPage.locator('[data-sidebar-jump]').first().waitFor({ state: 'detached' })
  const close = savedDraftPage.locator('[data-sidebar-close]')
  if (width <= 600 && await close.isVisible()) await close.click()
}
await savedDraftPage.setViewportSize({ width: 1440, height: 900 })
await pressChord('Meta+2', savedDraftPage)
await savedDraftPage.waitForURL(savedFileUrl)
check('the inherited desktop shortcut opens the second saved draft', true)
await savedModelPicker.click()
await savedModelDialog.getByRole('button', { name: 'Codex · Catalog fixture', exact: true }).click()
const numberedModels = savedModelDialog.locator('[data-draft-model-option][aria-keyshortcuts]')
await numberedModels.nth(1).waitFor()
const modelAtTwo = await numberedModels.nth(1).getAttribute('title')
check('the provider default does not take a numbered model slot',
  await savedModelDialog.getByRole('button', { name: 'Provider default', exact: true }).getAttribute('aria-keyshortcuts') === null
  && await numberedModels.first().getAttribute('title') === 'Fixture Fast')
for (const [width, height] of workspaceViewports) {
  await savedDraftPage.setViewportSize({ width, height })
  await savedDraftPage.waitForFunction(() => {
    const dialog = document.querySelector('[data-draft-model-dialog][open]')
    const frame = dialog?.getBoundingClientRect()
    const done = dialog?.querySelector('[data-draft-model-footer] button')?.getBoundingClientRect()
    const option = dialog?.querySelector('[data-draft-model-option][aria-keyshortcuts]')
    const badge = option?.querySelector('[data-model-jump]')?.getBoundingClientRect()
    const bounds = option?.getBoundingClientRect()
    return Boolean(frame && done && bounds && badge
      && frame.left >= 0 && frame.right <= innerWidth + 1
      && done.left >= frame.left && done.right <= frame.right && done.bottom <= frame.bottom
      && badge.right <= bounds.right + 1 && bounds.right <= frame.right)
  })
  check(`the model shortcuts fit at ${width}×${height}`, true)
  await capture(`workspace-model-jump-${width}x${height}`, savedDraftPage)
}
await savedDraftPage.setViewportSize({ width: 1440, height: 900 })
await pressChord('Meta+2', savedDraftPage)
await savedModelDialog.locator('[data-draft-model-row][aria-selected="true"] [data-draft-model-option]').filter({ hasText: modelAtTwo || '' }).waitFor()
check('while the model picker is open the same number selects its model', savedDraftPage.url() === savedFileUrl)
await savedModelDialog.getByRole('button', { name: 'Done', exact: true }).click()
await pressChord('Meta+3', savedDraftPage)
await savedDraftPage.waitForURL(savedSecondUrl)
check('closing the model picker gives the number back to sidebar navigation', true)

const jumpActiveId = derivedId('numbered-sidebar-active-thread')
const jumpPinnedId = derivedId('numbered-sidebar-pinned-thread')
await harness.engine.dispatch({ id: 'numbered-sidebar-active-thread', at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude' } })
await harness.engine.dispatch({ id: 'numbered-sidebar-pinned-thread', at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude' } })
await harness.engine.dispatch({ id: 'numbered-sidebar-initial-pin', at: Date.now(), command: { type: 'session.organize', sessionId: jumpPinnedId, action: 'pin' } })
await savedDraftPage.waitForLoadState('networkidle')
await savedDraftPage.goto(backgroundDraftUrl)
const selectedPanel = savedDraftPage.locator('[data-space-active="true"]')
const jumpPinned = selectedPanel.locator(`[data-section-id^="pinned-"] a[href="/s/${jumpPinnedId}"]`)
await jumpPinned.waitFor()
await selectedPanel.locator(`[data-section-id="project-${workspaceId}"] a[href="/s/${jumpActiveId}"]`).waitFor()
const sixthHref = await selectedPanel.locator('[data-saved-draft-link], [data-sidebar-row]:not([data-collapsed]) a[data-sidebar-item][href^="/s/"]').nth(5).getAttribute('href')
await pressChord('Meta+5', savedDraftPage)
await savedDraftPage.waitForURL(backgroundDraftUrl)
await pressChord('Meta+Shift+]', savedDraftPage)
await savedDraftPage.waitForURL(new URL(sixthHref || '', baseUrl).href)
check('traversal crosses from the last draft into the visible thread list', new URL(savedDraftPage.url()).pathname.startsWith('/s/'))
await pressChord('Meta+Shift+[', savedDraftPage)
await savedDraftPage.waitForURL(backgroundDraftUrl)
const pinnedShelf = selectedPanel.locator('[data-section-id^="pinned-"]')
await savedDraftPage.waitForFunction(() => document.documentElement.dataset.harnessKeyboard === 'ready')
await jumpPinned.waitFor()
await savedDraftPage.keyboard.down(primaryModifier)
await jumpPinned.locator('xpath=self::*[@data-sidebar-jump]').waitFor()
await pinnedShelf.locator('[data-sidebar-section-header]').click()
await jumpPinned.locator('xpath=self::*[@data-sidebar-jump]').waitFor({ state: 'detached' })
const expandedSixth = await selectedPanel.locator('[data-saved-draft-link], [data-sidebar-row]:not([data-collapsed]) a[data-sidebar-item][href^="/s/"]').nth(5).getAttribute('href')
await savedDraftPage.keyboard.up(primaryModifier)
await pressChord('Meta+6', savedDraftPage)
await savedDraftPage.waitForURL(new URL(expandedSixth || '', baseUrl).href)
check('collapsed shelves give their numbers to the following visible threads', Boolean(expandedSixth) && expandedSixth !== sixthHref)
// A fixture context is torn down immediately. Let the destination's catalog
// and settlement requests complete first, as they would in an open tab.
await savedDraftPage.waitForLoadState('networkidle')
await savedDraftPage.goto(scratchDraftUrl)
await savedDraftPage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Saved scratch draft')
await savedEditor.fill('')
await savedDraftPage.waitForFunction(key => !JSON.parse(localStorage.getItem(key) ?? 'null')?.text, scratchKey)
check('an intentional edit can still empty a saved draft after restore', true)
await savedDraftContext.close()


const shareContext = await browser.newContext({ colorScheme, reducedMotion })
const sharePage = await shareContext.newPage()
sharePage.on('pageerror', error => {
  console.error('Share page error at', new URL(sharePage.url()).pathname, error.message)
  pageErrors.push(error.message)
})
await sharePage.addInitScript(() => {
  Object.assign(window, { craft: {
    menu: { set: () => {} },
    clipboard: { writeText: (text: string) => {
      if (sessionStorage.getItem('fixture.share.deny')) throw new Error('Clipboard permission denied.')
      localStorage.setItem('fixture.share.clipboard', text)
    } },
  } })
})
execFileSync('git', ['config', '--local', 'remote.origin.url', 'git@github.com:Fixture/notes-app.git'], { cwd: dir })
const sharedThreadId = derivedId('linked-prompt-source-session')
await harness.engine.dispatch({ id: 'linked-prompt-source-session', at: Date.now(), command: { type: 'session.create', workspaceId, driverKind: 'claude' } })
const shareWriter = new WebSocket('ws://localhost:' + port + '/ws')
await new Promise<void>((resolve, reject) => {
  shareWriter.addEventListener('open', () => resolve(), { once: true })
  shareWriter.addEventListener('error', () => reject(new Error('Could not open share fixture socket.')), { once: true })
})
try {
  for (const [id, text] of [
    ['shared-fixture-first', 'Share an earlier prompt & its punctuation?'],
    ['shared-fixture-second', 'Keep the later message visible in this thread.'],
  ]) {
    shareWriter.send(encode({ t: 'dispatch', envelope: {
      id, at: Date.now(), command: { type: 'session.turn.start', sessionId: sharedThreadId, text },
    } }))
    const deadline = Date.now() + 15_000
    while (!harness.engine.current.sessions.get(sharedThreadId)?.turns.some(turn => turn.prompt === text && turn.status === 'complete')) {
      if (Date.now() >= deadline) throw new Error('Could not seed the shared thread.')
      await Bun.sleep(100)
    }
  }
}
finally { shareWriter.close() }
const sourceTurnId = harness.engine.current.sessions.get(sharedThreadId)!.turns[0]!.id
const shareThreadUrl = baseUrl + '/s/' + sharedThreadId
const sourceTurn = sharePage.locator('[data-turn="' + sourceTurnId + '"]')
const sharedEditor = sharePage.getByRole('textbox', { name: 'Message', exact: true })
const shareModal = sharePage.locator('[data-prompt-link-dialog]')
const clipboard = async () => {
  await sharePage.waitForFunction(() => Boolean(localStorage.getItem('fixture.share.clipboard')))
  return new URL(await sharePage.evaluate(() => localStorage.getItem('fixture.share.clipboard') || ''))
}
const clearClipboard = () => sharePage.evaluate(() => localStorage.removeItem('fixture.share.clipboard'))
const shareState = () => [...harness.engine.current.sessions.values()].reduce((totals, thread) =>
  [totals[0]! + 1, totals[1]! + thread.turns.length], [0, 0])
const shareBefore = shareState()

await sharePage.setViewportSize({ width: 1440, height: 900 })
await sharePage.goto(shareThreadUrl)
await sourceTurn.getByRole('button', { name: 'Copy prompt link', exact: true }).click()
const sentPrompt = await clipboard()
check('a sent prompt can be shared as a new editable draft', sentPrompt.pathname === '/new'
  && sentPrompt.searchParams.get('prompt') === 'Share an earlier prompt & its punctuation?')
await clearClipboard()
await sourceTurn.getByRole('button', { name: 'Copy message link', exact: true }).click()
const sentMessage = await clipboard()
check('a message link points to its exact historical turn', sentMessage.href === shareThreadUrl + '#turn-' + sourceTurnId)
await sharePage.evaluate(() => sessionStorage.setItem('fixture.share.deny', '1'))
const messageCopy = sourceTurn.getByRole('button', { name: 'Copy message link', exact: true })
await messageCopy.click()
const clipboardDialog = sharePage.getByRole('dialog', { name: 'Copy link' })
await clipboardDialog.waitFor()
check('clipboard denial offers the same address for manual copy',
  await clipboardDialog.getByRole('textbox', { name: 'Shareable link' }).inputValue() === sentMessage.href)
await clipboardDialog.getByRole('button', { name: 'Done' }).click()
await sharePage.waitForFunction(() => document.activeElement?.hasAttribute('data-copy-message-link'))
await sharePage.evaluate(() => sessionStorage.removeItem('fixture.share.deny'))
await clearClipboard()
await sharePage.locator('[data-thread-actions-trigger]').click()
await sharePage.getByRole('button', { name: 'Copy thread link', exact: true }).click()
check('Copy thread link uses the clean thread address', (await clipboard()).href === shareThreadUrl)
await clearClipboard()
await sharePage.locator('[data-transcript]').focus()
await pressChord('Control+Shift+C', sharePage)
check('the registered shortcut copies the same thread link', (await clipboard()).href === shareThreadUrl)
await sharePage.goto(sentMessage.href)
await sourceTurn.locator('xpath=self::*[@data-linked-turn]').waitFor()
await sharePage.waitForFunction(() => document.activeElement?.hasAttribute('data-linked-turn'))
check('opening a message link focuses its historical turn', true)
await sharePage.goto(shareThreadUrl + '#turn-999999')
await sharePage.getByText('This message is unavailable in the current thread.').waitFor()
check('a missing message shows recovery without losing the thread', await sharedEditor.isVisible())

const unsafeThreadPrompt = 'Review A\u200B&B 👩‍💻\nSecond line'
await sharePage.goto(shareThreadUrl + '?' + new URLSearchParams({ prompt: unsafeThreadPrompt, branch: 'ignored' }))
await sharePage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Review A&B 👩‍💻\nSecond line')
await sharePage.locator('[data-linked-prompt-notice]').getByText('Hidden characters were removed from this prompt.', { exact: false }).waitFor()
check('an empty thread composer receives sanitized text and consumes the URL prompt',
  !new URL(sharePage.url()).searchParams.has('prompt') && shareState().join() === shareBefore.join())
await sharePage.goto(shareThreadUrl + '?' + new URLSearchParams({ prompt: 'Replace this draft only with consent.' }))
await shareModal.getByRole('heading', { name: 'Replace draft text?' }).waitFor()
for (const [width, height] of workspaceViewports) {
  await sharePage.setViewportSize({ width, height })
  check('linked prompt consent fits at ' + width + '×' + height, await shareModal.evaluate(dialog => {
    const box = dialog.getBoundingClientRect()
    const button = dialog.querySelector('[data-share-primary]')?.getBoundingClientRect()
    return Boolean(button && box.left >= 0 && box.right <= innerWidth + 1 && button.right <= box.right && button.bottom <= box.bottom)
  }))
  await capture('linked-prompt-confirmation-' + width + 'x' + height, sharePage)
}
await sharePage.keyboard.press('Escape')
check('cancelling a linked replacement preserves the existing draft', await sharedEditor.inputValue() === 'Review A&B 👩‍💻\nSecond line')
await sharePage.goto(shareThreadUrl + '?' + new URLSearchParams({ prompt: 'Replace this draft only with consent.' }))
await shareModal.getByRole('button', { name: 'Replace draft text' }).click()
check('accepting a linked replacement changes the editor without sending',
  await sharedEditor.inputValue() === 'Replace this draft only with consent.'
  && !await sharePage.locator('[data-linked-prompt-notice]').isVisible() && shareState().join() === shareBefore.join())

await sharePage.setViewportSize({ width: 1440, height: 900 })
await clearClipboard()
await pressChord('Control+K', sharePage)
const sharePalette = sharePage.getByRole('dialog', { name: 'Search threads' })
await sharePalette.getByRole('button', { name: 'Copy prompt link with repo and model', exact: true }).click()
const contextPrompt = await clipboard()
check('the palette copies only the public repository and driver context',
  contextPrompt.searchParams.get('repo')?.toLowerCase() === 'fixture/notes-app'
  && !contextPrompt.href.includes(dir) && !contextPrompt.href.includes('providerInstance'))
const repoLink = new URL('/new', baseUrl)
repoLink.search = new URLSearchParams({
  prompt: 'Draft in the known project.', repo: 'fixture/notes-app', provider: 'codex', model: 'fixture-fast',
  branch: 'do-not-checkout', permission: 'full-access',
}).toString()
await sharePage.goto(repoLink.href)
await shareModal.getByRole('button', { name: 'Open project draft' }).click()
await sharePage.waitForURL(url => url.searchParams.get('workspace') === String(workspaceId) && Boolean(url.searchParams.get('draft')))
await sharePage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Draft in the known project.')
await sharePage.locator('[data-model-picker-trigger]').getByText('Fixture Fast', { exact: true }).waitFor()
check('a known repository opens a fresh draft with the available named model', !new URL(sharePage.url()).searchParams.has('branch'))

await sharePage.waitForLoadState('networkidle')
await sharePage.goto(sentPrompt.href)
await sharePage.waitForURL(url => url.searchParams.get('project') === 'none' && Boolean(url.searchParams.get('draft')))
await sharePage.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === 'Share an earlier prompt & its punctuation?')
check('an unscoped prompt link opens a projectless draft without running it', shareState().join() === shareBefore.join())

await sharePage.waitForLoadState('networkidle')
await sharePage.goto(baseUrl + '/new?' + new URLSearchParams({ prompt: 'Missing checkout', repo: 'fixture/missing-checkout', provider: 'codex', model: 'missing-model' }))
await shareModal.getByText('fixture/missing-checkout is unavailable on this host.').waitFor()
await shareModal.getByRole('button', { name: 'Use without a project' }).click()
await sharePage.waitForURL(url => url.searchParams.get('project') === 'none' && Boolean(url.searchParams.get('draft')))
await sharePage.getByText('The linked model is unavailable. Your default model was selected.').waitFor()
check('missing repositories and models yield a usable draft with an explicit fallback', await sharedEditor.inputValue() === 'Missing checkout')

await sharePage.waitForLoadState('networkidle')
await sharePage.goto(baseUrl + '/new?' + new URLSearchParams({ pr: 'fixture/notes-app/12', prompt: 'Check the PR' }))
check('pull request links keep an explicit route to GitHub', await shareModal.getByRole('link', { name: 'Open pull request on GitHub' }).getAttribute('href') === 'https://github.com/fixture/notes-app/pull/12')
await shareModal.getByRole('button', { name: 'Cancel' }).click()
await sharePage.waitForURL(baseUrl + '/')
await sharePage.waitForLoadState('networkidle')
const unavailableThread = await sharePage.goto(baseUrl + '/s/999999999999')
check('a missing thread has a real 404 and a route back to the workspace',
  unavailableThread?.status() === 404 && await sharePage.getByRole('link', { name: 'Back to workspace' }).isVisible())
await sharePage.waitForLoadState('networkidle')
await shareContext.close()

const cloneContext = await browser.newContext({ colorScheme, reducedMotion })
const clonePage = await cloneContext.newPage()
clonePage.on('pageerror', error => {
  console.error('Clone page error at', new URL(clonePage.url()).pathname, error.message)
  pageErrors.push(error.message)
})
const gitFiles = fixtureGitRepository(join(driveRoot, 'clone-server'))
const pullRequestHead = fixturePullRequest(join(driveRoot, 'clone-server'), 7)
const networkGate = Promise.withResolvers<void>()
let delayGit = true
const gitFixture = serveFixtureGit(gitFiles.remote, () => delayGit ? networkGate.promise : Promise.resolve())
const remote = `http://127.0.0.1:${gitFixture.port}/notebook.git`
const gitConfigCount = process.env.GIT_CONFIG_COUNT
const nextConfig = Number(gitConfigCount) || 0
const gitConfigKey = 'GIT_CONFIG_KEY_' + nextConfig
const gitConfigValue = 'GIT_CONFIG_VALUE_' + nextConfig
const oldKey = process.env[gitConfigKey]
const oldValue = process.env[gitConfigValue]
try {
  const countBeforeClone = harness.engine.current.sessions.size
  const destination = join(driveRoot, 'cloned-notebook')
  await clonePage.setViewportSize({ width: 390, height: 844 })
  await clonePage.goto(backgroundDraftUrl)
  await clonePage.getByRole('button', { name: 'Workspace actions' }).click()
  await clonePage.locator('[data-project-add]').click()
  await clonePage.getByRole('dialog', { name: 'Add project' }).getByRole('button', { name: 'Clone a repository' }).click()
  const cloneDialog = clonePage.getByRole('dialog', { name: 'Clone a repository' })
  const urlBox = cloneDialog.getByRole('textbox', { name: 'Repository URL' })
  const destinationBox = cloneDialog.getByRole('textbox', { name: 'Destination folder' })
  const cloneSubmit = cloneDialog.getByRole('button', { name: 'Clone repository', exact: true })
  async function submitClone(expectedDestination: string) {
    const [response] = await Promise.all([
      clonePage.waitForResponse(result => new URL(result.url()).pathname === '/projects/clone' && result.request().method() === 'POST'),
      cloneSubmit.click(),
    ])
    if (response.request().postDataJSON().destination !== expectedDestination)
      throw new Error('Clone setup submitted a directory other than the one entered in the fixture.')
    if (response.status() !== 202) throw new Error('Clone setup failed: ' + await response.text())
  }
  const suggestionRoute = '**/projects/clone?remote=*'
  const suggestionStarted = Promise.withResolvers<void>()
  const answerSuggestion = Promise.withResolvers<void>()
  await clonePage.route(suggestionRoute, async (route) => {
    suggestionStarted.resolve()
    await answerSuggestion.promise
    await route.fulfill({ json: { destination: join(driveRoot, 'suggested-notebook'), directory: 'notebook' } })
  })
  await urlBox.fill(remote)
  await destinationBox.click()
  try {
    const requestStarted = await Promise.race([suggestionStarted.promise.then(() => true), Bun.sleep(4000).then(() => false)])
    if (!requestStarted) throw new Error('The clone folder suggestion was not requested.')
    await destinationBox.fill(join(driveRoot, 'typed-notebook'))
    await destinationBox.fill('')
  }
  finally { answerSuggestion.resolve() }
  await clonePage.waitForLoadState('networkidle')
  await clonePage.unroute(suggestionRoute)
  check('a delayed clone suggestion respects a destination the user cleared', await destinationBox.inputValue() === '')
  await destinationBox.fill(destination)
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    check(`clone setup fits at ${width}×${height}`, await cloneDialog.evaluate(dialog => {
      const bounds = dialog.getBoundingClientRect()
      const submit = dialog.querySelector('[type=submit]')?.getBoundingClientRect()
      return Boolean(submit && bounds.left >= 0 && bounds.right <= innerWidth + 1 && submit.bottom <= bounds.bottom)
    }))
    await capture(`workspace-project-clone-${width}x${height}`, clonePage)
  }

  await submitClone(destination)
  await cloneDialog.getByRole('button', { name: 'Stop clone' }).waitFor()
  await clonePage.reload()
  await cloneDialog.getByRole('button', { name: 'Stop clone' }).click()
  await cloneDialog.getByText('Clone stopped.', { exact: true }).waitFor()
  check('reloading reattaches to a cancellable clone and stopping it leaves no checkout', !existsSync(destination))

  delayGit = false
  networkGate.resolve()
  await submitClone(destination)
  await clonePage.waitForURL(url => Boolean(url.searchParams.get('workspace')) && url.href !== backgroundDraftUrl)
  await clonePage.locator('[data-project-trust]').waitFor()
  const manualId = Number(new URL(clonePage.url()).searchParams.get('workspace'))
  check('cloning through Add project registers the real checkout untrusted with no provider turn',
    harness.engine.current.workspaces.get(manualId)?.trusted === false
    && harness.engine.current.sessions.size === countBeforeClone
    && readFileSync(join(destination, 'README.md'), 'utf8') === 'Clone fixture notebook\n')

  process.env.GIT_CONFIG_COUNT = String(nextConfig + 1)
  process.env[gitConfigKey] = 'url.' + remote + '.insteadOf'
  process.env[gitConfigValue] = 'https://github.com/fixture/notebook.git'
  const linkedPrompt = 'Read the notebook before suggesting changes.'
  const linkDestination = join(driveRoot, 'linked-notebook')
  await clonePage.waitForLoadState('networkidle')
  await clonePage.goto(baseUrl + '/new?' + new URLSearchParams({ prompt: linkedPrompt, repo: 'fixture/notebook' }))
  const promptReview = clonePage.locator('[data-prompt-link-dialog]')
  await promptReview.getByText('fixture/notebook is unavailable on this host.').waitFor()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-project-clone-link-${width}x${height}`, clonePage)
  }
  await promptReview.getByRole('button', { name: 'Clone repository' }).click()
  await clonePage.waitForFunction(() => /notebook$/.test(document.querySelector<HTMLInputElement>('[data-project-clone-destination]')?.value || ''))
  check('an unavailable GitHub repository opens clone settings with its repository and suggested folder',
    await urlBox.inputValue() === 'fixture/notebook')
  await destinationBox.fill(linkDestination)
  await submitClone(linkDestination)
  await clonePage.waitForURL(url => Boolean(url.searchParams.get('workspace')) && Boolean(url.searchParams.get('draft')))
  await clonePage.locator('[data-project-trust]').click()
  const editor = clonePage.getByRole('textbox', { name: 'Message', exact: true })
  await editor.waitFor()
  await clonePage.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, linkedPrompt)
  check('cloning from a prompt link preserves its draft through project trust without sending',
    harness.engine.current.sessions.size === countBeforeClone
    && readFileSync(join(linkDestination, 'README.md'), 'utf8') === 'Clone fixture notebook\n')
  const pullRequestPrompt = 'Review the notebook pull request.'
  await clonePage.clock.setFixedTime(new Date('2026-11-26T17:00:00Z'))
  const pullRequestUrl = baseUrl + '/new?' + new URLSearchParams({ pr: 'fixture/notebook/7', prompt: pullRequestPrompt })
  const checkOut = promptReview.getByRole('button', { name: 'Check out pull request', exact: true })
  await clonePage.goto(pullRequestUrl)
  await checkOut.waitFor()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    check(`pull request confirmation fits at ${width}×${height}`, await checkOut.evaluate(button => {
      const frame = button.closest('dialog')!.getBoundingClientRect()
      const action = button.getBoundingClientRect()
      return frame.left >= 0 && frame.right <= innerWidth + 1 && action.bottom <= frame.bottom
    }))
    await capture(`workspace-pull-request-confirm-${width}x${height}`, clonePage)
  }
  await promptReview.getByRole('button', { name: 'Cancel' }).click()
  await clonePage.waitForURL(baseUrl + '/')
  check('cancelling a pull request link preserves the project and creates no thread',
    harness.engine.current.sessions.size === countBeforeClone && !existsSync(join(linkDestination, 'review.txt')))
  await clonePage.waitForLoadState('networkidle')
  await clonePage.goto(pullRequestUrl)
  await checkOut.click()
  await clonePage.waitForURL(url => /^\/s\/\d+$/.test(url.pathname))
  const pullRequestSession = Number(new URL(clonePage.url()).pathname.slice(3))
  await clonePage.waitForFunction(() => document.querySelector('[data-workspace-branch]')?.textContent?.startsWith('harness/session-'))
  await clonePage.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, pullRequestPrompt)
  const pullRequestThread = harness.engine.current.sessions.get(pullRequestSession)
  check('confirmation checks out the exact PR commit with an unsent draft and no provider run',
    pullRequestThread?.pullRequest?.commit === pullRequestHead && pullRequestThread?.turns.length === 0
    && readFileSync(join(pullRequestThread.worktreePath, 'review.txt'), 'utf8') === 'Only in the pull request\n'
    && !existsSync(join(linkDestination, 'review.txt')))
  await capture('workspace-pull-request-thread-360x800', clonePage)
  await clonePage.goto(baseUrl + '/new?' + new URLSearchParams({ pr: 'FIXTURE/notebook/7', prompt: 'Replacement text.' }))
  await promptReview.getByText('Replace draft text?', { exact: true }).waitFor()
  await promptReview.getByRole('button', { name: 'Cancel' }).click()
  check('reopening a PR uses the same thread and respects an existing draft',
    new URL(clonePage.url()).pathname === '/s/' + pullRequestSession && await editor.inputValue() === pullRequestPrompt
    && harness.engine.current.sessions.size === countBeforeClone + 1)
  await clonePage.goto(baseUrl + '/new?' + new URLSearchParams({ pr: 'fixture/notebook/7' }))
  await clonePage.waitForURL(baseUrl + '/s/' + pullRequestSession)
  await clonePage.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, pullRequestPrompt)
  check('a PR link without a prompt opens the existing draft without a replacement dialog', !await promptReview.isVisible())

  process.env[gitConfigValue] = 'https://github.com/fixture/another-notebook.git'
  const newCheckout = join(driveRoot, 'second-pr-project')
  const prSuggestionStarted = Promise.withResolvers<void>()
  const suggestPrDestination = Promise.withResolvers<void>()
  await clonePage.route(suggestionRoute, async (route) => {
    prSuggestionStarted.resolve()
    await suggestPrDestination.promise
    await route.fulfill({ json: { destination: join(driveRoot, 'late-pr-suggestion'), directory: 'another-notebook' } }).catch(() => {})
  })
  await clonePage.goto(baseUrl + '/new?' + new URLSearchParams({ pr: 'fixture/another-notebook/7', prompt: pullRequestPrompt }))
  await promptReview.getByRole('button', { name: 'Clone repository' }).click()
  try {
    const requestStarted = await Promise.race([prSuggestionStarted.promise.then(() => true), Bun.sleep(4000).then(() => false)])
    if (!requestStarted) throw new Error('The linked PR clone suggestion was not requested.')
    await destinationBox.fill(newCheckout)
  }
  finally { suggestPrDestination.resolve() }
  await clonePage.waitForLoadState('networkidle')
  await clonePage.unroute(suggestionRoute)
  check('a late linked PR clone suggestion preserves the folder the user typed', await destinationBox.inputValue() === newCheckout)
  await submitClone(newCheckout)
  await clonePage.waitForURL(url => url.searchParams.has('workspace') && url.searchParams.has('pr'))
  const trustControl = clonePage.locator('[data-project-trust]')
  await trustControl.waitFor()
  check('a PR clone pauses for project trust before asking to check out the pull request',
    !await promptReview.isVisible() && harness.engine.current.sessions.size === countBeforeClone + 1)
  await trustControl.click()
  await checkOut.waitFor()
  await checkOut.click()
  await clonePage.waitForURL(url => /^\/s\/\d+$/.test(url.pathname) && url.pathname !== '/s/' + pullRequestSession)
  await clonePage.waitForFunction(text => document.querySelector<HTMLTextAreaElement>('[data-prompt]')?.value === text, pullRequestPrompt)
  check('after cloning and giving trust, a new PR checkout preserves the original linked draft',
    harness.engine.current.sessions.size === countBeforeClone + 2 && !existsSync(join(newCheckout, 'review.txt')))
  await clonePage.waitForLoadState('networkidle')

  if (!pullRequestThread?.worktreePath) throw new Error('The PR fixture checkout is unavailable.')
  const commitCheckout = pullRequestThread.worktreePath
  const fixturePath = join(commitCheckout, 'review.txt')
  const excludedCommitPath = join(commitCheckout, 'later changes.txt')
  const lateCommitPath = join(commitCheckout, 'newly staged.txt')
  const fixtureGit = (...args: string[]) => execFileSync('git', args, { cwd: commitCheckout, encoding: 'utf8' }).trim()
  fixtureGit('config', 'user.name', 'Fixture Author')
  fixtureGit('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(fixturePath, 'Staged review note\n')
  writeFileSync(excludedCommitPath, 'Keep staged\n')
  fixtureGit('add', '--', 'review.txt', 'later changes.txt')
  writeFileSync(fixturePath, 'Newer working note\n')
  const beforeCommit = fixtureGit('rev-parse', 'HEAD')
  await clonePage.setViewportSize({ width: 1440, height: 900 })
  await clonePage.goto(baseUrl + '/s/' + pullRequestSession)
  await clonePage.getByRole('button', { name: 'Changes', exact: true }).click()
  const openCommit = clonePage.getByRole('button', { name: 'Commit staged', exact: true })
  const commitDialog = clonePage.getByRole('dialog', { name: 'Commit staged changes' })
  const commitMessage = commitDialog.getByRole('textbox', { name: 'Commit message' })
  const editCommitFiles = commitDialog.getByRole('button', { name: 'Edit files', exact: true })
  const includeAllCommitFiles = commitDialog.getByRole('checkbox', { name: 'Include all staged files', exact: true })
  const includeLaterCommitFile = commitDialog.getByRole('checkbox', { name: 'Include later changes.txt', exact: true })
  const commitSelectedFiles = commitDialog.getByRole('button', { name: 'Commit', exact: true })
  await openCommit.click()
  await commitDialog.getByText('review.txt', { exact: true }).waitFor()
  await commitMessage.fill('Review staged note')
  await editCommitFiles.click()
  await includeAllCommitFiles.uncheck()
  await commitDialog.getByText('0 of 2 staged files included', { exact: true }).waitFor()
  check('the commit action is disabled when every file is excluded', await commitSelectedFiles.isDisabled())
  await includeAllCommitFiles.check()
  await includeLaterCommitFile.press('Space')
  await commitDialog.getByText('1 of 2 staged files included', { exact: true }).waitFor()
  check('staged line totals reflect only the included files',
    (await commitDialog.locator('[data-staged-selected-totals]').innerText()).replace(/\s+/g, ' ').trim() === 'Selected lines +1 −1')
  check('keyboard selection keeps focus on the changed file', await includeLaterCommitFile.evaluate(input => input === document.activeElement))
  check('the master file selection shows a mixed state', await includeAllCommitFiles.evaluate((input: HTMLInputElement) => input.indeterminate))
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-review-commit-${width}x${height}`, clonePage)
  }
  await clonePage.keyboard.press('Escape')
  await commitDialog.waitFor({ state: 'hidden' })
  check('Escape closes commit review and leaves the index and branch unchanged',
    fixtureGit('rev-parse', 'HEAD') === beforeCommit && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt\nreview.txt'
    && await openCommit.evaluate(button => button === document.activeElement))
  await openCommit.click()
  await commitMessage.fill('Review staged note')
  await editCommitFiles.click()
  await includeLaterCommitFile.uncheck()
  writeFileSync(lateCommitPath, 'Staged after review\n')
  fixtureGit('add', '--', 'newly staged.txt')
  await commitSelectedFiles.click()
  await commitDialog.getByRole('alert').filter({ hasText: 'The branch or staged files changed' }).waitFor()
  await commitDialog.getByRole('button', { name: 'Refresh staged files', exact: true }).click()
  await commitDialog.getByText('1 of 3 staged files included', { exact: true }).waitFor()
  check('refresh preserves the message and selection after a stale staged review',
    await commitMessage.inputValue() === 'Review staged note' && !await includeLaterCommitFile.isChecked()
    && !await commitDialog.getByRole('checkbox', { name: 'Include newly staged.txt', exact: true }).isChecked())
  await commitSelectedFiles.click()
  await commitDialog.waitFor({ state: 'hidden' })
  await clonePage.getByText(/^Committed [0-9a-f]{7}\.$/u).waitFor()
  check('the commit dialog records only the selected blobs and keeps the remaining index and newer working changes',
    fixtureGit('show', 'HEAD:review.txt') === 'Staged review note' && readFileSync(fixturePath, 'utf8') === 'Newer working note\n'
    && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt\nnewly staged.txt')
  const workingAdded = join(commitCheckout, 'working add.txt')
  writeFileSync(workingAdded, 'Untracked choice\n')
  const openWorkingCommit = clonePage.getByRole('button', { name: 'Commit changes', exact: true })
  const workingDialog = clonePage.getByRole('dialog', { name: 'Commit changes', exact: true })
  await openWorkingCommit.click()
  await workingDialog.getByText('4 of 4 changed files included', { exact: true }).waitFor()
  await workingDialog.getByRole('button', { name: 'Edit files', exact: true }).click()
  for (const file of ['later changes.txt', 'newly staged.txt', 'working add.txt']) {
    await workingDialog.getByRole('checkbox', { name: 'Include ' + file, exact: true }).uncheck()
  }
  const workingMessage = workingDialog.getByRole('textbox', { name: 'Commit message' })
  const confirmWorking = workingDialog.getByRole('button', { name: 'Commit', exact: true })
  await workingMessage.fill('Review working note')
  await workingDialog.getByText('1 of 4 changed files included', { exact: true }).waitFor()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-working-commit-${width}x${height}`, clonePage)
  }
  writeFileSync(fixturePath, 'Latest working note\n')
  await confirmWorking.click()
  await workingDialog.getByRole('alert').filter({ hasText: 'working tree, or staged files changed' }).waitFor()
  await workingDialog.getByRole('button', { name: 'Refresh changed files', exact: true }).click()
  await workingDialog.getByText('1 of 4 changed files included', { exact: true }).waitFor()
  check('a refreshed working-tree review keeps the commit message and selection',
    await workingMessage.inputValue() === 'Review working note'
    && await workingDialog.getByRole('checkbox', { name: 'Include review.txt', exact: true }).isChecked())
  await confirmWorking.click()
  await workingDialog.waitFor({ state: 'hidden' })
  await clonePage.getByText(/^Committed [0-9a-f]{7}\.$/u).waitFor()
  check('working-tree commit records only the selected working copy and preserves staged and untracked exclusions',
    fixtureGit('show', 'HEAD:review.txt') === 'Latest working note'
    && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt\nnewly staged.txt'
    && fixtureGit('ls-files', '--others', '--exclude-standard') === 'working add.txt')
  fixtureGit('reset', '--', 'later changes.txt', 'newly staged.txt')
  rmSync(excludedCommitPath)
  rmSync(lateCommitPath)
  rmSync(workingAdded)
  await clonePage.waitForLoadState('networkidle')

  const previousCommitBranch = fixtureGit('branch', '--show-current')
  const previousCommitHead = fixtureGit('rev-parse', 'HEAD')
  writeFileSync(fixturePath, 'Reviewed feature branch note\n')
  await openWorkingCommit.click()
  const commitToFeature = workingDialog.getByRole('button', { name: 'Commit on new branch', exact: true })
  await commitToFeature.waitFor()
  await workingMessage.fill('Review working files on a feature branch')
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-working-commit-branch-${width}x${height}`, clonePage)
  }
  const featureBranch = 'feature/review-working-files-on-a-feature-branch'
  await commitToFeature.click()
  await workingDialog.waitFor({ state: 'hidden' })
  await clonePage.getByText(new RegExp('^Committed [0-9a-f]{7} on ' + featureBranch + '\\.$', 'u')).waitFor()
  check('committing on a new branch switches the managed checkout and leaves its previous branch unchanged',
    fixtureGit('branch', '--show-current') === featureBranch && fixtureGit('rev-parse', 'refs/heads/' + previousCommitBranch) === previousCommitHead
    && fixtureGit('show', 'HEAD:review.txt') === 'Reviewed feature branch note')

  const generatedBase = fixtureGit('rev-parse', 'HEAD')
  writeFileSync(fixturePath, 'Generate from this working edit\n')
  writeFileSync(excludedCommitPath, 'GENERATION_EXCLUDED_FIXTURE\n')
  fixtureGit('add', '--', 'later changes.txt')
  await clonePage.waitForLoadState('networkidle')
  await openWorkingCommit.click()
  await workingDialog.getByPlaceholder('Leave blank to generate from the included files').waitFor()
  await workingDialog.getByRole('button', { name: 'Edit files', exact: true }).click()
  const excludedFromGeneration = workingDialog.getByRole('checkbox', { name: 'Include later changes.txt' })
  await excludedFromGeneration.uncheck()
  rejectCommitGeneration = true
  try {
    await commitToFeature.click()
    await workingDialog.getByRole('alert').filter({ hasText: 'Could not generate a commit message.' }).waitFor()
  }
  finally { rejectCommitGeneration = false }
  check('a generation error keeps the blank review and selected files and leaves Git untouched',
    await workingMessage.inputValue() === '' && !await excludedFromGeneration.isChecked()
      && fixtureGit('rev-parse', 'HEAD') === generatedBase && await commitToFeature.isEnabled())
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-generated-commit-${width}x${height}`, clonePage)
  }
  await commitToFeature.click()
  await workingDialog.waitFor({ state: 'hidden' })
  await clonePage.getByText(/^Committed [0-9a-f]{7} on feature\/generated-review\.$/u).waitFor()
  check('blank commit uses generated text and branch from the selected working patch',
    fixtureGit('log', '-1', '--format=%s') === 'Summarize the reviewed edit'
      && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt'
      && commitGenerationPatches.length === 2
      && commitGenerationPatches.every(patch => patch.includes('Generate from this working edit') && !patch.includes('GENERATION_EXCLUDED_FIXTURE')))
  fixtureGit('reset', '--', 'later changes.txt')
  rmSync(excludedCommitPath)
  await clonePage.waitForLoadState('networkidle')

  const combinedRemote = join(driveRoot, 'commit-and-push-fixture.git')
  execFileSync('git', ['init', '--bare', '-q', combinedRemote])
  const combinedBase = fixtureGit('branch', '--show-current')
  const combinedHead = fixtureGit('rev-parse', 'HEAD')
  fixtureGit('remote', 'add', 'combined', combinedRemote)
  fixtureGit('push', '-q', 'combined', combinedBase + ':' + combinedBase)
  fixtureGit('remote', 'set-head', 'combined', combinedBase)
  fixtureGit('config', 'remote.pushDefault', 'combined')
  const rejectedPushHook = join(combinedRemote, 'hooks', 'pre-receive')
  writeFileSync(rejectedPushHook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  writeFileSync(fixturePath, 'Combined action reviewed note\n')
  writeFileSync(excludedCommitPath, 'Kept outside the publication\n')
  fixtureGit('add', '--', 'later changes.txt')
  await clonePage.waitForLoadState('networkidle')
  const openCombined = clonePage.getByRole('button', { name: 'Commit & push', exact: true })
  const combinedDialog = clonePage.getByRole('dialog', { name: 'Commit & push to default branch?', exact: true })
  const newCombined = combinedDialog.getByRole('button', { name: 'Commit & push on new branch', exact: true })
  await openCombined.click()
  await combinedDialog.getByText('Remote branch combined/' + combinedBase, { exact: true }).waitFor()
  await combinedDialog.getByText('New branch remote combined', { exact: true }).waitFor()
  await combinedDialog.getByPlaceholder('Leave blank to generate from the included files').waitFor()
  await combinedDialog.getByRole('button', { name: 'Edit files', exact: true }).click()
  await combinedDialog.getByRole('checkbox', { name: 'Include later changes.txt', exact: true }).uncheck()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-commit-and-push-${width}x${height}`, clonePage)
  }
  await combinedDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  check('cancelling Commit & push preserves the default branch and staged content',
    fixtureGit('rev-parse', 'HEAD') === combinedHead && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt')
  await openCombined.click()
  await combinedDialog.getByPlaceholder('Leave blank to generate from the included files').waitFor()
  await combinedDialog.getByRole('button', { name: 'Edit files', exact: true }).click()
  await combinedDialog.getByRole('checkbox', { name: 'Include later changes.txt', exact: true }).uncheck()
  await newCombined.click()
  const combinedFeature = 'feature/publish-selected-working-files'
  const retryPush = clonePage.getByRole('button', { name: 'Retry push', exact: true })
  await combinedDialog.waitFor({ state: 'hidden' })
  await retryPush.waitFor()
  const preparedCommit = fixtureGit('rev-parse', 'HEAD')
  check('a rejected combined push leaves the reviewed local commit and keeps excluded staging',
    fixtureGit('branch', '--show-current') === combinedFeature && fixtureGit('rev-parse', combinedBase) === combinedHead
    && fixtureGit('show', 'HEAD:review.txt') === 'Combined action reviewed note' && fixtureGit('diff', '--cached', '--name-only') === 'later changes.txt')
  await capture('workspace-commit-and-push-rejected-360x800', clonePage)
  rmSync(rejectedPushHook)
  await retryPush.click()
  const combinedPushDialog = clonePage.getByRole('dialog', { name: 'Push commits' })
  await combinedPushDialog.getByText('combined/' + combinedFeature, { exact: true }).waitFor()
  await combinedPushDialog.getByRole('button', { name: 'Push', exact: true }).click()
  await clonePage.getByText('Pushed to combined/' + combinedFeature + '.', { exact: true }).waitFor()
  check('Retry push publishes the exact saved commit without a second commit',
    fixtureGit('rev-parse', 'HEAD') === preparedCommit
    && execFileSync('git', ['--git-dir', combinedRemote, 'rev-parse', 'refs/heads/' + combinedFeature], { encoding: 'utf8' }).trim() === preparedCommit
    && commitGenerationPatches.length === 3 && !commitGenerationPatches[2]?.includes('Kept outside the publication'))
  fixtureGit('config', '--unset', 'remote.pushDefault')
  fixtureGit('remote', 'remove', 'combined')
  fixtureGit('reset', '--', 'later changes.txt')
  rmSync(excludedCommitPath)
  await clonePage.waitForLoadState('networkidle')

  const syncRemote = join(driveRoot, 'sync-fixture.git')
  const syncPeer = join(driveRoot, 'sync-peer')
  execFileSync('git', ['init', '--bare', '-q', syncRemote])
  fixtureGit('remote', 'set-url', 'origin', syncRemote)
  const syncBranch = fixtureGit('branch', '--show-current')
  const gitActions = clonePage.getByRole('group', { name: 'Git actions' })
  const openPush = gitActions.getByRole('button', { name: 'Push', exact: true })
  const openPull = gitActions.getByRole('button', { name: 'Pull', exact: true })
  const pushDialog = clonePage.getByRole('dialog', { name: 'Push commits' })
  const pullDialog = clonePage.getByRole('dialog', { name: 'Pull changes' })
  await openPush.click()
  await pushDialog.getByText('origin/' + syncBranch, { exact: true }).waitFor()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-sync-push-${width}x${height}`, clonePage)
  }
  await clonePage.keyboard.press('Escape')
  await pushDialog.waitFor({ state: 'hidden' })
  check('cancelling a push preserves the empty remote',
    execFileSync('git', ['--git-dir', syncRemote, 'for-each-ref'], { encoding: 'utf8' }).trim() === ''
    && await openPush.evaluate(button => button === document.activeElement))
  await openPush.click()
  await pushDialog.getByRole('button', { name: 'Push', exact: true }).click()
  await clonePage.getByText('Pushed to origin/' + syncBranch + '.', { exact: true }).waitFor()
  check('a first push publishes only the selected branch and sets its upstream',
    fixtureGit('rev-parse', '--abbrev-ref', '@{upstream}') === 'origin/' + syncBranch
    && execFileSync('git', ['--git-dir', syncRemote, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).trim() === 'refs/heads/' + syncBranch)
  fixtureGit('remote', 'set-head', 'origin', syncBranch)
  await clonePage.setViewportSize({ width: 1280, height: 800 })
  await openPush.click()
  const defaultPush = clonePage.getByRole('dialog', { name: 'Push to default branch?' })
  await defaultPush.getByText('origin/' + syncBranch, { exact: true }).waitFor()
  await capture('workspace-sync-default-push-1280x800', clonePage)
  await defaultPush.getByRole('button', { name: 'Cancel', exact: true }).click()
  execFileSync('git', ['clone', '-qb', syncBranch, '--', syncRemote, syncPeer])
  writeFileSync(join(syncPeer, 'review.txt'), 'Upstream review note\n')
  execFileSync('git', ['-C', syncPeer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qam', 'Peer review note'])
  execFileSync('git', ['-C', syncPeer, 'push', '-q'])
  await openPull.click()
  await pullDialog.getByText('origin/' + syncBranch, { exact: true }).waitFor()
  for (const [width, height] of workspaceViewports) {
    await clonePage.setViewportSize({ width, height })
    await capture(`workspace-sync-pull-${width}x${height}`, clonePage)
  }
  await pullDialog.getByRole('button', { name: 'Pull', exact: true }).click()
  await clonePage.getByText('Pulled from origin/' + syncBranch + '.', { exact: true }).waitFor()
  check('pull fast-forwards the isolated thread without changing its source checkout',
    readFileSync(fixturePath, 'utf8') === 'Upstream review note\n' && !existsSync(join(linkDestination, 'review.txt')))
  await clonePage.waitForLoadState('networkidle')

  const publishRemote = join(driveRoot, 'sync-publish.git')
  execFileSync('git', ['init', '--bare', '-q', publishRemote])
  fixtureGit('remote', 'add', 'publish', publishRemote)
  fixtureGit('config', 'branch.' + syncBranch + '.pushRemote', 'publish')
  const upstreamHead = fixtureGit('rev-parse', '@{upstream}')
  writeFileSync(fixturePath, 'Publishing review note\n')
  fixtureGit('commit', '-qam', 'Publishing review note')
  await openPush.click()
  await pushDialog.getByText('publish/' + syncBranch, { exact: true }).waitFor()
  await capture('workspace-sync-push-separate-remote-360x800', clonePage)
  await pushDialog.getByRole('button', { name: 'Push', exact: true }).click()
  await clonePage.getByText('Pushed to publish/' + syncBranch + '.', { exact: true }).waitFor()
  check('a separately configured push publishes only to the reviewed publishing remote',
    execFileSync('git', ['--git-dir', publishRemote, 'rev-parse', 'refs/heads/' + syncBranch], { encoding: 'utf8' }).trim() === fixtureGit('rev-parse', 'HEAD')
    && execFileSync('git', ['--git-dir', syncRemote, 'rev-parse', 'refs/heads/' + syncBranch], { encoding: 'utf8' }).trim() === upstreamHead
    && fixtureGit('rev-parse', '--abbrev-ref', '@{upstream}') === 'origin/' + syncBranch)
  await clonePage.waitForLoadState('networkidle')

  const githubRemote = 'https://github.com/fixture/workspace-pr-review.git'
  fixtureGit('remote', 'set-url', 'publish', githubRemote)
  fixtureGit('config', 'url.' + publishRemote + '.insteadOf', githubRemote)
  execFileSync('git', ['--git-dir', publishRemote, 'update-ref', 'refs/heads/main', upstreamHead])
  const github = fixtureGitHubCli(driveRoot, { 'fixture/workspace-pr-review': { bare: publishRemote } })
  const toolPath = process.env.PATH
  process.env.PATH = github.bin + delimiter + toolPath
  try {
    writeFileSync(fixturePath, 'Contents approved for PR review\n')
    fixtureGit('commit', '-qam', 'Add a release note')
    const head = fixtureGit('rev-parse', 'HEAD')
    const openPr = clonePage.locator('[data-repository-pull-request-open]')
    const prDialog = clonePage.getByRole('dialog', { name: 'Create pull request' })
    const account = prDialog.getByText('fixture-user', { exact: true })
    await openPr.click()
    await account.waitFor()
    await clonePage.keyboard.press('Escape')
    await prDialog.waitFor({ state: 'hidden' })
    check('cancelling the PR review leaves the published head unchanged and returns focus',
      execFileSync('git', ['--git-dir', publishRemote, 'rev-parse', 'refs/heads/' + syncBranch], { encoding: 'utf8' }).trim() !== head
      && await openPr.evaluate(button => button === document.activeElement))
    await openPr.click()
    await account.waitFor()
    const baseInput = prDialog.getByRole('textbox', { name: 'Base branch' })
    await baseInput.fill('missing')
    await prDialog.getByRole('button', { name: 'Refresh review' }).click()
    await prDialog.getByRole('alert').getByText('GitHub could not find the selected base branch.').waitFor()
    await baseInput.fill('main')
    await prDialog.getByRole('button', { name: 'Refresh review' }).click()
    const createPr = prDialog.getByRole('button', { name: 'Push and create' })
    const title = prDialog.getByRole('textbox', { name: 'Title' })
    await title.fill('Verify the draft pull request')
    await prDialog.getByRole('textbox', { name: /Description/ }).fill('Synthetic branch content for review.')
    await prDialog.getByRole('checkbox', { name: 'Open as draft' }).check()
    await clonePage.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-repository-pull-request-confirm]')
      return button && !button.disabled
    })
    check('the PR inputs use the workspace appearance', await title.evaluate(input =>
      getComputedStyle(input).backgroundColor === getComputedStyle(input.closest('form')!.querySelector('textarea')!).backgroundColor))
    for (const [width, height] of workspaceViewports) {
      await clonePage.setViewportSize({ width, height })
      await capture(`workspace-create-pull-request-${width}x${height}`, clonePage)
    }
    await createPr.click()
    await prDialog.waitFor({ state: 'hidden' })
    const linkedPr = clonePage.locator('[data-repository-pull-request-link]')
    const address = 'https://github.com/fixture/workspace-pr-review/pull/1'
    const data = JSON.parse(readFileSync(github.state, 'utf8'))
    check('the reviewed branch is published and a draft PR is created with its entered title',
      data.posts === 1 && data.pulls[0].draft === true && data.pulls[0].head.sha === head
      && data.pulls[0].title === 'Verify the draft pull request'
      && await linkedPr.getAttribute('href') === address)
    await clonePage.setViewportSize({ width: 1280, height: 800 })
    await clonePage.reload()
    await clonePage.getByRole('button', { name: 'Changes', exact: true }).click()
    await linkedPr.waitFor()
    await openPr.click()
    await prDialog.getByRole('link', { name: 'Open existing pull request #1' }).waitFor()
    await prDialog.getByRole('button', { name: 'Link pull request' }).click()
    await prDialog.waitFor({ state: 'hidden' })
    check('reload restores the scoped PR link and linking again does not create another PR',
      await linkedPr.getAttribute('href') === address && JSON.parse(readFileSync(github.state, 'utf8')).posts === 1)

    const checks = [[
      { __typename: 'StatusContext', id: 'status:pending', context: 'Verify packaging', state: 'PENDING', description: 'Waiting for a runner' },
      { __typename: 'CheckRun', id: 'check:completed', name: 'Unit tests', conclusion: 'SUCCESS', status: 'COMPLETED' },
      { __typename: 'CheckRun', id: 'check:failed', name: 'Integration suite', conclusion: 'FAILURE', status: 'COMPLETED', detailsUrl: 'https://ci.example.com/jobs/2' },
    ]]
    github.configureChecks(checks)
    const checksToggle = clonePage.getByRole('button', { name: 'Checks', exact: true })
    const checksPanel = clonePage.getByRole('region', { name: 'Pull request checks' })
    await checksToggle.focus()
    await clonePage.keyboard.press('Enter')
    await checksPanel.getByText('Integration suite', { exact: true }).waitFor()
    const checkRows = checksPanel.locator('[data-pull-request-check]')
    const checkNames = () => checkRows.locator('p.font-medium').allTextContents()
    check('keyboard opens checks for the linked PR head with attention and pending checks first',
      await checksToggle.getAttribute('aria-expanded') === 'true' && (await checkNames()).join(',') === 'Integration suite,Verify packaging'
      && await checksPanel.getByText('Head ' + head.slice(0, 7), { exact: true }).getAttribute('title') === head
      && await checksPanel.getByRole('link', { name: 'Details for Integration suite' }).getAttribute('href') === 'https://ci.example.com/jobs/2')
    await checksPanel.getByRole('button', { name: 'Show all', exact: true }).click()
    await checksPanel.getByText('Unit tests', { exact: true }).waitFor()
    await clonePage.setViewportSize({ width: 390, height: 844 })
    await capture('workspace-pull-request-checks-390x844', clonePage)
    check('Show all reveals completed checks without page overflow',
      (await checkNames()).join(',') === 'Integration suite,Verify packaging,Unit tests'
      && await clonePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await checksPanel.getByRole('button', { name: 'Show less', exact: true }).click()
    await checksPanel.getByText('Unit tests', { exact: true }).waitFor({ state: 'hidden' })
    github.configureChecks([], 'unreadable')
    const refreshChecks = checksPanel.getByRole('button', { name: 'Refresh checks', exact: true })
    await refreshChecks.click()
    await checksPanel.getByRole('alert').getByText(/Check the host account/).waitFor()
    github.configureChecks([])
    await refreshChecks.click()
    await checksPanel.getByText('No checks reported for this commit.', { exact: true }).waitFor()
    await checksToggle.click()
    await checksPanel.waitFor({ state: 'hidden' })
    check('refresh recovers from a GitHub read error and closing leaves the linked PR intact',
      await checksToggle.getAttribute('aria-expanded') === 'false' && await linkedPr.getAttribute('href') === address
      && JSON.parse(readFileSync(github.state, 'utf8')).posts === 1)

    github.configureChecks(checks)
    const returnThread = new URL(clonePage.url()).pathname
    await clonePage.getByRole('link', { name: 'Review PR', exact: true }).click()
    const reviewTitle = clonePage.getByRole('heading', { name: 'Verify the draft pull request' })
    await reviewTitle.waitFor()
    const reviewList = clonePage.getByRole('region', { name: 'Pull request list' })
    const reviewTabs = clonePage.getByRole('navigation', { name: 'Pull request views' })
    check('the Changes link opens the selected request directly with the matching thread and responsive list',
      new URL(clonePage.url()).searchParams.get('selectedUrl') === address && !await reviewList.isVisible()
      && await clonePage.getByRole('link', { name: 'Open linked thread' }).getAttribute('href') === returnThread)
    const checksRollup = clonePage.getByRole('link', { name: '1 of 3 failing', exact: true })
    await checksRollup.press('Enter')
    await clonePage.waitForURL(url => url.hash === '#pr-detail-checks')
    check('the review check summary reaches the checks heading on a phone',
      new URL(clonePage.url()).hash === '#pr-detail-checks'
      && await clonePage.locator('#pr-detail-checks').evaluate(heading => heading === document.activeElement)
      && await clonePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await clonePage.getByText('Integration suite', { exact: true }).waitFor()
    await capture('pull-requests-summary-390x844', clonePage)
    await reviewTabs.getByRole('link', { name: 'Timeline' }).click()
    await clonePage.getByText('fixture-reviewer', { exact: true }).waitFor()
    await clonePage.locator('[data-pr-activity] strong').filter({ hasText: 'export' }).waitFor()
    check('review conversation renders safe Markdown in the Timeline view',
      !await clonePage.evaluate(() => Boolean((globalThis as typeof globalThis & { __pr_html?: boolean }).__pr_html)))
    github.configureConversations('normal')
    github.configureCommentPages('normal')
    await reviewTabs.getByRole('link', { name: 'Code' }).click()
    await clonePage.locator('[data-pr-file-patch] > summary').click()
    await clonePage.locator('[data-pr-patch][aria-label="Patch for report.txt"]').getByText('+Report fixture', { exact: false }).waitFor()
    await clonePage.setViewportSize({ width: 1280, height: 800 })
    await reviewList.waitFor()
    await capture('pull-requests-code-1280x800', clonePage)
    const viewedFile = clonePage.getByRole('button', { name: 'Viewed report.txt' })
    await clonePage.locator('[data-pr-viewed-form] button[aria-disabled="false"]').waitFor()
    const openingReviewUrl = clonePage.url()
    const viewedResponse = (desired: boolean) => clonePage.waitForResponse(response => {
      const request = response.request()
      return request.method() === 'POST' && new URL(response.url()).pathname === '/pull-requests/viewed'
        && new URLSearchParams(request.postData() ?? '').get('viewed') === String(desired)
    })
    await clonePage.bringToFront()
    const [marked] = await Promise.all([viewedResponse(true), viewedFile.press('Enter')])
    if (!marked.ok()) throw new Error(`Mark Viewed returned HTTP ${marked.status()}: ${await marked.text()}`)
    await clonePage.getByText('File marked as viewed.', { exact: true }).waitFor()
    check('mark viewed preserves the exact file, expanded patch and selected request',
      await viewedFile.getAttribute('aria-pressed') === 'true'
      && clonePage.url() === openingReviewUrl
      && await viewedFile.evaluate(button => document.activeElement === button)
      && await clonePage.locator('details[open] [data-pr-patch]').getByText('+Report fixture', { exact: true }).isVisible())
    await clonePage.reload()
    await viewedFile.waitFor()
    check('viewed state survives reload and matches the forge', await viewedFile.getAttribute('aria-pressed') === 'true'
      && JSON.parse(readFileSync(github.state, 'utf8')).fileViewed === true)
    await clonePage.setViewportSize({ width: 390, height: 844 })
    await capture('pull-requests-viewed-390x844', clonePage)
    await clonePage.locator('[data-pr-viewed-form] button[aria-disabled="false"]').waitFor()
    const [unmarked] = await Promise.all([viewedResponse(false), viewedFile.click()])
    if (!unmarked.ok()) throw new Error(`Unmark Viewed returned HTTP ${unmarked.status()}: ${await unmarked.text()}`)
    await clonePage.getByText('File marked as unviewed.', { exact: true }).waitFor()
    check('unmark viewed restores the unchecked file without changing the pull request',
      await viewedFile.getAttribute('aria-pressed') === 'false' && JSON.parse(readFileSync(github.state, 'utf8')).fileViewed === false)

    const filePatch = clonePage.locator('[data-pr-file-patch]')
    await filePatch.locator(':scope > summary').click()
    const conversation = filePatch.locator('[data-pr-conversation]').filter({ hasText: 'Line 1 after changes' })
    const oldConversation = filePatch.locator('[data-pr-conversation]').filter({ hasText: 'Line 12 before changes' })
    const comment = conversation.getByText(/Verify the inline report/)
    const resolveConversation = conversation.getByRole('button', { name: 'Resolve', exact: true })
    await comment.waitFor()
    await conversation.locator('[data-pr-conversation-form] button[aria-disabled="false"]').waitFor()
    check('Code anchors the current review after its line and keeps outdated comments collapsed',
      await conversation.evaluate(element => element.previousElementSibling?.textContent?.includes('+Report fixture'))
      && await oldConversation.getAttribute('open') === null)
    const beforeLine = filePatch.getByRole('link', { name: 'Before line 1', exact: true })
    const afterLine = filePatch.getByRole('link', { name: 'After line 2', exact: true })
    await beforeLine.focus()
    await clonePage.keyboard.press('Enter')
    await clonePage.keyboard.press('Shift+ArrowDown')
    await clonePage.keyboard.press('Shift+ArrowDown')
    const lineTools = clonePage.locator('[data-pr-line-tools]')
    await lineTools.getByText('Before line 1 to after line 2', { exact: true }).waitFor()
    check('PR line navigation spans the deletion and additions in one hunk',
      await afterLine.evaluate(element => element === document.activeElement)
      && await filePatch.locator('[data-pr-line-row][data-selected]').count() === 3)
    const lineAddress = await lineTools.locator('[data-pr-open-line-link]').getAttribute('href')
    if (!lineAddress) throw new Error('Missing PR line selection address')
    const linked = await clonePage.context().newPage()
    try {
      await linked.goto(new URL(lineAddress, clonePage.url()).href)
      check('a PR line link expands its file and restores the range and focus',
        await linked.locator('[data-pr-file-patch]').getAttribute('open') !== null
        && await linked.locator('[data-pr-line-row][data-selected]').count() === 3
        && await linked.locator('[data-pr-line][aria-current="location"]').evaluate(element => element === document.activeElement))
    }
    finally { await linked.close() }
    await capture('pull-requests-line-range-390x844', clonePage)
    await filePatch.getByRole('link', { name: 'After line 21', exact: true }).click({ modifiers: ['Shift'] })
    check('a selection across hunks starts a new range',
      await filePatch.locator('[data-pr-line-row][data-selected]').count() === 1
      && await lineTools.getByText('Range starts again in this hunk.', { exact: true }).isVisible())
    await clonePage.keyboard.press('Escape')
    check('Escape clears the range without closing the inline conversation',
      await filePatch.locator('[data-pr-line-row][data-selected]').count() === 0 && await comment.isVisible())
    await capture('pull-requests-inline-conversation-390x844', clonePage)
    const [resolution] = await Promise.all([
      clonePage.waitForResponse(response => new URL(response.url()).pathname === '/pull-requests/conversation' && response.request().method() === 'POST'),
      resolveConversation.press('Enter'),
    ])
    if (!resolution.ok()) throw new Error(`Resolve conversation returned HTTP ${resolution.status()}: ${await resolution.text()}`)
    const undoResolution = conversation.getByRole('button', { name: 'Unresolve', exact: true })
    await conversation.getByText('Conversation resolved.', { exact: true }).waitFor()
    check('resolving keeps the review and focus visible and updates the forge',
      await comment.isVisible() && await undoResolution.evaluate(button => button === document.activeElement)
      && JSON.parse(readFileSync(github.state, 'utf8')).conversationResolved === true)
    await clonePage.reload()
    await filePatch.locator(':scope > summary').click()
    await conversation.getByText('Resolved conversation', { exact: true }).waitFor()
    check('reloading a resolved thread hides the conversation until expanded', !await comment.isVisible())
    await conversation.locator(':scope > summary').click()
    await comment.waitFor()
    await undoResolution.click()
    await conversation.getByText('Conversation reopened.', { exact: true }).waitFor()
    check('unresolving returns the same conversation to the open state',
      await comment.isVisible() && JSON.parse(readFileSync(github.state, 'utf8')).conversationResolved === false)
    const openReply = conversation.locator('[data-pr-reply] > summary')
    const replyInput = conversation.getByRole('textbox', { name: 'Reply to this conversation' })
    await openReply.click()
    await replyInput.waitFor()
    await clonePage.waitForFunction(() => globalThis.document.activeElement?.getAttribute('name') === 'body')
    await replyInput.fill('Follow up on the **inline report**.')
    await replyInput.press('Escape')
    await replyInput.waitFor({ state: 'hidden' })
    await openReply.click()
    check('closing the reply editor restores the draft when reopened',
      await replyInput.inputValue() === 'Follow up on the **inline report**.')
    await replyInput.press('Enter')
    check('plain Enter inserts a line without posting a reply', (await replyInput.inputValue()).includes('\n')
      && JSON.parse(readFileSync(github.state, 'utf8')).replyRequests === undefined)
    await conversation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await replyInput.waitFor({ state: 'hidden' })
    const cancelledFocus = await openReply.evaluate(element => element === document.activeElement)
    await openReply.click()
    await clonePage.waitForFunction(() => globalThis.document.activeElement?.getAttribute('name') === 'body')
    check('Cancel keeps the draft available and returns to the reply toggle',
      cancelledFocus && (await replyInput.inputValue()).includes('\n'))
    await conversation.locator('[data-pr-reply-form]').scrollIntoViewIfNeeded()
    await capture('pull-requests-inline-reply-390x844', clonePage)
    const replyAddress = clonePage.url()
    const [replyResponse] = await Promise.all([
      clonePage.waitForResponse(response => new URL(response.url()).pathname === '/pull-requests/reply' && response.request().method() === 'POST'),
      replyInput.press('Control+Enter'),
    ])
    if (!replyResponse.ok()) throw new Error(`Post reply returned HTTP ${replyResponse.status()}: ${await replyResponse.text()}`)
    await conversation.getByText('Reply posted.', { exact: true }).waitFor()
    await conversation.getByText('Follow up on the inline report.', { exact: true }).waitFor()
    check('a reply renders in place and restores focus to Reply with one write',
      clonePage.url() === replyAddress && await openReply.evaluate(element => element === document.activeElement)
      && JSON.parse(readFileSync(github.state, 'utf8')).replyRequests === 1)
    const loadComments = conversation.getByRole('link', { name: 'Load more comments', exact: true })
    const postedReply = conversation.getByText('Follow up on the inline report.', { exact: true })
    await openReply.click()
    await clonePage.waitForFunction(() => globalThis.document.activeElement?.getAttribute('name') === 'body')
    await replyInput.fill('A second unsent review draft.')
    github.configureCommentPages('unavailable')
    await loadComments.focus()
    const [failedComments] = await Promise.all([
      clonePage.waitForResponse(response => new URL(response.url()).pathname === '/pull-requests/comments' && response.request().method() === 'GET'),
      clonePage.keyboard.press('Enter'),
    ])
    if (failedComments.status() !== 503) throw new Error(`Load comments returned HTTP ${failedComments.status()}`)
    await conversation.getByText('Could not load more comments. Try again.', { exact: true }).waitFor()
    check('a failed comment read leaves the loaded conversation and draft available',
      await replyInput.inputValue() === 'A second unsent review draft.' && await postedReply.count() === 1)
    github.configureCommentPages('overlap')
    await loadComments.press('Enter')
    const firstAdded = conversation.locator('[data-pr-conversation-comment]').filter({ hasText: /History comment 19\./ })
    await firstAdded.waitFor()
    await clonePage.waitForFunction(() => globalThis.document.activeElement?.textContent?.includes('History comment 19.'))
    check('loading a page skips boundary duplicates and focuses the first added comment',
      await conversation.getByText('History comment 18.', { exact: true }).count() === 1
      && await firstAdded.count() === 1 && clonePage.url() === replyAddress)
    await loadComments.scrollIntoViewIfNeeded()
    await capture('pull-requests-inline-comment-pages-390x844', clonePage)
    await loadComments.press('Enter')
    await conversation.getByText('History comment 43.', { exact: true }).waitFor()
    await loadComments.waitFor({ state: 'hidden' })
    check('the final comment page keeps a draft and shows a concurrently posted reply only once',
      await replyInput.inputValue() === 'A second unsent review draft.' && await postedReply.count() === 1
      && await conversation.getByText('History comment 38.', { exact: true }).count() === 1
      && await conversation.locator('[data-pr-conversation-comment]').count() === 46)

    const editor = clonePage.locator('[data-pr-review-composer]')
    const reviewDialog = clonePage.getByRole('dialog', { name: 'Review pull request' })
    const afterThree = filePatch.getByRole('link', { name: 'After line 3', exact: true })
    await afterLine.click()
    await afterThree.click({ modifiers: ['Shift'] })
    await lineTools.getByRole('button', { name: 'Add inline comment', exact: true }).click()
    const inlineText = editor.getByRole('textbox')
    await inlineText.fill('Verify **these report lines**.')
    check('the draft opens directly below the last selected line with textarea focus',
      await editor.evaluate(element => element.previousElementSibling?.hasAttribute('data-selected')
        && element.contains(document.activeElement)))
    await capture('pull-requests-inline-review-editor-390x844', clonePage)
    await inlineText.press('Control+Enter')
    await beforeLine.click()
    await lineTools.getByRole('button', { name: 'Add inline comment', exact: true }).click()
    await inlineText.fill('Keep this deletion on the left side.')
    await editor.getByRole('button', { name: 'Add to review', exact: true }).click()
    await clonePage.reload()
    const openReview = clonePage.getByRole('button', { name: 'Review pull request, 2 comments pending', exact: true })
    await openReview.click()
    await reviewDialog.getByText('Keep this deletion on the left side.', { exact: true }).waitFor()
    check('both anchors survive reload and a PR author can only comment',
      await reviewDialog.getByText('Verify **these report lines**.', { exact: true }).isVisible()
      && await reviewDialog.getByText('Comment as fixture-user', { exact: true }).isVisible()
      && await reviewDialog.getByRole('radio').count() === 0
      && await reviewDialog.evaluate(element => element.matches(':modal') && element.contains(document.activeElement)))
    await clonePage.keyboard.press('Escape')
    await reviewDialog.waitFor({ state: 'hidden' })
    check('closing the review returns focus to the toolbar', await openReview.evaluate(element => element === document.activeElement))
    await openReview.click()
    await reviewDialog.getByRole('listitem').filter({ hasText: 'Verify **these report lines**.' }).getByRole('button', { name: 'Edit', exact: true }).click()
    await inlineText.waitFor()
    check('editing a staged comment reopens its diff range with the staged text',
      await filePatch.locator('[data-pr-line-row][data-selected]').count() === 2
      && await inlineText.inputValue() === 'Verify **these report lines**.')
    await inlineText.fill('Verify the **updated range**.')
    await editor.getByRole('button', { name: 'Save comment', exact: true }).click()
    await openReview.click()
    await reviewDialog.getByRole('textbox', { name: /Summary/ }).fill('Review the exported report.')
    await capture('pull-requests-inline-review-submit-390x844', clonePage)
    github.configureInlineReviews('unconfirmed')
    await reviewDialog.getByRole('button', { name: 'Submit review', exact: true }).click()
    await reviewDialog.getByText('GitHub has yet to confirm this review.', { exact: false }).waitFor()
    await clonePage.reload()
    await openReview.click()
    const checkReview = reviewDialog.getByRole('button', { name: 'Check GitHub', exact: true })
    await checkReview.click()
    await reviewDialog.getByText('GitHub has yet to confirm this review.', { exact: false }).waitFor()
    check('an unconfirmed review is locked and retrying does not post again',
      await reviewDialog.getByRole('textbox', { name: /Summary/ }).getAttribute('readonly') !== null
      && JSON.parse(readFileSync(github.state, 'utf8')).reviewRequests === 1)
    github.revealInlineReview()
    await checkReview.click()
    await clonePage.getByText('Review submitted to GitHub.', { exact: true }).waitFor()
    const posted = JSON.parse(readFileSync(github.state, 'utf8'))
    check('the confirmed review contains both validated anchors and clears the local queue',
      posted.reviewRequests === 1 && posted.inlineReviews[0].comments.length === 2
      && posted.inlineReviews[0].comments[0].start_line === 2 && posted.inlineReviews[0].comments[0].line === 3
      && posted.inlineReviews[0].comments[1].side === 'LEFT'
      && await clonePage.getByRole('button', { name: 'Review pull request', exact: true }).isVisible())
    const lifecycleMenu = clonePage.locator('[data-pr-lifecycle-menu]')
    const actions = clonePage.getByRole('button', { name: 'Pull request actions', exact: true })
    const closeTrigger = lifecycleMenu.getByRole('button', { name: 'Close pull request', exact: true })
    const confirmClose = clonePage.getByRole('button', { name: 'Confirm close', exact: true })
    const lifecycleStatus = (text: string) => clonePage.locator('[data-pr-lifecycle-message]').getByText(text, { exact: true })
    const pullState = () => JSON.parse(readFileSync(github.state, 'utf8'))
    await actions.press('Enter')
    await closeTrigger.press('Enter')
    await confirmClose.waitFor()
    await capture('pull-requests-lifecycle-close-390x844', clonePage)
    await clonePage.keyboard.press('Escape')
    check('Escape dismisses close confirmation and returns focus without writing to GitHub',
      await confirmClose.isHidden()
      && await closeTrigger.evaluate(element => element === document.activeElement)
      && pullState().lifecycleWrites === undefined)
    await lifecycleMenu.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await lifecycleStatus('Pull request is ready for review.').waitFor()
    check('marking a draft ready keeps Code and the selected diff range intact',
      new URL(clonePage.url()).searchParams.get('tab') === 'code'
      && await filePatch.locator('[data-pr-line-row][data-selected]').count() === 2
      && pullState().pulls[0].draft === false)
    await actions.click()
    await lifecycleMenu.getByRole('button', { name: 'Convert to draft', exact: true }).click()
    await lifecycleStatus('Pull request converted to draft.').waitFor()
    await actions.click()
    await closeTrigger.click()
    github.configureLifecycle('unconfirmed')
    await confirmClose.click()
    const checkLifecycle = clonePage.getByRole('button', { name: 'Check GitHub again', exact: true })
    await checkLifecycle.waitFor()
    github.revealLifecycle()
    await checkLifecycle.click()
    await lifecycleStatus('Pull request closed.').waitFor()
    github.configureLifecycle('normal')
    await actions.click()
    await lifecycleMenu.getByRole('button', { name: 'Reopen pull request', exact: true }).click()
    await lifecycleStatus('Pull request reopened.').waitFor()
    check('the draft, close, and reopen transitions are confirmed on GitHub without a repeated close',
      pullState().lifecycleWrites === 4 && pullState().pulls[0].state === 'open' && pullState().pulls[0].draft === true)
    const mergeReviewUrl = clonePage.url()
    await clonePage.setViewportSize({ width: 1280, height: 800 })

    await clonePage.getByRole('link', { name: 'Back to list', exact: true }).click()
    await reviewList.getByRole('searchbox', { name: 'Search pull requests' }).fill('unmatched review')
    await reviewList.getByRole('button', { name: 'Search', exact: true }).click()
    await reviewList.getByText('No pull requests match these filters.', { exact: true }).waitFor()
    await reviewList.getByRole('searchbox', { name: 'Search pull requests' }).fill('draft pull request')
    await reviewList.getByRole('combobox', { name: 'Sort' }).selectOption('oldest')
    await reviewList.getByRole('button', { name: 'Search', exact: true }).click()
    await reviewList.locator('[data-pr-row]').getByText(/Verify the draft pull request/).waitFor()
    check('review search reopens a matching title and restores the selected sort from its address',
      new URL(clonePage.url()).searchParams.get('q') === 'draft pull request'
      && await reviewList.getByRole('combobox', { name: 'Sort' }).inputValue() === 'oldest')

    const beforeFilters = pullState()
    const filterLabel = { id: 413, node_id: 'LA_fixture_reporting', name: 'Release reporting', color: '298265' }
    writeFileSync(github.state, JSON.stringify({ ...beforeFilters,
      labelPages: [[filterLabel]], pulls: beforeFilters.pulls.map((pull: { number: number }) => pull.number === 1
        ? { ...pull, filterChecks: 'success', filterReview: 'none', labels: [filterLabel] } : pull),
    }))
    try {
      await clonePage.setViewportSize({ width: 390, height: 844 })
      const filters = reviewList.locator('[data-pr-filters]')
      const additionalFilters = filters.locator('[data-pr-additional-filters] > summary')
      const resultRow = reviewList.locator('[data-pr-row]').first()
      await clonePage.reload()
      await resultRow.getByText('Passing checks', { exact: true }).waitFor()
      check('the grouped phone list exposes author, label, and check state on its review row',
        await reviewList.getByRole('heading', { name: 'Authored 1' }).isVisible()
        && await resultRow.getByText('Release reporting', { exact: true }).isVisible()
        && await resultRow.getByText('fixture-user', { exact: true }).isVisible())
      await capture('pull-requests-grouped-phone-390x844', clonePage)
      await clonePage.setViewportSize({ width: 360, height: 800 })
      await clonePage.locator('html').evaluate(root => { root.style.zoom = '1.5' })
      try {
        const enlargedViews = filters.locator('[data-pr-views] > summary')
        check('enlarged list controls keep the saved views icons inside their trigger',
          await enlargedViews.evaluate((trigger) => {
            const bounds = trigger.getBoundingClientRect()
            return [...trigger.children].every((child) => {
              const icon = child.getBoundingClientRect()
              return !icon.width || icon.left >= bounds.left && icon.right <= bounds.right
            }) && bounds.right <= innerWidth
          }))
        await capture('pull-requests-grouped-zoom-360x800', clonePage)
      }
      finally {
        await clonePage.locator('html').evaluate(root => { root.style.zoom = '' })
        await clonePage.setViewportSize({ width: 390, height: 844 })
      }
      const initialRow = await resultRow.boundingBox()
      await additionalFilters.press('Enter')
      const openRow = await resultRow.boundingBox()
      check('the phone filters panel exposes list scope without shifting the results',
        await filters.getByRole('combobox', { name: 'Repository' }).isVisible()
        && Boolean(initialRow && openRow && Math.abs(initialRow.y - openRow.y) < 1))
      await filters.getByRole('combobox', { name: 'Profile' }).focus()
      await clonePage.keyboard.press('Escape')
      check('Escape closes pull request filters and returns focus to their trigger',
        await filters.getByRole('combobox', { name: 'Profile' }).isHidden()
        && await additionalFilters.evaluate(element => element === element.ownerDocument.activeElement))
      await additionalFilters.press('Enter')
      await filters.getByRole('combobox', { name: 'Draft', exact: true }).selectOption('only')
      await filters.getByRole('combobox', { name: 'Review', exact: true }).selectOption('none')
      await filters.getByRole('combobox', { name: 'Checks', exact: true }).selectOption('passing')
      await filters.getByLabel('Author', { exact: true }).fill('@me')
      await filters.getByRole('searchbox', { name: 'Find a label or author' }).fill('release reporting')
      await filters.getByRole('button', { name: 'Find labels', exact: true }).click()
      const match = filters.getByRole('checkbox', { name: 'Release reporting', exact: true })
      await match.check()
      await capture('pull-requests-advanced-filters-390x844', clonePage)
      await filters.getByRole('button', { name: 'Apply filters' }).click()
      await reviewList.locator('[data-pr-row]').getByText(/Verify the draft pull request/).waitFor()
      await reviewList.locator('[data-pr-row]').first().click()
      await clonePage.getByRole('link', { name: 'Timeline', exact: true }).click()
      const url = new URL(clonePage.url())
      check('advanced list filters combine and stay on the selected pull request across its tabs',
        url.searchParams.get('label') === filterLabel.name && url.searchParams.get('draft') === 'only'
        && url.searchParams.get('review') === 'none' && url.searchParams.get('checks') === 'passing' && url.searchParams.get('author') === '@me')

      await clonePage.getByRole('link', { name: 'Back to list', exact: true }).click()
      const search = filters.getByRole('searchbox', { name: 'Search pull requests' })
      const typed = 'draft:true author:me label:"Release reporting",unused -label:wip draft pull request'
      await search.fill(typed)
      await search.press('Enter')
      await clonePage.waitForURL(url => url.searchParams.get('q') === typed)
      await reviewList.locator('[data-pr-row]').getByText(/Verify the draft pull request/).waitFor()
      check('typed PR search handles OR labels, exclusions, viewer alias, and literal title words',
        await reviewList.locator('[data-pr-row]').count() === 1 && await search.inputValue() === typed)
      const savedViews = filters.locator('[data-pr-views] > summary')
      const saveView = filters.getByRole('button', { name: 'Save current view…', exact: true })
      const viewName = clonePage.getByRole('textbox', { name: 'Name', exact: true })
      const viewSave = clonePage.getByRole('button', { name: 'Save view', exact: true })
      await savedViews.press('ArrowDown')
      check('the saved PR views disclosure can be opened and navigated by keyboard',
        await saveView.evaluate(element => element === element.ownerDocument.activeElement))
      await saveView.press('Enter')
      await viewName.waitFor()
      check('opening the saved-view editor focuses its name field', await viewName.evaluate(element => element === element.ownerDocument.activeElement))
      await capture('pull-requests-save-view-390x844', clonePage)
      await viewName.fill('Draft release reviews')
      await viewSave.click()
      await reviewList.getByText('View saved.', { exact: true }).waitFor()
      await clonePage.reload()
      await savedViews.getByText('Draft release reviews', { exact: true }).waitFor()
      await savedViews.click()
      await capture('pull-requests-saved-views-390x844', clonePage)
      await saveView.click()
      await viewName.fill('draft release reviews')
      await viewSave.click()
      await clonePage.getByRole('dialog').getByText('A view with this name already exists.', { exact: true }).waitFor()
      await clonePage.keyboard.press('Escape')
      await viewName.waitFor({ state: 'hidden' })
      check('cancelling a duplicate saved name returns focus to the Views control',
        await savedViews.evaluate(element => element === element.ownerDocument.activeElement))

      await additionalFilters.press('Enter')
      const draftFilter = filters.getByRole('combobox', { name: 'Draft', exact: true })
      await draftFilter.selectOption('hide')
      await filters.getByRole('button', { name: 'Apply filters' }).click()
      await reviewList.getByText('No pull requests match these filters.', { exact: true }).waitFor()
      check('changing the draft menu removes its typed qualifier and preserves the rest of the PR search',
        await search.inputValue() === typed.replace('draft:true ', '')
        && new URL(clonePage.url()).searchParams.get('chooseDraft') === 'hide')
      await savedViews.getByText('Modified', { exact: true }).waitFor()
      await savedViews.click()
      await filters.getByRole('button', { name: 'Update saved view', exact: true }).click()
      await savedViews.getByText('Modified', { exact: true }).waitFor({ state: 'hidden' })
      await savedViews.click()
      await filters.getByRole('button', { name: 'Rename view…', exact: true }).click()
      await viewName.fill('Reviewed release drafts')
      await viewSave.click()
      await savedViews.getByText('Reviewed release drafts', { exact: true }).waitFor()

      await clonePage.setViewportSize({ width: 1280, height: 800 })
      await clonePage.goto(mergeReviewUrl)
      await clonePage.getByRole('link', { name: 'Timeline', exact: true }).click()
      const currentReview = clonePage.locator('[data-pr-workspace-detail]')
      const reviewInstance = await currentReview.elementHandle()
      await search.focus()
      await search.dispatchEvent('compositionstart')
      await search.fill('まだ編集中')
      await search.fill('draft:false unmatched live review')
      const liveResponse = clonePage.waitForResponse(response => new URL(response.url()).pathname === '/pull-requests/results' && response.ok())
      await search.dispatchEvent('compositionend')
      await liveResponse
      await reviewList.getByText('No pull requests match these filters.', { exact: true }).waitFor()
      const liveUrl = new URL(clonePage.url())
      const back = currentReview.getByRole('link', { name: 'Back to list', exact: true })
      const liveBack = new URL((await back.getAttribute('href'))!, liveUrl)
      check('search updates the PR results after composition while keeping focus and the open Timeline',
        liveUrl.searchParams.get('q') === 'draft:false unmatched live review'
        && liveUrl.searchParams.get('selectedUrl') === address && liveUrl.searchParams.get('tab') === 'timeline'
        && liveBack.searchParams.get('q') === liveUrl.searchParams.get('q')
        && await search.evaluate(element => element === element.ownerDocument.activeElement)
        && await reviewInstance?.evaluate(element => element.isConnected) === true)
      await capture('pull-requests-live-search-1280x800', clonePage)
      await search.press('Escape')
      await clonePage.waitForURL(url => !url.searchParams.has('q'))
      check('Escape clears live PR search while retaining its selected review', await search.inputValue() === ''
        && new URL(clonePage.url()).searchParams.get('selectedUrl') === address)
      await search.fill('preserve an independently selected request')
      await search.press('Enter')
      await clonePage.waitForURL(url => url.searchParams.get('q') === 'preserve an independently selected request')
      check('submitting a pull request search preserves an independently selected request',
        new URL(clonePage.url()).searchParams.get('selectedUrl') === address
        && new URL(clonePage.url()).searchParams.get('tab') === 'timeline')
      await savedViews.click()
      await filters.getByRole('button', { name: 'Reviewed release drafts', exact: true }).click()
      await savedViews.getByText('Reviewed release drafts', { exact: true }).waitFor()
      const appliedView = new URL(clonePage.url()).searchParams
      check('applying a saved PR view restores the updated filters and keeps the selected request and tab',
        appliedView.get('selectedUrl') === address && appliedView.get('tab') === 'timeline'
        && appliedView.get('q') === typed.replace('draft:true ', '') && appliedView.get('draft') === 'hide'
        && appliedView.get('sort') === 'oldest' && !appliedView.has('page'))
      await savedViews.click()
      await filters.getByRole('button', { name: 'Delete view', exact: true }).click()
      await reviewList.getByText('View deleted.', { exact: true }).waitFor()
      await clonePage.reload()
      await savedViews.getByText('Views', { exact: true }).waitFor()
      check('deleting a saved view clears the local preset and leaves its applied filters in place',
        await search.inputValue() === typed.replace('draft:true ', ''))
    }
    finally { writeFileSync(github.state, JSON.stringify(beforeFilters)) }

    try {
      const original = beforeFilters.pulls.find((pull: { number: number }) => pull.number === 1)
      writeFileSync(github.state, JSON.stringify({ ...beforeFilters, pulls: [
        ...beforeFilters.pulls,
        ...Array.from({ length: 23 }, (_, index) => ({ ...original, number: index + 101,
          title: 'Continuation pull request ' + index, user: { login: 'another-author' },
          html_url: original.html_url.replace(/1$/u, String(index + 101)),
          updated_at: new Date(Date.UTC(2026, 11, index + 1)).toISOString(),
        })),
      ] }))
      await clonePage.goto(mergeReviewUrl)
      await reviewList.getByLabel('Saved pull request views').waitFor()
      const nextPage = reviewList.getByRole('link', { name: 'Load more pull requests' })
      const selectedReview = await clonePage.locator('[data-pr-workspace-detail]').elementHandle()
      const firstResult = await reviewList.locator('[data-pr-entry]').first().elementHandle()
      const addressBeforeAppend = clonePage.url()
      const firstPageRowCount = await reviewList.locator('[data-pr-entry]').count()
      const pageResult = clonePage.waitForResponse(response => {
        const url = new URL(response.url())
        return url.pathname === '/pull-requests/results' && url.searchParams.get('page') === '2'
      })
      await nextPage.press('Enter')
      const response = await pageResult
      const responseBody = await response.json().catch(() => null)
      try { await reviewList.getByText('Continuation pull request 0', { exact: false }).waitFor({ timeout: 8_000 }) }
      catch (error) {
        console.error('Pull request continuation', { status: response.status(), partial: responseBody?.partial,
          rows: responseBody?.html?.match(/data-pr-entry=/gu)?.length, statusText: await reviewList.getByRole('status').allTextContents() })
        throw error
      }
      const loadedKeys = await reviewList.locator('[data-pr-entry]').evaluateAll(rows => rows.map(row => row.getAttribute('data-pr-entry')))
      const continuedAddress = new URL(clonePage.url())
      const loadedThrough = continuedAddress.searchParams.get('through')
      continuedAddress.searchParams.delete('through')
      check('loading more PRs appends unique rows and leaves the open review mounted',
        loadedKeys.length > firstPageRowCount && new Set(loadedKeys).size === loadedKeys.length
        && await reviewList.locator('[data-pr-entry]').filter({ hasText: 'Continuation pull request' }).count() === 23
        && loadedThrough === '2' && continuedAddress.href === addressBeforeAppend
        && await selectedReview?.evaluate(node => node.isConnected) === true
        && await firstResult?.evaluate(node => node.isConnected) === true)
      await reviewList.locator('[data-pr-entry]').last().evaluate(row => row.scrollIntoView({ block: 'center' }))
      check('revealing appended PR rows keeps the workspace header in the viewport',
        await clonePage.locator('[data-pr-workspace-header]').evaluate(header => scrollY === 0 && header.getBoundingClientRect().top === 0))
      await capture('pull-requests-load-more-1280x800', clonePage)
      const olderRequest = reviewList.locator('[data-pr-entry]').filter({ hasText: 'Continuation pull request 0' })
      await olderRequest.scrollIntoViewIfNeeded()
      const firstVisible = await reviewList.evaluate(list => {
        const top = list.getBoundingClientRect().top
        return [...list.querySelectorAll('[data-pr-entry]')].find(row => row.getBoundingClientRect().bottom > top)?.getAttribute('data-pr-entry')
      })
      const listRestored = () => reviewList.evaluate((list, key) => {
        const anchor = [...list.querySelectorAll('[data-pr-entry]')].find(row => row.getAttribute('data-pr-entry') === key)
        const bounds = list.getBoundingClientRect()
        const row = anchor?.getBoundingClientRect()
        return Boolean(row && row.bottom > bounds.top && row.top < bounds.bottom)
      }, firstVisible)
      const beforeReview = clonePage.url()
      await olderRequest.press('Enter')
      await clonePage.getByRole('heading', { name: 'Continuation pull request 0', exact: true }).waitFor()
      await reviewList.getByLabel('Saved pull request views').waitFor()
      check('opening an appended pull request restores the loaded keys',
        new URL(clonePage.url()).searchParams.get('through') === '2'
        && JSON.stringify(await reviewList.locator('[data-pr-entry]').evaluateAll(rows => rows.map(row => row.getAttribute('data-pr-entry')))) === JSON.stringify(loadedKeys))
      check('opening an appended pull request keeps the previous scroll anchor visible',
        await listRestored())
      await capture('pull-requests-restored-list-1280x800', clonePage)
      await clonePage.goBack()
      await clonePage.waitForURL(beforeReview)
      await reviewList.getByLabel('Saved pull request views').waitFor()
      check('browser Back restores loaded PRs and keeps the prior scroll anchor visible',
        await reviewList.locator('[data-pr-entry]').count() === loadedKeys.length && await listRestored())
    }
    finally { writeFileSync(github.state, JSON.stringify(beforeFilters)) }

    github.configureMerge('ready', ['MERGE', 'SQUASH'])
    await clonePage.setViewportSize({ width: 390, height: 844 })
    if (clonePage.url() === mergeReviewUrl) await clonePage.reload({ waitUntil: 'domcontentloaded' })
    else await clonePage.goto(mergeReviewUrl, { waitUntil: 'domcontentloaded' })
    await actions.click()
    await lifecycleMenu.getByRole('button', { name: 'Ready for review', exact: true }).click()
    await lifecycleStatus('Pull request is ready for review.').waitFor()
    github.configureBranchUpdate(1)
    await clonePage.reload({ waitUntil: 'domcontentloaded' })
    const branchTrigger = clonePage.getByRole('button', { name: 'Update branch', exact: true })
    const branchPanel = clonePage.getByRole('form', { name: 'Update pull request branch', exact: true })
    await branchTrigger.press('Enter')
    await branchPanel.waitFor()
    await capture('pull-requests-update-branch-390x844', clonePage)
    await clonePage.keyboard.press('Escape')
    check('the branch update panel returns focus to the branch control without writing',
      await branchPanel.isHidden()
      && await branchTrigger.evaluate(element => element === document.activeElement)
      && pullState().branchWrites === undefined)
    await branchTrigger.press('Enter')
    await branchPanel.getByRole('radio', { name: 'Update with rebase' }).check()
    github.configureLifecycle('lost-response')
    await branchPanel.getByRole('button', { name: 'Confirm update', exact: true }).click()
    await lifecycleStatus('Branch is up to date with the reviewed base.').waitFor()
    github.configureLifecycle('normal')
    check('updating the branch reloads Code without carrying the old diff anchor',
      pullState().branchWrites.length === 1 && pullState().branchWrites[0].updateMethod === 'REBASE'
      && new URL(clonePage.url()).searchParams.get('tab') === 'code'
      && !new URL(clonePage.url()).searchParams.has('reviewLine') && await branchTrigger.isHidden())
    const mergeTrigger = clonePage.getByRole('button', { name: 'Merge pull request', exact: true })
    const mergeConfirmation = clonePage.getByRole('form', { name: 'Merge pull request', exact: true })
    await mergeTrigger.press('Enter')
    await mergeConfirmation.waitFor()
    await capture('pull-requests-merge-method-390x844', clonePage)
    await clonePage.keyboard.press('Escape')
    check('merging requires confirmation and Escape returns focus to the merge action',
      await mergeConfirmation.isHidden()
      && await mergeTrigger.evaluate(element => element === document.activeElement)
      && pullState().mergeWrites === undefined)
    await mergeTrigger.press('Enter')
    await mergeConfirmation.getByRole('radio', { name: 'Squash and merge' }).check()
    github.configureLifecycle('unconfirmed')
    await mergeConfirmation.getByRole('button', { name: 'Confirm', exact: true }).click()
    await checkLifecycle.waitFor()
    github.revealLifecycle()
    await checkLifecycle.click()
    await lifecycleStatus('Pull request merged.').waitFor()
    check('merge recovery retains the chosen method and never submits a second GitHub mutation',
      pullState().mergeWrites.length === 1 && pullState().mergeWrites[0].input.mergeMethod === 'SQUASH'
      && await clonePage.locator('strong[data-pr-state="Merged"]').isVisible() && await actions.isHidden())

    const mergedPullUrl = clonePage.url()
    github.configureRevert('unconfirmed')
    await clonePage.reload({ waitUntil: 'domcontentloaded' })
    const revert = lifecycleMenu.getByRole('button', { name: 'Revert changes', exact: true })
    const revertPanel = clonePage.getByRole('form', { name: 'Open a revert pull request?', exact: true })
    await actions.press('Enter')
    await revert.press('Enter')
    await revertPanel.waitFor()
    await capture('pull-requests-revert-confirmation-390x844', clonePage)
    await clonePage.keyboard.press('Escape')
    check('Escape closes the revert confirmation and returns focus without writing',
      await revertPanel.isHidden() && await revert.evaluate(element => document.activeElement === element)
      && pullState().revertWrites === undefined)
    await revert.press('Enter')
    await revertPanel.getByRole('button', { name: 'Create revert PR', exact: true }).click()
    await checkLifecycle.waitFor()
    github.configureRevert('normal')
    await checkLifecycle.click()
    await lifecycleStatus('Revert pull request opened on GitHub.').waitFor()
    check('revert recovery opens the new PR without replacing or reopening the merged source',
      pullState().revertWrites.length === 1 && Boolean(pullState().pulls[0].merged_at)
      && new URL(clonePage.url()).searchParams.get('selectedUrl') === pullState().pulls[1].html_url
      && await clonePage.locator('strong[data-pr-state="Open"]').isVisible())

    github.configureBranchDeletion({ mode: 'lost-response' })
    await clonePage.goto(mergedPullUrl, { waitUntil: 'domcontentloaded' })
    await clonePage.getByRole('link', { name: 'Summary', exact: true }).click()
    const deleteBranch = lifecycleMenu.getByRole('button', { name: 'Delete branch', exact: true })
    const deleteBranchPanel = clonePage.getByRole('dialog', { name: 'Delete remote branch?', exact: true })
    await actions.press('Enter')
    await deleteBranch.press('Enter')
    await deleteBranchPanel.waitFor()
    await capture('pull-requests-delete-branch-390x844', clonePage)
    const focusesCancel = await deleteBranchPanel.getByRole('button', { name: 'Cancel', exact: true })
      .evaluate(element => element === document.activeElement)
    const modal = await deleteBranchPanel.evaluate(element => element.matches(':modal'))
    await clonePage.keyboard.press('Escape')
    await clonePage.waitForFunction(() => document.activeElement?.matches('[data-pr-delete-branch-trigger], [data-pr-lifecycle-trigger]'))
    check('deleting a branch focuses Cancel and Escape returns focus without writing', focusesCancel
      && modal && await deleteBranchPanel.isHidden() && pullState().deleteBranchWrites === undefined)
    if (!await deleteBranch.isVisible()) await actions.press('Enter')
    await deleteBranch.evaluate((element) => {
      Reflect.deleteProperty(HTMLButtonElement.prototype, 'commandForElement')
      element.removeAttribute('command')
    })
    await deleteBranch.press('Enter')
    await deleteBranchPanel.waitFor()
    check('older WebViews can open the modal from the pull request summary', await deleteBranchPanel.evaluate(element => element.matches(':modal')))
    await deleteBranchPanel.getByRole('button', { name: 'Delete branch', exact: true }).click()
    await checkLifecycle.waitFor()
    github.configureBranchDeletion({ mode: 'normal' })
    await checkLifecycle.click()
    await lifecycleStatus('Branch deleted on GitHub.').waitFor()
    await actions.press('Enter')
    check('branch deletion recovers the remote result without a second write and keeps the merged PR selected',
      pullState().deleteBranchWrites.length === 1 && pullState().branchDeletion.target === null
      && await deleteBranch.isHidden() && await revert.isVisible()
      && await clonePage.locator('strong[data-pr-state="Merged"]').isVisible())

    const workflowState = pullState()
    const fork = { full_name: 'fixture-fork/notebook', node_id: 'fixture-repo:fixture-fork/notebook' }
    const openPull = workflowState.pulls[1]
    openPull.head.repo = fork
    delete workflowState.branchDeletion
    workflowState.workflowRuns = [41, 42].map(id => ({ id, run_attempt: 1, name: 'Review workflow ' + id, event: 'pull_request',
      status: 'completed', conclusion: 'action_required', head_branch: openPull.head.ref, head_sha: openPull.head.sha,
      repository: openPull.base.repo, head_repository: fork, pull_requests: [] }))
    workflowState.workflowApprovalStatus = 201
    workflowState.workflowDropReply = 41
    writeFileSync(github.state, JSON.stringify(workflowState))
    const workflowUrl = new URL(clonePage.url())
    workflowUrl.searchParams.set('selectedUrl', openPull.html_url)
    workflowUrl.searchParams.set('state', 'open')
    workflowUrl.searchParams.delete('lifecycleResult')
    workflowUrl.hash = ''
    await clonePage.goto(workflowUrl.href, { waitUntil: 'domcontentloaded' })
    const approve = clonePage.getByRole('button', { name: 'Approve workflows to run', exact: true })
    const approvalPanel = clonePage.getByRole('form', { name: 'Run the reviewed workflows?', exact: true })
    await approve.focus()
    await approve.press('Enter')
    await approvalPanel.waitFor()
    await capture('pull-requests-workflow-approval-390x844', clonePage)
    await approvalPanel.getByRole('button', { name: 'Cancel', exact: true }).press('Escape')
    await approvalPanel.waitFor({ state: 'hidden' })
    await clonePage.waitForFunction(() => document.activeElement?.matches('[data-pr-workflow-approval-trigger]'))
    check('workflow approval cancellation returns focus without writing',
      await approve.evaluate(element => document.activeElement === element) && pullState().workflowApprovalPosts === undefined)
    await approve.press('Enter')
    await approvalPanel.getByRole('button', { name: 'Confirm approval', exact: true }).click()
    const recoverApproval = clonePage.getByRole('button', { name: 'Check GitHub and finish approval', exact: true })
    await recoverApproval.waitFor()
    await recoverApproval.click()
    await lifecycleStatus('Reviewed workflows are no longer awaiting approval.').waitFor()
    check('workflow recovery finishes only the reviewed runs and never repeats the accepted approval',
      JSON.stringify(pullState().workflowApprovalPosts) === '[41,42]' && await approve.isHidden())

    const labelState = pullState()
    const oldLabel = { id: 11, name: 'Legacy/needs review', color: 'aa2222', archived_at: '2026-11-10T15:00:00Z' }
    const reportLabel = { id: 31, name: 'Report & analysis', color: '298265', description: 'Check the exported CSV' }
    const concurrentLabel = { id: 41, name: 'Accessibility', color: 'cc5599' }
    const person = { id: 'user:accessibility', __typename: 'User', login: 'accessibility-reviewer' }
    const bot = { id: 'bot:review-check', __typename: 'Bot', login: 'review-check[bot]' }
    const team = { id: 'team:docs', __typename: 'Team', slug: 'docs-and-release-reviewers', name: 'Docs and release reviewers' }
    const candidate = { id: 'user:dorian', __typename: 'User', login: 'dorian', name: 'Dorian Reviewer' }
    labelState.pulls[1].labels = [oldLabel]
    labelState.pulls[1].requested_reviewers = [person, bot]
    labelState.pulls[1].requested_teams = [team]
    labelState.pulls[1].reviewerNodes = [person, bot, team]
    const verdict = (id: number, login: string, state: string, commit: string) =>
      ({ id, user: { login }, state, commit_id: commit, submitted_at: '2026-11-01T14:00:00Z' })
    const reviewedHead = labelState.pulls[1].head.sha
    labelState.pulls[1].reviewDecision = 'REVIEW_REQUIRED'
    labelState.pulls[1].latestReviews = [
      { state: 'COMMENTED', author: { login: 'release-commenter' } },
      { state: 'DISMISSED', author: { login: 'dismissed-reviewer' } },
    ]
    labelState.reviewOutcomePages = [[
      verdict(101, person.login, 'APPROVED', 'd'.repeat(40)),
      verdict(102, 'dismissed-reviewer', 'APPROVED', reviewedHead),
    ], [
      verdict(103, 'dismissed-reviewer', 'DISMISSED', reviewedHead),
      verdict(104, 'release-approver', 'APPROVED', reviewedHead),
      verdict(105, person.login, 'COMMENTED', reviewedHead),
    ]]
    labelState.reviewerPeople = [person, candidate]
    labelState.reviewerPageSize = 1
    labelState.labelPages = [[oldLabel, concurrentLabel], [reportLabel]]
    labelState.labelPermission = 'WRITE'
    writeFileSync(github.state, JSON.stringify(labelState))
    await clonePage.goto(workflowUrl.href, { waitUntil: 'domcontentloaded' })
    const changeLabels = clonePage.getByRole('link', { name: 'Change labels', exact: true })
    const reviewers = clonePage.getByRole('region', { name: 'Reviewers', exact: true })
    await reviewers.waitFor()
    check('the Summary joins pending people, bots, teams, and completed outcomes before labels',
      await reviewers.getByRole('listitem').count() === 6
      && await reviewers.getByText('@accessibility-reviewer', { exact: true }).isVisible()
      && await reviewers.getByText('@review-check[bot]', { exact: true }).isVisible()
      && await reviewers.getByText('Team', { exact: true }).isVisible()
      && await reviewers.evaluate(section => section.nextElementSibling?.hasAttribute('data-pr-label-section') === true))
    check('the Summary distinguishes branch policy, current approvals, older approvals, and dismissed reviews',
      await reviewers.getByText('Review required', { exact: true }).isVisible()
      && await reviewers.getByText('Approved on an earlier commit', { exact: true }).isVisible()
      && await reviewers.getByText('Approved', { exact: true }).isVisible()
      && await reviewers.getByText('Review requested again', { exact: true }).isVisible()
      && await reviewers.getByRole('listitem').filter({ hasText: '@dismissed-reviewer' }).getByText('Review dismissed', { exact: true }).isVisible()
      && await reviewers.getByRole('listitem').filter({ hasText: '@release-commenter' }).getByText('Commented', { exact: true }).isVisible()
      && await clonePage.evaluate(() => document.documentElement.scrollWidth === innerWidth))
    await capture('pull-requests-reviewers-390x844', clonePage)
    const changeReviewers = clonePage.getByRole('link', { name: 'Change reviewers', exact: true })
    const picker = clonePage.getByRole('form', { name: 'Change reviewers', exact: true })
    const docsTeam = picker.getByRole('checkbox', { name: /docs-and-release-reviewers/u })
    const searchReviewers = picker.getByRole('searchbox', { name: 'Search reviewers' })
    const dorian = picker.getByRole('checkbox', { name: /Dorian Reviewer/u })
    await changeReviewers.click()
    await docsTeam.uncheck()
    await searchReviewers.fill('dorian')
    await searchReviewers.press('Enter')
    await dorian.waitFor()
    check('GitHub reviewer search reaches beyond the first page and retains the staged withdrawal',
      !(await docsTeam.isChecked()) && pullState().reviewerWrites === undefined)
    await capture('pull-requests-reviewer-picker-390x844', clonePage)
    await picker.getByRole('link', { name: 'Cancel', exact: true }).click()
    await changeReviewers.click()
    check('canceling reviewer edits leaves the existing team requested', await docsTeam.isChecked() && pullState().reviewerWrites === undefined)
    await docsTeam.uncheck()
    await searchReviewers.fill('dorian')
    await picker.getByRole('button', { name: 'Search GitHub', exact: true }).click()
    await dorian.check()
    const reviewInterrupted = pullState()
    reviewInterrupted.reviewerDropResponse = team.id
    writeFileSync(github.state, JSON.stringify(reviewInterrupted))
    await picker.getByRole('button', { name: 'Save reviewers', exact: true }).click()
    await clonePage.getByRole('button', { name: 'Check GitHub and finish', exact: true }).click()
    await reviewers.getByRole('status').filter({ hasText: 'Review requests updated on GitHub.' }).waitFor()
    const reviewed = pullState()
    check('reviewer recovery issues only the reviewed team withdrawal and person request',
      JSON.stringify(reviewed.reviewerWrites.map(([, method, id]: [number, string, string]) => [method, id])) === '[["DELETE","team:docs"],["POST","user:dorian"]]'
      && await reviewers.getByText('@dorian', { exact: true }).isVisible())
    reviewed.labelPermission = 'TRIAGE'
    writeFileSync(github.state, JSON.stringify(reviewed))
    await clonePage.reload({ waitUntil: 'domcontentloaded' })
    check('triage still edits labels and hides repository-write review requests', await changeLabels.isVisible() && await changeReviewers.isHidden())
    const labelEditor = clonePage.getByRole('form', { name: 'Change labels', exact: true })
    const labelSearch = labelEditor.getByRole('searchbox', { name: 'Search labels', exact: true })
    const legacyLabel = labelEditor.getByRole('checkbox', { name: /Legacy\/needs review/u })
    const newLabel = labelEditor.getByRole('checkbox', { name: /Report & analysis/u })
    await changeLabels.click()
    await legacyLabel.uncheck()
    await labelSearch.fill('exported')
    await newLabel.waitFor()
    await legacyLabel.waitFor({ state: 'hidden' })
    await capture('pull-requests-labels-390x844', clonePage)
    await labelSearch.press('Enter')
    check('label search retains an unchecked reviewed choice and fits on the phone',
      await labelEditor.locator('input[name=label][value="11"]').evaluate((node: HTMLInputElement) => node.closest('label')?.hidden && !node.checked) === true
      && await clonePage.evaluate(() => document.documentElement.scrollWidth === innerWidth) && pullState().labelWrites === undefined)
    await labelEditor.getByRole('link', { name: 'Cancel', exact: true }).click()
    await changeLabels.click()
    check('closing the label editor cancels draft changes without writing', await legacyLabel.isChecked() && pullState().labelWrites === undefined)
    await legacyLabel.uncheck()
    await newLabel.check()
    const concurrent = pullState()
    concurrent.pulls[1].labels.push(concurrentLabel)
    concurrent.labelDropResponse = reportLabel.id
    writeFileSync(github.state, JSON.stringify(concurrent))
    await labelEditor.getByRole('button', { name: 'Save labels', exact: true }).click()
    const recoverLabels = clonePage.getByRole('button', { name: 'Check GitHub and finish labels', exact: true })
    await recoverLabels.waitFor()
    await recoverLabels.click()
    await clonePage.getByRole('status').filter({ hasText: 'Labels updated on GitHub.' }).waitFor()
    const finalLabels = pullState()
    check('label recovery preserves a concurrent label and mutates only the reviewed add and removal once',
      JSON.stringify(finalLabels.labelWrites.map(([, method, id]: [number, string, number]) => [method, id])) === '[["POST",31],["DELETE",11]]'
      && JSON.stringify(finalLabels.pulls[1].labels.map((label: { id: number }) => label.id)) === '[41,31]')

    const farLabel = { id: 13_000_042_107, node_id: 'LA_fixture_far', name: 'Long-range release', color: '225588', description: 'Review the release record' }
    finalLabels.labelPages = [[reportLabel, concurrentLabel], ...Array.from({ length: 11 }, (_, page) =>
      Array.from({ length: 100 }, (_, i) => ({ id: 10_000 + 100 * page + i, name: 'Queue item ' + (100 * page + i), color: '118899' }))), [farLabel]]
    writeFileSync(github.state, JSON.stringify(finalLabels))
    await changeLabels.click()
    await labelEditor.getByText('More labels are available on GitHub. Refine your search.', { exact: true }).waitFor()
    const far = labelEditor.getByRole('checkbox', { name: /Long-range release/u })
    check('a large repository opens a bounded label picker with a host search', await far.isHidden()
      && await labelEditor.getByRole('button', { name: 'Search GitHub', exact: true }).isVisible())
    await newLabel.uncheck()
    await labelSearch.fill('Long-range release')
    await labelSearch.press('Enter')
    await far.waitFor()
    check('GitHub label search finds an off-catalog label and retains the staged removal', !await newLabel.isChecked()
      && pullState().labelWrites.length === 2)
    await capture('pull-requests-large-label-search-390x844', clonePage)
    await far.check()
    await labelEditor.getByRole('button', { name: 'Save labels', exact: true }).click()
    await clonePage.getByRole('status').filter({ hasText: 'Labels updated on GitHub.' }).waitFor()
    check('saving searched labels applies only their reviewed additions and removals',
      JSON.stringify(pullState().labelWrites.slice(2).map(([, method, id]: [number, string, number]) => [method, id])) === `[["POST",${farLabel.id}],["DELETE",31]]`
      && JSON.stringify(pullState().pulls[1].labels.map((label: { id: number }) => label.id)) === `[41,${farLabel.id}]`)
  }
  finally { if (toolPath === undefined) delete process.env.PATH; else process.env.PATH = toolPath }

}
finally {
  delayGit = false
  networkGate.resolve()
  gitFixture.stop(true)
  for (const [key, value] of [['GIT_CONFIG_COUNT', gitConfigCount], [gitConfigKey, oldKey], [gitConfigValue, oldValue]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await cloneContext.close()
}

// 16. Project scope: one host, two projects, and an agent pinned to one of
// them. The project left alone is as much of the point as the pinned one, so
// the host's own answer is set first and both projects are read against it.
//
// On its own page: the main one is still mounted on a live thread from an
// earlier section, and the events arriving there navigate it out from under a
// goto.
const scopePage = await browserContext.newPage()
scopePage.on('pageerror', error => pageErrors.push(error.message))
await scopePage.setViewportSize({ width: 1280, height: 800 })
const scopedServiceFolder = join(driveRoot, 'scoped-service')
const scopedDocsFolder = join(driveRoot, 'scoped-docs')
mkdirSync(scopedServiceFolder)
mkdirSync(scopedDocsFolder)
// Earlier sections leave the host default wherever they finished with it, and
// a command that changes nothing is refused, so this only moves it if needed.
if (harness.engine.current.settings.defaultDriver !== 'claude')
  await harness.engine.dispatch({ id: 'project-scope-host', at: Date.now(), command: { type: 'settings.update', changes: { defaultDriver: 'claude' } } })
for (const [id, path] of [['project-scope-service', scopedServiceFolder], ['project-scope-docs', scopedDocsFolder]] as const) {
  await harness.engine.dispatch({ id, at: Date.now(), command: { type: 'workspace.add', profileId: derivedId(ledgerProfile), path } })
  await harness.engine.dispatch({ id: `${id}-trust`, at: Date.now(), command: { type: 'workspace.trust', workspaceId: derivedId(id), trusted: true } })
}
const scopedService = derivedId('project-scope-service')
const scopedDocs = derivedId('project-scope-docs')

const scopeSettings = scopePage.getByRole('dialog', { name: 'Settings' })
const projectAgent = scopePage.locator('#settings-project-driver')
const projectAgentNote = scopePage.locator('[data-project-settings-note]')
const composerAgent = scopePage.locator('[data-model-picker-trigger]')

/** The project's own answer as the log holds it, or undefined for inherited. */
const pinnedAgent = (workspaceId: number): string | undefined =>
  harness.engine.current.workspaces.get(workspaceId)?.settings?.defaultDriver

async function waitForPinnedAgent(workspaceId: number, driver: string | undefined, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pinnedAgent(workspaceId) === driver) return true
    await scopePage.waitForTimeout(50)
  }
  return false
}

/**
 * Open a project's draft page.
 *
 * Committed rather than loaded: the island replaces the address once it has
 * picked a profile, and that navigation aborts a goto still waiting on load.
 */
async function openProjectDraft(workspaceId: number): Promise<void> {
  await scopePage.goto(`${baseUrl}/?workspace=${workspaceId}`, { waitUntil: 'commit' })
  await composerAgent.waitFor({ timeout: 8000 })
}

async function openProjectGeneral(workspaceId: number): Promise<void> {
  await openProjectDraft(workspaceId)
  await pressChord('Meta+,', scopePage)
  await scopeSettings.waitFor({ state: 'visible', timeout: 4000 })
  await scopePage.waitForURL(url => url.pathname === '/settings/general')
}

await openProjectGeneral(scopedService)
check('a project that pins nothing says it follows the host, and names itself',
  await projectAgent.inputValue() === ''
  && ((await projectAgentNote.textContent()) ?? '').includes('scoped-service')
  && ((await projectAgentNote.textContent()) ?? '').includes('follows the host default'))

await projectAgent.selectOption('codex')
check('pinning an agent reaches the log as the project\'s answer and leaves the host alone',
  await waitForPinnedAgent(scopedService, 'codex')
  && harness.engine.current.settings.defaultDriver === 'claude'
  && pinnedAgent(scopedDocs) === undefined)
await capture('settings-project-agent-desktop', scopePage)

// Where the setting actually bites: the agent the project's next thread starts
// with. A draft already open keeps the agent it was composed with, which is
// why this is read on a fresh draft rather than on the one behind the sheet.
await openProjectDraft(scopedService)
check('the next thread in that project starts with the pinned agent',
  ((await composerAgent.textContent()) ?? '').includes('Codex'))

await openProjectGeneral(scopedDocs)
check('the other project is untouched and follows the host',
  await projectAgent.inputValue() === ''
  && ((await projectAgentNote.textContent()) ?? '').includes('scoped-docs'))
await openProjectDraft(scopedDocs)
check('a project that pinned nothing still starts with the host agent',
  ((await composerAgent.textContent()) ?? '').includes('Claude'))

// Rendered, not hydrated: the pin is in the page the host serves, so the row
// is right on first paint rather than correcting itself a moment later. The
// settings route takes its project from the address it will return to, which
// is how the sheet itself links to it.
const scopedServiceSettings = `${baseUrl}/settings/general?from=${encodeURIComponent(`/?workspace=${scopedService}`)}`
await scopePage.goto(scopedServiceSettings, { waitUntil: 'commit' })
await scopeSettings.waitFor({ state: 'visible', timeout: 8000 })
check('a reload shows the pinned agent before the island hydrates',
  await projectAgent.inputValue() === 'codex'
  && ((await projectAgentNote.textContent()) ?? '').includes('Only sessions in'))

await projectAgent.selectOption('')
check('handing the agent back to the host forgets the project override entirely',
  await waitForPinnedAgent(scopedService, undefined)
  && harness.engine.current.workspaces.get(scopedService)?.settings === undefined
  && harness.engine.current.settings.defaultDriver === 'claude')
await openProjectDraft(scopedService)
check('the project follows the host again once it pins nothing',
  ((await composerAgent.textContent()) ?? '').includes('Claude'))

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
