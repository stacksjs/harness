/**
 * What the agent changed on disk.
 *
 * A transcript tells you what the agent *said* it did and which tools it ran.
 * Neither is the same as what is now in your working tree, and the gap between
 * them is exactly where an agent harness earns its keep — the review step is
 * the point.
 *
 * Scope, stated plainly: this is the workspace's **uncommitted** state, not a
 * per-session attribution. If you had your own edits in flight before the
 * session started, they appear here too. Attributing changes to one session
 * needs a baseline commit recorded when the session opens, which belongs with
 * the branch-per-session work in PLAN.md §M6; claiming it now would be worse
 * than not offering it, because a wrong attribution is trusted.
 */

import { spawn } from 'node:child_process'

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

    let path = match[3]
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

/** Largest patch sent to the page. Beyond this the browser is the bottleneck. */
export const MAX_PATCH_BYTES = 512 * 1024

/** Read the workspace's uncommitted changes. */
export async function workspaceDiff(workspacePath: string): Promise<WorkspaceDiff> {
  const inside = await git(workspacePath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out.trim() !== 'true')
    return { isRepository: false, files: [], patch: '' }

  const [status, numstat, patch] = await Promise.all([
    git(workspacePath, ['status', '--porcelain=v1', '-z']),
    git(workspacePath, ['diff', 'HEAD', '--numstat', '-z']),
    git(workspacePath, ['diff', 'HEAD']),
  ])

  if (!status.ok)
    return { isRepository: true, files: [], patch: '', error: 'git status failed' }

  const counts = parseNumstat(numstat.out)
  const files = parseStatus(status.out).map(file => ({ ...file, ...(counts.get(file.path) ?? {}) }))

  return {
    isRepository: true,
    files,
    patch: patch.out.length > MAX_PATCH_BYTES
      // Truncated with a note rather than silently: a diff that stops halfway
      // with no explanation reads as a complete diff.
      ? `${patch.out.slice(0, MAX_PATCH_BYTES)}\n\n… truncated at ${MAX_PATCH_BYTES / 1024}KB\n`
      : patch.out,
  }
}
