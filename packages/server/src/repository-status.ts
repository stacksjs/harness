import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { workspaceGitEnvironment } from './git-environment'

const exec = promisify(execFile)

export interface RepositoryStatus {
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  pendingPullRequest?: string
}

/** Porcelain v2 reports branch and index changes without quoting filenames. */
export function parseRepositoryStatus(output: string): RepositoryStatus {
  const status: RepositoryStatus = {
    branch: null, head: null, upstream: null, ahead: null, behind: null,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
  }
  const entries = output.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.startsWith('# branch.oid ')) {
      const head = entry.slice('# branch.oid '.length)
      if (head !== '(initial)') status.head = head
    }
    else if (entry.startsWith('# branch.head ')) {
      const branch = entry.slice('# branch.head '.length)
      if (branch !== '(detached)') status.branch = branch
    }
    else if (entry.startsWith('# branch.upstream ')) {
      status.upstream = entry.slice('# branch.upstream '.length)
    }
    else if (entry.startsWith('# branch.ab ')) {
      const counts = /^# branch\.ab \+(\d+) -(\d+)$/u.exec(entry)
      if (counts) {
        status.ahead = Number(counts[1])
        status.behind = Number(counts[2])
      }
    }
    else if (entry.startsWith('u ')) status.conflicted++
    else if (entry.startsWith('? ')) status.untracked++
    else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      if (entry[2] !== '.') status.staged++
      if (entry[3] !== '.') status.unstaged++
      // A type-2 record includes its previous filename as a second token.
      if (entry[0] === '2') index++
    }
  }
  return status
}

export async function readRepositoryStatus(path: string): Promise<RepositoryStatus | null> {
  try {
    const { stdout } = await exec('git', [
      '--no-optional-locks', '-C', path, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all',
    ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024, env: workspaceGitEnvironment() })
    return parseRepositoryStatus(stdout)
  }
  catch { return null }
}
