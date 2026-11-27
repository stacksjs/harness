import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parseNumstat } from './diff'
import { readRepositoryStatus } from './repository-status'

const exec = promisify(execFile)
const checkoutOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START']

function gitEnvironment(index?: string) {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GCM_INTERACTIVE: 'Never', LC_ALL: 'C',
    ...(index && { GIT_INDEX_FILE: index }),
  }
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

interface StagedEntry {
  path: Buffer
  mode: string
  object: string
}

function stagedDiff(path: string, format: string[], index?: string) {
  return exec('git', ['-C', path, 'diff', '--cached', '-z', '--no-renames', '--no-ext-diff', ...format], {
    encoding: 'buffer', timeout: 5000, maxBuffer: 2 * 1024 * 1024, env: gitEnvironment(index),
  }).then(result => result.stdout)
}

export async function prepareStagedCommit(path: string, includeStats = false) {
  const raw = ['--raw', '--no-abbrev']
  const [status, diff, operating] = await Promise.all([
    readRepositoryStatus(path),
    includeStats ? stagedDiff(path, [...raw, '--numstat']).catch(() => stagedDiff(path, raw)) : stagedDiff(path, raw),
    gitOperationInProgress(path),
  ])
  if (!status) throw new Error('Git could not read the repository.')
  const entries: StagedEntry[] = []
  const rawRecordPrefix = ':'.charCodeAt(0)
  let offset = 0
  // Git writes raw records before numstat. Both describe the same index read.
  while (offset < diff.length && diff[offset] === rawRecordPrefix) {
    const metadataEnd = diff.indexOf(0, offset)
    if (metadataEnd < 0) throw new Error('Git returned an invalid staged file.')
    const pathEnd = diff.indexOf(0, metadataEnd + 1)
    const match = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) [A-Z]$/u.exec(diff.toString('ascii', offset, metadataEnd))
    if (!match || pathEnd <= metadataEnd + 1) throw new Error('Git returned an invalid staged file.')
    entries.push({ path: diff.subarray(metadataEnd + 1, pathEnd), mode: match[1]!, object: match[2]! })
    offset = pathEnd + 1
  }
  const revision = createHash('sha256').update(JSON.stringify([path, status.branch, status.head])).update(diff.subarray(0, offset)).digest('hex')
  const files = entries.map(entry => entry.path.toString())
  const stats = offset < diff.length ? parseNumstat(diff.toString('utf8', offset)) : null
  const problem = operating || status.conflicted ? 'Finish the in-progress Git operation before committing here.'
    : !status.branch ? 'Switch to a branch before committing here.'
      : !entries.length ? 'Stage files in this repository before committing.' : null
  return {
    head: status.head, entries,
    preview: {
      branch: status.branch, revision, problem,
      files,
      fileKeys: entries.map(entry => entry.path.toString('base64')),
      fileStats: stats ? files.map(file => stats.get(file) ?? null) : [],
    },
  }
}

const pathTerminator = Buffer.from([0])

function writeSelectedIndex(path: string, index: string, entries: StagedEntry[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', path, 'update-index', '-z', '--index-info'], {
      env: gitEnvironment(index), timeout: 5000, stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.stdin.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Git could not prepare the selected index.')))
    child.stdin.end(Buffer.concat(entries.flatMap(entry => [Buffer.from(`${entry.mode} ${entry.object}\t`), entry.path, pathTerminator])))
  })
}

export async function createStagedCommit(path: string, message: string, prepared: Awaited<ReturnType<typeof prepareStagedCommit>>,
  excluded: number[], authorize: () => boolean) {
  // Use the checkout's index, identity, hooks and signing configuration.
  if (excluded.length === 0) {
    await repositoryGit(path, ['commit', '--quiet', '--message', message], 45_000)
  }
  else {
    const omitted = new Set(excluded)
    if (excluded.some(index => index >= prepared.entries.length)) throw new RepositoryCommitError('Refresh the review and select the staged files again.')
    const entries = prepared.entries.filter((_, index) => !omitted.has(index))
    if (entries.length === 0) throw new RepositoryCommitError('Include at least one staged file.')
    const temporary = await mkdtemp(join(tmpdir(), 'harness-commit-'))
    try {
      const index = join(temporary, 'index')
      // Commit the reviewed blobs. The real index already has these entries,
      // so changing HEAD leaves the excluded entries staged without rewriting it.
      await repositoryGit(path, ['read-tree', prepared.head ?? '--empty'], 5000, index)
      await writeSelectedIndex(path, index, entries)
      const paths = await stagedDiff(path, ['--name-only', ...(prepared.head ? [prepared.head] : [])], index)
      if (!paths.equals(Buffer.concat(entries.flatMap(entry => [entry.path, pathTerminator]))))
        throw new RepositoryCommitError('These staged paths depend on one another. Review the selection and include the related files.')
      const latest = await prepareStagedCommit(path)
      if (!authorize() || latest.preview.problem || latest.preview.revision !== prepared.preview.revision)
        throw new RepositoryCommitError('The checkout or staged files changed. Refresh the review before committing.')
      await repositoryGit(path, ['commit', '--quiet', '--message', message], 45_000, index)
    }
    finally { await rm(temporary, { recursive: true, force: true }).catch(() => {}) }
  }
  const { stdout } = await repositoryGit(path, ['rev-parse', '--verify', 'HEAD'])
  return stdout.trim()
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

export async function readRepositorySubmission(request: Request, commit: boolean): Promise<{ revision: string, message: string, excluded: number[] } | null> {
  const value = await readRepositoryInput(request, commit ? 131_072 : 24_576)
  const revision = value?.revision
  const message = typeof value?.message === 'string' ? value.message.trim() : ''
  const excluded = commit && value?.excluded !== undefined ? value.excluded : []
  return typeof revision === 'string' && /^[0-9a-f]{64}$/u.test(revision)
    && Array.isArray(excluded) && excluded.every(index => Number.isSafeInteger(index) && index >= 0)
    && Buffer.byteLength(message) <= 4096 && !message.includes('\0') ? { revision, message, excluded } : null
}
