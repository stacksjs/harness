import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ClaudeInstance } from '../src/claude'
import { CodexDriver } from '../src/codex'
import { prepareMcpConsent } from '../src/mcp-consent'

const form = {
  mode: 'form',
  message: 'Allow ChatGPT to use Fixture Calendar?',
  serverName: 'calendar',
  requestedSchema: { type: 'object', required: ['choice'], properties: { choice: {
    oneOf: [
      { const: 'once', title: 'Approve once' },
      { const: 'session', title: 'Allow this session' },
    ],
  } } },
}

it('maps only advertised scopes that can satisfy the consent form', () => {
  const prepared = prepareMcpConsent({ ...form, _meta: { allowPersistentApproval: true } }, 'codex')
  expect(prepared?.name).toBe('Fixture Calendar')
  expect(prepared?.connector.choices.map(choice => [choice.decision, choice.scope])).toEqual([
    ['cancelled', 'once'], ['denied', 'once'], ['allowed', 'session'], ['allowed', 'once'],
  ])
  expect(prepared?.accepted.get('session')).toEqual({ action: 'accept', content: { choice: 'session' }, _meta: { persist: 'session' } })
  expect(prepareMcpConsent({ ...form, mode: 'url', url: 'https://example.test/private' }, 'codex')).toBeUndefined()
  expect(prepareMcpConsent({
    ...form, requestedSchema: { properties: { privateValue: { default: 'hidden' } }, required: ['privateValue'] },
  }, 'claude')).toBeUndefined()
})

it('returns typed Codex MCP actions over stdio and handles provider withdrawal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-codex-mcp-'))
  const binaryPath = join(directory, 'codex-mcp-fixture')
  writeFileSync(binaryPath, `#!${process.execPath}
import { createInterface } from 'node:readline'
const send = frame => console.log(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const respond = (id, result) => send({ id, result })
const params = { ...${JSON.stringify(form)}, threadId: 'thread-1', turnId: 'turn-1' }
const replies = new Map()
const consent = (id, override) => send({ id, method: 'mcpServer/elicitation/request', params: { ...params, ...override } })
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, result } = JSON.parse(line)
  if (method === 'initialize') respond(id, {})
  else if (method === 'thread/start') respond(id, { thread: { id: 'thread-1' } })
  else if (method === 'turn/start') {
    respond(id, { turn: { id: 'turn-1' } })
    consent(90, { mode: 'url', url: 'https://example.test/auth?token=fixture-secret' })
    consent(91, { threadId: 'stale-thread' })
    consent(92)
  }
  else if (id === 90 || id === 91 || id === 92) {
    replies.set(id, result)
    if (replies.size !== 3) return
    const chosen = replies.get(92)
    const ok = replies.get(90)?.action === 'cancel' && replies.get(91)?.action === 'cancel'
      && chosen?.action === 'accept' && chosen?.content?.choice === 'session' && chosen?._meta?.persist === 'session'
    consent(93)
    send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 93 } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: ok ? 'matched' : 'mismatch' } })
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1' } } })
  }
})
`, { mode: 0o755 })
  const instance = await CodexDriver.create({ workspacePath: directory, binaryPath })
  const events = []
  try {
    for await (const event of instance.startTurn({ text: 'Ask for connector consent.' })) {
      events.push(event)
      if (event.type === 'approval-request' && event.requestId === 'mcp:92')
        await instance.respondApproval(event.requestId, true, undefined, { decision: 'allowed', scope: 'session' })
    }
    expect(events.map(event => event.type)).toEqual(['session-bound', 'approval-request', 'approval-request', 'approval-cancelled', 'assistant-delta', 'turn-complete'])
    expect(events[1]).toMatchObject({ toolName: 'Fixture Calendar', connector: { choices: [{ label: 'Cancel' }, { label: 'Decline' }, { label: 'Allow this session' }, { label: 'Approve' }] } })
    expect(events[3]).toEqual({ type: 'approval-cancelled', requestId: 'mcp:93' })
    expect(events[4]).toEqual({ type: 'assistant-delta', text: 'matched' })
    expect(JSON.stringify(events)).not.toContain('fixture-secret')
  }
  finally {
    await instance.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}, 5000)

it('uses the Claude SDK elicitation hook for consent and cancels unsupported URL mode', async () => {
  const controller = new AbortController()
  const answers = Promise.withResolvers<unknown[]>()
  const instance = new ClaudeInstance({ workspacePath: tmpdir() }, (input) => {
    const { onElicitation } = input.options as Options
    const stream = (async function* () {
      const url = await onElicitation!({ serverName: 'calendar', message: 'Open a link', mode: 'url', url: 'https://example.test/auth' }, { signal: controller.signal })
      const explicit = await onElicitation!({ ...form, mode: 'form' }, { signal: controller.signal })
      const approved = await onElicitation!({ ...form, mode: 'form' }, { signal: controller.signal })
      answers.resolve([url, explicit, approved])
      yield { type: 'result', subtype: 'success', usage: {} }
    })()
    return Object.assign(stream, { close() {}, async interrupt() { controller.abort() } }) as unknown as Query
  })
  const iterator = instance.startTurn({ text: 'Ask for connector consent.' })[Symbol.asyncIterator]()
  try {
    const { value } = await iterator.next()
    expect(value).toMatchObject({ type: 'approval-request', connector: {
      choices: [{ decision: 'cancelled' }, { decision: 'denied' }, { decision: 'allowed', scope: 'once' }],
    } })
    if (value.type !== 'approval-request') throw new Error('Expected connector consent')
    await instance.respondApproval(value.requestId, false, undefined, { decision: 'cancelled', scope: 'once' })
    const next = await iterator.next()
    if (next.value.type !== 'approval-request') throw new Error('Expected a second connector consent')
    await instance.respondApproval(next.value.requestId, true, undefined, { decision: 'allowed', scope: 'once' })
    expect(await answers.promise).toEqual([{ action: 'cancel' }, { action: 'cancel' }, { action: 'accept', content: { choice: 'once' } }])
    expect((await iterator.next()).value).toMatchObject({ type: 'turn-complete' })
  }
  finally { await instance.stop() }
})
