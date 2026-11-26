import type { CombinedWorktreeIntent, WorktreeSelection } from '@harness/contract'
import { lstat, mkdir, readdir, readlink, realpath, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isWorkspaceGitRoot } from './diff'
import { projectWorktreeLayout, resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import type { WorktreeOpenMode } from './worktree'
import { branchFor, checkoutBase, includesCheckoutBase, isCleanForLayoutRemoval, openReserved, release, remove } from './worktree'
import { clearWorktreeLayoutReceipts, runWorktreeLayout, worktreeLayoutOutcome } from './worktree-layout'

type Checkout = CombinedWorktreeIntent['checkouts'][number]
type LayoutLink = CombinedWorktreeIntent['links'][number]

function within(parent: string, target: string): boolean {
  const path = relative(parent, target)
  return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function sharedLinks(source: string, target: string, excluded: string[]): Promise<LayoutLink[]> {
  const links: LayoutLink[] = []
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === '.git') continue
    const original = join(source, entry.name)
    const path = join(target, entry.name)
    if (excluded.includes(original)) continue
    if (entry.isDirectory() && excluded.some(repo => within(original, repo))) {
      links.push(...await sharedLinks(original, path, excluded))
    }
    else if (entry.isFile() || entry.isDirectory()) links.push({ source: original, path })
    else if (entry.isSymbolicLink()) {
      const linked = await realpath(original).catch(() => null)
      if (linked && within(source, linked)) links.push({ source: original, path })
    }
  }
  return links
}

export async function planCombinedWorktree(source: string, storage: string, sessionId: number, selection?: WorktreeSelection,
  fork?: CombinedWorktreeIntent): Promise<CombinedWorktreeIntent | null> {
  const repository = await realpath(source).catch(() => null)
  if (!repository) return null
  const layout = fork ? null : await projectWorktreeLayout(repository)
  const discovered = fork ? fork.checkouts.filter(checkout => checkout.key) : await scanProjectRepositories(repository)
  if (!fork && !layout && !discovered.length && !selection?.repositories?.length) return null
  const requested = fork || selection?.repositories === undefined
    ? (fork || discovered.length <= 8 ? discovered.map(repo => repo.key) : [])
    : [...new Set(selection.repositories)]
  const baseDirectory = await realpath(dirname(storage))
  const storagePath = join(baseDirectory, basename(storage))
  const path = join(storagePath, `${sessionId}-${crypto.randomUUID()}`, 'project')
  const branch = branchFor(sessionId)
  const checkouts: Checkout[] = []
  if (await isWorkspaceGitRoot(repository)) {
    const base = await checkoutBase(repository, fork ? 'HEAD' : selection?.baseBranch, !fork)
    if (base) checkouts.push({ key: '', label: 'Project root', repository, path, branch, base })
  }
  for (const key of requested) {
    const repo = discovered.find(row => row.key === key)
    const worktree = fork?.checkouts.find(row => row.key === key)
    const original = worktree ? (await openReserved(worktree, false, dirname(fork!.path))).path
      : repo && await resolveProjectRepository(repository, key)
    if (!repo || !original || !await isWorkspaceGitRoot(original))
      throw new Error('A selected project repository is unavailable. Check Git and the project folders.')
    const base = await checkoutBase(original, fork ? 'HEAD' : selection?.baseBranch, !fork)
    if (base) checkouts.push({ key, label: repo.label, repository: original, path: join(path, key), branch, base })
  }
  checkouts.sort((a, b) => a.path.length - b.path.length)
  const links = layout || checkouts.some(checkout => !checkout.key) ? []
    : fork ? fork.links.map(link => ({ source: link.source, path: join(path, relative(fork.path, link.path)) }))
      : await sharedLinks(repository, path, [storagePath, ...discovered.map(repo => join(repository, repo.key))])
  return {
    repository, path, branch, checkouts, links,
    ...(layout && { layout: { fingerprint: layout.fingerprint, baseBranch: selection?.baseBranch } }),
  }
}

