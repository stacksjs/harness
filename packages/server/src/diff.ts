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
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { snapshotTree } from './checkpoint'
import { parseWorkspacePatch } from './diff-patch'

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
  scope: 'session' | 'working-tree' | 'branch' | 'commit' | 'turn'
  comparisonLabel?: string
  comparisonTarget?: string
  files: FileChange[]
  /** Unified diff for tracked changes. Empty when there are none. */
  patch: string
  /** Set when git could not be consulted; the UI shows this rather than "no changes". */
  error?: string
}

/** Run a git command in the workspace, capturing stdout. */
function git(cwd: string, args: string[], limit = Infinity): Promise<{ ok: boolean, out: string }> {
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
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      if (out.length + chunk.length > limit) {
        child.kill()
        resolve({ ok: false, out: '' })
      }
      else out += chunk
    })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, out: '' }) })
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, out }) })
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
    if (/[RC]/u.test(code)) {
      i++
      files.push({ path, status: code.includes('R') ? 'renamed' : 'added', insertions: 0, deletions: 0 })
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
    const match = field.match(/^(\d+|-)\t(\d+|-)\t(.*)$/su)
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
function parseNameStatus(raw: string): FileChange[] {
  const files: FileChange[] = []
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (!code) continue
    // `R100\0old\0new` — a rename spends two paths, and the new one is what
    // the reader cares about.
    if (/^[RC]/u.test(code)) {
      const to = fields[i + 2]
      i += 2
      if (to) files.push({ path: to, status: code.startsWith('R') ? 'renamed' : 'added', insertions: 0, deletions: 0 })
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

/** The comparison inputs that can change without reopening the Changes pane. */
export async function workspaceDiffRevision(workspacePath: string, baseline?: string): Promise<string> {
  const head = await git(workspacePath, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  return Bun.hash(JSON.stringify([workspacePath, baseline ?? '', head.ok ? head.out.trim() : ''])).toString(36)
}

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

  return readWorkspaceDiff(workspacePath, scope, range, scoped)
}

async function readWorkspaceDiff(workspacePath: string, scope: WorkspaceDiff['scope'], range: string[], againstTree: boolean, comparisonLabel?: string): Promise<WorkspaceDiff> {
  const [status, numstat, patch] = await Promise.all([
    git(workspacePath, againstTree ? ['diff', '--name-status', '-z', ...range] : ['status', '--porcelain=v1', '-z']),
    git(workspacePath, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', ...range]),
    git(workspacePath, ['-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index',
      '--src-prefix=a/', '--dst-prefix=b/', '--output-indicator-old=-',
      '--output-indicator-new=+', '--output-indicator-context= ', ...range]),
  ])

  if (!status.ok || (againstTree && (!numstat.ok || !patch.ok)))
    return { isRepository: true, scope, files: [], patch: '', error: 'Could not read this Git comparison.' }

  const counts = parseNumstat(numstat.out)
  const listed = againstTree ? parseNameStatus(status.out) : parseStatus(status.out)
  const files = listed.map(file => ({ ...file, ...(counts.get(file.path) ?? {}) }))

  return {
    isRepository: true,
    scope,
    ...(comparisonLabel ? { comparisonLabel } : {}),
    files,
    patch: patch.out.length > MAX_PATCH_BYTES
      ? `${patch.out.slice(0, MAX_PATCH_BYTES)}\n\n… truncated at ${MAX_PATCH_BYTES / 1024}KB\n`
      : patch.out,
  }
}

export type WorkspaceReviewMode = 'uncommitted' | 'branch' | 'commit' | 'turn'

export interface WorkspaceReviewTurn {
  id: number
  number: number
  before: string
  after: string
}

export interface WorkspaceReviewOptions {
  isRepository: boolean
  base: string | null
  branches: Array<{ ref: string, label: string }>
  commits: Array<{ sha: string, subject: string }>
  turns: Array<{ id: number, number: number }>
}

const commitId = /^[\da-f]{40}(?:[\da-f]{24})?$/u
const branchRef = /^refs\/(?:heads|remotes)\//u

function refLabel(ref: string): string {
  return ref.replace(branchRef, '')
}

async function resolveCommit(path: string, ref: string): Promise<string | null> {
  const result = await git(path, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
  const sha = result.out.trim()
  return result.ok && commitId.test(sha) ? sha : null
}

export async function isWorkspaceGitRoot(path: string): Promise<boolean> {
  const prefix = await git(path, ['rev-parse', '--is-inside-work-tree', '--show-prefix'])
  return prefix.ok && prefix.out.trimEnd() === 'true'
}

/** Only the before blob of a visible text patch can supply its unchanged lines. */
export async function workspaceDiffContext(path: string, diff: WorkspaceDiff, file: string, object: string): Promise<Response> {
  const headers = { 'cache-control': 'private, no-store' }
  if (!commitId.test(object) || /^0+$/u.test(object) || !file || file.length > 4096 || file.includes('\0'))
    return Response.json({ error: 'Invalid diff context request.' }, { status: 400, headers })
  if (diff.error || !diff.files.some(entry => entry.path === file) || !await isWorkspaceGitRoot(path))
    return Response.json({ error: 'This file is unavailable in the comparison.' }, { status: 404, headers })
  const hunks = parseWorkspacePatch(diff.patch).get(file)
  if (!hunks || hunks[0]?.beforeObject !== object)
    return Response.json({ error: 'The comparison changed. Refresh Changes and try again.' }, { status: 409, headers })
  const size = await git(path, ['cat-file', '-s', object])
  if (size.ok && Number(size.out) > MAX_PATCH_BYTES)
    return Response.json({ error: 'This file is too large to expand in Changes.' }, { status: 413, headers })
  const blob = await git(path, ['cat-file', 'blob', object], MAX_PATCH_BYTES)
  if (!blob.ok || blob.out.includes('\0'))
    return Response.json({ error: 'Git could not read text context for this file.' }, { status: 404, headers })
  return Response.json({ text: blob.out }, { headers })
}

async function reviewWorkingState(path: string): Promise<string | null> {
  const status = await git(path, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!status.ok) return null
  const details = await Promise.all(parseStatus(status.out).map(async (file) => {
    try {
      const stat = await lstat(join(path, file.path))
      return [stat.size, stat.mtimeMs, stat.ctimeMs]
    }
    catch { return null }
  }))
  return Bun.hash(JSON.stringify([status.out, details])).toString(36)
}

/** Same common-ancestor comparison for the branch picker and the commit list. */
async function reviewBase(path: string, head: string, choice?: string): Promise<{ ref: string, merge: string } | null> {
  const origin = choice ? null : await git(path, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  const candidates = choice ? [choice] : [
    ...(origin?.ok ? [origin.out.trim()] : []),
    'refs/heads/main',
    'refs/heads/master',
  ]
  for (const ref of candidates) {
    if (!branchRef.test(ref) || !(await git(path, ['check-ref-format', ref])).ok) continue
    const tip = await resolveCommit(path, ref)
    if (!tip) continue
    const merge = await git(path, ['merge-base', tip, head])
    if (merge.ok && commitId.test(merge.out.trim())) return { ref, merge: merge.out.trim() }
  }
  return choice ? null : { ref: 'HEAD', merge: head }
}

export async function workspaceReviewOptions(path: string, turns: WorkspaceReviewTurn[], selectedBase?: string): Promise<WorkspaceReviewOptions> {
  const isRepository = await isWorkspaceGitRoot(path)
  const options: WorkspaceReviewOptions = {
    isRepository,
    base: null, branches: [], commits: [],
    turns: turns.map(({ id, number }) => ({ id, number })),
  }
  if (!isRepository) return options
  const head = await resolveCommit(path, 'HEAD')
  const [refs, base] = await Promise.all([
    git(path, ['for-each-ref', '--count=250', '--format=%(refname)%00%(symref)', 'refs/heads/', 'refs/remotes/']),
    head ? reviewBase(path, head, selectedBase) : null,
  ])
  options.base = base?.ref ?? null
  if (refs.ok) options.branches = refs.out.trimEnd().split('\n').flatMap((row) => {
    const [ref, symbolic] = row.split('\0')
    return ref && branchRef.test(ref) && !symbolic ? [{ ref, label: refLabel(ref) }] : []
  })
  if (head && base) {
    const log = await git(path, ['log', '-50', '--format=%H%x00%s', `${base.merge}..${head}`, '--'])
    if (log.ok) options.commits = log.out.trimEnd().split('\n').flatMap((row) => {
      const [sha, subject = ''] = row.split('\0')
      return sha && commitId.test(sha) ? [{ sha, subject }] : []
    })
  }
  return options
}

/** Null means the client already holds the immutable input revision. */
export async function reviewWorkspaceDiff(
  path: string,
  mode: WorkspaceReviewMode,
  target: string | undefined,
  turns: WorkspaceReviewTurn[],
  knownRevision?: string,
): Promise<(WorkspaceDiff & { revision?: string }) | null> {
  const scope = mode === 'uncommitted' ? 'working-tree' : mode
  const unavailable = (error: string): WorkspaceDiff => ({ isRepository: true, scope, files: [], patch: '', error })
  if (!await isWorkspaceGitRoot(path)) return { isRepository: false, scope, files: [], patch: '' }
  const head = await resolveCommit(path, 'HEAD')
  if (!head) return unavailable('Git history is unavailable for this comparison.')

  let base = head
  let tip: string | undefined
  let label: string | undefined
  let comparisonTarget: string | undefined
  if (mode === 'branch') {
    const branch = await reviewBase(path, head, target)
    if (!branch) return unavailable('This branch base is unavailable or has no common history.')
    base = branch.merge
    label = refLabel(branch.ref)
    if (branch.ref !== 'HEAD') comparisonTarget = branch.ref
  }
  else if (mode === 'commit') {
    if (!target || !commitId.test(target)
      || !(await git(path, ['merge-base', '--is-ancestor', target, head])).ok)
      return unavailable('This commit is unavailable on the current branch.')
    const parents = await git(path, ['rev-list', '--parents', '-1', target, '--'])
    if (!parents.ok) return unavailable('Could not read this commit.')
    const firstParent = parents.out.trim().split(' ')[1]
    const emptyTree = firstParent ? null : await git(path, ['hash-object', '-t', 'tree', '--stdin'])
    base = firstParent ?? emptyTree?.out.trim() ?? ''
    if (!commitId.test(base)) return unavailable('Could not read the parent tree.')
    tip = target
    label = target.slice(0, 7)
    comparisonTarget = target
  }
  else if (mode === 'turn') {
    const turn = target ? turns.find(entry => String(entry.id) === target) : turns.at(-1)
    if (!turn) return unavailable('This turn has no recorded Git comparison.')
    const [before, after] = await Promise.all([resolveCommit(path, turn.before), resolveCommit(path, turn.after)])
    if (!before || !after) return unavailable('The checkpoints for this turn are unavailable.')
    base = before
    tip = after
    label = String(turn.number)
    comparisonTarget = String(turn.id)
  }

  const workingState = tip ? '' : await reviewWorkingState(path)
  if (workingState === null) return unavailable('Could not check the working tree for changes.')
  const revision = Bun.hash(JSON.stringify([path, mode, label, comparisonTarget, base, tip ?? head, workingState])).toString(36)
  if (revision === knownRevision) return null
  // Branch and uncommitted review both include untracked files. The existing
  // checkpoint mechanism uses a temporary index and leaves the real one alone.
  const current = tip ?? await snapshotTree(path)
  if (!current) return unavailable('Could not read the current working tree.')
  const diff = await readWorkspaceDiff(path, scope, [base, current], true, label)
  return diff.error ? diff : { ...diff, revision, ...(comparisonTarget && { comparisonTarget }) }
}
