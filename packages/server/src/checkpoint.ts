/**
 * Workspace snapshots, so a turn can be undone.
 *
 * An agent that edits eleven files and gets the ninth wrong is the normal case,
 * not the exceptional one. Reading a diff tells you it happened; a checkpoint is
 * what lets you take it back without hand-reverting eleven files.
 *
 * ## How the snapshot is taken
 *
 * A **temporary index**, not the stash and not a commit on your branch:
 *
 *     GIT_INDEX_FILE=<temp> git read-tree HEAD
 *     GIT_INDEX_FILE=<temp> git add -A
 *     GIT_INDEX_FILE=<temp> git write-tree      -> tree
 *     git commit-tree <tree> -p HEAD            -> commit
 *
 * Nothing about the user's own state moves. Their index is untouched, their
 * branch does not advance, the stash list does not grow, and no file in the
 * working tree changes. The result is a dangling commit reachable by SHA, which
 * `git gc` will eventually collect and which nothing depends on until a revert
 * asks for it.
 *
 * `git add -A` respects `.gitignore`, so `node_modules` and build output stay
 * out. That is also the one thing a checkpoint cannot promise to restore — see
 * `restore`.
 *
 * ## Why not `git stash`
 *
 * `git stash` mutates: it reverts the working tree as a side effect of saving,
 * and it pushes onto a list the user also uses by hand. A harness that quietly
 * consumed someone's stash stack would be worse than one with no checkpoints.
 */

import { spawn } from 'node:child_process'
import { lstat, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface CaptureResult {
  /** The commit holding the snapshot, or null when nothing could be captured. */
  ref: string | null
  tree?: string
  /** Why capture did not happen, for a caller that must explain itself. */
  reason?: 'not-a-repository' | 'no-commits' | 'git-failed'
}

export interface RestoreResult {
  ok: boolean
  /** Files written back to the state the checkpoint recorded. */
  restored: number
  /** Files that did not exist at the checkpoint and were removed. */
  removed: number
  reason?: string
  cleanup?: () => Promise<void>
}

function git(cwd: string, args: string[], env?: Record<string, string>, input?: string | Uint8Array): Promise<{ ok: boolean, out: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      const gitEnv = { ...process.env, ...env }
      for (const key of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete gitEnv[key]
      if (!env?.GIT_INDEX_FILE) delete gitEnv.GIT_INDEX_FILE
      child = spawn('git', args, {
        cwd,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'],
        env: gitEnv,
      })
    }
    catch {
      return resolve({ ok: false, out: '' })
    }

    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
    let out = ''
    // A capture runs on the turn path, so it must not be able to hang a turn.
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      child.kill('SIGKILL')
      child.stdout?.destroy()
    }, 15000)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !expired, out }) })
  })
}