function marker(root: string): string { return join(root, '.harness-owner') }

async function ownedRoot(intent: CombinedWorktreeIntent, create: boolean): Promise<string | null> {
  const root = dirname(intent.path)
  const parent = dirname(root)
  if (create) {
    await mkdir(parent).catch((error) => { if (error.code !== 'EEXIST') throw error })
    if (await realpath(parent) !== parent) return null
    await mkdir(root).catch((error) => { if (error.code !== 'EEXIST') throw error })
  }
  if (await realpath(root).catch(() => null) !== root) return null
  const ownerFile = marker(root)
  const state = await lstat(ownerFile).catch(() => null)
  if (state?.isFile() && state.size === Buffer.byteLength(root))
    return await Bun.file(ownerFile).text() === root ? root : null
  if (!create || state || (await readdir(root)).length !== 0) return null
  await writeFile(ownerFile, root, { flag: 'wx' })
  return root
}

async function prepareDirectory(root: string, path: string): Promise<boolean> {
  if (path === root) return true
  if (!within(root, path)) return false
  let current = root
  for (const component of relative(root, path).split(sep)) {
    current = join(current, component)
    await mkdir(current).catch((error) => { if (error.code !== 'EEXIST') throw error })
    if (await realpath(current) !== current || !(await lstat(current)).isDirectory()) return false
  }
  return true
}

async function verifyLayout(intent: CombinedWorktreeIntent, root: string, checkBases = false): Promise<boolean> {
  if (await ownedRoot(intent, false) !== root || await realpath(intent.path).catch(() => null) !== intent.path) return false
  if (!(await lstat(intent.path)).isDirectory()) return false
  for (const checkout of intent.checkouts) {
    if (!(await openReserved(checkout, false, root)).path || (checkBases && !await includesCheckoutBase(checkout))) return false
  }
  return true
}

async function rollbackCleanLayoutCheckouts(intent: CombinedWorktreeIntent, root: string): Promise<void> {
  if (await ownedRoot(intent, false) !== root) return
  for (const checkout of [...intent.checkouts].reverse()) {
    if (!await lstat(checkout.path).catch(() => null)) continue
    if (!(await openReserved(checkout, false, root)).path || !await isCleanForLayoutRemoval(checkout.path, [])) return
    if (!(await remove(checkout.repository, checkout.path)).ok) return
  }
}

/** Startup only adopts a full layout. Recovery uses the recorded checkout paths. */
export async function openCombinedWorktree(intent: CombinedWorktreeIntent, mode: WorktreeOpenMode,
  authorize = () => false, signal?: AbortSignal, beforeRestore?: () => void): Promise<boolean> {
  const create = mode === true
  const recover = typeof mode === 'string'
  if (create && intent.layout && !authorize())
    throw new Error('This project uses a worktree layout command. Start its first turn from the trusted Harness host.')
  try {
    const restorePaths = recover && authorize() && !intent.layout
    const root = await ownedRoot(intent, create || restorePaths)
    if (!root) return false
    if (intent.layout) {
      if (create) {
        const outcome = await worktreeLayoutOutcome(intent, 'create')
        try { await runWorktreeLayout(intent, 'create', authorize, () => verifyLayout(intent, root, true), signal) }
        catch (error) {
          if (outcome === null && await worktreeLayoutOutcome(intent, 'create') === 'failed')
            await rollbackCleanLayoutCheckouts(intent, root).catch(() => {})
          throw error
        }
      }
      if (await worktreeLayoutOutcome(intent, 'create') !== 'complete') return false
      if (!recover) return await verifyLayout(intent, root)
    }
    for (const checkout of intent.checkouts) {
      if (await realpath(checkout.repository).catch(() => null) !== checkout.repository) return false
      if (!(await openReserved(checkout, mode, root, authorize, beforeRestore)).path) return false
    }
    if ((create || (restorePaths && authorize())) && !await prepareDirectory(root, intent.path)) return false
    if (await realpath(intent.path).catch(() => null) !== intent.path) return false
    for (const link of intent.links) {
      if (!within(intent.path, link.path)) return false
      const parent = dirname(link.path)
      const mayCreate = create || (restorePaths && authorize())
      if (mayCreate && !await prepareDirectory(root, parent)) return false
      if (await realpath(parent).catch(() => null) !== parent) return false
      if (await readlink(link.path).catch(() => null) === link.source) continue
      if (!mayCreate) return false
      const type = (await lstat(link.source)).isDirectory() ? 'dir' : 'file'
      if (recover && !authorize()) return false
      await symlink(link.source, link.path, type)
    }
    return true
  }
  catch (error) {
    if (intent.layout && create) throw error
    return false
  }
}

