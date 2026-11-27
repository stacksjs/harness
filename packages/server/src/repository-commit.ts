import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readRepositoryStatus } from './repository-status'

const exec = promisify(execFile)
const checkoutOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START']

export function repositoryGit(path: string, args: string[], timeout = 5000) {
  return exec('git', ['-C', path, ...args], {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GCM_INTERACTIVE: 'Never', LC_ALL: 'C' },
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

export async function stagedCommitPreview(path: string) {
  const [status, diff, operating] = await Promise.all([
    readRepositoryStatus(path),
    repositoryGit(path, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff']),
    gitOperationInProgress(path),
  ])
  if (!status) throw new Error('Git could not read the repository.')
  const records = diff.stdout.split('\0')
  const files = records.filter((record, index) => index % 2 === 1 && record.length > 0)
  const revision = createHash('sha256').update(JSON.stringify([path, status.branch, status.head, diff.stdout])).digest('hex')
  const problem = operating || status.conflicted ? 'Finish the in-progress Git operation before committing here.'
    : !status.branch ? 'Switch to a branch before committing here.'
      : !files.length ? 'Stage files in this repository before committing.' : null
  return { branch: status.branch, files, revision, problem }
}

export async function createStagedCommit(path: string, message: string) {
  // Use the checkout's index, identity, hooks and signing configuration.
  await repositoryGit(path, ['commit', '--quiet', '--message', message], 45_000)
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

export async function readRepositorySubmission(request: Request): Promise<{ revision: string, message: string } | null> {
  const value = await readRepositoryInput(request, 24_576)
  const revision = value?.revision
  const message = typeof value?.message === 'string' ? value.message.trim() : ''
  return typeof revision === 'string' && /^[0-9a-f]{64}$/u.test(revision)
    && Buffer.byteLength(message) <= 4096 && !message.includes('\0') ? { revision, message } : null
}