async function withTemporaryIndex<T>(run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-index-'))
  try {
    return await run({ GIT_INDEX_FILE: join(dir, 'index') })
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * A tree object for the working tree exactly as it stands.
 *
 * Shared with the diff, which needs the *same* notion of "now" the checkpoint
 * uses. Comparing a checkpoint tree against the live index instead reports a
 * file that is present but untracked as deleted — it is in the tree and not in
 * the index, and git has no way to know you still have it.
 *
 * Built in a temporary index, so nothing the user owns moves.
 */
export async function snapshotTree(workspacePath: string): Promise<string | null> {
  return withTemporaryIndex(async (env) => {
    const read = await git(workspacePath, ['read-tree', 'HEAD'], env)
    if (!read.ok) return null
    const add = await git(workspacePath, ['add', '-A'], env)
    if (!add.ok) return null
    const tree = await git(workspacePath, ['write-tree'], env)
    return tree.ok ? tree.out.trim() : null
  })
}

/**
 * Snapshot the workspace, without disturbing it.
 *
 * Returns null rather than throwing when there is nothing to snapshot: a plain
 * directory and a repository with no commits are both ordinary situations, and
 * a turn must not fail because its workspace is not under version control.
 */
export async function capture(workspacePath: string, message = 'harness checkpoint', excluded: string[] = [], sourceIndex?: Uint8Array): Promise<CaptureResult> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
  if (!inside.ok || inside.out.trimEnd() !== 'true')
    return { ref: null, reason: 'not-a-repository' }

  const head = await git(workspacePath, ['rev-parse', 'HEAD'])
  // `commit-tree -p HEAD` needs a parent. An empty repository has none, and
  // capturing without one would produce a root commit whose revert semantics
  // differ from every other checkpoint's.
  if (!head.ok) return { ref: null, reason: 'no-commits' }

  return withTemporaryIndex(async (env) => {
    if (sourceIndex) await writeFile(env.GIT_INDEX_FILE!, sourceIndex)
    else if (!(await git(workspacePath, ['read-tree', 'HEAD'], env)).ok) return { ref: null, reason: 'git-failed' as const }

    // `-A` stages tracked modifications, deletions *and* untracked files, so an
    // agent's new file is inside the snapshot rather than surviving a revert.
    const paths = excluded.length ? ['--', '.', ...excluded.map(path => `:(exclude,literal)${path}`)] : []
    const add = await git(workspacePath, ['add', '-A', ...paths], env)
    if (!add.ok) return { ref: null, reason: 'git-failed' as const }

    const tree = await git(workspacePath, ['write-tree'], env)
    if (!tree.ok) return { ref: null, reason: 'git-failed' as const }

    // Checkpoints are internal Git objects. Capture must work before the
    // user configures an identity or a signing key for their own commits.
    const commit = await git(workspacePath, ['commit-tree', '--no-gpg-sign', tree.out.trim(), '-p', head.out.trim(), '-m', message], {
      ...env,
      GIT_AUTHOR_NAME: 'Harness',
      GIT_AUTHOR_EMAIL: 'checkpoint@harness.invalid',
      GIT_COMMITTER_NAME: 'Harness',
      GIT_COMMITTER_EMAIL: 'checkpoint@harness.invalid',
    })
    if (!commit.ok) return { ref: null, reason: 'git-failed' as const }

    return { ref: commit.out.trim(), tree: tree.out.trim() }
  })
}

/** Git paths come from NUL-terminated output and are always repository-relative. */
function listedFiles(result: { ok: boolean, out: string }): Set<string> | null {
  if (!result.ok) return null
  return new Set(result.out.split('\0').filter(path => path && !path.endsWith('/')))
}

/** Plan removals before writing the snapshot, including checks for replaced directories. */
async function removableFiles(root: string, wanted: Set<string>, present: Set<string>): Promise<string[] | null> {
  const removals: string[] = []
  for (const path of present) {
    if (wanted.has(path)) continue
    const target = join(root, path)
    try {
      // Git can report indexed paths even when a parent directory has since
      // become a symlink. A rewind must never unlink through that symlink.
      const parent = dirname(target)
      if (await realpath(parent) !== parent || (await lstat(target)).isDirectory()) return null
      removals.push(target)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
  }
  return removals
}

interface RestorePlan {
  root: string
  commit: string
  wanted: Set<string>
  removals: string[]
  excluded: string[]
}

function failed(reason: string): RestoreResult {
  return { ok: false, restored: 0, removed: 0, reason }
}

function withinScope(path: string, excluded: string[]): boolean {
  return !excluded.some(folder => path === folder || path.startsWith(`${folder}/`))
}

async function prepareRestore(workspacePath: string, ref: string, excluded: string[] = []): Promise<RestorePlan | RestoreResult> {
  const root = await realpath(workspacePath).catch(() => null)
  const inside = root && await git(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
  if (!root || !inside || !inside.ok || inside.out.trimEnd() !== 'true') return failed('not a git repository')

  const exists = await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  if (!exists.ok) return failed(`unknown checkpoint: ${ref}`)
  const commit = exists.out.trim()
  const [tree, index] = await Promise.all([
    git(root, ['ls-tree', '-r', '-z', commit]),
    git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).then(listedFiles),
  ])
  if (!tree.ok || !index) return failed('could not safely enumerate files to restore')
  const gitlinks: string[] = []
  const wanted = new Set<string>()
  for (const record of tree.out.split('\0')) {
    const tab = record.indexOf('\t')
    if (tab === -1) continue
    const path = record.slice(tab + 1)
    if (record.startsWith('160000 ')) gitlinks.push(path)
    else if (withinScope(path, excluded)) wanted.add(path)
  }
  const protectedPaths = [...excluded, ...gitlinks]
  const present = new Set([...index].filter(path => withinScope(path, protectedPaths)))
  const removals = await removableFiles(root, wanted, present)
  if (!removals) return failed('could not safely enumerate files to restore')

  // A directory in place of a checkpoint file may hold ignored files or a
  // separately managed repository. An ignored file at the same path is also
  // outside the working-tree snapshot, so leave the current checkout intact.
  for (const path of wanted) {
    const target = join(root, path)
    try {
      const parent = dirname(target)
      if (await realpath(parent) !== parent) return failed('a checkpoint file has a replaced parent directory')
      const stat = await lstat(target)
      if (stat.isDirectory() || !present.has(path)) return failed('a checkpoint file conflicts with an existing path')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return failed('could not inspect a checkpoint file')
    }
  }
  return { root, commit, wanted, removals, excluded }
}

async function applyRestore({ root, commit, wanted, removals }: RestorePlan): Promise<RestoreResult> {
  if (await realpath(root).catch(() => null) !== root) return failed('the checkout moved before the restore')
  const written = await withTemporaryIndex(async (env) => {
    if (!(await git(root, ['read-tree', commit], env)).ok) return false
    if (!wanted.size) return true
    return (await git(root, ['checkout-index', '-f', '-z', '--stdin'], env, [...wanted].join('\0') + '\0')).ok
  })
  if (!written) return failed('could not write the checkpoint back')

  let removed = 0
  for (const target of removals) {
    try {
      const parent = dirname(target)
      if (await realpath(parent) !== parent) throw new Error('unsafe parent path')
      await rm(target, { force: true })
      removed++
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { ok: false, restored: wanted.size, removed, reason: 'could not remove files created since the checkpoint' }
    }
  }
  return { ok: true, restored: wanted.size, removed }
}

/** Restore the working tree using a temporary index. The live index is preserved. */
export async function restore(workspacePath: string, ref: string, excluded: string[] = []): Promise<RestoreResult> {
  const plan = await prepareRestore(workspacePath, ref, excluded)
  return 'ok' in plan ? plan : applyRestore(plan)
}

export interface RepositoryRestoreTarget {
  path: string
  label: string
  ref: string
  excluded: string[]
}

interface RewindTarget {
  plan: RestorePlan
  label: string
  index: string
  head: string
  before: Buffer | null
  after: Buffer
  backup: string
  recoveryRef: string
  indexRecovery?: { ref: string, object: string }
}

async function readIndex(path: string): Promise<Buffer | null> {
  try { return await readFile(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return null
  }
}

/** Git honours the adjacent lock. Check the bytes again while holding it. */
async function replaceIndex(path: string, expected: Buffer | null, next: Buffer | null): Promise<boolean> {
  const lock = `${path}.lock`
  const handle = await open(lock, 'wx').catch(() => null)
  if (!handle) return false
  let ownsLock = true
  try {
    const current = await readIndex(path)
    if (expected === null ? current !== null : current === null || !expected.equals(current)) return false
    if (next === null) await rm(path, { force: true })
    else {
      await handle.writeFile(next)
      await handle.sync()
      await handle.close()
      await rename(lock, path)
      ownsLock = false
    }
    return true
  }
  catch { return false }
  finally {
    await handle.close().catch(() => {})
    if (ownsLock) await rm(lock, { force: true }).catch(() => {})
  }
}

export function rewindReference(operation: string): string {
  return `refs/harness/rewind/${new Bun.CryptoHasher('sha256').update(operation).digest('hex').slice(0, 24)}`
}

/** Preflight all checkouts and retain recovery objects before touching any. */
export async function restoreRepositories(
  scopes: RepositoryRestoreTarget[], operation: string, allowed: () => boolean,
): Promise<RestoreResult> {
  const planned: RewindTarget[] = []
  const attempted: RewindTarget[] = []
  const updatedIndexes = new Set<RewindTarget>()
  const reference = rewindReference(operation)
  const retained = new Set<RewindTarget>()
  let restored = 0
  let removed = 0
  let completed = false
  const cleanup = async () => {
    for (const target of planned) {
      if (retained.size) break
      await git(target.plan.root, ['update-ref', '-d', target.recoveryRef, target.backup])
      if (target.indexRecovery) await git(target.plan.root, ['update-ref', '-d', target.indexRecovery.ref, target.indexRecovery.object])
    }
  }
  try {
    for (const [position, scope] of scopes.entries()) {
      const plan = await prepareRestore(scope.path, scope.ref, scope.excluded)
      if ('ok' in plan) return failed(`${scope.label}: ${plan.reason}`)
      const [actual, baseline] = await Promise.all([
        git(plan.root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']),
        git(plan.root, ['rev-parse', '--verify', 'HEAD']),
      ])
      if (!actual.ok || !baseline.ok) return failed(`Could not read Git staging for ${scope.label}.`)
      const index = actual.out.trimEnd()
      const head = baseline.out.trim()
      const before = await readIndex(index)
      const after = await withTemporaryIndex(async (env) => {
        if (before) await writeFile(env.GIT_INDEX_FILE!, before)
        const paths = ['.', ...scope.excluded.map(path => `:(exclude,literal)${path}`)]
        if (!(await git(plan.root, ['reset', '--quiet', head, '--', ...paths], env)).ok) return null
        return readIndex(env.GIT_INDEX_FILE!)
      })
      if (!after) return failed(`Could not prepare the Git index for ${scope.label}.`)
      const backup = await capture(plan.root, 'Harness pre-rewind recovery', scope.excluded, before ?? undefined)
      if (!backup.ref) return failed(`Could not save the current files in ${scope.label}.`)
      const recoveryRef = `${reference}/${position}/files`
      const target: RewindTarget = { plan, label: scope.label, index, head, before, after, backup: backup.ref, recoveryRef }
      if (!(await git(plan.root, ['update-ref', recoveryRef, backup.ref, ''])).ok)
        return failed(`Could not retain recovery files for ${scope.label}.`)
      planned.push(target)
      if (before) {
        const blob = await git(plan.root, ['hash-object', '-w', '--stdin'], undefined, before)
        const ref = `${reference}/${position}/index`
        const object = blob.out.trim()
        if (!blob.ok || !(await git(plan.root, ['update-ref', ref, object, ''])).ok)
          return failed(`Could not retain the recovery index for ${scope.label}.`)
        target.indexRecovery = { ref, object }
      }
    }
    for (const target of planned) {
      if (!allowed()) throw new Error('The workspace is no longer available for rewind.')
      attempted.push(target)
      const result = await applyRestore(target.plan)
      if (!result.ok) throw new Error(`Could not restore ${target.label}. ${result.reason ?? ''}`)
      restored += result.restored
      removed += result.removed
    }
    for (const target of planned) {
      const head = await git(target.plan.root, ['rev-parse', '--verify', 'HEAD'])
      if (!allowed() || !head.ok || head.out.trim() !== target.head || !await replaceIndex(target.index, target.before, target.after))
        throw new Error(`Could not update the staged state in ${target.label}.`)
      updatedIndexes.add(target)
    }
    completed = true
    return { ok: true, restored, removed, cleanup }
  }
  catch (error) {
    for (const target of attempted.toReversed()) {
      const recovered = await restore(target.plan.root, target.backup, target.plan.excluded).catch(() => null)
      const indexRecovered = !updatedIndexes.has(target) || await replaceIndex(target.index, target.after, target.before).catch(() => false)
      if (!recovered?.ok || !indexRecovered) retained.add(target)
    }
    const message = error instanceof Error ? error.message : 'Could not rewind the repositories.'
    return failed(retained.size ? `${message} Recovery references remain under ${reference}.` : message)
  }
  finally {
    if (!completed) await cleanup()
  }
}
