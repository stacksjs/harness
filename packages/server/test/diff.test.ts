import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { expandWorkspaceDiffGap, parseWorkspacePatch, revealWorkspaceDiffContext, workspaceDiffContextKey, workspaceDiffLink, workspaceDiffLinkedRows, workspaceDiffLocation, workspaceDiffRows } from '../src/browser-diff'
import { capture } from '../src/checkpoint'
import { MAX_PATCH_BYTES, parseNumstat, parseStatus, reviewWorkspaceDiff, summarizeTurnFiles, workspaceDiff } from '../src/diff'
import type { ReviewConversation } from '../src/pull-request-conversations'
import { placeReviewConversations } from '../src/pull-request-conversations'

it('attaches review conversations to the matching side and preserves unanchored history', () => {
  const patch = [
    '@@ -1,2 +1,3 @@', '-Original', '+Replacement', '+Inserted', ' Common',
    '@@ -62 +63 @@', '-Previous ending', '+New ending', '\\ No newline at end of file',
  ].join('\n')
  const conversation = (id: string, side: 'before' | 'after', line: number, outdated = false): ReviewConversation => ({
    id, anchor: id, path: 'report.txt', side, line, outdated, location: '', isResolved: false,
    viewerCanResolve: true, viewerCanUnresolve: false, comments: [], moreComments: false,
  })
  const sections = placeReviewConversations(patch, [
    conversation('added', 'after', 1),
    conversation('old', 'before', 1, true),
    conversation('removed', 'before', 1),
    conversation('context-before', 'before', 2),
    conversation('context-after', 'after', 3),
    conversation('ending', 'after', 63),
    conversation('outside', 'after', 99),
  ])
  expect(sections.map(section => section.conversations.map(thread => thread.id))).toEqual([
    ['removed'], ['added'], ['context-before', 'context-after'], ['ending'], ['old', 'outside'],
  ])
  expect(sections.filter(section => section.patch).map(section => section.patch).join('\n')).toBe(patch)
  expect(placeReviewConversations(patch, [conversation('outside', 'after', 99)]).map(section => section.patch)).toEqual([patch, ''])
})

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

