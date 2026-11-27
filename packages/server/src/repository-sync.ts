import { createHash } from 'node:crypto'
import { gitOperationInProgress, repositoryGit } from './repository-commit'
import { readRepositoryStatus } from './repository-status'
import type { RepositoryStatus } from './repository-status'

export type RepositorySyncAction = 'pull' | 'push'

function dirty(status: RepositoryStatus) {
  return Boolean(status.staged || status.unstaged || status.untracked || status.conflicted)
}

export class RepositorySyncError extends Error {}

async function gitConfig(path: string, name: string): Promise<string> {
  return (await repositoryGit(path, ['config', '--get', name]).catch(() => null))?.stdout.trimEnd() ?? ''
}

async function pushRemoteName(path: string, branch: string, upstream = ''): Promise<string> {
  const [list, override, fallback] = await Promise.all([
    repositoryGit(path, ['remote']),
    branch ? gitConfig(path, 'branch.' + branch + '.pushRemote') : '',
    gitConfig(path, 'remote.pushDefault'),
  ])
  const names = list.stdout.trim().split('\n').filter(Boolean)
  const remote = override || fallback || upstream || (names.includes('origin') ? 'origin' : names.length === 1 ? names[0]! : '')
  return remote && !remote.startsWith('-') && names.includes(remote) ? remote : ''
}

async function remoteDestination(path: string, remote: string, action: RepositorySyncAction) {
  const urls = (await repositoryGit(path, [
    'remote', 'get-url', ...(action === 'push' ? ['--push'] : []), '--all', '--', remote,
  ])).stdout.trim().split('\n')
  return urls.length === 1 && urls[0]
    ? createHash('sha256').update(JSON.stringify([remote, urls[0]])).digest('hex')
    : ''
}

/** The future branch has no upstream. Its name-specific config can only be checked after generation. */
export async function featureBranchDestination(path: string, branch = '') {
  const remote = await pushRemoteName(path, branch)
  const destinationKey = remote ? await remoteDestination(path, remote, 'push') : ''
  return { remote, destinationKey, problem: !remote ? 'Configure a named Git remote before pushing a feature branch.'
    : !destinationKey ? 'Configure a single URL for this remote.' : null }
}

export async function repositorySyncPreview(path: string, action: RepositorySyncAction) {
  const [status, operating] = await Promise.all([readRepositoryStatus(path), gitOperationInProgress(path)])
  if (!status) throw new Error('Git could not read the repository.')
  const { branch, head } = status
  const base = { branch, trackingRef: '', head, remote: '', ref: '', revision: '', destinationKey: '', firstPush: false, defaultTarget: false }
  if (!branch || !head) return { ...base, problem: 'Check out a branch with at least one commit.' }
  if (operating || status.conflicted) return { ...base, problem: 'Finish the in-progress Git operation first.' }
  const branchRef = 'refs/heads/' + branch
  const { stdout: refs } = await repositoryGit(path, [
    'for-each-ref', '--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream)', branchRef,
  ])
  const [, trackedRemote = '', trackedRef = '', upstream = ''] = refs.split('\n').map(line => line.split('\0')).find(([ref]) => ref === branchRef) ?? []
  const firstPush = !status.upstream && action === 'push'
  const remote = action === 'push' ? await pushRemoteName(path, branch, trackedRemote) : trackedRemote
  const isUpstreamBranch = branchRef === trackedRef || (upstream === 'refs/remotes/' + branch && trackedRemote !== '.')
  const ref = action === 'pull' || isUpstreamBranch ? trackedRef : branchRef
  const targetsUpstream = Boolean(status.upstream && remote === trackedRemote && ref === trackedRef)
  if (!remote || remote === '.' || remote.startsWith('-') || !ref.startsWith('refs/heads/')) {
    return { ...base, problem: action === 'push'
      ? 'Configure a named Git remote for this branch before pushing.'
      : 'Set a remote upstream for this branch first.' }
  }
  const destinationKey = await remoteDestination(path, remote, action)
  const trackingPrefix = 'refs/remotes/' + remote + '/'
  const trackingRef = targetsUpstream && upstream.startsWith(trackingPrefix) ? upstream : ''
  const remoteHead = action === 'push'
    ? (await repositoryGit(path, ['symbolic-ref', '--quiet', trackingPrefix + 'HEAD']).catch(() => null))?.stdout.trim()
    : undefined
  const defaultTarget = remoteHead === (trackingRef || trackingPrefix + ref.slice('refs/heads/'.length))
  const problem = !destinationKey ? 'Configure a single URL for this remote.'
    : action === 'pull' && dirty(status) ? 'Commit or stash working changes before pulling.'
      : targetsUpstream && (status.behind ?? 0) > 0 && (status.ahead ?? 0) > 0
        ? 'The branch has diverged. Merge or rebase it in Git before syncing.'
        : targetsUpstream && (status.behind ?? 0) > 0 && action === 'push' ? 'Pull the upstream changes before pushing.' : null
  const revision = createHash('sha256').update(JSON.stringify([path, action, branch, head, remote, ref, trackingRef, destinationKey, firstPush, defaultTarget])).digest('hex')
  return { branch, trackingRef, head, remote, ref, revision, destinationKey, firstPush, defaultTarget, problem }
}

export async function syncRepository(path: string, action: RepositorySyncAction, preview: Pick<Awaited<ReturnType<typeof repositorySyncPreview>>,
  'branch' | 'head' | 'remote' | 'ref' | 'trackingRef' | 'firstPush' | 'revision'>,
  authorize: () => boolean, createRemoteBranch = false) {
  const { branch, head, remote, ref, trackingRef, firstPush } = preview
  if (!branch || !head || !authorize()) throw new RepositorySyncError('The checkout is no longer available for this Git operation.')
  if (action === 'push') {
    try {
      await repositoryGit(path, [
        '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', '-c', 'remote.' + remote + '.mirror=false',
        'push', '--porcelain', '--no-follow-tags', ...(createRemoteBranch ? ['--force-with-lease=' + ref + ':'] : []),
        '--', remote, head + ':' + ref,
      ], 45_000)
    }
    catch (error) {
      const output = (error as { stdout?: string })?.stdout ?? ''
      if (createRemoteBranch && /\(stale info\)/u.test(output))
        throw new RepositorySyncError('The remote already has that branch. Review the destination before pushing it.')
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
