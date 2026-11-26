/**
 * A git worktree per session, so two agents cannot overwrite each other.
 *
 * Sessions share a workspace by design — `harness:run` reuses one by path, and
 * a profile's project is one directory. That is fine until two sessions run at
 * once: they edit the same files, each sees the other's half-finished work, and
 * a revert in one throws away the other's. The transcript then describes
 * changes that are not the ones on disk.
 *
 * ## Worktree, not just a branch
 *
 * `git switch -c` gives a session its own branch but not its own files: there
 * is still one working tree, and switching it under a running agent changes
 * files out from under a process that is mid-edit. `git worktree add` gives
 * both — a directory and a branch — so isolation is real rather than nominal.
 *
 * ## Where they live
 *
 * Under `.git/harness/worktrees/<session>`, inside the repository's own git
 * directory. That keeps them out of the working tree (nothing to gitignore,
 * nothing to accidentally commit), and `git worktree list` still knows about
 * them, so a person can find and remove one without harness's help.
 *
 * ## Each turn is a commit
 *
 * A worktree alone leaves the agent's work uncommitted, so the branch is empty
 * and `git merge harness/session-<id>` gets you nothing — the point of the
 * branch would be lost. Every turn that changes something commits onto it, so
 * the branch carries the work and the history reads one commit per turn.
 *
 * ## What this deliberately does not do
 *
 * Merge anything back. `harness/session-<id>` is a branch you merge, rebase or
 * open a PR from with the tools you already use. A harness that invented its
 * own merge flow would be a worse version of one you have.
 */

import type { CheckoutIntent } from '@harness/contract'
import { spawn } from 'node:child_process'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'

export interface WorktreeResult {
  /** Directory the agent should run in, or null when none was made. */
  path: string | null
  /** Branch the work lands on. */
  branch: string | null
  reason?: 'not-a-repository' | 'no-commits' | 'git-failed' | 'already-exists' | 'checkout-conflict'
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean, out: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    }
    catch {
      return resolve({ ok: false, out: '' })
    }

    let out = ''
    // Creating a worktree copies a checkout, which is slow on a large
    // repository but must not be unbounded — it runs on the turn path.
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out }) }, 60000)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { out += chunk })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
  })
}

/**
 * The branch a session's work lands on.
 *
 * Namespaced under `harness/` so it is obvious where it came from and so
 * `git branch --list 'harness/*'` finds every one of them. The session id is
 * already unique, which is what keeps `worktree add -b` from colliding.
 */
export function branchFor(sessionId: number): string {
  return `harness/session-${sessionId}`
}

async function gitDirectory(path: string): Promise<string | null> {
  const result = await git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return result.ok ? realpath(result.out.trimEnd()).catch(() => null) : null
}