describe('turn attribution', () => {
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trimEnd()
  }
  const identity = (cwd: string) => {
    git(cwd, 'config', 'user.name', 'Harness Fixture')
    git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  }
  const changed = async (cwd: string, before: string, after: string) => {
    const [summary, patch] = await Promise.all([
      summarizeTurnFiles(cwd, { before, after }),
      reviewWorkspaceDiff(cwd, 'turn', '1', [{ id: 1, number: 1, before, after }]),
    ])
    expect(patch?.error).toBeUndefined()
    expect(patch?.files).toEqual(summary?.files ?? [])
    return { summary, patch }
  }

  it.each(['fast-forward', 'rebase', 'import only'] as const)('excludes imported commits during %s while keeping the saved workspace intact', async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-attribution-'))
    try {
      const upstream = join(dir, 'upstream')
      const workspace = join(dir, 'workspace')
      git(dir, 'init', '-qb', 'main', upstream)
      identity(upstream)
      writeFileSync(join(upstream, 'shared.txt'), 'Baseline\n')
      git(upstream, 'add', '.')
      git(upstream, 'commit', '-qm', 'Baseline')
      git(dir, 'clone', '-q', upstream, workspace)
      identity(workspace)
      if (mode === 'rebase') {
        writeFileSync(join(workspace, 'preexisting local.txt'), 'Local commit\n')
        git(workspace, 'add', '.')
        git(workspace, 'commit', '-qm', 'Local before rebase')
      }
      const before = (await capture(workspace)).ref!
      writeFileSync(join(upstream, 'imported [docs].txt'), 'Only upstream wrote this\n')
      git(upstream, 'add', '.')
      git(upstream, 'commit', '-qm', 'Upstream import')
      git(workspace, 'fetch', '-q', 'origin')
      git(workspace, ...(mode === 'rebase' ? ['rebase', 'origin/main'] : ['merge', '--ff-only', 'origin/main']))
      if (mode !== 'import only') {
        git(workspace, 'mv', '--', 'shared.txt', ':!renamed [draft].txt')
        git(workspace, 'commit', '-qm', 'Rename locally')
        writeFileSync(join(workspace, 'turn notes.txt'), 'Written by the turn\n')
      }
      const after = (await capture(workspace)).ref!
      const { patch, summary } = await changed(workspace, before, after)
      expect(summary?.total).toBe(mode === 'import only' ? 0 : 2)
      expect(patch?.patch).not.toContain('imported [docs].txt')
      if (mode !== 'import only') {
        expect(summary?.files.map(file => file.path).sort()).toEqual([':!renamed [draft].txt', 'turn notes.txt'])
        expect(patch?.patch).toContain('rename to :!renamed [draft].txt')
        expect(patch?.patch).toContain('+Written by the turn')
      }
      expect(git(workspace, 'diff', '--name-only', before, after)).toContain('imported [docs].txt')
      expect((await reviewWorkspaceDiff(workspace, 'commit', git(upstream, 'rev-parse', 'HEAD'), []))?.patch).toContain('Only upstream wrote this')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20_000)

  it('keeps a merge conflict resolved to the upstream version and omits unrelated imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-attribution-merge-'))
    try {
      git(dir, 'init', '-qb', 'main')
      identity(dir)
      git(dir, 'config', 'core.precomposeunicode', 'false')
      const shared = join(dir, 'shared.txt')
      const retired = 'é [retired]'
      writeFileSync(shared, 'Baseline\n')
      writeFileSync(join(dir, retired), 'File retired by both branches\n')
      git(dir, 'add', '.')
      git(dir, 'commit', '-qm', 'Baseline')
      git(dir, 'checkout', '-qb', 'upstream')
      writeFileSync(shared, 'Upstream\n')
      writeFileSync(join(dir, 'upstream-only.txt'), 'Unrelated\n')
      git(dir, 'rm', '--', retired)
      mkdirSync(join(dir, retired))
      writeFileSync(join(dir, retired, 'child.txt'), 'Imported nested file\n')
      git(dir, 'add', '-A')
      const oldDate = '2020-01-01T12:00:00Z'
      expect(spawnSync('git', ['commit', '-qm', 'Old upstream commit'], {
        cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: oldDate, GIT_COMMITTER_DATE: oldDate },
      }).status).toBe(0)
      git(dir, 'checkout', '-q', 'main')
      writeFileSync(shared, 'Local\n')
      git(dir, 'commit', '-qam', 'Conflicting local commit')
      const before = (await capture(dir)).ref!
      git(dir, 'rm', '--', retired)
      git(dir, 'commit', '-qm', 'Retire the original file')
      expect(spawnSync('git', ['merge', '--no-edit', 'upstream'], { cwd: dir }).status).toBe(1)
      writeFileSync(shared, 'Upstream\n')
      git(dir, 'add', '--', 'shared.txt')
      git(dir, 'commit', '-qm', 'Resolve conflict to upstream')
      const after = (await capture(dir)).ref!

      const { summary, patch } = await changed(dir, before, after)
      expect(summary?.files.map(file => file.path).sort()).toEqual(['shared.txt', retired])
      expect(patch?.patch).toContain('+Upstream')
      expect(patch?.patch).toContain('-File retired by both branches')
      expect(patch?.patch).not.toContain('upstream-only.txt')
      expect(patch?.patch).not.toContain('Imported nested file')
      expect(git(dir, 'diff', '--name-only', before, after)).toContain('upstream-only.txt')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  }, 20_000)
})

describe('reading a real workspace', () => {
  it('keeps totals for the entire checkpoint comparison while bounding the transcript preview', async () => {
    const dir = repo()
    try {
      const head = () => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim()
      const before = head()
      for (let i = 0; i < 10; i++) writeFileSync(join(dir, `file [${i}].txt`), 'a\nb\n')
      expect(spawnSync('git', ['add', '.'], { cwd: dir }).status).toBe(0)
      expect(spawnSync('git', ['commit', '-qm', 'Add ten files'], { cwd: dir }).status).toBe(0)
      const after = head()
      writeFileSync(join(dir, 'outside the turn.txt'), 'Later\n')
      const result = await summarizeTurnFiles(dir, { before, after })
      expect(result).toMatchObject({ total: 10, insertions: 20, deletions: 0 })
      expect(result?.files).toHaveLength(8)
      expect(result?.files[0]).toEqual({ path: 'file [0].txt', status: 'added', insertions: 2, deletions: 0 })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
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
