import type { HarnessState } from '@harness/engine'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { parsePullRequest } from './prompt-links'

type PullRequest = NonNullable<ReturnType<typeof parsePullRequest>>

const exec = promisify(execFile)

export function findPullRequestThread(state: HarnessState, pull: PullRequest) {
  let match
  for (const session of state.sessions.values()) {
    const workspace = state.workspaces.get(session.workspaceId)
    if (!workspace?.trusted || session.navigation?.archivedAt
      || session.pullRequest?.repository.toLowerCase() !== pull.repository.toLowerCase()
      || session.pullRequest.number !== pull.number) continue
    if (!match || (session.lastActivityAt ?? 0) >= (match.lastActivityAt ?? 0)) match = session
  }
  return match
}

/** Fetch just the PR head without updating the current checkout or tracking branches. */
export async function fetchPullRequest(path: string, remote: string, pull: PullRequest): Promise<string | null> {
  const repository = createHash('sha256').update(pull.repository.toLowerCase()).digest('hex')
  const ref = 'refs/harness/pull-requests/' + repository + '/' + pull.number
  const git = (args: string[], timeout: number) => exec('git', ['-C', path, ...args], {
    timeout, maxBuffer: 32 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  })
  try {
    await git([
      'fetch', '--no-write-fetch-head', '--no-tags', '--no-recurse-submodules', '--no-auto-maintenance',
      '--', remote, '+refs/pull/' + pull.number + '/head:' + ref,
    ], 45_000)
    const { stdout } = await git(['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], 3000)
    const commit = stdout.trim()
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit) ? commit : null
  }
  catch { return null }
}
