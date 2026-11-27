import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readIndex, replaceIndex, snapshotTree, withTemporaryIndex } from './checkpoint'
import { parseNumstat } from './diff'
import { workspaceGitEnvironment } from './git-environment'
import { readRepositoryStatus } from './repository-status'

const exec = promisify(execFile)
const checkoutOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START']

function gitEnvironment(index?: string) {
  return workspaceGitEnvironment({ GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GCM_INTERACTIVE: 'Never', LC_ALL: 'C',
    ...(index && { GIT_INDEX_FILE: index }),
  })
}

export function repositoryGit(path: string, args: string[], timeout = 5000, index?: string) {
  return exec('git', ['-C', path, ...args], {
    timeout, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment(index),
  })
}

export async function gitOperationInProgress(path: string) {
  const { stdout } = await repositoryGit(path, ['rev-parse', '--absolute-git-dir'])
  const directory = stdout.replace(/\r?\n$/u, '')
  return (await Promise.all(checkoutOperations.map(name => lstat(join(directory, name)).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })))).some(Boolean)
}

export class RepositoryCommitError extends Error {}
export class CommitGenerationError extends Error {}
export type RepositoryCommitScope = 'staged' | 'working'

export function generatedCommitMessage(value: unknown, includeBranch: boolean): { message: string, branch?: string } {
  const invalid = () => new CommitGenerationError('The provider returned an invalid commit message. Try again or enter a message.')
  if (!value || typeof value !== 'object') throw invalid()
  const { subject, body, branch } = value as Record<string, unknown>
  if (typeof subject !== 'string' || !subject.trim() || /[\r\n\0]/u.test(subject)
    || typeof body !== 'string' || body.includes('\0')
    || (includeBranch && (typeof branch !== 'string' || !branch.trim() || /[\r\n\0]/u.test(branch) || branch.length > 256)))
    throw invalid()
  const message = [subject.trim(), body.trim()].filter(Boolean).join('\n\n')
  if (Buffer.byteLength(message) > 4096) throw invalid()
  return { message, ...(includeBranch && typeof branch === 'string' && { branch: branch.trim() }) }
}

interface StagedEntry {
  path: Buffer
  mode: string
  object: string
}

function commitDiff(path: string, comparison: string[], format: string[], index?: string) {
  return exec('git', ['-C', path, 'diff', '-z', '--no-renames', '--no-ext-diff', ...format, ...comparison, '--'], {
    encoding: 'buffer', timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment(index),
  }).then(result => result.stdout)
}

const raw = ['--raw', '--no-abbrev']

function parseCommitDiff(diff: Buffer) {
  const entries: StagedEntry[] = []
  const rawRecordPrefix = ':'.charCodeAt(0)
  let offset = 0
  // Git writes raw records before numstat. Both describe the same index read.
  while (offset < diff.length && diff[offset] === rawRecordPrefix) {
    const metadataEnd = diff.indexOf(0, offset)
    if (metadataEnd < 0) throw new Error('Git returned an invalid changed file.')
    const pathEnd = diff.indexOf(0, metadataEnd + 1)
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]$/u.exec(diff.toString('ascii', offset, metadataEnd))
    if (!match || pathEnd <= metadataEnd + 1) throw new Error('Git returned an invalid changed file.')
    entries.push({ path: diff.subarray(metadataEnd + 1, pathEnd), mode: match[1]!, object: match[2]! })
    offset = pathEnd + 1
  }
  const stats = offset < diff.length ? parseNumstat(diff.toString('utf8', offset)) : null
  return { entries, records: diff.subarray(0, offset), stats }
}

async function emptyTree(path: string) {
  return withTemporaryIndex(async (environment) => {
    const index = environment.GIT_INDEX_FILE
    await repositoryGit(path, ['read-tree', '--empty'], 5000, index)
    return (await repositoryGit(path, ['write-tree'], 5000, index)).stdout.trim()
  })
}

