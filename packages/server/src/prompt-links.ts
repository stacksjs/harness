import type { IssueReference } from '@harness/contract'
import { issueRepositoryKey, parseIssueUrl } from '@harness/contract'

// Prompt sanitization follows T3 Code's MIT-licensed promptLinks.ts at
// 431da7f4e55b82b386e68a9f32c543fac2efedf5. See ../../drivers/T3CODE-LICENSE.md.
export const maxLinkedPromptLength = 8_000
export const promptLinkKeys = ['prompt', 'repo', 'pr', 'provider', 'model', 'issue'] as const

export interface LinkedPrompt {
  text: string
  hiddenCharacters: number
  repository?: string
  pullRequest?: string
  issue?: IssueReference
  provider?: string
  model?: string
}

export type PromptLinkResult = { prompt: LinkedPrompt } | { error: string }

// Preserve emoji sequences and ordinary line breaks while stripping controls
// that could make the text read differently from what the user sees.
const hiddenCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF0-\uFFFB\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu

function emojiPart(value: string | undefined): boolean {
  const point = value?.codePointAt(0)
  return point !== undefined && ((point >= 0x1F000 && point <= 0x1FAFF) || (point >= 0x2190 && point <= 0x2BFF) || point === 0xFE0F)
}

export function sanitizeLinkedPrompt(raw: string): Pick<LinkedPrompt, 'text' | 'hiddenCharacters'> {
  let removed = 0
  const visible = Array.from(raw.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(hiddenCharacters, () => {
    removed++
    return ''
  }))
  const text = visible.filter((character, index) => {
    if (character !== '\u200D' || (emojiPart(visible[index - 1]) && emojiPart(visible[index + 1]))) return true
    removed++
    return false
  }).join('').trim()
  return { text, hiddenCharacters: removed }
}

export function linkedRepository(value: string): string | null {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([a-z\d][a-z\d-]{0,38})\/([a-z\d._-]{1,104})\/?$/iu.exec(value.trim())
  if (!match) return null
  const name = match[2]!.replace(/\.git$/iu, '')
  return !name || name.length > 100 || /^\.+$/u.test(name) ? null : match[1] + '/' + name
}

export function repositoryFromRemote(remote: string): string | null {
  const source = remote.trim().replace(/^git@github\.com:/iu, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//iu, 'https://github.com/')
  return /^https?:\/\/(?:www\.)?github\.com\//iu.test(source) ? linkedRepository(source) : null
}

export function parsePullRequest(value: string): { repository: string, number: number, url: string } | null {
  const match = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([^/\s]+\/[^/\s#]+)(?:\/pull\/|\/|#)(\d+)(?:[/?#].*)?$/iu.exec(value.trim())
  if (!match) return null
  const repository = linkedRepository(match[1]!)
  const number = Number(match[2])
  return repository && Number.isSafeInteger(number) && number > 0
    ? { repository, number, url: 'https://github.com/' + repository + '/pull/' + number }
    : null
}

export function parseLinkedPrompt(params: URLSearchParams, newThread: boolean): PromptLinkResult {
  const raw = params.get('prompt') ?? ''
  if (raw.length > maxLinkedPromptLength) return { error: 'This prompt exceeds the 8,000 character limit.' }
  const prompt: LinkedPrompt = sanitizeLinkedPrompt(raw)
  if (!prompt.text && prompt.hiddenCharacters) return { error: 'This prompt contained only hidden characters.' }
  if (newThread && params.has('pr')) {
    const pull = parsePullRequest(params.get('pr')!)
    if (!pull) return { error: 'This link names an unreadable GitHub pull request.' }
    return { prompt: { ...prompt, repository: pull.repository, pullRequest: pull.url } }
  }
  if (!prompt.text) return { error: 'This link has no prompt.' }
  if (!newThread) return { prompt }
  const issue = params.has('issue') ? parseIssueUrl(params.get('issue')!) : null
  if (params.has('repo')) {
    const value = params.get('repo')!
    const repository = issue?.tracker === 'gitlab' && issueRepositoryKey(issue) === value.toLowerCase() ? value.toLowerCase() : linkedRepository(value)
    if (!repository) return { error: 'This link names an unreadable repository.' }
    prompt.repository = repository
  }
  if (params.has('issue')) {
    if (!issue || issueRepositoryKey(issue) !== prompt.repository?.toLowerCase())
      return { error: 'This issue link does not match the linked repository.' }
    prompt.issue = issue
  }
  const provider = params.get('provider')?.trim().toLowerCase()
  const model = params.get('model')?.trim()
  if (provider) prompt.provider = provider.slice(0, 80)
  if (model) prompt.model = model.slice(0, 160)
  return { prompt }
}

export function threadLink(origin: string, sessionId: number, turnId?: number): string {
  return new URL('/s/' + sessionId + (turnId ? '#turn-' + turnId : ''), origin).href
}

export function newThreadLink(origin: string, prompt: string, context?: { repository: string, provider?: string, model?: string }): string {
  if (prompt.length > maxLinkedPromptLength) throw new Error('Shorten the prompt to 8,000 characters to share it.')
  if (!sanitizeLinkedPrompt(prompt).text) throw new Error('Write a prompt before sharing it.')
  const address = new URL('/new', origin)
  address.searchParams.set('prompt', prompt)
  if (context) {
    address.searchParams.set('repo', context.repository)
    if (context.provider) address.searchParams.set('provider', context.provider)
    if (context.provider && context.model) address.searchParams.set('model', context.model)
  }
  return address.href
}
