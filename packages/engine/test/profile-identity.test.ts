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
