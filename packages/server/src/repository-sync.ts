import { createHash } from 'node:crypto'
import { gitOperationInProgress, repositoryGit } from './repository-commit'
import { readRepositoryStatus } from './repository-status'
import type { RepositoryStatus } from './repository-status'

export type RepositorySyncAction = 'pull' | 'push'

function dirty(status: RepositoryStatus) {
  return Boolean(status.staged || status.unstaged || status.untracked || status.conflicted)
}

export class RepositorySyncError extends Error {}

export async function repositorySyncPreview(path: string, action: RepositorySyncAction) {
  const [status, operating] = await Promise.all([readRepositoryStatus(path), gitOperationInProgress(path)])
  if (!status) throw new Error('Git could not read the repository.')
  const { branch, head } = status
  const base = { branch, trackingRef: '', head, remote: '', ref: '', revision: '', firstPush: false, defaultTarget: false }
  if (!branch || !head) return { ...base, problem: 'Check out a branch with at least one commit.' }
  if (operating || status.conflicted) return { ...base, problem: 'Finish the in-progress Git operation first.' }
  const branchRef = 'refs/heads/' + branch
  const { stdout: refs } = await repositoryGit(path, [
    'for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', branchRef,
  ])
  const [, trackedRemote = '', trackedRef = '', upstream = ''] = refs.split('\n').map(line => line.split('\0')).find(([ref]) => ref === branchRef) ?? []
  const firstPush = !status.upstream && action === 'push'
  let remote = trackedRemote
  let ref = trackedRef
  if (firstPush) {
    const remotes = (await repositoryGit(path, ['remote'])).stdout.trim().split('\n').filter(Boolean)
    remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : ''
    ref = branchRef
  }
  if (!remote || remote === '.' || remote.startsWith('-') || !ref.startsWith('refs/heads/')) {
    return { ...base, problem: firstPush
      ? 'Set an upstream or configure an origin remote before pushing.'
      : 'Set a remote upstream for this branch first.' }
  }
  const destination = (await repositoryGit(path, [
    'remote', 'get-url', ...(action === 'push' ? ['--push'] : []), '--all', '--', remote,
  ])).stdout.trim().split('\n')
  const trackingPrefix = 'refs/remotes/' + remote + '/'
  const trackingRef = upstream.startsWith(trackingPrefix) ? upstream : ''
  const remoteHead = action === 'push'
    ? (await repositoryGit(path, ['symbolic-ref', '--quiet', trackingPrefix + 'HEAD']).catch(() => null))?.stdout.trim()
    : undefined
  const defaultTarget = remoteHead === (trackingRef || trackingPrefix + ref.slice('refs/heads/'.length))
  const problem = destination.length !== 1 || !destination[0] ? 'Configure a single URL for this remote.'
    : action === 'pull' && dirty(status) ? 'Commit or stash working changes before pulling.'
      : (status.behind ?? 0) > 0 && (status.ahead ?? 0) > 0
        ? 'The branch has diverged. Merge or rebase it in Git before syncing.'
        : (status.behind ?? 0) > 0 && action === 'push' ? 'Pull the upstream changes before pushing.' : null
  const revision = createHash('sha256').update(JSON.stringify([path, action, branch, head, remote, ref, trackingRef, destination, firstPush, defaultTarget])).digest('hex')
  return { branch, trackingRef, head, remote, ref, revision, firstPush, defaultTarget, problem }
}

export async function syncRepository(path: string, action: RepositorySyncAction, preview: Awaited<ReturnType<typeof repositorySyncPreview>>,
  authorize: () => boolean) {
  const { branch, head, remote, ref, trackingRef, firstPush } = preview
  if (!branch || !head || !authorize()) throw new RepositorySyncError('The checkout is no longer available for this Git operation.')
  if (action === 'push') {
    try {
      await repositoryGit(path, [
        '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'remote.' + remote + '.mirror=false',
        'push', '--porcelain', '--no-follow-tags', '--', remote, head + ':' + ref,
      ], 45_000)
    }
    catch (error) {
      const output = (error as { stdout?: string })?.stdout ?? ''
      if (/\((?:fetch first|non-fast-forward)\)/u.test(output))
        throw new RepositorySyncError('The remote branch moved. Pull or integrate its changes before pushing again.')
      throw error
    }
    let warning
    if (firstPush && authorize()) {
      const current = await readRepositoryStatus(path)
      if (current?.branch === branch && current.head === head && !current.upstream) {
        try {
          await repositoryGit(path, ['branch', '--set-upstream-to=' + remote + '/' + ref.slice('refs/heads/'.length), '--', branch])
        }
        catch { warning = 'Pushed successfully. Set this branch’s upstream in Git to enable tracking.' }
      }
    }
    return { message: warning ?? 'Pushed to ' + remote + '/' + ref.slice('refs/heads/'.length) + '.' }
  }

  const temporaryRef = 'refs/harness/sync/' + crypto.randomUUID()
  try {
    await repositoryGit(path, [
      'fetch', '--no-write-fetch-head', '--no-tags', '--no-recurse-submodules', '--no-prune', '--no-auto-maintenance', '--refmap=', '--',
      remote, ref + ':' + temporaryRef, ...(trackingRef ? ['+' + ref + ':' + trackingRef] : []),
    ], 45_000)
    const { stdout } = await repositoryGit(path, ['rev-parse', '--verify', temporaryRef + '^{commit}'])
    const fetched = stdout.trim()
    const afterFetch = await repositorySyncPreview(path, action)
    if (!authorize() || afterFetch.revision !== preview.revision || afterFetch.problem)
      throw new RepositorySyncError(afterFetch.problem ?? 'The checkout changed during the fetch. Review the branch and try again.')
    if (fetched === head) return { message: 'The branch is up to date.' }
    if (await repositoryGit(path, ['merge-base', '--is-ancestor', fetched, head]).then(() => true, () => false))
      return { message: 'The branch already contains the upstream commits.' }
    if (!await repositoryGit(path, ['merge-base', '--is-ancestor', head, fetched]).then(() => true, () => false))
      throw new RepositorySyncError('The branch has diverged. Merge or rebase it in Git before pulling again.')
    if (!authorize()) throw new RepositorySyncError('The checkout is no longer available for this pull.')
    await repositoryGit(path, ['merge', '--ff-only', '--no-edit', '--no-autostash', fetched], 45_000)
    return { message: 'Pulled from ' + remote + '/' + ref.slice('refs/heads/'.length) + '.' }
  }
  finally { await repositoryGit(path, ['update-ref', '-d', temporaryRef]).catch(() => {}) }
}
