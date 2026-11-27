/**
 * Discovering projects from the agent history on this host.
 *
 * The fixture builds a `~/.claude/projects` tree the way Claude Code writes
 * one, including the part that makes this worth testing: the directory name
 * is the project path with its separators replaced by dashes, so a folder
 * whose own name contains a dash cannot be recovered from it. Every case here
 * therefore has the transcript disagree with the directory name.
 */

import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { claudeHistoryDirectory, discoverHistoryProjects } from '../src/project-history'

let home: string
let history: string

/** One conversation in `cwd`, in a history directory named the way Claude does. */
function conversation(cwd: string, id: string, ageDays = 1, records: Array<Record<string, unknown>> = []): void {
  const directory = join(history, cwd.replaceAll('/', '-'))
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${id}.jsonl`)
  const lines = [...records, { type: 'user', cwd, sessionId: id }].map(record => JSON.stringify(record))
  writeFileSync(file, `${lines.join('\n')}\n`)
  const when = (Date.now() - ageDays * 86_400_000) / 1000
  utimesSync(file, when, when)
}

function project(...segments: string[]): string {
  const path = join(home, ...segments)
  mkdirSync(path, { recursive: true })
  return path
}

function repository(...segments: string[]): string {
  const path = project(...segments)
  mkdirSync(join(path, '.git'), { recursive: true })
  return path
}

beforeEach(() => {
  // Canonical from the start: the scan returns canonical paths, since that
  // is what makes two spellings of one folder a single entry, and on macOS
  // the temporary directory is reached through a symlink.
  home = realpathSync(mkdtempSync(join(tmpdir(), 'harness-history-')))
  history = claudeHistoryDirectory(home)
  mkdirSync(history, { recursive: true })
})

afterEach(() => {
  home = ''
})

describe('discovering projects from agent history', () => {
  it('reads the path from the transcript rather than decoding the directory name', async () => {
    // The directory name is `...-easy-otc-api`, which could decode to three
    // nested folders. Only the transcript knows which it is.
    const path = repository('Code', 'easy-otc-api')
    conversation(path, 'one')

    const [found] = await discoverHistoryProjects({ home, historyDirectory: history })
    expect(found?.path).toBe(path)
    expect(found?.name).toBe('easy-otc-api')
    expect(found?.git).toBe(true)
  })

  it('counts conversations per folder and keeps the newest activity', async () => {
    const path = repository('Code', 'api')
    conversation(path, 'older', 9)
    conversation(path, 'newer', 2)

    const [found] = await discoverHistoryProjects({ home, historyDirectory: history })
    expect(found?.conversations).toBe(2)
    expect(Date.now() - found!.lastActivity).toBeLessThan(3 * 86_400_000)
  })

  it('puts Git repositories first and the newest activity on top', async () => {
    const fresh = repository('Code', 'fresh')
    const stale = repository('Code', 'stale')
    const folder = project('Notes', 'scratch')
    conversation(stale, 'a', 20)
    conversation(fresh, 'b', 1)
    conversation(folder, 'c', 0)

    const found = await discoverHistoryProjects({ home, historyDirectory: history })
    expect(found.map(entry => entry.name)).toEqual(['fresh', 'stale', 'scratch'])
    expect(found.map(entry => entry.git)).toEqual([true, true, false])
  })

  it('pre-selects an active Git repository with a few conversations, and nothing else', async () => {
    const active = repository('Code', 'active')
    const quiet = repository('Code', 'quiet')
    const old = repository('Code', 'old')
    const folder = project('Notes', 'folder')
    for (const id of ['a', 'b', 'c']) conversation(active, id, 3)
    conversation(quiet, 'a', 3)
    for (const id of ['a', 'b', 'c']) conversation(old, id, 45)
    for (const id of ['a', 'b', 'c']) conversation(folder, id, 3)

    const found = await discoverHistoryProjects({ home, historyDirectory: history })
    expect(found.filter(entry => entry.recommended).map(entry => entry.name)).toEqual(['active'])
  })

  it('leaves out scratch space, projects already registered, and folders that are gone', async () => {
    const downloads = repository('Downloads', 'cloned')
    const codexScratch = repository('Documents', 'Codex', 'session')
    const registered = repository('Code', 'registered')
    const missing = join(home, 'Code', 'deleted')
    const kept = repository('Code', 'kept')
    for (const path of [downloads, codexScratch, registered, kept, missing]) conversation(path, 'a')

    const found = await discoverHistoryProjects({ home, historyDirectory: history, registered: [registered] })
    expect(found.map(entry => entry.name)).toEqual(['kept'])
  })

  it('offers one entry for a folder two history directories disagree about', async () => {
    const path = repository('Code', 'shared')
    conversation(path, 'a', 4)
    // A second history directory for the same folder, which happens when the
    // path is reached through a different spelling.
    const alias = join(history, 'alias-spelling')
    mkdirSync(alias, { recursive: true })
    writeFileSync(join(alias, 'b.jsonl'), `${JSON.stringify({ type: 'user', cwd: path })}\n`)

    const found = await discoverHistoryProjects({ home, historyDirectory: history })
    expect(found).toHaveLength(1)
    expect(found[0]?.conversations).toBe(2)
  })

  it('ignores files that are not transcripts and records with no path', async () => {
    const path = repository('Code', 'api')
    const directory = join(history, path.replaceAll('/', '-'))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'memory.md'), 'not a transcript')
    writeFileSync(join(directory, 'empty.jsonl'), `${JSON.stringify({ type: 'summary' })}\n`)
    writeFileSync(join(directory, 'broken.jsonl'), '{"cwd": not json\n')

    expect(await discoverHistoryProjects({ home, historyDirectory: history })).toEqual([])
  })

  it('reads a path recorded part way into a transcript', async () => {
    const path = repository('Code', 'late')
    conversation(path, 'a', 1, [{ type: 'summary', content: 'no path here' }, { type: 'meta' }])

    expect((await discoverHistoryProjects({ home, historyDirectory: history }))[0]?.path).toBe(path)
  })

  it('returns nothing when the host has no agent history at all', async () => {
    expect(await discoverHistoryProjects({ home, historyDirectory: join(home, 'nowhere') })).toEqual([])
  })
})
