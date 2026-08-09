import type { HarnessEvent } from '@harness/contract'
import { describe, expect, it } from 'bun:test'
import { emptyState, replay } from '../src/projections'
import { InvalidCommand, derivedId, reduce } from '../src/reducer'

/** The reducer takes an envelope; these tests only vary the command. */
function run(state: ReturnType<typeof emptyState>, command: Parameters<typeof reduce>[1], id = 'c1') {
  return reduce(state, command, { id, at: 1, command })
}

/**
 * A profile's colour and icon.
 *
 * The Arc sidebar's whole idea is that a space has a feel — a name and a
 * colour you recognise before you read anything. The command accepted `icon`
 * and `tint`, `ViewProps` declared them, and the three layers in between
 * dropped them, so every space rendered blue. `profile.update` was in the
 * client allowlist and had no reducer case at all.
 */

let seq = 0
function ev(payload: HarnessEvent['payload']): HarnessEvent {
  return { seq: ++seq, sessionId: 0, turnId: 0, at: seq, commandId: `c${seq}`, payload } as HarnessEvent
}

function stateAfter(...payloads: HarnessEvent['payload'][]) {
  seq = 0
  const state = emptyState()
  replay(payloads.map(ev), state)
  return state
}

describe('creating a profile keeps its identity', () => {
  it('carries icon and tint into the event', () => {
    const events = run(emptyState(), { type: 'profile.create', name: 'Personal', icon: 'i-x', tint: 'violet' })
    expect(events[0].payload).toMatchObject({ name: 'Personal', icon: 'i-x', tint: 'violet' })
  })

  it('omits them rather than writing empties', () => {
    // Absent and empty must not be the same on replay: one means "the sidebar
    // picks", the other would mean "this profile has an icon named ''".
    const events = run(emptyState(), { type: 'profile.create', name: 'Plain' })
    expect(events[0].payload).not.toHaveProperty('icon')
    expect(events[0].payload).not.toHaveProperty('tint')
  })

  it('projects them onto the profile', () => {
    const state = stateAfter({ type: 'profile.created', profileId: 7, name: 'Personal', icon: 'i-x', tint: 'violet' })
    expect(state.profiles.get(7)).toMatchObject({ name: 'Personal', icon: 'i-x', tint: 'violet' })
  })

  it('defaults to empty, not undefined', () => {
    // The view treats empty as "no preference"; undefined would render the
    // string "undefined" through a template that does not guard.
    const state = stateAfter({ type: 'profile.created', profileId: 7, name: 'Plain' })
    expect(state.profiles.get(7)).toMatchObject({ icon: '', tint: '', position: 0 })
  })
})

describe('updating a profile', () => {
  const created = { type: 'profile.created', profileId: 7, name: 'Old', icon: 'i-a', tint: 'blue' } as const

  it('changes only what was asked for', () => {
    // A recolour must not silently rename, which is what restating every field
    // in the event would cause.
    const state = stateAfter(created, { type: 'profile.updated', profileId: 7, tint: 'rose' })
    expect(state.profiles.get(7)).toMatchObject({ name: 'Old', icon: 'i-a', tint: 'rose' })
  })

  it('can rename without touching the colour', () => {
    const state = stateAfter(created, { type: 'profile.updated', profileId: 7, name: 'New' })
    expect(state.profiles.get(7)).toMatchObject({ name: 'New', tint: 'blue' })
  })

  it('can clear a tint back to the default', () => {
    // Distinct from "unchanged": an explicit empty string is a real intent.
    const state = stateAfter(created, { type: 'profile.updated', profileId: 7, tint: '' })
    expect(state.profiles.get(7)!.tint).toBe('')
  })

  it('refuses a profile that does not exist', () => {
    expect(() => run(emptyState(), { type: 'profile.update', profileId: 99, name: 'x' }))
      .toThrow(InvalidCommand)
  })

  it('refuses an update that changes nothing', () => {
    // Otherwise it writes an event that replays to no difference, which makes
    // the log lie about what happened.
    const state = stateAfter({ type: 'profile.created', profileId: derivedId('c0'), name: 'P' })
    const id = derivedId('c0')
    expect(() => run(state, { type: 'profile.update', profileId: id }))
      .toThrow(InvalidCommand)
  })

  it('ignores an update for a profile the projection has not seen', () => {
    // The reducer refuses it, but a replay of an older log must not crash.
    expect(() => stateAfter({ type: 'profile.updated', profileId: 999, name: 'x' })).not.toThrow()
  })
})

