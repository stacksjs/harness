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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface CaptureResult {
  /** The commit holding the snapshot, or null when nothing could be captured. */
  ref: string | null
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
}

function git(cwd: string, args: string[], env?: Record<string, string>): Promise<{ ok: boolean, out: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: env ? { ...process.env, ...env } : process.env,
      })
    }
    catch {
      return resolve({ ok: false, out: '' })
    }

    let out = ''
    // A capture runs on the turn path, so it must not be able to hang a turn.
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out }) }, 15000)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
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
 * Snapshot the workspace, without disturbing it.
 *
 * Returns null rather than throwing when there is nothing to snapshot: a plain
 * directory and a repository with no commits are both ordinary situations, and
 * a turn must not fail because its workspace is not under version control.
 */
export async function capture(workspacePath: string, message = 'harness checkpoint'): Promise<CaptureResult> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { ref: null, reason: 'not-a-repository' }

  const head = await git(workspacePath, ['rev-parse', 'HEAD'])
  // `commit-tree -p HEAD` needs a parent. An empty repository has none, and
  // capturing without one would produce a root commit whose revert semantics
  // differ from every other checkpoint's.
  if (!head.ok) return { ref: null, reason: 'no-commits' }

  return withTemporaryIndex(async (env) => {
    const read = await git(workspacePath, ['read-tree', 'HEAD'], env)
    if (!read.ok) return { ref: null, reason: 'git-failed' as const }

    // `-A` stages tracked modifications, deletions *and* untracked files, so an
    // agent's new file is inside the snapshot rather than surviving a revert.
    const add = await git(workspacePath, ['add', '-A'], env)
    if (!add.ok) return { ref: null, reason: 'git-failed' as const }

    const tree = await git(workspacePath, ['write-tree'], env)
    if (!tree.ok) return { ref: null, reason: 'git-failed' as const }

    const commit = await git(workspacePath, ['commit-tree', tree.out.trim(), '-p', head.out.trim(), '-m', message], env)
    if (!commit.ok) return { ref: null, reason: 'git-failed' as const }

    return { ref: commit.out.trim() }
  })
}

/** Files a tree contains, as repo-relative paths. */
async function filesIn(workspacePath: string, ref: string): Promise<Set<string>> {
  const listed = await git(workspacePath, ['ls-tree', '-r', '--name-only', '-z', ref])
  return new Set(listed.out.split('\0').filter(Boolean))
}

/** Files present in the working tree now, ignoring anything gitignored. */
async function filesNow(workspacePath: string): Promise<Set<string>> {
  const listed = await git(workspacePath, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return new Set(listed.out.split('\0').filter(Boolean))
}

/**
 * Put the workspace back to a captured state.
 *
 * Two halves, and the second is the one that is easy to forget: files the
 * checkpoint recorded are written back, **and** files created since are
 * removed. A restore that only writes leaves the agent's new files behind, so
 * the workspace ends up in a state that never existed — which is worse than not
 * reverting, because it looks like it worked.
 *
 * Ignored files are never touched. `node_modules` is not part of a checkpoint
 * and must not be deleted by one.
 */
export async function restore(workspacePath: string, ref: string): Promise<RestoreResult> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { ok: false, restored: 0, removed: 0, reason: 'not a git repository' }

  // Refuse an unknown ref rather than half-restoring. `^{commit}` also rejects a
  // ref that resolves to something that is not a commit.
  const exists = await git(workspacePath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!exists.ok)
    return { ok: false, restored: 0, removed: 0, reason: `unknown checkpoint: ${ref}` }

  const wanted = await filesIn(workspacePath, ref)
  const present = await filesNow(workspacePath)

  const written = await withTemporaryIndex(async (env) => {
    const read = await git(workspacePath, ['read-tree', ref], env)
    if (!read.ok) return false
    // `-a -f` writes every file in the index over whatever is there now.
    const checkout = await git(workspacePath, ['checkout-index', '-a', '-f'], env)
    return checkout.ok
  })

  if (!written)
    return { ok: false, restored: 0, removed: 0, reason: 'could not write the checkpoint back' }

  // Anything here now that the checkpoint did not have.
  //
  // Removed from disk rather than with `git rm`, which only knows about tracked
  // files — and with `--ignore-unmatch` it exits 0 on an untracked one, so it
  // reports success while leaving the agent's new file exactly where it was.
  // Deleting directly also keeps the real index out of it: `checkout-index`
  // wrote through a temporary index, so nothing has staged anything, and a
  // revert should not.
  let removed = 0
  for (const path of present) {
    if (wanted.has(path)) continue
    try {
      await rm(join(workspacePath, path), { force: true })
      removed++
    }
    catch {
      // A file that vanished under us is the outcome we wanted anyway.
    }
  }

  return { ok: true, restored: wanted.size, removed }
}
