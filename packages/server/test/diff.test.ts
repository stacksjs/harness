import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { MAX_PATCH_BYTES, parseNumstat, parseStatus, workspaceDiff } from '../src/diff'

/**
 * The parsers get their own tests because their inputs are the awkward cases —
 * renames, binary files, paths containing whitespace — and those are exactly
 * what a hand-rolled porcelain parser gets wrong. A wrong path here is shown to
 * the user as a file that does not exist.
 */

describe('parsing git status', () => {
  it('reads the ordinary states', () => {
    const raw = ' M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? src/d.ts\0'
    expect(parseStatus(raw).map(f => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['src/b.ts', 'added'],
      ['src/c.ts', 'deleted'],
      ['src/d.ts', 'untracked'],
    ])
  })

  it('consumes both halves of a rename', () => {
    // A rename spends two NUL fields. Leaving the second in place shifts every
    // entry after it and renders the old path as its own bogus change.
    const raw = 'R  new.ts\0old.ts\0 M after.ts\0'
    expect(parseStatus(raw).map(f => [f.path, f.status])).toEqual([
      ['new.ts', 'renamed'],
      ['after.ts', 'modified'],
    ])
  })

  it('keeps a path containing a space', () => {
    // The reason for -z: the line format would quote and escape this.
    expect(parseStatus(' M src/my file.ts\0')[0].path).toBe('src/my file.ts')
  })

  it('ignores empty and truncated entries', () => {
    expect(parseStatus('\0\0 M\0')).toEqual([])
  })
})

describe('parsing numstat', () => {
  it('reads line counts', () => {
    const counts = parseNumstat('3\t1\tsrc/a.ts\0' + '10\t0\tsrc/b.ts\0')
    expect(counts.get('src/a.ts')).toEqual({ insertions: 3, deletions: 1 })
    expect(counts.get('src/b.ts')).toEqual({ insertions: 10, deletions: 0 })
  })

  it('treats a binary file as zero rather than NaN', () => {
    // Binary files report `-`. Number('-') is NaN, which renders as "NaN".
    expect(parseNumstat('-\t-\tlogo.png\0').get('logo.png')).toEqual({ insertions: 0, deletions: 0 })
  })

  it('keys a rename by its new path, matching the status list', () => {
    // With -z a rename leaves the path empty and follows with old then new.
    const counts = parseNumstat('2\t2\t\0old.ts\0new.ts\0')
    expect(counts.get('new.ts')).toEqual({ insertions: 2, deletions: 2 })
  })
})

describe('reading a real workspace', () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-diff-'))
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir })
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\nthree\n')
    run('add', '.')
    run('commit', '-qm', 'first')
    return dir
  }

  it('reports a directory that is not a repository', async () => {
    // Not an error: plenty of workspaces are plain directories, and the UI
    // should say so rather than show an empty diff that implies no changes.
    const dir = mkdtempSync(join(tmpdir(), 'harness-plain-'))
    try {
      const diff = await workspaceDiff(dir)
      expect(diff.isRepository).toBe(false)
      expect(diff.files).toEqual([])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports a clean repository as clean', async () => {
    const dir = repo()
    try {
      const diff = await workspaceDiff(dir)
      expect(diff.isRepository).toBe(true)
      expect(diff.files).toEqual([])
      expect(diff.patch).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('finds a modification, with its line counts and patch', async () => {
    const dir = repo()
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'one\ntwo\nthree\nfour\n')
      const diff = await workspaceDiff(dir)

      const file = diff.files.find(f => f.path === 'tracked.txt')!
      expect(file.status).toBe('modified')
      expect(file.insertions).toBe(1)
      expect(file.deletions).toBe(0)
      expect(diff.patch).toContain('+four')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('finds an untracked file, which has no patch', async () => {
    // The case a diff-only view misses entirely — and a new file is the most
    // common thing an agent produces.
    const dir = repo()
    try {
      writeFileSync(join(dir, 'brand-new.ts'), 'export const x = 1\n')
      const diff = await workspaceDiff(dir)

      const file = diff.files.find(f => f.path === 'brand-new.ts')!
      expect(file.status).toBe('untracked')
      expect(diff.patch).not.toContain('brand-new')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('finds a deletion', async () => {
    const dir = repo()
    try {
      rmSync(join(dir, 'tracked.txt'))
      expect((await workspaceDiff(dir)).files[0]).toMatchObject({ path: 'tracked.txt', status: 'deleted' })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('finds a file inside a new directory', async () => {
    // git reports an untracked directory as the directory itself unless asked
    // otherwise; a bare "src/" tells the reviewer nothing.
    const dir = repo()
    try {
      mkdirSync(join(dir, 'nested'))
      writeFileSync(join(dir, 'nested', 'deep.ts'), 'x\n')
      const paths = (await workspaceDiff(dir)).files.map(f => f.path)
      expect(paths.some(p => p.includes('deep.ts') || p === 'nested/')).toBe(true)
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('truncates a very large patch and says so', async () => {
    // A diff that stops halfway with no note reads as a complete diff.
    const dir = repo()
    try {
      writeFileSync(join(dir, 'tracked.txt'), `${'x'.repeat(80)}\n`.repeat(20000))
      const diff = await workspaceDiff(dir)

      expect(diff.patch.length).toBeGreaterThan(MAX_PATCH_BYTES)
      expect(diff.patch).toContain('truncated')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
