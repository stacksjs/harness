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

import { spawn } from 'node:child_process'
import { join } from 'node:path'

export interface WorktreeResult {
  /** Directory the agent should run in, or null when none was made. */
  path: string | null
  /** Branch the work lands on. */
  branch: string | null
  reason?: 'not-a-repository' | 'no-commits' | 'git-failed' | 'already-exists'
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
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
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

/** Give a session its own checkout and branch. */
export async function create(workspacePath: string, sessionId: number): Promise<WorktreeResult> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { path: null, branch: null, reason: 'not-a-repository' }

  // A worktree branches from a commit. An empty repository has none, and
  // `worktree add` on one fails with a message about an invalid reference.
  const head = await git(workspacePath, ['rev-parse', 'HEAD'])
  if (!head.ok) return { path: null, branch: null, reason: 'no-commits' }

  // The repository's own git directory, resolved rather than assumed: in a
  // worktree or a submodule, `.git` is a file pointing elsewhere.
  const gitDir = await git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir.ok) return { path: null, branch: null, reason: 'git-failed' }

  const path = join(gitDir.out.trim(), 'harness', 'worktrees', String(sessionId))
  const branch = branchFor(sessionId)

  const added = await git(workspacePath, ['worktree', 'add', '-b', branch, path, head.out.trim()])
  if (!added.ok) {
    // Most often a leftover from a previous run with the same session id, which
    // `prune` clears. Reported rather than forced: removing someone's worktree
    // because a name collided is not a decision to make silently.
    return { path: null, branch: null, reason: 'already-exists' }
  }

  return { path, branch }
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
export async function commitTurn(worktreePath: string, message: string): Promise<string | null> {
  const staged = await git(worktreePath, ['add', '-A'])
  if (!staged.ok) return null

  // Nothing changed: `diff --cached --quiet` exits 0 when the index matches
  // HEAD, which is exactly "no work to record".
  const unchanged = await git(worktreePath, ['diff', '--cached', '--quiet'])
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

/**
 * Every worktree of this repository, with harness's own identified.
 *
 * Reported rather than filtered, because someone reading this list is usually
 * trying to work out where their disk went, and a worktree they made by hand
 * is part of that answer.
 */
export async function list(workspacePath: string): Promise<WorktreeEntry[]> {
  const listed = await git(workspacePath, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) return []

  const entries: WorktreeEntry[] = []
  let current: { path: string, branch: string | null } | null = null

  const flush = async (): Promise<void> => {
    if (!current) return
    const match = /\/harness\/worktrees\/(\d+)$/.exec(current.path)
    const status = await git(current.path, ['status', '--porcelain'])
    entries.push({
      path: current.path,
      branch: current.branch,
      sessionId: match ? Number(match[1]) : null,
      dirty: status.ok && status.out.trim().length > 0,
    })
    current = null
  }

  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      await flush()
      current = { path: line.slice('worktree '.length), branch: null }
    }
    else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '')
    }
  }
  await flush()

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
export async function release(workspacePath: string, path: string): Promise<{ removed: boolean, committed: string | null, reason?: string }> {
  const committed = await commitTurn(path, 'harness: work left uncommitted when the session went away')
  const removed = await remove(workspacePath, path, false)
  if (!removed.ok) {
    // Forced only after the work is safely on the branch, so what this discards
    // is the checkout and not the output.
    const forced = await remove(workspacePath, path, true)
    if (!forced.ok) return { removed: false, committed, reason: forced.reason }
  }
  return { removed: true, committed }
}

/** Whether a path is a live worktree of this repository. */
export async function exists(workspacePath: string, path: string): Promise<boolean> {
  const listed = await git(workspacePath, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) return false
  return listed.out.split('\n').some(line => line === `worktree ${path}`)
}
