import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expandWorkspaceDiffGap, parseWorkspacePatch, revealWorkspaceDiffContext, workspaceDiffContextKey, workspaceDiffLink, workspaceDiffLinkedRows, workspaceDiffLocation, workspaceDiffRows } from '../src/browser-diff'
import { MAX_PATCH_BYTES, parseNumstat, parseStatus, workspaceDiff } from '../src/diff'

it('expands unchanged lines with distinct before and after numbers across an insertion', () => {
  const path = 'sample.txt'
  const object = 'c'.repeat(40)
  const patch = `diff --git a/${path} b/${path}\nindex ${object}..${'d'.repeat(40)} 100644\n--- a/${path}\n+++ b/${path}\n@@ -2,0 +3 @@\n+Inserted\n@@ -65 +66 @@\n-Row 65\n+Changed\n`
  const hunks = parseWorkspacePatch(patch).get(path)!
  expect(workspaceDiffContextKey(hunks)).toContain(object)
  const context = { lines: Array.from({ length: 70 }, (_, index) => `Row ${index + 1}`), revealed: new Map() }
  const gap = workspaceDiffRows(hunks, true, 200, context).rows.find(row => row.gap?.index === 1)!.gap!
  expect(gap).toMatchObject({ before: 3, after: 4, count: 62 })
  const smaller = expandWorkspaceDiffGap(context, gap, 'below')
  const partial = workspaceDiffRows(hunks, true, 200, smaller).rows
  expect(partial.find(row => row.key === 'context-22')?.cells[1]).toEqual({ kind: 'context', before: 22, after: 23, text: 'Row 22' })
  expect(partial.find(row => row.gap?.index === 1)?.gap?.count).toBe(42)
  const linked = revealWorkspaceDiffContext(hunks, smaller, { path, side: 'after', line: 41 })!
  expect(workspaceDiffRows(hunks, false, 200, linked).rows.find(row => row.key === 'context-40')?.cells[0]?.text).toBe('Row 40')
  expect(workspaceDiffContextKey(parseWorkspacePatch(patch.replace('+Changed\n', '')).get(path))).toBeUndefined()
})

