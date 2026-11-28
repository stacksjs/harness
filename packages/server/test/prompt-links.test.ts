import { describe, expect, it } from 'bun:test'
import { matchingLinkedModel } from '../src/browser-prompt-links'
import { linkedRepository, newThreadLink, parseLinkedPrompt, repositoryFromRemote, sanitizeLinkedPrompt, threadLink } from '../src/prompt-links'

describe('linked prompts', () => {
  it('removes hidden controls while preserving multiline text and emoji', () => {
    expect(sanitizeLinkedPrompt(' \u200bFirst\r\nSe\u202Econd 👩‍💻 A\u200DB\u{E0061} ')).toEqual({
      text: 'First\nSecond 👩‍💻 AB', hiddenCharacters: 4,
    })
    expect(sanitizeLinkedPrompt('zero\u2028one\u2029two').text).toBe('zero\none\ntwo')
  })

  it('rejects empty, hidden-only, unreadable, and oversized prompts', () => {
    for (const params of [
      { prompt: '  ' }, { prompt: '\u200b\u200D' }, { prompt: 'x'.repeat(8001) },
      { prompt: 'test', repo: 'https://elsewhere.invalid/a/b' },
      { prompt: 'test', pr: 'a/b/0' },
    ]) {
      expect(parseLinkedPrompt(new URLSearchParams(params), true)).toHaveProperty('error')
    }
    expect(parseLinkedPrompt(new URLSearchParams({ prompt: 'x'.repeat(8000) }), true)).toHaveProperty('prompt')
  })

  it('carries only text into existing conversations', () => {
    expect(parseLinkedPrompt(new URLSearchParams({
      prompt: 'hello', repo: 'owner/name', provider: 'codex', model: 'specific-model', branch: 'foreign', permission: 'full-access',
    }), false)).toEqual({ prompt: { text: 'hello', hiddenCharacters: 0 } })
  })

  it('normalizes a GitHub repository and pull request without expanding a URL from another host', () => {
    expect(linkedRepository('https://github.com/Owner/Repo.git/')).toBe('Owner/Repo')
    expect(repositoryFromRemote('git@github.com:Owner/Repo.git')).toBe('Owner/Repo')
    expect(repositoryFromRemote('ssh://git@github.com/Owner/Repo')).toBe('Owner/Repo')
    expect(repositoryFromRemote('https://token@github.com/Owner/Repo')).toBeNull()
    expect(parseLinkedPrompt(new URLSearchParams({ pr: 'https://github.com/Owner/Repo/pull/123/files' }), true)).toEqual({
      prompt: { text: '', hiddenCharacters: 0, repository: 'Owner/Repo', pullRequest: 'https://github.com/Owner/Repo/pull/123' },
    })
  })

  it('round-trips encoded prompt text and puts a turn on a clean thread URL', () => {
    const share = new URL(newThreadLink('https://harness.test', 'A&B#C\n<> { }', { repository: 'Owner/Repo', provider: 'codex', model: 'fast' }))
    expect(share.pathname).toBe('/new')
    expect(share.searchParams.get('prompt')).toBe('A&B#C\n<> { }')
    expect(parseLinkedPrompt(share.searchParams, true)).toMatchObject({ prompt: { provider: 'codex', model: 'fast' } })
    expect(threadLink('https://harness.test', 12, 10)).toBe('https://harness.test/s/12#turn-10')
  })

  it('uses only a ready account that actually offers the linked model', () => {
    const rows = [
      { kind: 'codex', status: 'unauthenticated', models: [{ id: 'fast', name: 'Fast' }] },
      { kind: 'codex', status: 'ready', id: 5, models: [{ id: 'fast', name: 'Fast Model' }] },
    ]
    expect(matchingLinkedModel('codex', 'fast model', rows)).toEqual({ provider: 'codex:5', model: 'fast' })
    expect(matchingLinkedModel('codex', 'unknown', rows)).toBeNull()
    expect(matchingLinkedModel('claude', undefined, rows)).toBeNull()
  })
})

it('opens an issue-link draft only when its GitHub repository matches', () => {
  const params = new URLSearchParams({ prompt: 'Review the issue', repo: 'Owner/Repo', issue: 'https://github.com/Owner/Repo/issues/24' })
  expect(parseLinkedPrompt(params, true)).toMatchObject({ prompt: { issue: { tracker: 'github', repository: 'owner/repo', number: 24 } } })
  params.set('issue', 'https://github.com/other/repo/issues/24')
  expect(parseLinkedPrompt(params, true)).toHaveProperty('error')
  expect(parseLinkedPrompt(params, false)).toEqual({ prompt: { text: 'Review the issue', hiddenCharacters: 0 } })
})
