import type { Options, PermissionUpdate, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ApprovalSelection } from '@harness/contract'
import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAcpDriver } from '../src/acp'
import { ClaudeInstance } from '../src/claude'
import { CodexDriver } from '../src/codex'

const transportFixture = `
import { createInterface } from 'node:readline'
const { mode, request, expected } = await Bun.file('approval.json').json()
const emit = frame => console.log(JSON.stringify({ jsonrpc: '2.0', ...frame }))
const respond = (id, result) => emit({ id, result })
let promptId
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, result } = JSON.parse(line)
  if (method === 'initialize') respond(id, {})
  else if (method === 'thread/start') respond(id, { thread: { id: 'codex-thread' } })
  else if (method === 'session/new') respond(id, { sessionId: 'acp-session' })
  else if (method === 'turn/start') {
    respond(id, { turn: { id: 'codex-turn' } })
    emit({ id: 91, ...request })
  }
  else if (method === 'session/prompt') {
    promptId = id
    emit({ id: 91, ...request })
  }
  else if (id === 91) {
    const text = JSON.stringify(result) === JSON.stringify(expected) ? 'matching decision' : JSON.stringify(result)
    if (mode === 'codex') {
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread', delta: text } })
      emit({ method: 'turn/completed', params: { turn: { id: 'codex-turn', status: 'completed' } } })
    }
    else {
      emit({ method: 'session/update', params: { sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
      respond(promptId, { stopReason: 'end_turn' })
    }
  }
})
`

const cases: Array<{
  title: string
  mode: 'codex' | 'acp'
  request: object
  selection: ApprovalSelection
  ids: string[]
  expected: object
}> = [
  {
    title: 'Codex session choice',
    mode: 'codex',
    request: { method: 'item/commandExecution/requestApproval', params: { command: 'cat sample.txt', availableDecisions: ['acceptForSession', 'decline'] } },
    selection: { choiceId: 'acceptForSession', decision: 'allowed', scope: 'session' },
    ids: ['decline', 'acceptForSession'],
    expected: { decision: 'acceptForSession' },
  },
  {
    title: 'Codex legacy cancel',
    mode: 'codex',
    request: { method: 'execCommandApproval', params: { command: ['cat', 'sample.txt'] } },
    selection: { choiceId: 'cancel', decision: 'cancelled', scope: 'once' },
    ids: ['accept', 'decline', 'acceptForSession', 'cancel'],
    expected: { decision: 'abort' },
  },
  {
    title: 'Codex permission scope',
    mode: 'codex',
    request: { method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { read: ['/fixture'] } } } },
    selection: { choiceId: 'acceptForSession', decision: 'allowed', scope: 'session' },
    ids: ['accept', 'decline', 'acceptForSession'],
    expected: { permissions: { fileSystem: { read: ['/fixture'] } }, scope: 'session' },
  },
  {
    title: 'ACP exact option',
    mode: 'acp',
    request: {
      method: 'session/request_permission',
      params: {
        sessionId: 'acp-session',
        toolCall: { title: 'Read a fixture' },
        options: [
          { optionId: 'first', kind: 'allow_once', name: 'Allow sample A' },
          { optionId: 'second', kind: 'allow_once', name: 'Allow sample B' },
          { optionId: 'remember', kind: 'allow_always', name: 'Remember permission' },
        ],
      },
    },
    selection: { choiceId: 'acp:second', decision: 'allowed', scope: 'once' },
    ids: ['acp:first', 'acp:second', 'acp:remember', 'cancel'],
    expected: { outcome: { outcome: 'selected', optionId: 'second' } },
  },
]

it.each(cases)('delivers the offered $title over the native wire', async ({ mode, request, selection, ids, expected }) => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-approval-choice-'))
  const script = join(dir, 'approval-fixture')
  try {
    writeFileSync(join(dir, 'approval.json'), JSON.stringify({ mode, request, expected }))
    writeFileSync(script, `#!${process.execPath}\n${transportFixture}`, { mode: 0o755 })
    const driver = mode === 'codex' ? CodexDriver : createAcpDriver({ kind: 'opencode', binary: process.execPath, acpArgs: () => [script] })
    const instance = await driver.create({ workspacePath: dir, binaryPath: mode === 'codex' ? script : process.execPath })
    try {
      const events = []
      for await (const event of instance.startTurn({ text: 'Read a sample file' })) {
        events.push(event)
        if (event.type !== 'approval-request') continue
        expect(event.choices?.map(choice => choice.id)).toEqual(ids)
        if ('permissions' in expected) expect(JSON.parse(event.detail ?? '')).toEqual(expected.permissions)
        await instance.respondApproval(event.requestId, selection.decision === 'allowed', undefined, selection)
      }
      expect(events.filter(event => event.type === 'approval-request')).toHaveLength(1)
      expect(events).toContainEqual({ type: 'assistant-delta', text: 'matching decision' })
      expect(events.at(-1)).toMatchObject({ type: 'turn-complete' })
    }
    finally {
      await instance.stop()
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([true, false])('applies only Claude’s suggested tool rules when eligible is %s', async (eligible) => {
  const answer = Promise.withResolvers<unknown>()
  const abort = new AbortController()
  const suggestion: PermissionUpdate = { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Read', ruleContent: 'sample.txt' }], destination: 'projectSettings' }
  const updates: PermissionUpdate[] = eligible ? [suggestion] : [suggestion, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
  const instance = new ClaudeInstance({ workspacePath: tmpdir() }, ({ options }) => {
    const control = options as Options
    const stream = (async function* () {
      const result = await control.canUseTool!('Read', { file_path: 'sample.txt' }, { signal: abort.signal, toolUseID: 'read', suggestions: updates })
      answer.resolve(result)
      yield { type: 'result', subtype: 'success', usage: {} }
    })()
    return Object.assign(stream, { close() {} }) as unknown as Query
  })
  try {
    const events = instance.startTurn({ text: 'Read a sample file' })[Symbol.asyncIterator]()
    const event = (await events.next()).value
    if (event?.type !== 'approval-request') throw new Error('The SDK did not request an approval.')
    const scoped = event.choices?.find(choice => choice.scope === 'session')
    expect(Boolean(scoped)).toBe(eligible)
    if (scoped) expect(scoped.detail).toBe('Read(sample.txt)')
    await instance.respondApproval(event.requestId, true, undefined, scoped
      ? { decision: 'allowed', scope: 'session', choiceId: scoped.id }
      : { decision: 'allowed', scope: 'once' })
    expect(await answer.promise).toEqual({
      behavior: 'allow', updatedInput: { file_path: 'sample.txt' }, toolUseID: 'read',
      decisionClassification: eligible ? 'user_permanent' : 'user_temporary',
      ...(eligible ? { updatedPermissions: [{ ...suggestion, destination: 'session' }] } : {}),
    })
    expect((await events.next()).value).toMatchObject({ type: 'turn-complete' })
  }
  finally {
    await instance.stop()
  }
})
