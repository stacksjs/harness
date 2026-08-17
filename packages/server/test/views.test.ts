import type { HarnessState, ProfileState, SessionState, TurnState } from '@harness/engine'
import { describe, expect, it } from 'bun:test'
import { emptyState } from '@harness/engine'
import { viewProps } from '../src/views'

/**
 * A turn with every field the projection sets.
 *
 * Built through one helper rather than as literals: a hand-written fixture
 * drifts the moment `TurnState` gains a field, and it fails as a crash inside
 * `viewProps` rather than as a message about the fixture. `toolCalls` is
 * exactly how that happened.
 */
function turn(overrides: Partial<TurnState> = {}): TurnState {
  return {
    id: 1,
    role: 'user',
    status: 'running',
    prompt: 'refactor the parser',
    response: 'working',
    toolCalls: [],
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  }
}

/**
 * A session with every field the projection sets.
 *
 * Same reasoning as `turn()`, and the same lesson learned twice: a literal here
 * silently rots the moment `SessionState` gains a field, and it surfaces as a
 * crash inside `viewProps` rather than as a message about the fixture.
 * `checkpoints` is the second field to do that.
 */
function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 100,
    workspaceId: 10,
    driverKind: 'claude',
    model: '',
    providerSessionId: '',
    state: 'running',
    lastSeq: 3,
    turns: [turn()],
    checkpoints: [],
    ...overrides,
  }
}

/** Likewise for profiles, whose icon/tint/position arrived the same way. */
function profile(overrides: Partial<ProfileState> = {}): ProfileState {
  return { id: 1, name: 'Personal', icon: '', tint: '', position: 0, workspaceIds: [10, 11], ...overrides }
}

function stateWith(): HarnessState {
  const state = emptyState()
  state.profiles.set(1, profile())
  state.profiles.set(2, profile({ id: 2, name: 'Stacks', workspaceIds: [20] }))
  state.workspaces.set(10, { id: 10, profileId: 1, path: '/Users/chris/Code/alpha', trusted: true })
  state.workspaces.set(11, { id: 11, profileId: 1, path: '/Users/chris/Code/beta', trusted: false })
  state.workspaces.set(20, { id: 20, profileId: 2, path: '/Users/chris/Code/stacks', trusted: true })

  state.sessions.set(100, session())
  state.sessions.set(200, session({ id: 200, workspaceId: 20, state: 'idle', lastSeq: 1, turns: [] }))
  return state
}

describe('viewProps — shaping the read model for the page', () => {
  it('groups sessions under the profile that owns their workspace', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })

    const personal = props.profiles.find(p => p.name === 'Personal')!
    const stacks = props.profiles.find(p => p.name === 'Stacks')!

    // The sidebar swipes between profiles, so a session list that ignored the
    // grouping would show every project at once.
    expect(personal.sessions.map(s => s.id)).toEqual([100])
    expect(stacks.sessions.map(s => s.id)).toEqual([200])
  })

  it('names a session by its first prompt', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })
    expect(props.profiles.find(p => p.name === 'Personal')!.sessions[0]!.title)
      .toBe('refactor the parser')
  })

  it('calls a session with no turns new, not by its hash', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })
    expect(props.profiles.find(p => p.name === 'Stacks')!.sessions[0]!.title).toBe('New session')
  })

  it('shows a workspace by its last path segment, not the absolute path', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })
    expect(props.profiles.find(p => p.name === 'Personal')!.workspaces.map(w => w.name))
      .toEqual(['alpha', 'beta'])
  })

  it('opens on the first profile when none is named', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })
    expect(props.activeProfile).toBe('1')
  })

  it('carries no active session when the route names none', () => {
    expect(viewProps(stateWith(), { serverUrl: 'ws://x/ws' }).activeSession).toBeNull()
  })

  it('carries the requested session with its turns', () => {
    const props = viewProps(stateWith(), { sessionId: 100, serverUrl: 'ws://x/ws' })
    const active = props.activeSession as { id: number, state: string, turns: unknown[] }
    expect(active.id).toBe(100)
    expect(active.state).toBe('running')
    expect(active.turns).toHaveLength(1)
  })

  it('carries no active session for an id that does not exist', () => {
    expect(viewProps(stateWith(), { sessionId: 999, serverUrl: 'ws://x/ws' }).activeSession).toBeNull()
  })

  it('is empty, not broken, before anything has been created', () => {
    const props = viewProps(emptyState(), { serverUrl: 'ws://x/ws' })
    expect(props.profiles).toEqual([])
    expect(props.activeProfile).toBe('')
  })
})

describe('tool calls reach the page', () => {
  function propsWithTools(calls: Array<{ callId: string, name: string, ok: boolean | null }>) {
    const state = stateWith()
    state.sessions.get(100)!.turns = [turn({ toolCalls: calls })]
    const props = viewProps(state, { sessionId: 100, serverUrl: 'ws://x/ws' })
    return (props.activeSession as { turns: Array<{ toolCalls: Array<{ state: string, name: string }> }> }).turns[0].toolCalls
  }

  it('renders three states, not two', () => {
    // A tool still running must not look like one that finished. Collapsing
    // this to a boolean makes a hung command read as a completed one.
    expect(propsWithTools([
      { callId: 'a', name: 'Read', ok: null },
      { callId: 'b', name: 'Bash', ok: true },
      { callId: 'c', name: 'Edit', ok: false },
    ]).map(c => c.state)).toEqual(['running', 'ok', 'failed'])
  })

  it('keeps the order the agent ran them in', () => {
    expect(propsWithTools([
      { callId: 'a', name: 'Glob', ok: true },
      { callId: 'b', name: 'Read', ok: true },
    ]).map(c => c.name)).toEqual(['Glob', 'Read'])
  })

  it('is an empty list for a turn that ran none', () => {
    expect(propsWithTools([])).toEqual([])
  })
})

describe('the revert control', () => {
  function turnsWith(checkpoints: Array<{ id: number, turnId: number, kind: 'turn-start' | 'turn-end' | 'manual' }>) {
    const state = stateWith()
    state.sessions.set(100, session({
      turns: [turn({ id: 1 }), turn({ id: 2 })],
      checkpoints: checkpoints.map(c => ({ ...c, vcsRef: 'abc123', reverted: false })),
    }))
    const props = viewProps(state, { sessionId: 100, serverUrl: 'ws://x/ws' })
    return (props.activeSession as { turns: Array<{ id: number, checkpointId: number }> }).turns
  }

  it('offers a turn the snapshot taken before it ran', () => {
    // "Undo this turn" means going back to before it, so it is the turn-start
    // checkpoint and never the turn-end one.
    const turns = turnsWith([
      { id: 900, turnId: 1, kind: 'turn-start' },
      { id: 901, turnId: 2, kind: 'turn-start' },
    ])
    expect(turns.map(t => t.checkpointId)).toEqual([900, 901])
  })

  it('ignores an end-of-turn checkpoint', () => {
    // Reverting to turn-end would undo nothing, which is the most confusing
    // possible outcome for a button labelled "revert".
    expect(turnsWith([{ id: 900, turnId: 1, kind: 'turn-end' }])[0].checkpointId).toBe(0)
  })

  it('offers nothing for a turn with no snapshot', () => {
    // A workspace that is not a repository, or a turn from before
    // checkpointing existed. The view hides the button rather than showing a
    // disabled one that never explains itself.
    expect(turnsWith([]).map(t => t.checkpointId)).toEqual([0, 0])
  })
})
