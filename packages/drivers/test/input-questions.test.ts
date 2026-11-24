import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createAcpDriver } from '../src/acp'
import { ClaudeInstance } from '../src/claude'
import { CodexDriver } from '../src/codex'
import { acpInputForm } from '../src/input-questions'

const rpcFixture = `
import { createInterface } from 'node:readline'
const codex = process.argv.includes('app-server')
const send = frame => console.log(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const respond = (id, result) => send({ id, result })
let promptId
const form = { type: 'object', required: ['choice', 'confirm', 'count'], properties: {
  choice: { type: 'array', minItems: 1, items: { anyOf: [{ const: 'code', title: 'Source code' }] } },
  confirm: { type: 'boolean' },
  count: { type: 'integer' },
} }
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params, result } = JSON.parse(line)
  if (method === 'initialize') {
    if (codex ? params.capabilities?.experimentalApi !== true : !params.clientCapabilities?.elicitation?.form)
      throw new Error('Client did not advertise the question capability')
    respond(id, {})
  }
  else if (method === 'thread/start') respond(id, { thread: { id: 'codex-thread' } })
  else if (method === 'session/new') respond(id, { sessionId: 'acp-session' })
  else if (method === 'turn/start') {
    respond(id, { turn: { id: 'codex-turn' } })
    send({ id: 90, method: 'item/tool/requestUserInput', params: { threadId: 'codex-thread', turnId: 'codex-turn', questions: [
      { id: 'choice', question: 'Choose the fixture.', options: [{ label: 'Source code', description: 'Use a fixture' }], isOther: true },
      { id: 'private', question: 'Enter the fixture code.', isSecret: true },
    ] } })
  }
  else if (method === 'session/prompt') {
    promptId = id
    send({ id: 90, method: 'elicitation/create', params: { sessionId: 'acp-session', mode: 'form', requestedSchema: form, message: 'Choose the fixture.' } })
  }
  else if (id === 90) {
    const ok = codex
      ? result?.answers?.choice?.answers?.[0] === 'Custom fixture' && result?.answers?.private?.answers?.[0] === 'masked'
      : result?.action === 'accept' && result?.content?.choice?.[0] === 'code' && result?.content?.confirm === false && result?.content?.count === 3
    if (codex) {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread', delta: ok ? 'matched' : 'mismatch' } })
      send({ method: 'turn/completed', params: { turn: { id: 'codex-turn' } } })
    }
    else {
      send({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ok ? 'matched' : 'mismatch' } } } })
      respond(promptId, { stopReason: 'end_turn' })
    }
  }
})
`

it('delivers Codex questions and typed ACP form answers over their stdio transports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-provider-input-'))
  try {
    const codexPath = join(dir, 'codex-fixture')
    writeFileSync(codexPath, `#!${process.execPath}\n${rpcFixture}`)
    chmodSync(codexPath, 0o755)
    const acpPath = join(dir, 'acp-fixture.mjs')
    writeFileSync(acpPath, rpcFixture)
    const acp = createAcpDriver({ kind: 'opencode', binary: process.execPath, acpArgs: () => [acpPath] })
    for (const driver of [CodexDriver, acp]) {
      const instance = await driver.create({ workspacePath: dir, binaryPath: driver === CodexDriver ? codexPath : process.execPath, autoApprove: true })
      const events = []
      try {
        for await (const event of instance.startTurn({ text: 'Ask a fixture question' })) {
          events.push(event)
          if (event.type !== 'input-request') continue
          if (driver === CodexDriver) {
            expect(event.questions).toMatchObject([{ id: 'choice', allowOther: true }, { id: 'private', sensitive: true }])
            await instance.respondInput!(event.requestId, [{ questionId: 'choice', values: ['Custom fixture'] }, { questionId: 'private', values: ['masked'] }])
          }
          else {
            expect(event.questions[0]).toMatchObject({ kind: 'multiple', minSelections: 1, options: [{ label: 'Source code', value: 'code' }] })
            await instance.respondInput!(event.requestId, [
              { questionId: 'choice', values: ['code'] }, { questionId: 'confirm', values: ['false'] }, { questionId: 'count', values: ['3'] },
            ])
          }
        }
        expect(events.map(event => event.type)).toEqual(['session-bound', 'input-request', 'assistant-delta', 'turn-complete'])
        expect(events[2]).toEqual({ type: 'assistant-delta', text: 'matched' })
      }
      finally {
        await instance.stop()
      }
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 5000)

it('delivers Claude questions while the SDK is blocked on its permission callback', async () => {
  const abort = new AbortController()
  const result = Promise.withResolvers<unknown>()
  const instance = new ClaudeInstance({ workspacePath: tmpdir(), autoApprove: true }, (input) => {
    const sdkOptions = input.options as Options
    const stream = (async function* () {
      const resultValue = await sdkOptions.canUseTool!('AskUserQuestion', { questions: [{
        question: 'Choose validators', header: 'Checks', multiSelect: true, options: [{ label: 'Schema' }, { label: 'UI' }],
      }] }, { signal: abort.signal, toolUseID: 'sdk-tool' })
      result.resolve(resultValue)
      yield { type: 'result', subtype: 'success', usage: {} }
    })()
    return Object.assign(stream, { close() {}, async interrupt() { abort.abort() } }) as unknown as Query
  })
  const events = instance.startTurn({ text: 'Ask first' })[Symbol.asyncIterator]()
  try {
    const { value } = await events.next()
    expect(value).toMatchObject({ type: 'input-request', questions: [{ kind: 'multiple' }] })
    if (value.type !== 'input-request') throw new Error('Expected the SDK question')
    await instance.respondInput(value.requestId, [{ questionId: 'Choose validators', values: ['Schema', 'UI'] }])
    expect(await result.promise).toMatchObject({
      behavior: 'allow',
      toolUseID: 'sdk-tool',
      updatedInput: { answers: { 'Choose validators': 'Schema, UI' } },
    })
    expect((await events.next()).value).toMatchObject({ type: 'turn-complete' })
    expect((await events.next()).done).toBe(true)
  }
  finally {
    await instance.stop()
  }
})

it('declines ACP form fields it cannot faithfully represent', () => {
  expect(acpInputForm({ type: 'object', properties: { nested: { type: 'object' } } }, 'Question')).toBeUndefined()
})

it('folds an optional ACP free-text companion into the choice', () => {
  const form = acpInputForm({ type: 'object', properties: {
    scheme: { type: 'string', enum: ['default'] },
    scheme__other: { type: 'string' },
  } }, 'Choose a scheme')
  expect(form?.questions).toMatchObject([{ id: 'scheme', allowOther: true, optional: true }])
  expect(form?.content([{ questionId: 'scheme', values: ['custom'] }])).toEqual({ scheme__other: 'custom' })
  expect(form?.content([{ questionId: 'scheme', values: ['default'] }])).toEqual({ scheme: 'default' })
})
