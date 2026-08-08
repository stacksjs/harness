import type { HarnessEvent } from '@harness/contract'
import { describe, expect, it } from 'bun:test'
import { emptyState, replay } from '../src/projections'

/**
 * Tool calls in the read model.
 *
 * The log has carried `tool.call.began` / `tool.call.ended` since M2 and the
 * projection dropped both, so the web surface could show an agent's reply but
 * not the six commands behind it — the part you actually review. Nothing was
 * lost, which is the point of the log: projecting them makes every session ever
 * recorded show its tools on the next render.
 */

let seq = 0
function ev(sessionId: number, payload: HarnessEvent['payload']): HarnessEvent {
  return { seq: ++seq, sessionId, turnId: 0, at: seq, commandId: `c${seq}`, payload } as HarnessEvent
}

/** A session with one turn, plus whatever tool events the case needs. */
function transcript(...payloads: HarnessEvent['payload'][]) {
  seq = 0
  const state = emptyState()
  replay([
    ev(1, { type: 'session.created', workspaceId: 1, driverKind: 'claude' }),
    ev(1, { type: 'turn.started', turnId: 10, role: 'user', text: 'do the thing' }),
    ...payloads.map(p => ev(1, p)),
  ], state)
  return state.sessions.get(1)!.turns.find(t => t.id === 10)!
}

describe('tool calls are projected onto their turn', () => {
  it('records a call in flight', () => {
    // `ok: null` is what "still running" looks like — distinct from a call that
    // finished and failed.
    const turn = transcript({ type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Read' })

    expect(turn.toolCalls).toEqual([{ callId: 'a', name: 'Read', ok: null }])
  })

  it('resolves a call by its id, not its position', () => {
    // Tools run in parallel and finish out of order; pairing by index would
    // mark the wrong one failed.
    const turn = transcript(
      { type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Read' },
      { type: 'tool.call.began', turnId: 10, callId: 'b', toolName: 'Bash' },
      { type: 'tool.call.ended', turnId: 10, callId: 'b', ok: false },
      { type: 'tool.call.ended', turnId: 10, callId: 'a', ok: true },
    )

    expect(turn.toolCalls).toEqual([
      { callId: 'a', name: 'Read', ok: true },
      { callId: 'b', name: 'Bash', ok: false },
    ])
  })

  it('keeps the order the agent ran them in', () => {
    const turn = transcript(
      { type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Glob' },
      { type: 'tool.call.began', turnId: 10, callId: 'b', toolName: 'Read' },
      { type: 'tool.call.began', turnId: 10, callId: 'c', toolName: 'Edit' },
    )

    expect(turn.toolCalls.map(c => c.name)).toEqual(['Glob', 'Read', 'Edit'])
  })

  it('ignores a replayed begin rather than showing the call twice', () => {
    // A reconnect can resend, and the log is the same either way.
    const turn = transcript(
      { type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Read' },
      { type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Read' },
    )

    expect(turn.toolCalls).toHaveLength(1)
  })

  it('drops a result whose call was never seen', () => {
    // The driver conformance suite refuses that ordering, so its appearance
    // here would mean the log is wrong — and a fabricated row would hide it.
    const turn = transcript({ type: 'tool.call.ended', turnId: 10, callId: 'ghost', ok: true })

    expect(turn.toolCalls).toEqual([])
  })

  it('starts every turn with an empty list, not undefined', () => {
    // The view iterates this without guarding, and a session recorded before
    // tool calls were projected replays through the same path.
    const turn = transcript()

    expect(turn.toolCalls).toEqual([])
  })

  it('survives a replay identically', () => {
    // The whole promise of the log: the same events rebuild the same state.
    const payloads: HarnessEvent['payload'][] = [
      { type: 'tool.call.began', turnId: 10, callId: 'a', toolName: 'Read' },
      { type: 'tool.call.ended', turnId: 10, callId: 'a', ok: true },
    ]

    expect(transcript(...payloads)).toEqual(transcript(...payloads))
  })
})
