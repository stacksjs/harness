import type { StartTurnInput } from '../src/types'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { approvalLabel, CodexDriver, createLineReader, readableError, threadStartParams, translateNotification, usageOf } from '../src/codex'

describe('codex thread resume', () => {
  it.each(['ready', 'archived', 'moved-with-error', 'missing', 'different'] as const)('preserves the original conversation when an account reports %s', async (outcome) => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-resume-'))
    const binaryPath = join(workspacePath, 'codex-fixture')
    try {
      writeFileSync(binaryPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const outcome = ${JSON.stringify(outcome)}
let archived = outcome === 'archived' || outcome === 'moved-with-error'
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  appendFileSync('requests.log', JSON.stringify({ method, params }) + '\\n')
  const respond = payload => console.log(JSON.stringify({ id, ...payload }))
  if (method === 'initialize') respond({ result: {} })
  else if (method === 'thread/resume') {
    if (archived) respond({ error: { message: 'session native-thread is archived' } })
    else if (outcome === 'missing') respond({ error: { message: 'session unavailable in this account' } })
    else respond({ result: { thread: { id: outcome === 'different' ? 'wrong-thread' : 'native-thread' } } })
  }
  else if (method === 'thread/unarchive') {
    archived = false
    respond(outcome === 'moved-with-error' ? { error: { message: 'failed to read unarchived thread' } } : { result: {} })
  }
  else if (method === 'turn/start') respond({ result: { turn: { id: 'native-turn' } } })
  else respond({ error: { message: 'unexpected request' } })
}
`, { mode: 0o755 })
      const instance = await CodexDriver.create({ binaryPath, workspacePath, autoApprove: true })
      try {
        const events = instance.startTurn({
          text: 'Continue the original conversation', providerSessionId: 'native-thread',
          codexSelection: { model: 'second-model', effort: 'high' },
        })[Symbol.asyncIterator]()
        const wasArchived = outcome === 'archived' || outcome === 'moved-with-error'
        const shouldResume = outcome === 'ready' || wasArchived
        if (shouldResume) {
          expect((await events.next()).value).toEqual({ type: 'steering-ready' })
        }
        else {
          expect((await events.next()).value).toMatchObject({ type: 'error', message: expect.stringContaining('Check the selected account and retry') })
          expect((await events.next()).done).toBe(true)
        }
        const requests = readFileSync(join(workspacePath, 'requests.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const methods = ['initialize', 'thread/resume']
        if (wasArchived) methods.push('thread/unarchive', 'thread/resume')
        if (shouldResume) methods.push('turn/start')
        expect(requests.map(request => request.method)).toEqual(methods)
        expect(requests.slice(1).every(request => request.params.threadId === 'native-thread')).toBe(true)
        if (shouldResume) expect(requests.at(-1)?.params).toMatchObject({ model: 'second-model', effort: 'high', serviceTier: null })
      }
      finally {
        await instance.stop()
      }
    }
    finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})

it('retains the latest matching native turn occupancy rather than cumulative usage', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-context-'))
  const binaryPath = join(workspacePath, 'codex-fixture')
  try {
    writeFileSync(binaryPath, `#!${process.execPath}
import { createInterface } from 'node:readline'
const threadId = 'native-context'
const notify = (method, params) => console.log(JSON.stringify({ method, params }))
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  if (id === undefined) continue
  const respond = result => console.log(JSON.stringify({ id, result }))
  if (method === 'thread/start') respond({ thread: { id: threadId } })
  else if (method === 'turn/start') {
    const turnId = 'native-turn'
    respond({ turn: { id: turnId } })
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 90, outputTokens: 10, totalTokens: 100 }, total: { totalTokens: 8000 }, modelContextWindow: 32000 } })
    notify('thread/tokenUsage/updated', { threadId: 'different-thread', turnId, tokenUsage: { last: { totalTokens: 9999 }, modelContextWindow: 16000 } })
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
  }
  else respond({})
}
`, { mode: 0o755 })
    const instance = await CodexDriver.create({ binaryPath, workspacePath })
    try {
      const events = []
      for await (const event of instance.startTurn({ text: 'Use the saved context.' })) events.push(event)
      expect(events.at(-1)).toMatchObject({ type: 'turn-complete', contextUsage: { usedTokens: 100, maxTokens: 32000 } })
    }
    finally {
      await instance.stop()
    }
  }
  finally {
    rmSync(workspacePath, { recursive: true, force: true })
  }
})

it('delivers an attachment-only prompt as a native local image', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-image-'))
  const binaryPath = join(workspacePath, 'codex-fixture')
  const imagePath = join(workspacePath, 'image.png')
  try {
    writeFileSync(binaryPath, `#!${process.execPath}
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const threadId = 'image-thread'
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  let result = {}
  if (method === 'thread/start') result = { thread: { id: threadId } }
  if (method === 'turn/start') {
    writeFileSync(${JSON.stringify(join(workspacePath, 'input.json'))}, JSON.stringify(params.input))
    result = { turn: { id: 'image-turn' } }
  }
  console.log(JSON.stringify({ id, result }))
  if (method === 'turn/start') console.log(JSON.stringify({
    method: 'turn/completed', params: { threadId, turn: { id: 'image-turn', status: 'completed' } },
  }))
}
`, { mode: 0o755 })
    const instance = await CodexDriver.create({ binaryPath, workspacePath })
    try {
      const events = []
      for await (const event of instance.startTurn({ text: '', localImages: [imagePath] })) events.push(event)
      expect(events.at(-1)?.type).toBe('turn-complete')
      expect(await Bun.file(join(workspacePath, 'input.json')).json()).toEqual([{ type: 'localImage', path: imagePath }])
    }
    finally { await instance.stop() }
  }
  finally { rmSync(workspacePath, { recursive: true, force: true }) }
})

describe('codex native compaction', () => {
  it.each(['confirmed', 'unconfirmed', 'unsupported', 'interrupted'] as const)('reports the %s provider operation without sending a prompt', async mode => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-compact-'))
    const binaryPath = join(workspacePath, 'codex-fixture')
    try {
      writeFileSync(binaryPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const mode = ${JSON.stringify(mode)}
const threadId = 'existing-native-thread'
const turnId = 'native-compact-turn'
const notify = (method, params) => console.log(JSON.stringify({ method, params }))
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  appendFileSync('requests.log', JSON.stringify({method, params}) + '\\n')
  const respond = payload => console.log(JSON.stringify({ id, ...payload }))
  if (method === 'thread/resume') respond({ result: { thread: { id: threadId } } })
  else if (method === 'thread/compact/start') {
    if (mode === 'unsupported') {
      respond({ error: { code: -32601 } })
      continue
    }
    notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } })
    respond({ result: {} })
    notify('item/completed', { threadId, turnId: mode === 'confirmed' ? turnId : 'older-turn', item: { type: 'contextCompaction', id: 'compact-item' } })
    if (mode !== 'interrupted') notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
  }
  else if (method === 'turn/interrupt') {
    respond({ result: {} })
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted' } })
  }
  else respond({ result: {} })
}
`, { mode: 0o755 })
      const instance = await CodexDriver.create({ binaryPath, workspacePath })
      try {
        const events = instance.compact!('existing-native-thread')[Symbol.asyncIterator]()
        if (mode === 'interrupted') {
          const log = Bun.file(join(workspacePath, 'requests.log'))
          for (let attempt = 0; attempt < 100 && !(await log.exists() && (await log.text()).includes('thread/compact/start')); attempt++)
            await Bun.sleep(10)
          await Bun.sleep(25)
          await instance.interrupt()
        }
        const result = (await events.next()).value
        if (mode === 'confirmed')
          expect(result).toMatchObject({ type: 'turn-complete', contextCompacted: true, providerTurnId: 'native-compact-turn' })
        else
          expect(result).toMatchObject({ type: 'error' })
        expect((await events.next()).done).toBe(true)
        const requests = readFileSync(join(workspacePath, 'requests.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(requests.map(request => request.method)).toEqual([
          'initialize', 'thread/resume', 'thread/compact/start', ...(mode === 'interrupted' ? ['turn/interrupt'] : []),
        ])
        expect(requests[2]?.params).toEqual({ threadId: 'existing-native-thread' })
        if (mode === 'interrupted')
          expect(requests[3]?.params).toEqual({ threadId: 'existing-native-thread', turnId: 'native-compact-turn' })
      }
      finally {
        await instance.stop()
      }
    }
    finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('codex provider handoff', () => {
  it.each(['native', 'legacy', 'ambiguous', 'stopped', 'resumed', 'resume-missing'] as const)('starts the new request correctly with %s history delivery', async (mode) => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-handoff-'))
    const binaryPath = join(workspacePath, 'codex-fixture')
    try {
      writeFileSync(binaryPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const mode = ${JSON.stringify(mode)}
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  appendFileSync('requests.log', JSON.stringify({ method, params }) + '\\n')
  const respond = payload => console.log(JSON.stringify({ id, ...payload }))
  if (method === 'thread/start') respond({ result: { thread: { id: 'new-native-thread' } } })
  else if (method === 'thread/resume') {
    if (mode === 'resume-missing') respond({ error: { code: -32602 } })
    else respond({ result: { thread: { id: params.threadId } } })
  }
  else if (method === 'thread/inject_items') {
    if (mode === 'legacy') respond({ error: { code: -32601 } })
    else if (mode === 'ambiguous') respond({ error: { code: -32603 } })
    else if (mode !== 'stopped') respond({ result: {} })
  }
  else if (method === 'turn/start') respond({ result: { turn: { id: 'new-native-turn' } } })
  else respond({ result: {} })
}
`, { mode: 0o755 })
      const instance = await CodexDriver.create({ binaryPath, workspacePath })
      try {
        const returning = mode === 'resumed' || mode === 'resume-missing'
        const input: StartTurnInput = {
          text: 'The current request stays separate.',
          ...(returning ? { providerSessionId: 'original-native-thread', requireResume: true } : {}),
          historicalContext: {
            items: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Original assistant response.' }] }],
            inlinePrompt: 'Previous response.\n\nThe current request stays separate.',
          },
        }
        const events = instance.startTurn(input)[Symbol.asyncIterator]()
        if (!returning)
          expect((await events.next()).value).toEqual({ type: 'session-bound', providerSessionId: 'new-native-thread' })
        if (mode === 'resume-missing') {
          expect((await events.next()).value).toEqual({ type: 'resume-unavailable' })
          expect((await events.next()).done).toBe(true)
        }
        else if (mode === 'stopped') {
          const log = Bun.file(join(workspacePath, 'requests.log'))
          for (let attempt = 0; attempt < 100 && !(await log.text()).includes('thread/inject_items'); attempt++) await Bun.sleep(10)
          await instance.interrupt()
          expect((await events.next()).done).toBe(true)
        }
        else if (mode === 'ambiguous') {
          expect((await events.next()).value).toMatchObject({ type: 'error', message: expect.stringContaining('retry in a fresh conversation') })
          expect((await events.next()).done).toBe(true)
        }
        else expect((await events.next()).value).toEqual({ type: 'steering-ready' })
        const requests = readFileSync(join(workspacePath, 'requests.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(requests.map(request => request.method)).toEqual([
          'initialize', returning ? 'thread/resume' : 'thread/start',
          ...(mode === 'resume-missing' ? [] : ['thread/inject_items']),
          ...(mode === 'ambiguous' || mode === 'stopped' || mode === 'resume-missing' ? [] : ['turn/start']),
        ])
        if (mode !== 'resume-missing')
          expect(requests[2]?.params).toEqual({ threadId: input.providerSessionId ?? 'new-native-thread', items: input.historicalContext?.items })
        if (mode === 'native' || mode === 'legacy' || mode === 'resumed') expect(requests[3]?.params.input).toEqual([{ type: 'text', text: mode === 'legacy' ? input.historicalContext?.inlinePrompt : input.text }])
      }
      finally {
        await instance.stop()
      }
    }
    finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('codex response fork', () => {
  it.each(['bounded', 'rollback', 'legacy', 'missing'] as const)('verifies the fork boundary with %s history', async (mode) => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-fork-'))
    const binaryPath = join(workspacePath, 'codex-fixture')
    try {
      writeFileSync(binaryPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const mode = ${JSON.stringify(mode)}
const selected = { id: 'selected-turn', status: 'completed', items: [
  { type: 'userMessage', content: [{ type: 'text', text: 'Selected prompt' }] },
  { type: 'agentMessage', text: 'Selected response' },
] }
const tail = { id: 'tail-turn', status: 'completed', items: [] }
let history = mode === 'bounded' ? [selected] : mode === 'missing' ? [tail] : [tail, selected]
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  appendFileSync('requests.log', JSON.stringify({ method, params }) + '\\n')
  const result = payload => console.log(JSON.stringify({ id, result: payload }))
  const unsupported = () => console.log(JSON.stringify({ id, error: { code: -32601 } }))
  if (method === 'thread/fork') result({ thread: { id: 'native-fork' } })
  else if (method === 'thread/turns/list') {
    if (mode === 'legacy') unsupported()
    else result({ data: history, nextCursor: null })
  }
  else if (method === 'thread/read') {
    result({ thread: { id: params.threadId, turns: params.threadId === 'native-source' ? [selected, tail] : [...history].reverse() } })
  }
  else if (method === 'thread/rollback') {
    if (params.threadId !== 'native-fork') process.exit(1)
    history = history.slice(params.numTurns)
    result({ thread: { id: 'native-fork' } })
  }
  else if (method === 'turn/start') result({ turn: { id: 'following-turn' } })
  else result({})
}
`, { mode: 0o755 })
      const instance = await CodexDriver.create({ binaryPath, workspacePath })
      try {
        const fork = instance.fork!({
          providerSessionId: 'native-source',
          ...(mode === 'legacy' ? {} : { providerTurnId: 'selected-turn' }),
          prompt: 'Selected prompt',
          response: 'Selected response',
        })
        if (mode === 'missing') await expect(fork).rejects.toThrow('missing from the Codex fork')
        else {
          expect(await fork).toEqual({ providerSessionId: 'native-fork' })
          const stream = instance.startTurn({ text: 'Continue the fork', providerSessionId: 'native-fork' })
          expect((await stream[Symbol.asyncIterator]().next()).value).toEqual({ type: 'steering-ready' })
        }
        const requests = readFileSync(join(workspacePath, 'requests.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        expect(requests.find(request => request.method === 'thread/fork')?.params)
          .toMatchObject({ threadId: 'native-source', lastTurnId: 'selected-turn', excludeTurns: true })
        const rollback = requests.find(request => request.method === 'thread/rollback')
        if (mode === 'rollback' || mode === 'legacy') expect(rollback?.params).toEqual({ threadId: 'native-fork', numTurns: 1 })
        else expect(rollback).toBeUndefined()
        const archive = requests.find(request => request.method === 'thread/archive')
        if (mode === 'missing') expect(archive?.params).toEqual({ threadId: 'native-fork' })
        else {
          expect(archive).toBeUndefined()
          expect(requests.find(request => request.method === 'turn/start')?.params.threadId).toBe('native-fork')
        }
      }
      finally {
        await instance.stop()
      }
    }
    finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})

describe('codex account detection', () => {
  it('probes app-server from the same account directory used to run Codex', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-codex-account-'))
    const binaryPath = join(workspacePath, 'codex-fixture')
    try {
      writeFileSync(binaryPath, `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
if (process.argv.includes('--version')) {
  console.log('codex fixture');
} else {
  for await (const line of createInterface({ input: process.stdin })) {
    const frame = JSON.parse(line);
    if (frame.method === 'initialize') console.log(JSON.stringify({ id: frame.id, result: {} }));
    if (frame.method !== 'account/read' && frame.method !== 'model/list') continue;
    const path = process.env.CODEX_HOME;
    if (!path || realpathSync(dirname(path)) !== process.cwd()) process.exit(1);
    if (frame.method === 'model/list') {
      if (basename(path) === 'model-error') {
        console.log(JSON.stringify({ id: frame.id, error: { code: 4, message: 'fixture catalog expired' } }));
        continue;
      }
      const result = frame.params.cursor === 'second'
        ? { data: [{ model: basename(path) + '-small', additionalSpeedTiers: ['fast'] }] }
        : {
            nextCursor: 'second',
            data: [
              {
                model: basename(path), displayName: 'Fixture default', isDefault: true,
                supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
                serviceTiers: [{ id: 'fast', name: 'Faster' }], defaultServiceTier: 'fast',
                privatePath: path,
              },
              { model: 'internal', hidden: true },
            ],
          };
      console.log(JSON.stringify({ id: frame.id, result }));
      continue;
    }
    console.log(JSON.stringify({
      id: frame.id,
      result: { account: null, requiresOpenaiAuth: basename(path) === 'signed-out' },
    }));
  }
}
`, { mode: 0o755 })

      expect(await CodexDriver.probe({ binaryPath, workspacePath, home: 'signed-out' }))
        .toMatchObject({ status: 'unauthenticated', message: 'Run \`codex login\` on this machine.' })
      expect(await CodexDriver.probe({ binaryPath, workspacePath, home: 'no-login-required' }))
        .toMatchObject({ status: 'ready' })
      const catalogs = await Promise.all(['work-account', 'personal-account'].map(home =>
        CodexDriver.probe({ binaryPath, workspacePath, home }, { includeModels: true })))
      expect(catalogs[0].models).toEqual([
        {
          id: 'work-account', name: 'Fixture default', isDefault: true,
          reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium',
          speedTiers: [{ id: 'fast', name: 'Faster' }], defaultSpeedTier: 'fast',
        },
        { id: 'work-account-small', name: 'work-account-small', isDefault: false, reasoningEfforts: [], speedTiers: [{ id: 'fast', name: 'Fast' }] },
      ])
      expect(catalogs[1].models?.map(model => model.id)).toEqual(['personal-account', 'personal-account-small'])
      expect((await CodexDriver.probe({ binaryPath, workspacePath, home: 'signed-out' }, { includeModels: true })).models).toBeUndefined()
      const failedCatalog = await CodexDriver.probe({ binaryPath, workspacePath, home: 'model-error' }, { includeModels: true })
      expect(failedCatalog.status).toBe('ready')
      expect(failedCatalog.models).toBeUndefined()
    }
    finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})

/**
 * Frames below are either verbatim from a live `codex app-server` run
 * (handshake, thread lifecycle, the usage-limit error path) or taken from the
 * protocol schema the CLI generates for itself. Both beat invention: the first
 * is what the process actually said, the second is what its authors say it will
 * say.
 */

describe('codex line framing', () => {
  it('reassembles a frame split across chunks', () => {
    // A large tool output does not arrive whole. A reader that assumed it did
    // would silently drop the frame it was split across.
    const lines: string[] = []
    const read = createLineReader(l => lines.push(l))
    read('{"method":"a"')
    read(',"params":{}}\n{"met')
    read('hod":"b"}\n')
    expect(lines).toEqual(['{"method":"a","params":{}}', '{"method":"b"}'])
  })

  it('emits several frames from one chunk', () => {
    const lines: string[] = []
    const read = createLineReader(l => lines.push(l))
    read('{"a":1}\n{"b":2}\n{"c":3}\n')
    expect(lines).toHaveLength(3)
  })

  it('ignores blank lines and holds an unterminated tail', () => {
    const lines: string[] = []
    const read = createLineReader(l => lines.push(l))
    read('\n\n{"a":1}\n{"partial":')
    expect(lines).toEqual(['{"a":1}'])
    read('true}\n')
    expect(lines).toEqual(['{"a":1}', '{"partial":true}'])
  })
})

describe('codex notification translation', () => {
  it('streams assistant text from deltas', () => {
    expect(translateNotification({
      method: 'item/agentMessage/delta',
      params: { threadId: 't', turnId: 'u', itemId: 'i', delta: 'ok' },
    })).toEqual([{ type: 'assistant-delta', text: 'ok' }])
  })

  it('drops an empty delta', () => {
    // Codex emits these at message boundaries. Forwarding them would append
    // nothing while still waking every subscriber.
    expect(translateNotification({
      method: 'item/agentMessage/delta',
      params: { delta: '' },
    })).toEqual([])
  })

  it('does not re-emit the completed message body', () => {
    // `item/completed` for an agentMessage carries the whole text we already
    // streamed. Translating it would double every reply.
    expect(translateNotification({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'i', text: 'the full reply' } },
    })).toEqual([])
  })

  it('maps a shell command to a tool call', () => {
    expect(translateNotification({
      method: 'item/started',
      params: {
        item: {
          type: 'commandExecution',
          id: 'c1',
          command: 'cat note.txt',
          cwd: '/tmp',
          commandActions: [],
          status: 'inProgress',
        },
      },
    })).toEqual([{
      type: 'tool-call-begin',
      callId: 'c1',
      toolName: 'shell',
      args: { command: 'cat note.txt', cwd: '/tmp' },
    }])
  })

  it('reads success from the exit code, not the status', () => {
    // A command that ran to completion has status `completed` even when it
    // failed. Trusting status would render every non-zero exit as a success.
    const ended = (exitCode: number) => translateNotification({
      method: 'item/completed',
      params: { item: { type: 'commandExecution', id: 'c1', command: 'x', cwd: '/', commandActions: [], status: 'completed', exitCode } },
    })
    expect(ended(0)).toEqual([{ type: 'tool-call-end', callId: 'c1', ok: true }])
    expect(ended(1)).toEqual([{ type: 'tool-call-end', callId: 'c1', ok: false }])
  })

  it('names an MCP tool by server and tool', () => {
    expect(translateNotification({
      method: 'item/started',
      params: { item: { type: 'mcpToolCall', id: 'm1', server: 'node_repl', tool: 'eval', arguments: { code: '1+1' }, status: 'inProgress' } },
    })).toEqual([{
      type: 'tool-call-begin',
      callId: 'm1',
      toolName: 'node_repl/eval',
      args: { code: '1+1' },
    }])
  })

  it('treats an mcp error as a failed call', () => {
    expect(translateNotification({
      method: 'item/completed',
      params: { item: { type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', arguments: {}, status: 'completed', error: 'boom' } },
    })).toEqual([{ type: 'tool-call-end', callId: 'm1', ok: false }])
  })

  it('maps a file change and a web search', () => {
    expect(translateNotification({
      method: 'item/started',
      params: { item: { type: 'fileChange', id: 'f1', changes: { 'a.ts': {} }, status: 'inProgress' } },
    })[0]).toMatchObject({ toolName: 'edit', callId: 'f1' })

    expect(translateNotification({
      method: 'item/started',
      params: { item: { type: 'webSearch', id: 'w1', query: 'stx sidebar' } },
    })[0]).toMatchObject({ toolName: 'web_search', args: { query: 'stx sidebar' } })
  })

  it('stays silent on the user message it was itself given', () => {
    // Verbatim from a live run. The prompt is already in the transcript; a
    // driver echoing it back would show the user their own words twice.
    expect(translateNotification({
      method: 'item/started',
      params: { item: { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'hi' }] } },
    })).toEqual([])
  })

  it('stays silent on reasoning and plan items', () => {
    // Not yet surfaced. Emitting them as assistant text would interleave the
    // model's private reasoning into the reply.
    for (const type of ['reasoning', 'plan', 'contextCompaction']) {
      expect(translateNotification({ method: 'item/started', params: { item: { type, id: 'x' } } })).toEqual([])
      expect(translateNotification({ method: 'item/completed', params: { item: { type, id: 'x' } } })).toEqual([])
    }
  })

  it('stays silent on codex-internal chatter', () => {
    // All observed live. None of it belongs in a transcript.
    const noise = [
      { method: 'mcpServer/startupStatus/updated', params: { name: 'node_repl', status: 'ready' } },
      { method: 'remoteControl/status/changed', params: { status: 'disabled' } },
      { method: 'thread/status/changed', params: { status: { type: 'active' } } },
      { method: 'account/rateLimits/updated', params: { rateLimits: {} } },
      { method: 'warning', params: { message: 'model metadata not found' } },
      { method: 'thread/started', params: { thread: { id: 't' } } },
      { method: 'turn/started', params: { turn: { id: 'u' } } },
    ]
    for (const frame of noise) expect(translateNotification(frame)).toEqual([])
  })
})

describe('codex usage', () => {
  it('reads the last turn, not the running total', () => {
    // `total` accumulates across the thread. Charging a turn the thread total
    // would over-report every turn after the first.
    expect(usageOf({
      last: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 100, reasoningOutputTokens: 12, totalTokens: 150 },
      total: { inputTokens: 9000, outputTokens: 800, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 9800 },
    })).toEqual({ tokensIn: 120, tokensOut: 30 })
  })

  it('reports zero rather than NaN when usage is absent', () => {
    expect(usageOf(undefined)).toEqual({ tokensIn: 0, tokensOut: 0 })
    expect(usageOf({ last: {} })).toEqual({ tokensIn: 0, tokensOut: 0 })
  })
})

