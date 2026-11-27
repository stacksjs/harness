import type { GitBranchAttempt } from '@harness/contract'
import { gitOperationInProgress, repositoryGit, RepositoryCommitError } from './repository-commit'

function localRef(branch: string) {
  return 'refs/heads/' + branch
}

function creationMessage(attempt: GitBranchAttempt) {
  return 'harness: prepare feature branch ' + attempt.id
}

export async function planRepositoryBranch(path: string, repositoryKey: string, from: string, base: string, message: string, suggestion?: string): Promise<GitBranchAttempt> {
  const subject = suggestion || (message.split(/\r?\n/u, 1)[0] ?? '')
  const fragment = subject.normalize('NFKD').replace(/[\u0300-\u036f'"`]/gu, '').toLowerCase()
    .replace(/^[./\s_-]+|[./\s_-]+$/gu, '').replace(/[^a-z0-9/_-]+/gu, '-')
    .replace(/\/{2,}/gu, '/').replace(/-{2,}/gu, '-').replace(/^[./_-]+|[./_-]+$/gu, '')
    .slice(0, 64).replace(/[./_-]+$/gu, '') || 'update'
  const preferred = fragment.includes('/') ? fragment : 'feature/' + fragment
  const names = new Set((await repositoryGit(path, ['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads']))
    .stdout.toLowerCase().split('\n'))
  const namespaces = new Set<string>()
  for (const name of names) {
    for (let slash = name.indexOf('/'); slash !== -1; slash = name.indexOf('/', slash + 1))
      namespaces.add(name.slice(0, slash))
  }
  const parts = preferred.split('/')
  let to = ''
  for (const [index, part] of parts.entries()) {
    const prefix = to ? to + '/' + part : part
    to = prefix
    for (let suffix = 2; names.has(to) || (index === parts.length - 1 && namespaces.has(to)); suffix++)
      to = prefix + '-' + suffix
  }
  return { path, repositoryKey, from, to, base, id: crypto.randomUUID() }
}

async function resolveRef(path: string, ref: string) {
  return (await repositoryGit(path, ['rev-parse', '--verify', '--quiet', ref]).catch(() => null))?.stdout.trim()
}

async function activeRef(path: string) {
  return (await repositoryGit(path, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => null))?.stdout.trim()
}

async function switchBranch(path: string, branch: string) {
  // Both refs point at the same commit. Run commit hooks in the normal Git
  // commit below, without running checkout hooks for this bookkeeping step.
  await repositoryGit(path, ['-c', 'core.hooksPath=/dev/null', 'switch', '--quiet', '--no-guess', '--', branch], 15_000)
}

export async function startRepositoryBranch(attempt: GitBranchAttempt, authorize: () => boolean) {
  const { path, from, to, base } = attempt
  const current = async () => await activeRef(path) === localRef(from) && await resolveRef(path, localRef(from)) === base
  if (!await current() || !authorize())
    throw new RepositoryCommitError('The checkout changed. Refresh the review before creating the branch.')
  // Create only if absent, even when someone adds the same name after review.
  const absent = '0'.repeat(base.length)
  await repositoryGit(path, ['update-ref', '--create-reflog', '-m', creationMessage(attempt), localRef(to), base, absent])
  if (!await current() || !authorize())
    throw new RepositoryCommitError('The checkout changed. Refresh the review before committing.')
  await switchBranch(path, to)
}

/** Resolve a pending attempt after normal completion or a host restart. */
export async function reconcileRepositoryBranch(attempt: GitBranchAttempt, verify: (branch: string) => Promise<boolean>, authorize: () => boolean) {
  const { path, from, to, base } = attempt
  const fromRef = localRef(from)
  const toRef = localRef(to)
  const active = await activeRef(path)
  if ((active !== fromRef && active !== toRef) || !await verify(active === toRef ? to : from)) return false
  const reflog = (await repositoryGit(path, ['reflog', 'show', '--format=%gs', toRef]).catch(() => null))?.stdout.trimEnd().split('\n')
  if (reflog?.at(-1) !== creationMessage(attempt)) return false
  // Keep an advanced branch. Reflog entries can also show intervening work
  // when the branch has since been reset to the original commit.
  if (reflog.length !== 1 || await resolveRef(path, toRef) !== base) return active === toRef
  if (!authorize() || await gitOperationInProgress(path) || !authorize()) return active === toRef
  if (active === toRef) {
    try {
      if (await resolveRef(path, fromRef) !== base || await activeRef(path) !== toRef || !authorize()) return true
      await switchBranch(path, from)
    }
    catch { return await activeRef(path) === toRef }
  }
  // Never delete a branch now in use in another worktree or one that moved
  // since inspection. Git's expected-value check protects the ref itself.
  const registrations = await repositoryGit(path, ['worktree', 'list', '--porcelain', '-z']).catch(() => null)
  if (registrations && !registrations.stdout.split('\0').includes('branch ' + toRef) && authorize())
    await repositoryGit(path, ['update-ref', '-d', toRef, base]).catch(() => {})
  return false
}