export async function prepareRepositoryCommit(path: string, scope: RepositoryCommitScope, includeStats = false) {
  const [status, operating] = await Promise.all([readRepositoryStatus(path), gitOperationInProgress(path)])
  if (!status) throw new Error('Git could not read the repository.')
  const problem = operating || status.conflicted ? 'Finish the in-progress Git operation before committing here.'
    : !status.branch ? 'Switch to a branch before committing here.'
      : null
  let base = status.head
  let staged = Buffer.alloc(0)
  let comparison = ['--cached', ...(base ? [base] : [])]
  if (scope === 'working' && !problem) {
    const snapshot = await snapshotTree(path, [], undefined, base)
    if (!snapshot) throw new Error('Git could not read the working tree.')
    base ??= await emptyTree(path)
    comparison = [base, snapshot]
    staged = await commitDiff(path, ['--cached', base], raw)
  }
  const diff = problem ? Buffer.alloc(0) : includeStats
    ? await commitDiff(path, comparison, [...raw, '--numstat']).catch(() => commitDiff(path, comparison, raw))
    : await commitDiff(path, comparison, raw)
  const { entries, records, stats } = parseCommitDiff(diff)
  const revision = createHash('sha256').update(JSON.stringify([scope, path, status.branch, status.head, records.length]))
    .update(records).update(staged).digest('hex')
  const files = entries.map(entry => entry.path.toString())
  return {
    scope, base, head: status.head, entries, staged,
    preview: {
      branch: status.branch, revision,
      canCreateBranch: Boolean(status.head && !problem),
      problem: problem ?? (entries.length ? null : scope === 'staged' ? 'Stage files in this repository before committing.' : 'There are no working-tree changes to commit.'),
      files,
      fileKeys: entries.map(entry => entry.path.toString('base64')),
      fileStats: stats ? files.map(file => stats.get(file) ?? null) : [],
    },
  }
}

const pathTerminator = Buffer.from([0])
type PreparedCommit = Awaited<ReturnType<typeof prepareRepositoryCommit>>

function writeSelectedIndex(path: string, index: string, entries: StagedEntry[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', path, 'update-index', '-z', '--index-info'], {
      env: gitEnvironment(index), timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Git could not prepare the selected index.')))
    child.stdin.end(indexEntries(entries))
  })
}

