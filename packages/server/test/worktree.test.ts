import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nestedWorktrees, openCombinedWorktree, planCombinedWorktree, releaseCombinedWorktree } from '../src/combined-worktree'
import { branchFor, commitTurn, create, exists, list, openReserved, plan, prune, release, remove } from '../src/worktree'

/**
 * The point of a worktree is that two sessions cannot see each other's files.
 * Most of these check that isolation is real rather than nominal, and that
 * removing one cannot quietly destroy work.
 */

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-wt-'))
  const run = (...args: string[]) => spawnSync('git', args, { cwd: dir })
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.txt'), 'original\n')
  run('add', '.')
  run('commit', '-qm', 'first')
  return dir
}

const g = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout?.trim() ?? ''

/**
 * Longer than bun's 5s default, on purpose.
 *
 * Every one of these makes a real checkout and then deletes a repository that
 * contains one. That is a few hundred milliseconds each on a quiet machine and
 * several seconds on a busy one, and a suite that only passes with
 * `--timeout` on the command line is a suite that fails in CI.
 */
const GIT_TIMEOUT = 30_000

describe('reserved worktrees', () => {
  it('uses the default branch for an empty composer selection and HEAD for a legacy command', async () => {
    const dir = repo()
    try {
      expect(spawnSync('git', ['branch', '-M', 'main'], { cwd: dir }).status).toBe(0)
      const base = g(dir, 'rev-parse', 'HEAD')
      expect(spawnSync('git', ['switch', '-qc', 'topic'], { cwd: dir }).status).toBe(0)
      writeFileSync(join(dir, 'app.txt'), 'topic\n')
      expect(spawnSync('git', ['commit', '-qam', 'Topic changes'], { cwd: dir }).status).toBe(0)
      const head = g(dir, 'rev-parse', 'HEAD')
      expect(head).not.toBe(base)
      expect(await plan(dir, 42, 'selected', '')).toMatchObject({ base })
      expect(await plan(dir, 43, 'legacy')).toMatchObject({ base: head })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('keeps the reserved base when the project moves forward before checkout', async () => {
    const dir = repo()
    try {
      const intent = await plan(dir, 42, crypto.randomUUID())
      if ('reason' in intent) throw new Error(intent.reason)
      writeFileSync(join(dir, 'app.txt'), 'next commit\n')
      g(dir, 'commit', '-qam', 'Move project forward')
      expect(g(dir, 'rev-parse', 'HEAD')).not.toBe(intent.base)
      expect(await openReserved(intent, false)).toMatchObject({ path: null })
      expect(await openReserved(intent, true)).toEqual({ path: intent.path, branch: intent.branch })
      expect(readFileSync(join(intent.path, 'app.txt'), 'utf8')).toBe('original\n')
      expect(await list(dir)).toContainEqual({ path: intent.path, branch: intent.branch, sessionId: 42, dirty: false })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('preserves a checkout with the same branch at a different path and an unregistered reserved directory', async () => {
    const dir = repo()
    try {
      const intent = await plan(dir, 42, crypto.randomUUID())
      if ('reason' in intent) throw new Error(intent.reason)
      const separate = join(dir, 'separate')
      expect(spawnSync('git', ['worktree', 'add', '-b', intent.branch, separate], { cwd: dir }).status).toBe(0)
      writeFileSync(join(separate, 'separate.txt'), 'Keep this checkout\n')
      expect(await openReserved(intent, true)).toMatchObject({ path: null, reason: 'already-exists' })
      expect(readFileSync(join(separate, 'separate.txt'), 'utf8')).toBe('Keep this checkout\n')
      mkdirSync(intent.path, { recursive: true })
      writeFileSync(join(intent.path, 'unknown.txt'), 'Keep this file\n')
      expect(await openReserved(intent, true)).toMatchObject({ path: null, reason: 'checkout-conflict' })
      expect(readFileSync(join(intent.path, 'unknown.txt'), 'utf8')).toBe('Keep this file\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('reattaches the branch and leaves other stale Git registrations and path conflicts alone', async () => {
    const dir = repo()
    try {
      const intent = await plan(dir, 42, crypto.randomUUID())
      if ('reason' in intent) throw new Error(intent.reason)
      expect(await openReserved(intent, true)).toMatchObject({ path: intent.path })
      writeFileSync(join(intent.path, 'app.txt'), 'Committed by the session\n')
      const head = await commitTurn(intent.path, 'Session change')
      expect(head).toBeTruthy()
      const unrelated = join(intent.repository, 'other')
      expect(spawnSync('git', ['worktree', 'add', '-qb', 'unrelated', unrelated], { cwd: dir }).status).toBe(0)
      rmSync(unrelated, { recursive: true })
      rmSync(intent.path, { recursive: true })

      expect(await openReserved(intent, 'recover')).toMatchObject({ path: null })
      mkdirSync(intent.path)
      writeFileSync(join(intent.path, 'unowned.txt'), 'Keep this file\n')
      expect(await openReserved(intent, 'recover', undefined, () => true)).toMatchObject({ path: null })
      expect(readFileSync(join(intent.path, 'unowned.txt'), 'utf8')).toBe('Keep this file\n')
      rmSync(intent.path, { recursive: true })
      symlinkSync(dir, intent.path, 'junction')
      expect(await openReserved(intent, 'recover', undefined, () => true)).toMatchObject({ path: null })
      rmSync(intent.path)

      expect(await openReserved(intent, 'recover', undefined, () => true)).toMatchObject({ path: intent.path })
      expect(g(intent.path, 'symbolic-ref', '--short', 'HEAD')).toBe(intent.branch)
      expect(g(intent.path, 'rev-parse', 'HEAD')).toBe(head!)
      expect(await exists(dir, unrelated)).toBe(true)
      expect(await remove(dir, intent.path)).toEqual({ ok: true })
      const separate = join(dir, 'separate')
      expect(spawnSync('git', ['worktree', 'add', '-q', separate, intent.branch], { cwd: dir }).status).toBe(0)
      expect(await openReserved(intent, 'recover', undefined, () => true)).toMatchObject({ path: null })
      expect(readFileSync(join(separate, 'app.txt'), 'utf8')).toBe('Committed by the session\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it.each(['origin', 'upstream', 'attached project head', 'detached remote head', 'detached project head', 'unborn head'] as const)(
    'reconstructs a deleted branch before sending using %s', async (source) => {
      const dir = repo()
      try {
        const git = (...args: string[]) => {
          const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
          if (result.status !== 0) throw new Error(result.stderr)
          return result.stdout.trim()
        }
        const intent = await plan(dir, 42, crypto.randomUUID())
        if ('reason' in intent) throw new Error(intent.reason)
        expect(await openReserved(intent, true)).toMatchObject({ path: intent.path })
        writeFileSync(join(intent.path, 'app.txt'), 'Committed by the session\n')
        const published = await commitTurn(intent.path, 'Session change')
        expect(published).toBeTruthy()

        const remote = source === 'origin' || source === 'upstream' ? source : undefined
        const upstream = remote && `refs/remotes/${remote}/${intent.branch}`
        // The remote URL cannot work. Only its cached Git ref is needed.
        if (remote || source === 'detached remote head') {
          git('remote', 'add', remote ?? 'upstream', join(dir, 'unreachable.git'))
          if (remote === 'origin') {
            git('remote', 'add', 'aaa', join(dir, 'also-unreachable.git'))
            git('update-ref', `refs/remotes/aaa/${intent.branch}`, intent.base)
          }
          if (upstream) git('update-ref', upstream, published!)
          else {
            git('update-ref', 'refs/remotes/upstream/main', published!)
            git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/main')
          }
        }
        writeFileSync(join(dir, 'app.txt'), 'Latest project checkout\n')
        git('commit', '-qam', 'Move project forward')
        const projectHead = git('rev-parse', 'HEAD')
        git('config', 'branch.autoSetupMerge', 'always')
        if (source.startsWith('detached')) git('switch', '--detach', projectHead)
        if (source === 'unborn head') git('switch', '--orphan', 'unborn')

        rmSync(intent.path, { recursive: true })
        // Retain the stale worktree registration while simulating a deleted ref.
        git('update-ref', '-d', `refs/heads/${intent.branch}`, published!)
        expect(await openReserved(intent, 'recover', undefined, () => true)).toMatchObject({ path: null })
        expect(existsSync(intent.path)).toBe(false)
        const restored = await openReserved(intent, 'resume', undefined, () => true)
        if (source === 'unborn head') {
          expect(restored.path).toBeNull()
          expect(await exists(dir, intent.path)).toBe(true)
          return
        }
        expect(restored).toMatchObject({ path: intent.path, branch: intent.branch })
        expect(g(intent.path, 'symbolic-ref', '--short', 'HEAD')).toBe(intent.branch)
        expect(g(intent.path, 'rev-parse', 'HEAD')).toBe(upstream || source === 'detached remote head' ? published! : projectHead)
        expect(g(intent.path, 'rev-parse', '--symbolic-full-name', '@{upstream}')).toBe(upstream ?? '')
        expect(g(dir, 'rev-parse', 'HEAD')).toBe(projectHead)
        expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('Latest project checkout\n')
      }
      finally { rmSync(dir, { recursive: true, force: true }) }
    }, GIT_TIMEOUT,
  )
})

it('keeps commits separate when the project root and a child are both repositories', async () => {
  const project = repo()
  const storage = mkdtempSync(join(tmpdir(), 'harness-combined-'))
  try {
    const child = join(project, 'packages', 'api')
    mkdirSync(child, { recursive: true })
    expect(g(child, 'init', '-qb', 'main')).toBe('')
    writeFileSync(join(child, 'api.txt'), 'API baseline\n')
    g(child, 'add', '.')
    g(child, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'API baseline')
    const intent = await planCombinedWorktree(project, join(storage, 'worktrees'), 42)
    if (!intent) throw new Error('No combined worktree was reserved.')
    expect(await openCombinedWorktree(intent, true)).toBe(true)
    expect(intent.checkouts.map(checkout => checkout.key)).toEqual(['', 'packages/api'])
    const [root, api] = intent.checkouts
    writeFileSync(join(root!.path, 'app.txt'), 'Project update\n')
    writeFileSync(join(api!.path, 'api.txt'), 'API update\n')
    expect(await commitTurn(root!.path, 'Project change', nestedWorktrees(intent, root!))).toBeTruthy()
    expect(await commitTurn(api!.path, 'API change')).toBeTruthy()
    expect(g(project, 'ls-tree', intent.branch, 'packages')).toBe('')
    expect(g(child, 'show', `${intent.branch}:api.txt`)).toBe('API update')
    expect(await releaseCombinedWorktree(intent)).toMatchObject({ removed: true })
    expect(existsSync(intent.path)).toBe(false)
    expect(g(project, 'show', `${intent.branch}:app.txt`)).toBe('Project update')
  }
  finally {
    rmSync(storage, { recursive: true, force: true })
    rmSync(project, { recursive: true, force: true })
  }
}, GIT_TIMEOUT)

describe('creating a worktree for a session', () => {
  it('gives it a directory and a branch of its own', async () => {
    const dir = repo()
    try {
      const result = await create(dir, 42)

      expect(result.path).toBeTruthy()
      expect(result.branch).toBe('harness/session-42')
      expect(existsSync(join(result.path!, 'app.txt'))).toBe(true)
      // Checked out on its own branch, not on the repository's.
      expect(g(result.path!, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('harness/session-42')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('leaves the original working tree and branch untouched', async () => {
    // The whole reason for a worktree over `git switch -c`: the user's checkout
    // must not move under them.
    const dir = repo()
    try {
      const branchBefore = g(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
      writeFileSync(join(dir, 'app.txt'), 'my edit in flight\n')

      await create(dir, 42)

      expect(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branchBefore)
      expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('my edit in flight\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('isolates two sessions from each other', async () => {
    // The failure this exists to prevent: two agents editing the same file.
    const dir = repo()
    try {
      const one = await create(dir, 1)
      const two = await create(dir, 2)

      writeFileSync(join(one.path!, 'app.txt'), 'session one\n')
      writeFileSync(join(two.path!, 'app.txt'), 'session two\n')

      expect(readFileSync(join(one.path!, 'app.txt'), 'utf8')).toBe('session one\n')
      expect(readFileSync(join(two.path!, 'app.txt'), 'utf8')).toBe('session two\n')
      // And neither touched the workspace.
      expect(readFileSync(join(dir, 'app.txt'), 'utf8')).toBe('original\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('lives inside the git directory, not the working tree', async () => {
    // Nothing to gitignore and nothing to commit by accident.
    const dir = repo()
    try {
      const result = await create(dir, 42)

      expect(result.path).toContain('.git')
      expect(g(dir, 'status', '--porcelain')).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('declines a plain directory rather than failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-plain-'))
    try {
      expect((await create(dir, 1)).reason).toBe('not-a-repository')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('declines a repository with no commits', async () => {
    // A worktree branches from a commit, and there is none to branch from.
    const dir = mkdtempSync(join(tmpdir(), 'harness-empty-'))
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir })
      expect((await create(dir, 1)).reason).toBe('no-commits')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('reports a collision rather than clobbering', async () => {
    // Removing someone's worktree because a name collided is not a decision to
    // make silently.
    const dir = repo()
    try {
      await create(dir, 7)
      expect((await create(dir, 7)).reason).toBe('already-exists')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('removing a worktree', () => {
  it('refuses while it still holds uncommitted work', async () => {
    // The output of a session is exactly what would be lost.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'unreviewed agent work\n')

      const removed = await remove(dir, result.path!)

      expect(removed.ok).toBe(false)
      expect(removed.reason).toContain('uncommitted')
      expect(existsSync(result.path!)).toBe(true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('removes a clean one', async () => {
    const dir = repo()
    try {
      const result = await create(dir, 42)

      expect((await remove(dir, result.path!)).ok).toBe(true)
      expect(existsSync(result.path!)).toBe(false)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('keeps the branch, which is the deliverable', async () => {
    // The directory is scratch space; the branch is the work.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'agent work\n')
      spawnSync('git', ['add', '.'], { cwd: result.path! })
      spawnSync('git', ['commit', '-qm', 'agent work'], { cwd: result.path! })

      await remove(dir, result.path!)

      expect(g(dir, 'branch', '--list', 'harness/session-42')).toContain('harness/session-42')
      expect(g(dir, 'show', 'harness/session-42:app.txt')).toBe('agent work')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('forces past uncommitted work when told to', async () => {
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'scratch\n')

      expect((await remove(dir, result.path!, true)).ok).toBe(true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('recovering from a crash', () => {
  it('prunes a registration whose directory is gone', async () => {
    // A stale registration is enough to make `worktree add` refuse the same
    // name later, which would strand every future session with that id.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      rmSync(result.path!, { recursive: true, force: true })

      expect(await exists(dir, result.path!)).toBe(true)
      await prune(dir)
      expect(await exists(dir, result.path!)).toBe(false)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('names branches predictably enough to find them all', () => {
    expect(branchFor(7)).toBe('harness/session-7')
  })
})

describe('recording a turn on the branch', () => {
  it('commits what the turn changed', async () => {
    // Without this the branch is an empty pointer beside a dirty worktree, and
    // `git merge harness/session-N` gets you nothing — the whole point of
    // giving the session a branch would be lost.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'agent work\n')

      const sha = await commitTurn(result.path!, 'harness: turn 1')

      expect(sha).toMatch(/^[0-9a-f]{40}$/)
      expect(g(dir, 'show', 'harness/session-42:app.txt')).toBe('agent work')
      expect(g(result.path!, 'status', '--porcelain')).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('includes files the agent created', async () => {
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'new.ts'), 'export const x = 1\n')

      await commitTurn(result.path!, 'harness: turn 1')

      expect(g(dir, 'show', 'harness/session-42:new.ts')).toBe('export const x = 1')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('records nothing for a turn that only read', async () => {
    // An empty commit per question would bury the ones that matter.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      expect(await commitTurn(result.path!, 'harness: turn 1')).toBeNull()
      // Still exactly the commit it branched from.
      expect(g(dir, 'rev-list', '--count', 'harness/session-42')).toBe('1')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('leaves the workspace branch where it was', async () => {
    // Committing in a worktree must not move the branch the user is on.
    const dir = repo()
    try {
      const before = g(dir, 'rev-parse', 'HEAD')
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'agent work\n')

      await commitTurn(result.path!, 'harness: turn 1')

      expect(g(dir, 'rev-parse', 'HEAD')).toBe(before)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('one commit per turn, in order', async () => {
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'one\n')
      await commitTurn(result.path!, 'harness: turn 1')
      writeFileSync(join(result.path!, 'app.txt'), 'two\n')
      await commitTurn(result.path!, 'harness: turn 2')

      expect(g(dir, 'log', '--format=%s', 'harness/session-42').split('\n')).toEqual([
        'harness: turn 2',
        'harness: turn 1',
        'first',
      ])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('keeps the repository author when one is configured', async () => {
    // `-c` overrides rather than fills, so a blanket default would rewrite the
    // author on every machine that had one set.
    const dir = repo()
    try {
      const result = await create(dir, 42)
      writeFileSync(join(result.path!, 'app.txt'), 'agent work\n')

      await commitTurn(result.path!, 'harness: turn 1')

      expect(g(dir, 'log', '-1', '--format=%an <%ae>', 'harness/session-42')).toBe('Test <test@example.com>')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)
})

describe('listing and releasing', () => {
  it('reports harness worktrees, their branch, and whether they are dirty', async () => {
    const dir = repo()
    try {
      const made = await create(dir, 4242)
      expect(made.path).not.toBeNull()

      let entries = await list(dir)
      let mine = entries.find(entry => entry.sessionId === 4242)
      expect(mine).toBeDefined()
      expect(mine!.branch).toBe('harness/session-4242')
      expect(mine!.dirty).toBe(false)

      writeFileSync(join(made.path!, 'scratch.txt'), 'half a turn')
      entries = await list(dir)
      mine = entries.find(entry => entry.sessionId === 4242)
      expect(mine!.dirty).toBe(true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('keeps uncommitted work by committing it to the branch, then removes the directory', async () => {
    const dir = repo()
    try {
      const made = await create(dir, 4343)
      writeFileSync(join(made.path!, 'left-behind.txt'), 'do not lose me')

      const released = await release(dir, made.path!)
      expect(released.removed).toBe(true)
      // The whole point: the work is on the branch, not in the bin.
      expect(released.committed).not.toBeNull()
      expect(await exists(dir, made.path!)).toBe(false)

      expect(g(dir, 'show', 'harness/session-4343:left-behind.txt')).toContain('do not lose me')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('releases a clean worktree without inventing a commit', async () => {
    const dir = repo()
    try {
      const made = await create(dir, 4444)

      const released = await release(dir, made.path!)
      expect(released.removed).toBe(true)
      expect(released.committed).toBeNull()
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)

  it('retains a dirty checkout when a Git hook refuses its cleanup commit', async () => {
    const dir = repo()
    try {
      const made = await create(dir, 4545)
      const hooks = join(dir, '.git', 'test-hooks')
      mkdirSync(hooks)
      writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      g(dir, 'config', 'core.hooksPath', hooks)
      const unsaved = join(made.path!, 'unsaved.txt')
      writeFileSync(unsaved, 'Keep uncommitted work\n')
      expect(await release(dir, made.path!)).toEqual({ removed: false, committed: null, reason: 'the worktree has uncommitted changes' })
      expect(await exists(dir, made.path!)).toBe(true)
      expect(readFileSync(unsaved, 'utf8')).toBe('Keep uncommitted work\n')
      expect(g(dir, 'rev-parse', made.branch!)).toBe(g(dir, 'rev-parse', 'HEAD'))
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, GIT_TIMEOUT)
})