export async function openCombinedRepository(intent: CombinedWorktreeIntent, checkout: Checkout): Promise<string | null> {
  const root = await ownedRoot(intent, false)
  if (!root) return null
  return (await openReserved(checkout, false, root)).path
}

export function nestedWorktrees(intent: CombinedWorktreeIntent, checkout: Checkout): string[] {
  return intent.checkouts.filter(other => within(checkout.path, other.path)).map(other => relative(checkout.path, other.path))
}

/** Drop registered children and owned links. Files created beside them stay available. */
export async function releaseCombinedWorktree(intent: CombinedWorktreeIntent, allowProjectCommands = false): Promise<{ removed: boolean, committed: string | null }> {
  try {
    const root = await ownedRoot(intent, false)
    if (!root) return { removed: false, committed: null }
    if (intent.layout) {
      const created = await worktreeLayoutOutcome(intent, 'create')
      const removed = await worktreeLayoutOutcome(intent, 'remove')
      if (created === 'started' || removed === 'started' || removed === 'failed') return { removed: false, committed: null }
      if (allowProjectCommands && created === 'complete' && removed === null) {
        let clean = true
        for (const checkout of intent.checkouts) {
          if (!(await openReserved(checkout, false, root)).path
            || !await isCleanForLayoutRemoval(checkout.path, nestedWorktrees(intent, checkout))) {
            clean = false
            break
          }
        }
        if (clean) await runWorktreeLayout(intent, 'remove', () => true)
      }
      if (await ownedRoot(intent, false) !== root) return { removed: false, committed: null }
    }
    let committed = null
    for (const checkout of [...intent.checkouts].reverse()) {
      const exists = await lstat(checkout.path).then(() => true, (error) => {
        if (error.code !== 'ENOENT') throw error
        return false
      })
      if (!exists) continue
      if (!(await openReserved(checkout, false, root)).path) return { removed: false, committed }
      const result = await release(checkout.repository, checkout.path, nestedWorktrees(intent, checkout), true)
      committed = result.committed ?? committed
      // A retained child must never be swept up by removing its parent checkout.
      if (!result.removed) return { removed: false, committed }
    }
    const parents = new Set([intent.path])
    for (const path of [...intent.links, ...intent.checkouts].map(entry => entry.path)) {
      for (let parent = dirname(path); within(root, parent); parent = dirname(parent)) parents.add(parent)
    }
    for (const link of intent.links) {
      if (await realpath(dirname(link.path)).catch(() => null) !== dirname(link.path)) continue
      if (await readlink(link.path).catch(() => null) === link.source) await unlink(link.path)
    }
    for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
      if (await realpath(parent).catch(() => null) === parent) await rmdir(parent).catch(() => {})
    }
    let remains = await readdir(root)
    if (intent.layout && remains.every(name => name === '.harness-owner' || /^\.harness-layout-(?:create|remove)-(?:started|complete|failed)$/u.test(name))) {
      await clearWorktreeLayoutReceipts(intent)
      remains = await readdir(root)
    }
    if (remains.length !== 1 || remains[0] !== basename(marker(root))) return { removed: false, committed }
    await unlink(marker(root))
    await rmdir(root)
    return { removed: true, committed }
  }
  catch { return { removed: false, committed: null } }
}