function indexEntries(entries: StagedEntry[]) {
  return Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.object}\t`), entry.path, pathTerminator]))
}

export function sameRepositoryCommitFiles(before: PreparedCommit, after: PreparedCommit) {
  return before.head === after.head && before.staged.equals(after.staged)
    && indexEntries(before.entries).equals(indexEntries(after.entries))
}

function withSelectedCommitIndex<T>(path: string, prepared: PreparedCommit, excluded: number[],
  run: (index: string, entries: StagedEntry[], paths: Buffer, comparison: string[]) => Promise<T>) {
  if (excluded.some(index => index >= prepared.entries.length)) throw new RepositoryCommitError('Refresh the review and select the files again.')
  const omitted = new Set(excluded)
  const entries = prepared.entries.filter((_, index) => !omitted.has(index))
  if (entries.length === 0) throw new RepositoryCommitError('Include at least one file.')
  return withTemporaryIndex(async (environment) => {
    const index = environment.GIT_INDEX_FILE
    await repositoryGit(path, ['read-tree', prepared.head ?? '--empty'], 5000, index)
    await writeSelectedIndex(path, index, entries)
    const expectedPaths = Buffer.concat(entries.flatMap(entry => [entry.path, pathTerminator]))
    const comparison = ['--cached', ...(prepared.base ? [prepared.base] : [])]
    const paths = await commitDiff(path, comparison, ['--name-only'], index)
    if (!paths.equals(expectedPaths))
      throw new RepositoryCommitError('These files depend on one another. Review the selection and include the related paths.')
    return run(index, entries, expectedPaths, comparison)
  })
}

export function reviewedCommitPatch(path: string, prepared: PreparedCommit, excluded: number[]) {
  return withSelectedCommitIndex(path, prepared, excluded, async (index, _entries, _paths, comparison) => {
    const { stdout } = await repositoryGit(path, ['diff', ...comparison, '--no-ext-diff', '--no-textconv', '--no-color',
      '--no-renames', '--stat', '--patch', '--'], 5000, index).catch((error) => {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof error.stdout === 'string')
        return { stdout: error.stdout }
      throw error
    })
    return stdout.length > 50_000 ? stdout.slice(0, 50_000) + '\n[Patch truncated]' : stdout
  })
}

export async function verifyRepositoryCommit(path: string, prepared: PreparedCommit, authorize: () => boolean) {
  const latest = await prepareRepositoryCommit(path, prepared.scope)
  if (!authorize() || latest.preview.problem || latest.preview.revision !== prepared.preview.revision)
    throw new RepositoryCommitError('The checkout or selected files changed. Refresh the review before committing.')
}

async function prepareIndexUpdate(path: string, base: string, tree: string, before: Buffer | null,
  staged: Buffer, selected: Set<string>, index: string, pathspec: string) {
  if (before) await writeFile(index, before)
  else await repositoryGit(path, ['read-tree', '--empty'], 5000, index)
  await repositoryGit(path, ['--literal-pathspecs', 'reset', '--quiet', tree, `--pathspec-from-file=${pathspec}`, '--pathspec-file-nul'], 5000, index)
  const unselected = (entries: StagedEntry[]) => entries.filter(entry => !selected.has(entry.path.toString('base64')))
  const changes = await commitDiff(path, ['--cached', base], raw, index)
  if (!indexEntries(unselected(parseCommitDiff(staged).entries)).equals(indexEntries(unselected(parseCommitDiff(changes).entries))))
    throw new RepositoryCommitError('The selection conflicts with an excluded staged file. Review the related paths before committing.')
  return readIndex(index)
}

export async function createRepositoryCommit(path: string, message: string, prepared: PreparedCommit, excluded: number[], authorize: () => boolean) {
  if (prepared.scope === 'staged' && excluded.length === 0) {
    await verifyRepositoryCommit(path, prepared, authorize)
    await repositoryGit(path, ['commit', '--quiet', '--message', message], 45_000)
    return { commit: (await repositoryGit(path, ['rev-parse', '--verify', 'HEAD'])).stdout.trim() }
  }
  const working = prepared.scope === 'working' && prepared.base !== null ? prepared.base : null
  const realIndex = working ? (await repositoryGit(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trimEnd() : null
  const before = realIndex ? await readIndex(realIndex) : null
  return withSelectedCommitIndex(path, prepared, excluded, async (index, entries, expectedPaths) => {
    // Compute the new index before committing. A path replacement must leave
    // unrelated staged changes intact, even if Git's pathspec matches children.
    const reconciled = `${index}-reconciled`
    const pathspec = `${index}-paths`
    const selected = new Set(entries.map(entry => entry.path.toString('base64')))
    let tree = ''
    let next: Buffer | null = null
    if (working) {
      tree = (await repositoryGit(path, ['write-tree'], 5000, index)).stdout.trim()
      await writeFile(pathspec, expectedPaths)
      next = await prepareIndexUpdate(path, working, tree, before, prepared.staged, selected, reconciled, pathspec)
    }
    await verifyRepositoryCommit(path, prepared, authorize)

    await repositoryGit(path, ['commit', '--quiet', '--message', message], 45_000, index)
    const commit = (await repositoryGit(path, ['rev-parse', '--verify', `refs/heads/${prepared.preview.branch}`])).stdout.trim()
    if (!working || !realIndex) return { commit }
    try {
      // A hook can format or restage selected files in Git's commit index.
      const actualTree = (await repositoryGit(path, ['rev-parse', `${commit}^{tree}`])).stdout.trim()
      if (actualTree !== tree) {
        await rm(reconciled, { force: true })
        next = await prepareIndexUpdate(path, working, actualTree, before, prepared.staged, selected, reconciled, pathspec)
      }
      const [active, head] = await Promise.all([
        repositoryGit(path, ['symbolic-ref', '--quiet', 'HEAD']), repositoryGit(path, ['rev-parse', '--verify', 'HEAD']),
      ])
      if (active.stdout.trim() === `refs/heads/${prepared.preview.branch}` && head.stdout.trim() === commit
        && next && await replaceIndex(realIndex, before, next))
        return { commit }
    }
    catch { /* The commit already exists. Leave the live index available for review. */ }
    return { commit, warning: 'Review the Git index. Its staged state could not be updated after the commit.' }
  })
}

export async function readRepositoryBody(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return null
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let input = ''
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) return null
      input += decoder.decode(chunk.value, { stream: true })
    }
    return input + decoder.decode()
  }
  catch { return null }
  finally { void reader.cancel().catch(() => {}) }
}

export async function readRepositoryInput(request: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  if (request.headers.get('content-type') !== 'application/json') return null
  const input = await readRepositoryBody(request, maxBytes)
  if (input === null) return null
  try {
    const value = JSON.parse(input)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  }
  catch { return null }
}

export async function readRepositorySubmission(request: Request, commit: boolean) {
  const value = await readRepositoryInput(request, commit ? 131_072 : 24_576)
  const revision = value?.revision
  const message = typeof value?.message === 'string' ? value.message.trim() : ''
  const excluded = commit && value?.excluded !== undefined ? value.excluded : []
  const newBranch = commit ? value?.newBranch ?? false : false
  const generate = commit ? value?.generate ?? null : null
  return typeof revision === 'string' && /^[0-9a-f]{64}$/u.test(revision)
    && Array.isArray(excluded) && excluded.every(index => Number.isSafeInteger(index) && index >= 0)
    && typeof newBranch === 'boolean' && (generate === null || (typeof generate === 'string' && /^[0-9a-f]{64}$/u.test(generate) && !message))
    && Buffer.byteLength(message) <= 4096 && !message.includes('\0')
    ? { revision, message, excluded, newBranch, generate } : null
}
