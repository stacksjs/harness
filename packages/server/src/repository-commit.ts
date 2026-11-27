import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { readRepositoryStatus } from './repository-status'

const exec = promisify(execFile)
const checkoutOperations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START']

function git(path: string, args: string[], timeout = 5000) {
  return exec('git', ['-C', path, ...args], {
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' },
  })
}

export async function stagedCommitPreview(path: string) {
  const [status, diff, directory] = await Promise.all([
    readRepositoryStatus(path),
    git(path, ['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff']),
    git(path, ['rev-parse', '--absolute-git-dir']),
  ])
  if (!status) throw new Error('Git could not read the repository.')
  const gitDirectory = directory.stdout.replace(/\r?\n$/u, '')
  const operating = (await Promise.all(checkoutOperations.map(name => lstat(join(gitDirectory, name)).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw error
  })))).some(Boolean)
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
  await git(path, ['commit', '--quiet', '--message', message], 45_000)
  const { stdout } = await git(path, ['rev-parse', '--verify', 'HEAD'])
  return stdout.trim()
}

export async function readCommitSubmission(request: Request): Promise<{ revision: string, message: string } | null> {
  if (request.headers.get('content-type') !== 'application/json' || !request.body) return null
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let input = ''
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 24_576) return null
      input += decoder.decode(chunk.value, { stream: true })
    }
    const value = JSON.parse(input + decoder.decode())
    const revision = value?.revision
    const message = typeof value?.message === 'string' ? value.message.trim() : ''
    return typeof revision === 'string' && /^[0-9a-f]{64}$/u.test(revision)
      && message && Buffer.byteLength(message) <= 4096 && !message.includes('\0') ? { revision, message } : null
  }
  catch { return null }
  finally { void reader.cancel().catch(() => {}) }
}
