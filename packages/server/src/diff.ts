/**
 * What the agent changed on disk.
 *
 * A transcript tells you what the agent *said* it did and which tools it ran.
 * Neither is the same as what is now in your working tree, and the gap between
 * them is exactly where an agent harness earns its keep — the review step is
 * the point.
 *
 * ## What it is measured against
 *
 * A session's **first checkpoint**, when it has one. That snapshot is taken
 * before the agent's first turn runs, so diffing against it answers "what did
 * this session change" — including work the agent committed, which
 * `git diff HEAD` misses entirely.
 *
 * No new bookkeeping was needed for that: checkpoints already exist so a turn
 * can be undone, and the earliest one *is* the baseline. Recording a second
 * marker beside it would have been one more thing to keep in step.
 *
 * Without a baseline — a workspace that is not a repository, or a session from
 * before checkpointing — it falls back to `HEAD`, which is the workspace's
 * uncommitted state and *not* per-session. The caller is told which it got, so
 * the UI can say so rather than implying an attribution it does not have.
 */

import { spawn } from 'node:child_process'
import { snapshotTree } from './checkpoint'

export interface FileChange {
  path: string
  /** Untracked files have no diff to show, only a name. */
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  insertions: number
  deletions: number
}

export interface WorkspaceDiff {
  /** False when the workspace is not a git repository at all. */
  isRepository: boolean
  /**
   * Whether the comparison is against this session's baseline or merely
   * against `HEAD`. The difference matters to the reader: one is "what this
   * session did", the other is "what is uncommitted here".
   */
  scope: 'session' | 'working-tree'
  files: FileChange[]
  /** Unified diff for tracked changes. Empty when there are none. */
  patch: string
  /** Set when git could not be consulted; the UI shows this rather than "no changes". */
  error?: string
}

/** Run a git command in the workspace, capturing stdout. */
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
    // A repository with a huge diff must not hang the page. The cap is on time,
    // not bytes, because the byte cap belongs with the caller that renders it.
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, out }) }, 5000)
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
  })
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated, because a filename may contain a newline and the line-based
 * format quotes and escapes it — which then has to be un-escaped correctly, and
 * getting that subtly wrong shows the user a path that does not exist.
 */
export function parseStatus(raw: string): FileChange[] {
  const files: FileChange[] = []
  const entries = raw.split('\0')

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.length < 4) continue

    const code = entry.slice(0, 2)
    const path = entry.slice(3)

    if (code === '??') {
      files.push({ path, status: 'untracked', insertions: 0, deletions: 0 })
      continue
    }

    // A rename spends two NUL-separated fields: the new path, then the old one.
    // Skipping the second is what keeps the list aligned.
    if (code[0] === 'R' || code[1] === 'R') {
      i++
      files.push({ path, status: 'renamed', insertions: 0, deletions: 0 })
      continue
    }

    const flags = code.replace(/\s/g, '')
    files.push({
      path,
      status: flags.includes('D') ? 'deleted' : flags.includes('A') ? 'added' : 'modified',
      insertions: 0,
      deletions: 0,
    })
  }

  return files
}

/**
 * Parse `git diff --numstat -z` into per-file line counts.
 *
 * Binary files report `-` for both counts rather than a number; they are
 * reported as zero rather than skipped, so the file still appears in the list.
 */
export function parseNumstat(raw: string): Map<string, { insertions: number, deletions: number }> {
  const counts = new Map<string, { insertions: number, deletions: number }>()
  const fields = raw.split('\0')

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const match = field.match(/^(\d+|-)\t(\d+|-)\t(.*)$/)
    if (!match) continue

    let path = match[3] ?? ''
    // With -z, a rename leaves the path empty and puts old then new in the two
    // following fields. The new one is what the status list is keyed by.
    if (path === '') {
      i += 2
      path = fields[i] ?? ''
      if (!path) continue
    }

    counts.set(path, {
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    })
  }

  return counts
}

/**
 * Files changed against a baseline commit, plus anything untracked it did not
 * contain.
 *
 * `git status` reports against HEAD, so using it alongside a baseline patch
 * would describe two different comparisons in one panel — a list that says
 * three files and a diff that shows five. `diff --name-status` answers the same
 * question the patch does.
 *
 * Both sides are trees. Comparing a baseline tree against the live *index*
 * instead reports a file that is present but untracked as deleted: it is in the
 * tree, absent from the index, and git cannot tell you still have it. Snapshotting
 * the working tree the same way the checkpoint did makes the comparison
 * symmetric, and brings untracked files in on both sides for free.
 */
async function filesAgainst(workspacePath: string, baseline: string, now: string): Promise<FileChange[]> {
  const named = await git(workspacePath, ['diff', '--name-status', '-z', baseline, now])

  const files: FileChange[] = []
  const fields = named.out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (!code) continue
    // `R100\0old\0new` — a rename spends two paths, and the new one is what
    // the reader cares about.
    if (code.startsWith('R')) {
      const to = fields[i + 2]
      i += 2
      if (to) files.push({ path: to, status: 'renamed', insertions: 0, deletions: 0 })
      continue
    }
    const path = fields[++i]
    if (!path) continue
    files.push({
      path,
      status: code.startsWith('D') ? 'deleted' : code.startsWith('A') ? 'added' : 'modified',
      insertions: 0,
      deletions: 0,
    })
  }

  return files
}

/** Largest patch sent to the page. Beyond this the browser is the bottleneck. */
export const MAX_PATCH_BYTES = 512 * 1024

/** Read the workspace's uncommitted changes. */
export async function workspaceDiff(workspacePath: string, baseline?: string): Promise<WorkspaceDiff> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { isRepository: false, scope: 'working-tree', files: [], patch: '' }

  // A baseline that git no longer has is treated as absent rather than as an
  // error: checkpoints are dangling commits, so `git gc` can collect one, and a
  // diff against HEAD is still useful.
  const usable = baseline
    ? (await git(workspacePath, ['rev-parse', '--verify', '--quiet', `${baseline}^{commit}`])).ok
    : false
  // The other side of a baseline comparison: the working tree as a tree.
  const now = usable ? await snapshotTree(workspacePath) : null
  const scoped = usable && now !== null
  const scope = scoped ? 'session' as const : 'working-tree' as const
  const range = scoped ? [baseline!, now!] : ['HEAD']

  const [status, numstat, patch] = await Promise.all([
    git(workspacePath, ['status', '--porcelain=v1', '-z']),
    git(workspacePath, ['diff', ...range, '--numstat', '-z']),
    git(workspacePath, ['diff', ...range]),
  ])

  if (!status.ok)
    return { isRepository: true, scope, files: [], patch: '', error: 'git status failed' }

  const counts = parseNumstat(numstat.out)
  const listed = scoped ? await filesAgainst(workspacePath, baseline!, now!) : parseStatus(status.out)
  const files = listed.map(file => ({ ...file, ...(counts.get(file.path) ?? {}) }))

  return {
    isRepository: true,
    scope,
    files,
    patch: patch.out.length > MAX_PATCH_BYTES
      // Truncated with a note rather than silently: a diff that stops halfway
      // with no explanation reads as a complete diff.
      ? `${patch.out.slice(0, MAX_PATCH_BYTES)}\n\n… truncated at ${MAX_PATCH_BYTES / 1024}KB\n`
      : patch.out,
  }
}
