import { createHash } from 'node:crypto'
import { placeReviewConversations, reviewLineRange } from './pull-request-conversations'

export const reviewVerdicts = ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const
const states = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const
const lineId = /^file-[a-f0-9]{24}-[LR][1-9][0-9]*$/u
const sha = /^[0-9a-f]{40}$/u
const intentId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

type Draft = { path: string, page: number, line: string, start: string, body: string }

export function fileAnchor(path: string) {
  return 'file-' + createHash('sha256').update(path).digest('hex').slice(0, 24)
}

function draftText(value: unknown, maxBytes: number) {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const text = value.replace(/\r\n?/gu, '\n').trim()
  return Buffer.byteLength(text) <= maxBytes ? text : null
}

export function readInlineReview(values: URLSearchParams) {
  const token = values.get('intent') ?? ''
  const base = values.get('base') ?? ''
  const verdict = reviewVerdicts.find(verdict => verdict === values.get('verdict'))
  const summary = draftText(values.get('summary'), 16_384)
  if (!intentId.test(token) || !sha.test(base) || !verdict || summary === null) return null
  let input: unknown
  try { input = JSON.parse(values.get('drafts') ?? '') }
  catch { return null }
  if (!Array.isArray(input) || input.length > 50 || (!summary && !input.length && verdict !== 'APPROVE')) return null
  const drafts: Draft[] = []
  const locations = new Set<string>()
  let bytes = Buffer.byteLength(summary)
  for (const entry of input) {
    const { path, page, line, start } = entry ?? {}
    const body = draftText(entry?.body, 8192)
    if (!body || typeof path !== 'string' || !path || path.includes('\0') || Buffer.byteLength(path) > 4096
      || !Number.isInteger(page) || page < 1 || page > 100 || typeof line !== 'string' || typeof start !== 'string'
      || !lineId.test(line) || !lineId.test(start)) return null
    const location = JSON.stringify([path, line, start])
    if (locations.has(location)) return null
    locations.add(location)
    bytes += Buffer.byteLength(body)
    if (bytes > 65_536) return null
    drafts.push({ path, page, line, start, body })
  }
  return { token, base, verdict, summary, drafts }
}

export function anchoredReviewComment(draft: Draft, patch: string) {
  const range = reviewLineRange(placeReviewConversations(patch, []), fileAnchor(draft.path), draft.line, draft.start)
  if (!range) return null
  const { first, last } = range
  const side = (side: 'before' | 'after') => side === 'before' ? 'LEFT' : 'RIGHT'
  const ranged = first.row.position !== last.row.position
  return { path: draft.path, body: draft.body, line: last.number, side: side(last.side),
    ...(ranged && { start_line: first.number, start_side: side(first.side) }) }
}

export const inlineReviewMarker = /^<!-- harness:pr-review:[a-f0-9-]{36} -->(?:\r?\n\r?\n)?/u

export function inlineReviewBody(token: string, summary: string) {
  return '<!-- harness:pr-review:' + token + ' -->' + (summary ? '\n\n' + summary : '')
}

export function matchesInlineReview(value: unknown, login: string, head: string, body: string, verdict: typeof reviewVerdicts[number]) {
  const review = value as { id?: number, user?: { login?: string }, commit_id?: string, body?: string, state?: string } | null
  return Number.isSafeInteger(review?.id) && review?.user?.login?.toLowerCase() === login.toLowerCase()
    && review.commit_id === head && review.body === body && review.state === states[verdict]
}