describe('linking to a diff line', () => {
  it('resolves the same path, comparison, and original side without copying unrelated query parameters', () => {
    const location = { path: 'src/notes #2 [é].txt', side: 'before', line: 426, mode: 'turn', target: '481' } as const
    const link = new URL(workspaceDiffLink('http://localhost:3973/s/42?file=prior&line=2&profile=7&token=fixture#turn-3', location))
    expect(link.pathname).toBe('/s/42')
    expect(link.search).toBe('?profile=7')
    expect(workspaceDiffLocation(link.hash)).toEqual(location)
    expect(workspaceDiffLocation('#diff?file=notes.txt&side=before&line=1e3&mode=session')).toBeNull()
    expect(workspaceDiffLocation('#diff?file=notes.txt&side=after&line=1&mode=commit&target=HEAD~1')).toBeNull()
  })

  it('opens a bounded window around a later line and preserves row identity in split view', () => {
    const lines = Array.from({ length: 600 }, (_, index) => `+Line ${index + 1}`).join('\n')
    const path = 'long.txt'
    const hunks = parseWorkspacePatch(`diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,600 @@\n${lines}\n`).get(path)!
    const all = workspaceDiffRows(hunks, true, 1000).rows
    const linked = workspaceDiffLinkedRows(hunks, true, 200, { path, side: 'after', line: 345 })
    expect(linked.rows).toEqual(all.slice(321, 521))
    expect(linked.earlier).toBe(true)
    expect(linked.more).toBe(true)
  })
})

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
  function repo(initialPath = 'tracked.txt'): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-diff-'))
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir })
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    run('config', 'core.precomposeunicode', 'false')
    writeFileSync(join(dir, initialPath), 'one\ntwo\nthree\n')
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

  it.skipIf(process.platform === 'win32')('keeps line counts for filenames containing tabs and newlines', async () => {
    const path = 'notes [draft]\nwith\ta tab.txt'
    const dir = repo(path)
    try {
      writeFileSync(join(dir, path), 'one\ntwo\nupdated\n')
      expect((await workspaceDiff(dir)).files).toEqual([
        { path, status: 'modified', insertions: 1, deletions: 1 },
      ])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('renders quoted Git paths and aligns replacements without a final newline', async () => {
    const path = 'café [draft]\nwith\ta tab.txt'
    const dir = repo(path)
    try {
      spawnSync('git', ['config', 'diff.noprefix', 'true'], { cwd: dir })
      spawnSync('git', ['config', 'color.diff', 'always'], { cwd: dir })
      spawnSync('git', ['config', 'diff.suppressBlankEmpty', 'true'], { cwd: dir })
      writeFileSync(join(dir, path), 'first\n\nsecond')
      spawnSync('git', ['commit', '-qam', 'Remove trailing newline'], { cwd: dir })
      writeFileSync(join(dir, path), 'first\n\nreplacement\nadded')
      const { patch, error } = await workspaceDiff(dir)
      expect(error).toBeUndefined()
      const hunks = parseWorkspacePatch(patch).get(path)!
      const stacked = workspaceDiffRows(hunks, false, 200)
      expect(stacked.rows.map(row => row.cells[0]?.text)).toEqual([undefined, 'first', '', 'second', 'replacement', 'added'])
      const split = workspaceDiffRows(hunks, true, 200)
      expect(split.rows[3]?.cells).toMatchObject([
        { kind: 'deletion', text: 'second', before: 3, newlineNote: expect.any(String) },
        { kind: 'addition', text: 'replacement', after: 3 },
      ])
      expect(split.rows[4]?.cells).toEqual([
        null, { kind: 'addition', text: 'added', before: null, after: 4, newlineNote: expect.any(String) },
      ])
      expect(workspaceDiffRows(hunks, true, 3)).toEqual({ rows: split.rows.slice(0, 3), more: true })
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

describe('measuring against a session baseline', () => {
  function repo2(): string {
    const dir = mkdtempSync(join(tmpdir(), 'harness-base-'))
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir })
    run('init', '-q')
    run('config', 'user.email', 'test@example.com')
    run('config', 'user.name', 'Test')
    writeFileSync(join(dir, 'tracked.txt'), 'one\n')
    run('add', '.')
    run('commit', '-qm', 'first')
    return dir
  }

  /** The same snapshot the checkpoint reactor takes before a turn. */
  async function baselineOf(dir: string): Promise<string> {
    const { capture } = await import('../src/checkpoint')
    return (await capture(dir)).ref!
  }

  it('says which comparison it made', () => {
    // The reader needs to know whether a count means "this session" or "this
    // working tree" — they are different claims.
    const dir = repo2()
    try {
      return workspaceDiff(dir).then((d) => {
        expect(d.scope).toBe('working-tree')
        rmSync(dir, { recursive: true, force: true })
      })
    }
    catch { rmSync(dir, { recursive: true, force: true }); throw new Error('failed') }
  })

  it('sees work the agent committed, which git diff HEAD cannot', async () => {
    // The case that makes a baseline worth having. Once the agent commits,
    // `git diff HEAD` is empty and the review panel says "no changes" about a
    // session that rewrote a file.
    const dir = repo2()
    try {
      const baseline = await baselineOf(dir)

      writeFileSync(join(dir, 'tracked.txt'), 'agent rewrote this\n')
      spawnSync('git', ['add', '.'], { cwd: dir })
      spawnSync('git', ['commit', '-qm', 'agent work'], { cwd: dir })

      expect((await workspaceDiff(dir)).files).toEqual([])

      const scoped = await workspaceDiff(dir, baseline)
      expect(scoped.scope).toBe('session')
      expect(scoped.files.map(f => f.path)).toEqual(['tracked.txt'])
      expect(scoped.patch).toContain('agent rewrote this')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('excludes edits that were already there before the session', async () => {
    // The whole point of attribution: your work in flight is not the agent's.
    const dir = repo2()
    try {
      writeFileSync(join(dir, 'mine.txt'), 'I was editing this\n')
      const baseline = await baselineOf(dir)

      writeFileSync(join(dir, 'theirs.txt'), 'the agent made this\n')

      const scoped = await workspaceDiff(dir, baseline)
      expect(scoped.files.map(f => f.path)).toEqual(['theirs.txt'])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('reports a new file as added, with real line counts', async () => {
    // Better than the working-tree view can manage. There, a new file is
    // `untracked` with no counts, because `git diff` cannot see it. Between two
    // trees it is simply an addition, and its lines are countable — so the
    // reviewer learns how much was added rather than only that something was.
    const dir = repo2()
    try {
      const baseline = await baselineOf(dir)
      writeFileSync(join(dir, 'new.ts'), 'export const x = 1\n')

      const scoped = await workspaceDiff(dir, baseline)
      expect(scoped.files).toContainEqual({ path: 'new.ts', status: 'added', insertions: 1, deletions: 0 })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('falls back to the working tree when the baseline has been collected', async () => {
    // Checkpoints are dangling commits, so `git gc` can take one. A diff
    // against HEAD is still useful; claiming session scope would not be.
    const dir = repo2()
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'changed\n')
      const diff = await workspaceDiff(dir, '0000000000000000000000000000000000000000')

      expect(diff.scope).toBe('working-tree')
      expect(diff.files.map(f => f.path)).toEqual(['tracked.txt'])
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