describe('deleting a profile takes its contents with it', () => {
  const populated = () => {
    seq = 0
    const state = emptyState()
    replay([
      ev({ type: 'profile.created', profileId: 7, name: 'Doomed' }),
      ev({ type: 'profile.created', profileId: 8, name: 'Kept' }),
      ev({ type: 'workspace.added', workspaceId: 70, profileId: 7, path: '/a' }),
      ev({ type: 'workspace.added', workspaceId: 80, profileId: 8, path: '/b' }),
      ev({ type: 'session.created', sessionId: 700, workspaceId: 70, driverKind: 'claude' } as never),
      ev({ type: 'session.created', sessionId: 800, workspaceId: 80, driverKind: 'claude' } as never),
    ].map(e => ({ ...e, sessionId: (e.payload as any).sessionId ?? 0 })) as never, state)
    return state
  }

  it('names the workspaces and sessions it will remove', () => {
    // Recorded on the event rather than recomputed on replay: the projection
    // at replay time is the one *before* the deletion, so re-deriving the
    // cascade would have to stay identical forever.
    const state = populated()
    const events = run(state, { type: 'profile.delete', profileId: 7 })

    expect(events[0].payload).toMatchObject({
      profileId: 7,
      workspaceIds: [70],
      sessionIds: [700],
    })
  })

  it('removes them from the projection', () => {
    // Deleting only the profile left workspaces pointing at an id that no
    // longer existed and sessions reachable by nothing — present in state,
    // absent from every view, and impossible to delete afterwards.
    const state = populated()
    replay([ev({ type: 'profile.deleted', profileId: 7, workspaceIds: [70], sessionIds: [700] })], state)

    expect(state.profiles.has(7)).toBe(false)
    expect(state.workspaces.has(70)).toBe(false)
    expect(state.sessions.has(700)).toBe(false)
  })

  it('leaves every other profile alone', () => {
    const state = populated()
    replay([ev({ type: 'profile.deleted', profileId: 7, workspaceIds: [70], sessionIds: [700] })], state)

    expect(state.profiles.has(8)).toBe(true)
    expect(state.workspaces.has(80)).toBe(true)
    expect(state.sessions.has(800)).toBe(true)
  })

  it('still replays an old deletion that carried no cascade', () => {
    // Events written before the cascade existed removed nothing then and must
    // remove nothing now.
    const state = populated()
    expect(() => replay([ev({ type: 'profile.deleted', profileId: 7 } as never)], state)).not.toThrow()
    expect(state.profiles.has(7)).toBe(false)
    expect(state.workspaces.has(70)).toBe(true)
  })

  it('refuses a profile that does not exist', () => {
    expect(() => run(emptyState(), { type: 'profile.delete', profileId: 99 })).toThrow(InvalidCommand)
  })
})

describe('replay follows the order things were written', () => {
  it('does not resurrect a session that a later event removed', async () => {
    // The bug this pins. `seq` is per session, so replaying session by session
    // and concatenating reconstructs a *reordering* of the log: a
    // `profile.deleted` written last was applied before the `session.created`
    // it was meant to remove, and the session came back. The projection came
    // out as a state that never existed, which is the one thing an event log
    // is supposed to make impossible.
    const { Engine } = await import('../src/engine')
    const { MemoryStore } = await import('../src/store')

    const store = new MemoryStore()
    const engine = new Engine({ store, reducer: reduce })
    await engine.hydrate()

    const dispatch = (id: string, command: Parameters<typeof reduce>[1]) =>
      engine.dispatch({ id, at: 1, command })

    await dispatch('c_p', { type: 'profile.create', name: 'Doomed' })
    const profileId = derivedId('c_p')
    await dispatch('c_w', { type: 'workspace.add', profileId, path: '/tmp/x' })
    const workspaceId = derivedId('c_w')
    await dispatch('c_t', { type: 'workspace.trust', workspaceId, trusted: true })
    await dispatch('c_s', { type: 'session.create', workspaceId, driverKind: 'claude' })
    const sessionId = derivedId('c_s')

    // Session events, so the session has a log of its own — this is what used
    // to replay *after* the deletion.
    await dispatch('c_turn', { type: 'session.turn.start', sessionId, text: 'hi' })

    expect(engine.current.sessions.has(sessionId)).toBe(true)
    await dispatch('c_del', { type: 'profile.delete', profileId })
    expect(engine.current.sessions.has(sessionId)).toBe(false)

    // The state after a restart must equal the state before it.
    const rebuilt = new Engine({ store, reducer: reduce })
    await rebuilt.hydrate()

    expect(rebuilt.current.profiles.has(profileId)).toBe(false)
    expect(rebuilt.current.workspaces.has(workspaceId)).toBe(false)
    expect(rebuilt.current.sessions.has(sessionId)).toBe(false)
  })

  it('reads the whole log in append order', async () => {
    const { MemoryStore } = await import('../src/store')
    const store = new MemoryStore()

    // Interleaved across sessions, so per-session `seq` cannot order them.
    await store.append([{ sessionId: 0, commandId: 'a', at: 1, payload: { type: 'profile.created', profileId: 1, name: 'A' } } as never])
    await store.append([{ sessionId: 5, commandId: 'b', at: 2, payload: { type: 'turn.started', turnId: 1, role: 'user' } } as never])
    await store.append([{ sessionId: 0, commandId: 'c', at: 3, payload: { type: 'profile.created', profileId: 2, name: 'B' } } as never])

    expect((await store.readAll()).map(e => e.commandId)).toEqual(['a', 'b', 'c'])
  })
})
