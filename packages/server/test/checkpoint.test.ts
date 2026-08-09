import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, restore } from '../src/checkpoint'

/**
 * Reverting destroys work by design, so these tests are mostly about what a
 * checkpoint must *not* do: touch the user's index, their branch, their stash,
 * or anything gitignored — and never leave the workspace in a state that never
 * existed.
 */

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-ckpt-'))
  const run = (...args: string[]) => spawnSync('git', args, { cwd: dir })
  run('init', '-q')
  run('config', 'user.email', 'test@example.com')
  run('config', 'user.name', 'Test')
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
  writeFileSync(join(dir, 'tracked.txt'), 'original\n')
  run('add', '.')
  run('commit', '-qm', 'first')
  return dir
}

const g = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout?.trim() ?? ''
const read = (dir: string, name: string) => readFileSync(join(dir, name), 'utf8')

describe('capturing a checkpoint', () => {
  it('returns a commit for a clean repository', async () => {
    const dir = repo()
    try {
      const result = await capture(dir)
      expect(result.ref).toMatch(/^[0-9a-f]{40}$/)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('captures modifications and untracked files together', async () => {
    // An agent's *new* file is the common case, and a snapshot that missed it
    // would leave that file behind on every revert.
    const dir = repo()
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
      writeFileSync(join(dir, 'created.txt'), 'new\n')
      const { ref } = await capture(dir)

      const listed = g(dir, 'ls-tree', '-r', '--name-only', ref!)
      expect(listed).toContain('tracked.txt')
      expect(listed).toContain('created.txt')
      expect(g(dir, 'show', `${ref}:tracked.txt`)).toBe('changed')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('leaves the working tree, index, branch and stash exactly as they were', async () => {
    // The whole reason for a temporary index instead of `git stash`.
    const dir = repo()
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
      writeFileSync(join(dir, 'staged.txt'), 'staged\n')
      spawnSync('git', ['add', 'staged.txt'], { cwd: dir })

      const headBefore = g(dir, 'rev-parse', 'HEAD')
      const statusBefore = g(dir, 'status', '--porcelain')
      const stashBefore = g(dir, 'stash', 'list')

      await capture(dir)

      expect(g(dir, 'rev-parse', 'HEAD')).toBe(headBefore)
      expect(g(dir, 'status', '--porcelain')).toBe(statusBefore)
      expect(g(dir, 'stash', 'list')).toBe(stashBefore)
      expect(read(dir, 'tracked.txt')).toBe('changed\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('excludes ignored files', async () => {
    const dir = repo()
    try {
      mkdirSync(join(dir, 'ignored'))
      writeFileSync(join(dir, 'ignored', 'huge.bin'), 'x')
      const { ref } = await capture(dir)

      expect(g(dir, 'ls-tree', '-r', '--name-only', ref!)).not.toContain('ignored/')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('declines a plain directory without failing', async () => {
    // A workspace need not be a repository, and a turn must not fail because
    // its workspace is not under version control.
    const dir = mkdtempSync(join(tmpdir(), 'harness-plain-'))
    try {
      expect(await capture(dir)).toEqual({ ref: null, reason: 'not-a-repository' })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('declines a repository with no commits', async () => {
    // `commit-tree -p HEAD` has no parent to point at.
    const dir = mkdtempSync(join(tmpdir(), 'harness-empty-'))
    try {
      spawnSync('git', ['init', '-q'], { cwd: dir })
      expect((await capture(dir)).reason).toBe('no-commits')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('restoring a checkpoint', () => {
  it('puts a modified file back', async () => {
    const dir = repo()
    try {
      const { ref } = await capture(dir)
      writeFileSync(join(dir, 'tracked.txt'), 'agent wrote this\n')

      const result = await restore(dir, ref!)

      expect(result.ok).toBe(true)
      expect(read(dir, 'tracked.txt')).toBe('original\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('removes a file the agent created after the checkpoint', async () => {
    // The half that is easy to forget. Restoring only what the checkpoint had
    // leaves the new file behind, producing a state that never existed.
    const dir = repo()
    try {
      const { ref } = await capture(dir)
      writeFileSync(join(dir, 'agent-made-this.ts'), 'export const x = 1\n')

      const result = await restore(dir, ref!)

      expect(existsSync(join(dir, 'agent-made-this.ts'))).toBe(false)
      expect(result.removed).toBe(1)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('brings back a file the agent deleted', async () => {
    const dir = repo()
    try {
      const { ref } = await capture(dir)
      rmSync(join(dir, 'tracked.txt'))

      await restore(dir, ref!)

      expect(read(dir, 'tracked.txt')).toBe('original\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('never touches ignored files', async () => {
    // node_modules is not in a checkpoint and must not be deleted by one.
    const dir = repo()
    try {
      mkdirSync(join(dir, 'ignored'))
      writeFileSync(join(dir, 'ignored', 'keep.bin'), 'precious')
      const { ref } = await capture(dir)
      writeFileSync(join(dir, 'ignored', 'also-keep.bin'), 'also precious')

      await restore(dir, ref!)

      expect(existsSync(join(dir, 'ignored', 'keep.bin'))).toBe(true)
      expect(existsSync(join(dir, 'ignored', 'also-keep.bin'))).toBe(true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('leaves HEAD and the index alone', async () => {
    // A revert is about the working tree. Moving the branch or leaving staged
    // deletions behind would make the next commit wrong in a way nobody looks
    // for.
    const dir = repo()
    try {
      const { ref } = await capture(dir)
      const headBefore = g(dir, 'rev-parse', 'HEAD')
      writeFileSync(join(dir, 'extra.txt'), 'x\n')

      await restore(dir, ref!)

      expect(g(dir, 'rev-parse', 'HEAD')).toBe(headBefore)
      expect(g(dir, 'diff', '--cached', '--name-only')).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses an unknown ref rather than half-restoring', async () => {
    const dir = repo()
    try {
      const result = await restore(dir, '0000000000000000000000000000000000000000')
      expect(result.ok).toBe(false)
      expect(result.reason).toContain('unknown checkpoint')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('round-trips a whole tangle of changes', async () => {
    const dir = repo()
    try {
      mkdirSync(join(dir, 'src'))
      writeFileSync(join(dir, 'src', 'a.ts'), 'a\n')
      writeFileSync(join(dir, 'src', 'b.ts'), 'b\n')
      spawnSync('git', ['add', '.'], { cwd: dir })
      spawnSync('git', ['commit', '-qm', 'second'], { cwd: dir })

      const { ref } = await capture(dir)

      // Everything an agent might do at once.
      writeFileSync(join(dir, 'src', 'a.ts'), 'a modified\n')
      rmSync(join(dir, 'src', 'b.ts'))
      writeFileSync(join(dir, 'src', 'c.ts'), 'c\n')
      writeFileSync(join(dir, 'tracked.txt'), 'clobbered\n')

      await restore(dir, ref!)

      expect(read(dir, 'src/a.ts')).toBe('a\n')
      expect(read(dir, 'src/b.ts')).toBe('b\n')
      expect(existsSync(join(dir, 'src', 'c.ts'))).toBe(false)
      expect(read(dir, 'tracked.txt')).toBe('original\n')
      // And the workspace is genuinely clean against the checkpoint.
      expect(g(dir, 'status', '--porcelain')).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('is idempotent', async () => {
    // A double-click, or a retried command, must not do something different the
    // second time.
    const dir = repo()
    try {
      const { ref } = await capture(dir)
      writeFileSync(join(dir, 'tracked.txt'), 'changed\n')

      await restore(dir, ref!)
      const once = g(dir, 'status', '--porcelain')
      const second = await restore(dir, ref!)

      expect(second.ok).toBe(true)
      expect(g(dir, 'status', '--porcelain')).toBe(once)
      expect(read(dir, 'tracked.txt')).toBe('original\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
