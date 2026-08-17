import { describe, expect, it } from 'bun:test'
import { initializeParams, mcpServersParam, permissionChoice, readableAcpError, terminalOf, translateUpdate } from '../src/acp'

/**
 * Frames below are either verbatim from a live `cursor-agent acp` handshake
 * (initialize, the unauthenticated session/new error) or taken from the ACP
 * spec's own examples. Both beat invention: the first is what the process
 * actually said, the second is what the protocol's authors say it will say.
 */

describe('acp initialize', () => {
  it('pins the protocol version the live agent answered', () => {
    // cursor-agent 2026.08.11 answered `protocolVersion: 1`. Sending a version
    // it does not speak downgrades the whole negotiation.
    expect(initializeParams().protocolVersion).toBe(1)
  })

  it('declares no fs or terminal capability', () => {
    // Harness does not serve fs/* or terminal/* requests. Declaring them would
    // invite requests nothing answers, and the agent would hang on the reply.
    const caps = initializeParams().clientCapabilities as any
    expect(caps.fs).toEqual({ readTextFile: false, writeTextFile: false })
    expect(caps.terminal).toBe(false)
  })
})

describe('acp update translation', () => {
  it('streams assistant text from message chunks', () => {
    expect(translateUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ok' },
    })).toEqual([{ type: 'assistant-delta', text: 'ok' }])
  })

  it('drops an empty or non-text chunk', () => {
    expect(translateUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } })).toEqual([])
    expect(translateUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } })).toEqual([])
  })

  it('keeps the agent\'s thinking out of the transcript', () => {
    // Emitting thought chunks as assistant text would interleave the model's
    // private reasoning into the reply.
    expect(translateUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'let me think' },
    })).toEqual([])
  })

  it('maps a tool call to a begin', () => {
    expect(translateUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_1',
      title: 'Read main.ts',
      kind: 'read',
      status: 'in_progress',
      rawInput: { path: 'main.ts' },
    })).toEqual([{
      type: 'tool-call-begin',
      callId: 'call_1',
      toolName: 'Read main.ts',
      args: { path: 'main.ts' },
    }])
  })

  it('closes a call that arrives already settled', () => {
    // One frame, no later update. A bare begin would show the call running
    // forever, and the conformance suite treats a begin-less end as an orphan —
    // so the settled frame emits both, in order.
    const events = translateUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'call_2',
      title: 'List files',
      status: 'completed',
    })
    expect(events.map(e => e.type)).toEqual(['tool-call-begin', 'tool-call-end'])
  })

  it('falls back to the kind, then a generic label, for an untitled call', () => {
    expect(translateUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute' })[0])
      .toMatchObject({ toolName: 'execute' })
    expect(translateUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c' })[0])
      .toMatchObject({ toolName: 'tool', args: {} })
  })

  it('reads success and failure from the update status', () => {
    expect(translateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }))
      .toEqual([{ type: 'tool-call-end', callId: 'c1', ok: true }])
    expect(translateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'failed' }))
      .toEqual([{ type: 'tool-call-end', callId: 'c1', ok: false }])
  })

  it('stays silent while a call is merely progressing', () => {
    // `pending` and `in_progress` updates re-describe a call the begin already
    // announced; forwarding them would end nothing and wake every subscriber.
    for (const status of ['pending', 'in_progress']) {
      expect(translateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status })).toEqual([])
    }
    expect(translateUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [{ type: 'content' }] })).toEqual([])
  })

  it('stays silent on acp-internal chatter', () => {
    // Plans, command lists and mode changes are agent UI state, not transcript.
    const noise = [
      { sessionUpdate: 'plan', entries: [{ content: 'step 1', priority: 'high', status: 'pending' }] },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    ]
    for (const update of noise) expect(translateUpdate(update)).toEqual([])
    expect(translateUpdate(undefined)).toEqual([])
  })
})

