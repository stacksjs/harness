import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { DriverKind } from '@harness/contract'
import { describe, expect, it } from 'bun:test'
import { translate } from '../src/claude'
import { driverKinds, resolveDriver } from '../src/registry'

/**
 * Every driver ships a recorded-transcript fake so its bugs are reproducible
 * without the real CLI installed (PLAN.md §13). These are the SDK message
 * shapes taken from `@anthropic-ai/claude-agent-sdk`'s own type definitions.
 */
function streamDelta(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000001',
    session_id: 'sess_abc',
  } as unknown as SDKMessage
}

function assistantWithToolUse(id: string, name: string, input: unknown): SDKMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000002',
    session_id: 'sess_abc',
  } as unknown as SDKMessage
}

function toolResult(toolUseId: string, isError: boolean): SDKMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError }] },
    parent_tool_use_id: null,
    uuid: '00000000-0000-0000-0000-000000000003',
    session_id: 'sess_abc',
  } as unknown as SDKMessage
}

function successResult(costUsd: number, tokensIn = 10, tokensOut = 20): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    total_cost_usd: costUsd,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
    uuid: '00000000-0000-0000-0000-000000000004',
    session_id: 'sess_abc',
  } as unknown as SDKMessage
}

describe('Claude driver — translating the SDK stream', () => {
  it('turns a text delta into an assistant delta', () => {
    expect(translate(streamDelta('Hello'))).toEqual([{ type: 'assistant-delta', text: 'Hello' }])
  })

  it('ignores non-text deltas', () => {
    const thinking = {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '...' } },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000005',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(thinking)).toEqual([])
  })

  it('does not emit assistant text twice', () => {
    // With `includePartialMessages` the same text arrives as deltas *and* in
    // the complete assistant message. Emitting both would duplicate every
    // sentence in the transcript, so the complete message contributes nothing.
    const complete = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello there' }] },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000006',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(complete)).toEqual([])
  })

  it('emits a tool call from an assistant message', () => {
    expect(translate(assistantWithToolUse('toolu_1', 'Bash', { command: 'ls' })))
      .toEqual([{ type: 'tool-call-begin', callId: 'toolu_1', toolName: 'Bash', args: { command: 'ls' } }])
  })

  it('emits every tool call in a parallel batch', () => {
    const parallel = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'b', name: 'Grep', input: {} },
        ],
      },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000007',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(parallel).map(e => (e as { callId: string }).callId)).toEqual(['a', 'b'])
  })

  it('pairs a tool result back to its call', () => {
    expect(translate(toolResult('toolu_1', false)))
      .toEqual([{ type: 'tool-call-end', callId: 'toolu_1', ok: true }])
  })

  it('marks a failed tool result as not ok', () => {
    expect(translate(toolResult('toolu_1', true)))
      .toEqual([{ type: 'tool-call-end', callId: 'toolu_1', ok: false }])
  })

  it('treats an absent is_error as success', () => {
    const noFlag = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2' }] },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000008',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(noFlag)).toEqual([{ type: 'tool-call-end', callId: 'toolu_2', ok: true }])
  })

  it('ignores an ordinary user message with no tool results', () => {
    const plain = {
      type: 'user',
      message: { content: 'just text' },
      parent_tool_use_id: null,
      uuid: '00000000-0000-0000-0000-000000000009',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(plain)).toEqual([])
  })
})

describe('Claude driver — turn completion', () => {
  it('reports usage and cost in integer micro-USD', () => {
    // Integer micros, because summing a thousand float costs drifts.
    expect(translate(successResult(0.0123, 100, 250))).toEqual([
      { type: 'turn-complete', tokensIn: 100, tokensOut: 250, costMicros: 12300 },
    ])
  })

  it('rounds sub-micro costs rather than truncating to zero', () => {
    expect((translate(successResult(0.0000004))[0] as { costMicros: number }).costMicros).toBe(0)
    expect((translate(successResult(0.0000006))[0] as { costMicros: number }).costMicros).toBe(1)
  })

  it('reports a failed turn as an error', () => {
    const failure = {
      type: 'result',
      subtype: 'error_during_execution',
      uuid: '00000000-0000-0000-0000-00000000000a',
      session_id: 'sess_abc',
    } as unknown as SDKMessage
    expect(translate(failure)).toEqual([{ type: 'error', message: 'turn failed: error_during_execution' }])
  })
})

describe('Claude driver — the unmodelled remainder', () => {
  it('drops message types the engine has no event for', () => {
    // The SDK union is wide and grows with each release. A message we do not
    // model is not an error — the driver is where that decision belongs, so a
    // new SDK message type never reaches the engine as garbage.
    for (const type of ['system', 'hook_started', 'plugin_install', 'task_started', 'auth_status']) {
      const message = { type, uuid: 'u', session_id: 's' } as unknown as SDKMessage
      expect(translate(message)).toEqual([])
    }
  })
})

describe('Driver registry', () => {
  it('resolves the claude driver', () => {
    expect(resolveDriver('claude')?.kind).toBe('claude')
  })

  it('resolves every kind the contract declares', () => {
    // A registered driver can say "codex is not installed". An unregistered one
    // produces "no driver for codex", which the user cannot act on.
    for (const kind of driverKinds())
      expect(resolveDriver(kind)?.kind).toBe(kind)
    expect(driverKinds().sort()).toEqual(['claude', 'codex', 'cursor', 'grok', 'opencode'])
  })

  it('returns null for a kind this build does not ship', () => {
    // Null rather than throwing: a session recorded against a driver we do not
    // have must surface as unavailable, not crash the server at hydrate.
    expect(resolveDriver('nonesuch' as DriverKind)).toBeNull()
  })
})

describe('a failed result is not a completion', () => {
  /** The result message Claude Code actually returns for a model that does not exist. */
  function errorResult(): SDKMessage {
    return {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 404,
      duration_ms: 1020,
      duration_api_ms: 0,
      num_turns: 1,
      result: "There's an issue with the selected model (not-a-real-model). It may not exist or you may not have access to it.",
      session_id: 's',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      uuid: 'u',
    } as unknown as SDKMessage
  }

  it('treats is_error as the verdict, not the subtype', () => {
    // Verbatim from a live run: subtype is `success` and is_error is true.
    // Reading only the subtype recorded a 404 as a finished turn with zero
    // tokens — a transcript entry that completed and said nothing.
    expect(translate(errorResult())).toEqual([{
      type: 'error',
      message: "There's an issue with the selected model (not-a-real-model). It may not exist or you may not have access to it.",
    }])
  })

  it('carries the sentence the user can act on', () => {
    const [event] = translate(errorResult())
    expect(event.type).toBe('error')
    // `turn failed: success` is what the subtype alone would have produced.
    expect(event.type === 'error' && event.message).not.toContain('turn failed')
  })

  it('still completes a genuinely successful turn', () => {
    const ok = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's',
      total_cost_usd: 0.0153,
      usage: { input_tokens: 10, output_tokens: 45 },
      uuid: 'u',
    } as unknown as SDKMessage
    expect(translate(ok)).toEqual([{
      type: 'turn-complete',
      tokensIn: 10,
      tokensOut: 45,
      costMicros: 15300,
    }])
  })

  it('falls back to the subtype when there is no message', () => {
    const aborted = {
      type: 'result',
      subtype: 'error_during_execution',
      session_id: 's',
      usage: { input_tokens: 0, output_tokens: 0 },
      uuid: 'u',
    } as unknown as SDKMessage
    expect(translate(aborted)).toEqual([{ type: 'error', message: 'turn failed: error_during_execution' }])
  })
})