describe('codex approval labels', () => {
  it('labels a command by the command itself', () => {
    expect(approvalLabel('item/commandExecution/requestApproval', { command: 'rm -rf build' }))
      .toBe('rm -rf build')
  })

  it('joins an argv-form command', () => {
    expect(approvalLabel('execCommandApproval', { command: ['git', 'push'] })).toBe('git push')
  })

  it('labels a patch by the files it touches', () => {
    expect(approvalLabel('item/fileChange/requestApproval', { changes: { 'src/a.ts': {}, 'src/b.ts': {} } }))
      .toBe('edit src/a.ts, src/b.ts')
  })

  it('falls back to the method when nothing describes it', () => {
    // An unlabelled prompt is still better than an empty one — the user has to
    // decide something, and needs to know what kind of thing it is.
    expect(approvalLabel('item/permissions/requestApproval', {})).toBe('permissions')
  })
})

describe('codex thread parameters', () => {
  const WORKSPACE = '/tmp/w'

  it('spells the approval policy the way the wire does', () => {
    // These are kebab-case on the wire. `onRequest` was rejected live with
    // "unknown variant `onRequest`, expected one of untrusted, on-failure,
    // on-request, granular, never" — after a thread had already been started,
    // which is far too late for a typo to show up.
    expect(threadStartParams({ workspacePath: WORKSPACE }).approvalPolicy).toBe('untrusted')
    expect(threadStartParams({ workspacePath: WORKSPACE, autoApprove: true }).approvalPolicy).toBe('never')
  })

  it('does not delegate the ask-or-not decision to the model', () => {
    // `on-request` would let Codex run whatever it considers safe without
    // asking. Harness's contract is that the user owns that call, so an
    // unattended session must never silently land on it.
    expect(threadStartParams({ workspacePath: WORKSPACE }).approvalPolicy).not.toBe('on-request')
  })

  it('keeps the sandbox read-only until tool calls are approved', () => {
    expect(threadStartParams({ workspacePath: WORKSPACE }).sandbox).toBe('read-only')
    expect(threadStartParams({ workspacePath: WORKSPACE, autoApprove: true }).sandbox).toBe('workspace-write')
  })

  it('omits the model rather than sending null, letting codex pick its default', () => {
    expect('model' in threadStartParams({ workspacePath: WORKSPACE })).toBe(false)
    expect(threadStartParams({ workspacePath: WORKSPACE, model: 'gpt-5.4-mini' }).model).toBe('gpt-5.4-mini')
  })
})

describe('codex error messages', () => {
  it('unwraps the provider error codex nests inside its own', () => {
    // Verbatim from a live run. Raw, the user reads a JSON blob; unwrapped,
    // they read the one sentence that says what to do.
    expect(readableError('{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."}}'))
      .toBe("The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.")
  })

  it('leaves a plain message alone', () => {
    // Also verbatim: Codex's own errors are already readable and must not be
    // mangled by a parser looking for a wrapper that is not there.
    const plain = "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits."
    expect(readableError(plain)).toBe(plain)
  })

  it('keeps text that only looks like json', () => {
    expect(readableError('{not json after all')).toBe('{not json after all')
    expect(readableError('{"status":500}')).toBe('{"status":500}')
  })

  it('never returns empty for a missing message', () => {
    // An empty error renders as a session that failed for no stated reason.
    expect(readableError(undefined)).toBe('codex reported an error')
    expect(readableError(null)).toBe('codex reported an error')
  })
})
