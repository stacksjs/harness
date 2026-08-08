import type { HarnessState } from '@harness/engine'
import { describe, expect, it } from 'bun:test'
import { emptyState } from '@harness/engine'
import { viewProps } from '../src/views'

function stateWith(): HarnessState {
  const state = emptyState()
  state.profiles.set(1, { id: 1, name: 'Personal', workspaceIds: [10, 11] })
  state.profiles.set(2, { id: 2, name: 'Stacks', workspaceIds: [20] })
  state.workspaces.set(10, { id: 10, profileId: 1, path: '/Users/chris/Code/alpha', trusted: true })
  state.workspaces.set(11, { id: 11, profileId: 1, path: '/Users/chris/Code/beta', trusted: false })
  state.workspaces.set(20, { id: 20, profileId: 2, path: '/Users/chris/Code/stacks', trusted: true })

  state.sessions.set(100, {
    id: 100,
    workspaceId: 10,
    driverKind: 'claude',
    providerSessionId: '',
    state: 'running',
    lastSeq: 3,
    turns: [{ id: 1, role: 'user', status: 'running', prompt: 'refactor the parser', response: 'working', tokensIn: 0, tokensOut: 0, cost: 0 }],
  })
  state.sessions.set(200, {
    id: 200,
    workspaceId: 20,
    driverKind: 'claude',
    providerSessionId: '',
    state: 'idle',
    lastSeq: 1,
    turns: [],
  })
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

  it('falls back to an id when a session has no turns yet', () => {
    const props = viewProps(stateWith(), { serverUrl: 'ws://x/ws' })
    expect(props.profiles.find(p => p.name === 'Stacks')!.sessions[0]!.title).toBe('Session 200')
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
