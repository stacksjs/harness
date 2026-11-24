import type { HarnessState, SessionState } from '@harness/engine'
import { basename } from 'node:path'

interface ThreadSearchMatch {
  id: number
  title: string
  project: string
  excerpt?: string
  turnId?: number
}

const RESULT_LIMIT = 24

export function threadTitle(session: SessionState): string {
  return session.turns[0]?.prompt?.slice(0, 60) ?? 'New session'
}

export function searchThreads(state: HarnessState, profileId: number, query: string): ThreadSearchMatch[] {
  const terms = query.trim().slice(0, 120).split(/\s+/).filter(Boolean).slice(0, 12)
  if (!state.profiles.has(profileId) || terms.length === 0) return []
  const patterns = terms.map(term => new RegExp(RegExp.escape(term), 'iu'))
  const matchesAll = (text: string) => patterns.every(pattern => pattern.test(text))
  const matchMessages = terms.some(term => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}|[\p{L}\p{N}]{3}/u.test(term))
  const threads: ThreadSearchMatch[] = []
  const messages: ThreadSearchMatch[] = []

  for (const session of [...state.sessions.values()].reverse()) {
    const workspace = state.workspaces.get(session.workspaceId)
    if (workspace?.profileId !== profileId) continue
    const title = threadTitle(session)
    const project = workspace.scratch ? 'No project' : basename(workspace.path) || workspace.path
    const thread = { id: session.id, title, project }
    if (matchesAll([title, project, session.branch].join(' '))) {
      threads.push(thread)
      if (threads.length >= RESULT_LIMIT) break
      continue
    }
    if (!matchMessages || messages.length >= RESULT_LIMIT) continue
    for (let index = session.turns.length - 1; index >= 0; index--) {
      const turn = session.turns[index]!
      const text = [turn.prompt, turn.response].find(matchesAll)
      if (!text) continue
      const offset = text.search(patterns[0]!)
      const start = Math.max(0, offset - 36)
      const end = Math.min(text.length, offset + 100)
      const excerpt = `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`
      messages.push({ ...thread, excerpt, turnId: turn.id })
      break
    }
  }
  return threads.concat(messages).slice(0, RESULT_LIMIT)
}
