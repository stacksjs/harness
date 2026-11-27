/**
 * Projects the agent CLIs on this host have already worked in.
 *
 * A fresh Harness knows nothing, and asking someone to type an absolute path
 * is a poor first question when Claude Code has been run in twenty of their
 * repositories already. The reference welcome page offers what it finds in
 * agent history instead, Git repositories first and newest activity on top.
 *
 * The directory name under `~/.claude/projects` is the project path with its
 * separators replaced by dashes, which is not reversible: a folder called
 * `easy-otc-api` and one called `easy/otc/api` encode the same way. So the
 * path is read from the transcripts themselves, where every record carries
 * the `cwd` it ran in, and the directory name is never decoded.
 */

import type { Dirent } from 'node:fs'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

export interface HistoryProject {
  /** The canonical absolute path, as the transcripts recorded it. */
  path: string
  name: string
  /** Whether the folder is a Git repository, which decides the grouping. */
  git: boolean
  /** How many conversations this host has in that folder. */
  conversations: number
  /** Milliseconds, from the newest transcript in that folder. */
  lastActivity: number
  /** Whether to offer it pre-selected: see `RECENT_WINDOW_MS` below. */
  recommended: boolean
}

export interface HistoryScanOptions {
  /** Where Claude Code keeps its per-project transcripts. */
  historyDirectory?: string
  /** The user's home, which the excluded folders below are relative to. */
  home?: string
  /** Canonical paths already registered here, which are not offered again. */
  registered?: Iterable<string>
}

const MAX_PROJECTS = 50
const MAX_DIRECTORIES = 500
const MAX_TRANSCRIPTS = 200
/** Enough to reach a record carrying `cwd` without reading a whole session. */
const MAX_HEAD_BYTES = 64 * 1024
const RECENT_WINDOW_MS = 30 * 86_400_000
const RECOMMENDED_CONVERSATIONS = 3

/**
 * Folders that are someone else's scratch space rather than a project.
 *
 * Relative to the home directory, matched against the path itself and
 * anything below it, which is how the reference excludes them.
 */
const EXCLUDED = ['Downloads', join('Documents', 'Codex')]

export function claudeHistoryDirectory(home = homedir()): string {
  return join(home, '.claude', 'projects')
}

function withinExcluded(path: string, home: string): boolean {
  return EXCLUDED.some((folder) => {
    const inside = relative(join(home, folder), path)
    return inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))
  })
}

async function folderEntries(folder: string, budget: { remaining: number }): Promise<Dirent[]> {
  if (budget.remaining <= 0) return []
  const handle = await opendir(folder).catch(() => null)
  if (!handle) return []
  const entries: Dirent[] = []
  try {
    for await (const entry of handle) {
      entries.push(entry)
      if (--budget.remaining === 0) break
    }
  }
  catch { return [] }
  return entries
}

/**
 * The working directory a transcript ran in.
 *
 * Only the head of the file is read: `cwd` appears on ordinary records near
 * the start, and a long session is megabytes of assistant text that would
 * cost the whole scan nothing but time.
 */
async function transcriptCwd(path: string): Promise<string | null> {
  const head = await readFile(path, 'utf8').catch(() => null)
  if (head === null) return null
  for (const line of head.slice(0, MAX_HEAD_BYTES).split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const record = JSON.parse(line) as Record<string, unknown>
      const cwd = record.cwd
      if (typeof cwd === 'string' && isAbsolute(cwd) && !cwd.includes('\0')) return cwd
    }
    catch { continue }
  }
  return null
}

/** A folder that is still there, is a folder, and is not a symlink alias. */
async function usableFolder(path: string): Promise<string | null> {
  const canonical = await realpath(path).catch(() => null)
  if (canonical === null) return null
  return (await lstat(canonical).catch(() => null))?.isDirectory() ? canonical : null
}

export async function discoverHistoryProjects(options: HistoryScanOptions = {}): Promise<HistoryProject[]> {
  const home = options.home ?? homedir()
  const historyDirectory = options.historyDirectory ?? claudeHistoryDirectory(home)
  const registered = new Set(options.registered ?? [])
  const budget = { remaining: MAX_DIRECTORIES }
  const found = new Map<string, { conversations: number, lastActivity: number }>()

  for (const entry of await folderEntries(historyDirectory, budget)) {
    if (!entry.isDirectory()) continue
    const transcripts = await folderEntries(join(historyDirectory, entry.name), { remaining: MAX_TRANSCRIPTS })
    for (const transcript of transcripts) {
      if (!transcript.isFile() || !transcript.name.endsWith('.jsonl')) continue
      const file = join(historyDirectory, entry.name, transcript.name)
      const [cwd, stats] = await Promise.all([transcriptCwd(file), lstat(file).catch(() => null)])
      if (cwd === null || !stats) continue
      // Several history directories can name one folder, and the counts and
      // the newest activity belong to the folder rather than to either of
      // them, so they are merged here and not after canonicalizing.
      const seen = found.get(cwd) ?? { conversations: 0, lastActivity: 0 }
      found.set(cwd, {
        conversations: seen.conversations + 1,
        lastActivity: Math.max(seen.lastActivity, stats.mtimeMs),
      })
    }
  }

  const now = Date.now()
  const projects = new Map<string, HistoryProject>()
  for (const [path, { conversations, lastActivity }] of found) {
    if (withinExcluded(path, home)) continue
    const canonical = await usableFolder(path)
    if (canonical === null || registered.has(canonical)) continue
    const existing = projects.get(canonical)
    const git = (await lstat(join(canonical, '.git')).catch(() => null)) !== null
    projects.set(canonical, {
      path: canonical,
      name: basename(canonical) || canonical,
      git,
      conversations: conversations + (existing?.conversations ?? 0),
      lastActivity: Math.max(lastActivity, existing?.lastActivity ?? 0),
      recommended: false,
    })
  }

  return [...projects.values()]
    .map(project => ({
      ...project,
      recommended: project.git && project.conversations >= RECOMMENDED_CONVERSATIONS
        && now - project.lastActivity <= RECENT_WINDOW_MS,
    }))
    // Git repositories first, newest activity on top, as the reference lists
    // them; everything else keeps the same order under "Other folders".
    .sort((first, second) => Number(second.git) - Number(first.git) || second.lastActivity - first.lastActivity)
    .slice(0, MAX_PROJECTS)
}
