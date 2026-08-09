import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchFor, commitTurn, create, exists, list, prune, release, remove } from '../src/worktree'

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
})