describe('acp permission choices', () => {
  const OPTIONS = [
    { optionId: 'allow-always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'reject-always', name: 'Never Allow', kind: 'reject_always' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
  ]

  it('an allow picks the least-privileged allow on offer', () => {
    // The user approved *this* call, not every future one. `allow_always` is
    // only the answer when it is the only allow the agent offered.
    expect(permissionChoice(OPTIONS, true)).toBe('allow')
    expect(permissionChoice([{ optionId: 'aa', kind: 'allow_always' }], true)).toBe('aa')
  })

  it('a rejection prefers rejecting once', () => {
    expect(permissionChoice(OPTIONS, false)).toBe('reject')
  })

  it('resolves to null when no option expresses the decision', () => {
    // The caller answers null as `cancelled` — the honest outcome when the
    // agent offered nothing that means what the user decided.
    expect(permissionChoice([{ optionId: 'a', kind: 'allow_once' }], false)).toBeNull()
    expect(permissionChoice([], true)).toBeNull()
    expect(permissionChoice(undefined, true)).toBeNull()
  })
})

describe('acp stop reasons', () => {
  it('completes on end_turn', () => {
    expect(terminalOf({ stopReason: 'end_turn' })).toEqual({ type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 })
  })

  it('completes on cancelled rather than erroring', () => {
    // The user asked for the stop; an error would blame them for it.
    expect(terminalOf({ stopReason: 'cancelled' }).type).toBe('turn-complete')
  })

  it('reads the usage opencode attaches to the prompt response', () => {
    // Recorded live from opencode 1.18.18: core ACP has no usage, but the
    // response carries it as an extension and dropping it zeroed every total.
    expect(terminalOf({ stopReason: 'end_turn', usage: { inputTokens: 7032, outputTokens: 4 } }))
      .toEqual({ type: 'turn-complete', tokensIn: 7032, tokensOut: 4, costMicros: 0 })
  })

  it('reports zero for usage it cannot trust', () => {
    // Token counts are summed across turns; NaN or a negative would poison a
    // session total where zero merely undercounts.
    expect(terminalOf({ stopReason: 'end_turn', usage: { inputTokens: -5, outputTokens: Number.NaN } }))
      .toEqual({ type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 })
  })

  it('surfaces the limits and refusals as errors', () => {
    for (const reason of ['max_tokens', 'max_turn_requests', 'refusal'])
      expect(terminalOf({ stopReason: reason }).type).toBe('error')
  })

  it('names an unknown stop reason instead of inventing a completion', () => {
    expect(terminalOf({ stopReason: 'some_new_reason' })).toEqual({ type: 'error', message: 'the turn stopped (some_new_reason)' })
  })
})

describe('acp mcp servers', () => {
  it('spells env as a name/value list, the way the wire does', () => {
    // A record sent here is silently not an array and the agent sees no
    // variables at all.
    expect(mcpServersParam([
      { name: 'repl', type: 'stdio', command: 'bun', args: ['repl.ts'], env: { TOKEN: 't1' } },
    ])).toEqual([
      { name: 'repl', command: 'bun', args: ['repl.ts'], env: [{ name: 'TOKEN', value: 't1' }] },
    ])
  })

  it('carries http and sse servers with their headers', () => {
    expect(mcpServersParam([
      { name: 'docs', type: 'http', url: 'https://mcp.example/http', headers: { Authorization: 'Bearer x' } },
      { name: 'feed', type: 'sse', url: 'https://mcp.example/sse', headers: {} },
    ])).toEqual([
      { type: 'http', name: 'docs', url: 'https://mcp.example/http', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
      { type: 'sse', name: 'feed', url: 'https://mcp.example/sse', headers: [] },
    ])
  })

  it('sends an empty list rather than omitting the field', () => {
    expect(mcpServersParam(undefined)).toEqual([])
    expect(mcpServersParam([])).toEqual([])
  })
})

describe('acp error messages', () => {
  it('prefers the actionable detail over the category', () => {
    // Verbatim from a live unauthenticated `session/new`. The outer message
    // says what is wrong; `data.message` says what to do.
    expect(readableAcpError({
      code: -32000,
      message: 'Authentication required',
      data: { message: 'Authentication required. Please run \'agent login\' first, then call authenticate() with methodId \'cursor_login\'.' },
    } as any)).toBe('Authentication required. Please run \'agent login\' first, then call authenticate() with methodId \'cursor_login\'.')
  })

  it('falls back to the message when there is no detail', () => {
    expect(readableAcpError({ code: -32601, message: 'Method not found' } as any)).toBe('Method not found')
  })

  it('never returns empty for a missing error', () => {
    // An empty error renders as a session that failed for no stated reason.
    expect(readableAcpError(undefined)).toBe('the agent reported an error')
    expect(readableAcpError({} as any)).toBe('the agent reported an error')
  })
})