async function commitAt(path: string, ref: string): Promise<string | null> {
  const result = await git(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  return result.ok ? result.out.trim() : null
}

/** Resolve an explicit branch, then the repository's configured or usual default. */
export async function checkoutBase(path: string, requested?: string, defaultBranch = false): Promise<string | null> {
  if (requested && requested !== 'HEAD') {
    const name = requested.replace(/^refs\/heads\/|^origin\//u, '')
    if (!(await git(path, ['check-ref-format', `refs/heads/${name}`])).ok) throw new Error('Enter a valid Git base branch.')
    const selected = await commitAt(path, `refs/heads/${name}`) ?? await commitAt(path, `refs/remotes/origin/${name}`)
    if (selected) return selected
  }
  if (defaultBranch && requested !== 'HEAD') {
    const originHead = await git(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    if (originHead.ok && originHead.out.startsWith('refs/remotes/origin/')) {
      const defaultRef = originHead.out.trimEnd()
      const resolved = await commitAt(path, defaultRef.replace('refs/remotes/origin/', 'refs/heads/')) ?? await commitAt(path, defaultRef)
      if (resolved) return resolved
    }
    for (const name of ['main', 'master', 'trunk', 'develop']) {
      const resolved = await commitAt(path, `refs/heads/${name}`)
      if (resolved) return resolved
    }
  }
  return commitAt(path, 'HEAD')
}

/** Resolve a stable base and a checkout path before any Git mutation. */
export async function plan(workspacePath: string, sessionId: number, reservation?: string, baseBranch?: string): Promise<CheckoutIntent | { reason: NonNullable<WorktreeResult['reason']> }> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { reason: 'not-a-repository' }

  // A worktree branches from a commit. An empty repository has none, and
  // `worktree add` on one fails with a message about an invalid reference.
  const base = await checkoutBase(workspacePath, baseBranch, Boolean(baseBranch))
  if (!base) return { reason: 'no-commits' }

  // The repository's own git directory, resolved rather than assumed: in a
  // worktree or a submodule, `.git` is a file pointing elsewhere.
  const [gitDir, repository] = await Promise.all([gitDirectory(workspacePath), realpath(workspacePath).catch(() => null)])
  if (!gitDir || !repository) return { reason: 'git-failed' }
  const leaf = reservation ? `${sessionId}-${reservation}` : String(sessionId)
  return { path: join(gitDir, 'harness', 'worktrees', leaf), branch: branchFor(sessionId), repository, base }
}

async function add(intent: CheckoutIntent): Promise<WorktreeResult> {
  const { repository, path, branch, base } = intent
  const added = await git(repository, ['worktree', 'add', '-b', branch, path, base])
  if (!added.ok) {
    // Keep any existing branch or checkout when the reservation collides.
    return { path: null, branch: null, reason: 'already-exists' }
  }

  return { path, branch }
}

/** Give a session its own checkout and branch. */
export async function create(workspacePath: string, sessionId: number): Promise<WorktreeResult> {
  const intent = await plan(workspacePath, sessionId)
  return 'reason' in intent ? { path: null, branch: null, reason: intent.reason } : add(intent)
}

export type WorktreeOpenMode = boolean | 'recover' | 'resume'

/** Rebuild from local refs only. Only an existing copy of this branch is tracked. */
async function resumeBase(repository: string, branch: string): Promise<{ commit: string, upstream?: string } | null> {
  const remotes = await git(repository, ['remote'])
  const names = remotes.ok ? remotes.out.trim().split('\n').filter(Boolean) : []
  const remote = names.includes('origin') ? 'origin' : names[0]
  if (remote) {
    const upstream = `refs/remotes/${remote}/${branch}`
    const commit = await commitAt(repository, upstream)
    if (commit) return { commit, upstream }
    const branchHead = await git(repository, ['symbolic-ref', '--quiet', 'HEAD'])
    if (!branchHead.ok) {
      const commit = await commitAt(repository, `refs/remotes/${remote}/HEAD`)
      if (commit) return { commit }
    }
  }
  const commit = await commitAt(repository, 'HEAD')
  return commit ? { commit } : null
}

/** Find the exact registered checkout and leave conflicts untouched. */
export async function openReserved(intent: CheckoutIntent, mode: WorktreeOpenMode, combinedRoot?: string,
  authorize = () => false, beforeRestore?: () => void): Promise<WorktreeResult> {
  const { repository, path, branch } = intent
  const recovering = typeof mode === 'string'
  const conflict = { path: null, branch: null, reason: 'checkout-conflict' } as const
  const common = await gitDirectory(repository)
  if (!common || normalize(path) !== path) return conflict
  if (combinedRoot) {
    const entry = relative(combinedRoot, path)
    if (!entry || entry.startsWith(`..${sep}`) || entry === '..' || isAbsolute(entry)) return conflict
  }
  else if (join(common, 'harness', 'worktrees', basename(path)) !== path) return conflict
  const registrations = await gitWorktrees(repository)
  if (!registrations) return conflict
  const existing = registrations.find(entry => entry.path === path)
  if (existing && (existing.branch !== branch || existing.locked)) return conflict
  if (existing && !existing.prunable) {
    const [actual, marker, linkedCommon] = await Promise.all([
      realpath(path).catch(() => null), lstat(join(path, '.git')).catch(() => null), gitDirectory(path),
    ])
    return actual === path && marker?.isFile() && linkedCommon === common ? { path, branch } : conflict
  }
  if (!mode || (existing && !recovering)) return conflict

  try {
    // An unregistered path may hold files from an incomplete checkout or a user.
    const occupied = () => lstat(path).then(() => true, (error) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (await occupied()) return conflict
    const parent = dirname(path)
    const root = combinedRoot ?? common
    let base: Awaited<ReturnType<typeof resumeBase>> = null
    if (recovering) {
      if (!authorize() || registrations.some(entry => entry.path !== path && entry.branch === branch)) return conflict
      if (!await commitAt(repository, `refs/heads/${branch}`)) {
        base = mode === 'resume' ? await resumeBase(repository, branch) : null
        if (!base) return conflict
      }
    }
    if (await realpath(root) !== root) return conflict
    let current = root
    for (const part of relative(root, parent).split(sep).filter(Boolean)) {
      current = join(current, part)
      await mkdir(current).catch((error) => { if (error.code !== 'EEXIST') throw error })
      if (await realpath(current) !== current) return conflict
    }
    if (recovering) {
      // Drop only the stale registration at the verified path. Git's normal
      // removal and add checks still protect dirty or separately checked-out branches.
      if (await occupied() || !authorize()) return conflict
      if (existing && !(await git(repository, ['worktree', 'remove', '--', path])).ok) return conflict
      if (await occupied() || !authorize()) return conflict
      const checkout = base ? ['--no-track', '-b', branch, '--', path, base.commit] : ['--', path, branch]
      beforeRestore?.()
      const added = await git(repository, ['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--no-guess-remote', ...checkout])
      if (!added.ok) return conflict
      const opened = await openReserved(intent, false, combinedRoot)
      if (opened.path && base?.upstream && authorize())
        await git(repository, ['branch', `--set-upstream-to=${base.upstream}`, '--', branch])
      return opened
    }
    const created = await add(intent)
    return created.path ? openReserved(intent, false, combinedRoot) : created
  }
  catch { return conflict }
}

/**
 * Commit whatever the turn changed onto the session's branch.
 *
 * Returns null when there was nothing to commit, which is the common case for a
 * turn that only read files — an empty commit per question would bury the ones
 * that matter.
 *
 * The author is read from the repository's own config and passed back through
 * `-c`, falling back to a harness identity only when none is set. `-c`
 * overrides rather than fills, so passing a default unconditionally would
 * rewrite every commit's author on a machine that had one configured — while
 * passing nothing fails outright on a machine that does not.
 */
export async function commitTurn(worktreePath: string, message: string, excluded: string[] = []): Promise<string | null> {
  const paths = excluded.length ? ['--', '.', ...excluded.map(key => `:(exclude,literal)${key}`)] : []
  const staged = await git(worktreePath, ['add', '-A', ...paths])
  if (!staged.ok) return null

  // Nothing changed: `diff --cached --quiet` exits 0 when the index matches
  // HEAD, which is exactly "no work to record".
  const unchanged = await git(worktreePath, ['diff', '--cached', '--quiet', ...paths])
  if (unchanged.ok) return null

  const [name, email] = await Promise.all([
    git(worktreePath, ['config', 'user.name']),
    git(worktreePath, ['config', 'user.email']),
  ])

  const identity = [
    '-c', `user.name=${name.ok && name.out.trim() ? name.out.trim() : 'harness'}`,
    '-c', `user.email=${email.ok && email.out.trim() ? email.out.trim() : 'harness@localhost'}`,
  ]

  const committed = await git(worktreePath, [...identity, 'commit', '-q', '-m', message])
  if (!committed.ok) return null

  const head = await git(worktreePath, ['rev-parse', 'HEAD'])
  return head.ok ? head.out.trim() : null
}

/**
 * Remove a session's worktree.
 *
 * Refuses while it still holds uncommitted work unless `force` is set. The
 * branch is left behind either way — it is the whole point of the exercise, and
 * deleting it would throw away the session's output along with its scratch
 * directory.
 */
export async function remove(workspacePath: string, path: string, force = false): Promise<{ ok: boolean, reason?: string }> {
  const dirty = await git(path, ['status', '--porcelain'])
  if (!force && dirty.ok && dirty.out.trim().length > 0)
    return { ok: false, reason: 'the worktree has uncommitted changes' }

  const removed = await git(workspacePath, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  if (!removed.ok) return { ok: false, reason: 'git could not remove the worktree' }
  return { ok: true }
}

/**
 * Forget worktrees whose directories are gone.
 *
 * A crash, or someone deleting the directory by hand, leaves git holding a
 * registration for a path that no longer exists — and that registration is
 * enough to make `worktree add` refuse the same name later.
 */
export async function prune(workspacePath: string): Promise<void> {
  await git(workspacePath, ['worktree', 'prune'])
}

export interface WorktreeEntry {
  path: string
  branch: string | null
  /** The session it belongs to, when the path is one harness made. */
  sessionId: number | null
  /** Whether it holds changes no commit has recorded. */
  dirty: boolean
}

async function gitWorktrees(workspacePath: string) {
  const listed = await git(workspacePath, ['worktree', 'list', '--porcelain', '-z'])
  if (!listed.ok) return null
  return listed.out.split('\0\0').flatMap((record) => {
    const [path, ...fields] = record.split('\0')
    if (!path?.startsWith('worktree ')) return []
    return [{
      path: normalize(path.slice('worktree '.length)),
      branch: fields.find(field => field.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null,
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')),
      prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')),
    }]
  })
}

/**
 * Every worktree of this repository, with harness's own identified.
 *
 * Reported rather than filtered, because someone reading this list is usually
 * trying to work out where their disk went, and a worktree they made by hand
 * is part of that answer.
 */
export async function list(workspacePath: string): Promise<WorktreeEntry[]> {
  const listed = await gitWorktrees(workspacePath)
  if (!listed) return []
  const entries: WorktreeEntry[] = []
  for (const current of listed) {
    const match = /[\\/]harness[\\/]worktrees[\\/](\d+)(?:-[a-f\d-]{36})?$/u.exec(current.path)
    const status = await git(current.path, ['status', '--porcelain'])
    entries.push({
      path: current.path,
      branch: current.branch,
      sessionId: match ? Number(match[1]) : null,
      dirty: status.ok && status.out.trim().length > 0,
    })
  }

  return entries
}

/**
 * Give back a session's worktree without losing anything it holds.
 *
 * Uncommitted work is committed to the session's own branch first, rather than
 * discarded or left to block the removal. Deleting an agent's output because
 * someone tidied up a profile would be the worst version of this feature, and
 * refusing to clean up while a stray file sits there is how the directories
 * accumulate in the first place.
 *
 * The branch always survives: it is the deliverable, the directory is scratch.
 */
export async function release(workspacePath: string, path: string, excluded?: string[], preserveIgnored = false): Promise<{ removed: boolean, committed: string | null, reason?: string }> {
  const committed = await commitTurn(path, 'harness: work left uncommitted when the session went away', excluded)
  if (preserveIgnored) {
    const ignored = await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard'])
    if (!ignored.ok || ignored.out.length)
      return { removed: false, committed, reason: 'the worktree may contain ignored files' }
  }
  const removed = await remove(workspacePath, path, false)
  if (!removed.ok) return { removed: false, committed, reason: removed.reason }
  return { removed: true, committed }
}

export async function isCleanForLayoutRemoval(path: string, excluded: string[]): Promise<boolean> {
  const status = await git(path, ['status', '--porcelain', '--ignored', '-z', '--', '.', ...excluded.map(key => `:(exclude,literal)${key}`)])
  return status.ok && !status.out
}

export async function includesCheckoutBase(checkout: CheckoutIntent): Promise<boolean> {
  return (await git(checkout.path, ['merge-base', '--is-ancestor', checkout.base, 'HEAD'])).ok
}

/** Whether a path is a live worktree of this repository. */
export async function exists(workspacePath: string, path: string): Promise<boolean> {
  return (await gitWorktrees(workspacePath))?.some(entry => entry.path === normalize(path)) ?? false
}
