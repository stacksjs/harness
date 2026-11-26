import type { CombinedWorktreeIntent } from '@harness/contract'
import { lstat, open, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { projectWorktreeLayout } from './project-repositories'

type Phase = 'create' | 'remove'
type Outcome = 'started' | 'complete' | 'failed'
const commandTimeoutMs = 10 * 60 * 1000
const projectRuns = new Map<string, Promise<void>>()

function marker(intent: CombinedWorktreeIntent, phase: Phase, outcome: Outcome): string {
  return join(dirname(intent.path), `.harness-layout-${phase}-${outcome}`)
}

async function hasMarker(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size !== 0) throw new Error('The project layout receipt is unavailable.')
    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function worktreeLayoutOutcome(intent: CombinedWorktreeIntent, phase: Phase): Promise<Outcome | null> {
  if (await hasMarker(marker(intent, phase, 'complete'))) return 'complete'
  if (await hasMarker(marker(intent, phase, 'failed'))) return 'failed'
  return await hasMarker(marker(intent, phase, 'started')) ? 'started' : null
}

async function recordOutcome(intent: CombinedWorktreeIntent, phase: Phase, outcome: Outcome): Promise<void> {
  const file = await open(marker(intent, phase, outcome), 'wx', 0o600)
  try { await file.sync() }
  finally { await file.close() }
}

export async function clearWorktreeLayoutReceipts(intent: CombinedWorktreeIntent): Promise<void> {
  for (const phase of ['create', 'remove'] as const) {
    for (const outcome of ['complete', 'failed', 'started'] as const) {
      const path = marker(intent, phase, outcome)
      if (await hasMarker(path)) await unlink(path)
    }
  }
}

function invokeLayoutCommand(command: string, intent: CombinedWorktreeIntent, phase: Phase, signal?: AbortSignal): Promise<void> {
  const env = { ...process.env }
  // Git may have started the host from a hook in an entirely different checkout.
  for (const key of Object.keys(env)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|PREFIX|QUARANTINE_PATH|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/iu.test(key))
      delete env[key]
  }
  Object.assign(env, {
    T3_PROJECT_ROOT: intent.repository,
    T3_WORKTREE_ROOT: dirname(intent.path),
    T3_WORKTREE_PROJECT_PATH: intent.path,
    T3_WORKTREE_BRANCH: intent.branch,
    T3_WORKTREE_BASE: intent.layout?.baseBranch ?? '',
    T3_WORKTREE_REPOSITORIES: intent.checkouts.filter(checkout => checkout.key).map(checkout => checkout.repository).join('\n'),
  })
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32'
    const child = spawn(command, [], { shell: true, cwd: intent.repository, env, stdio: 'ignore', detached })
    let interrupted = ''
    const terminate = (reason: string) => {
      if (interrupted) return
      interrupted = reason
      if (!child.pid) return
      try {
        if (detached) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      }
      catch { /* The child raced cancellation and will report its exit. */ }
    }
    const abort = () => terminate(`Project worktree ${phase} was interrupted.`)
    const timer = setTimeout(() => terminate(`Project worktree ${phase} timed out after 10 minutes.`), commandTimeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.once('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (interrupted || code !== 0)
        reject(new Error(interrupted || `Project worktree ${phase} failed with exit status ${code ?? 'unknown'}.`))
      else resolve()
    })
    child.once('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new Error(`Could not start the project’s worktree ${phase} command.`))
    })
  })
}

/** Serialize commands for a project and remember attempts that may have side effects. */
export async function runWorktreeLayout(intent: CombinedWorktreeIntent, phase: Phase,
  authorize: () => boolean, verify?: () => Promise<boolean>, signal?: AbortSignal): Promise<void> {
  if (!intent.layout) return
  const previous = projectRuns.get(intent.repository)
  const run = Promise.resolve(previous).then(async () => {
    const state = await worktreeLayoutOutcome(intent, phase)
    if (state === 'complete') return
    if (state === 'started')
      throw new Error(`Project worktree ${phase} has an uncertain outcome. Inspect the reserved folder and command before starting another worktree.`)
    if (state === 'failed')
      throw new Error(`Project worktree ${phase} failed previously. Inspect the reserved folder and fix the project command.`)
    if (!authorize() || signal?.aborted) throw new Error('Run the project worktree command from the trusted Harness host.')
    const layout = await projectWorktreeLayout(intent.repository)
    if (layout?.fingerprint !== intent.layout?.fingerprint)
      throw new Error('The worktree layout in t3.json changed after reservation. Restore it or start a new worktree.')
    const command = layout?.[phase]
    if (!command) return
    await recordOutcome(intent, phase, 'started')
    try {
      if (!authorize() || signal?.aborted) throw new Error('The project worktree command was canceled before starting.')
      await invokeLayoutCommand(command, intent, phase, signal)
      if (verify && !await verify())
        throw new Error('The project layout must create each selected Git worktree on the reserved branch and base.')
    }
    catch (error) {
      await recordOutcome(intent, phase, 'failed')
      throw error
    }
    await recordOutcome(intent, phase, 'complete')
  })
  const tail = run.catch(() => {})
  projectRuns.set(intent.repository, tail)
  try { await run }
  finally {
    if (projectRuns.get(intent.repository) === tail) projectRuns.delete(intent.repository)
  }
}
