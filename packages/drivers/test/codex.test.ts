import { describe, expect, it } from 'bun:test'
import { approvalLabel, createLineReader, readableError, threadStartParams, translateNotification, usageOf } from '../src/codex'

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
