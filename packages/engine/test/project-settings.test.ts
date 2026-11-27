/**
 * A project's own answers to host settings.
 *
 * The questions here are the ones that only an event log can answer: what the
 * log records when a project pins a setting, what a replay of that log makes
 * of it on a build that no longer accepts the value, and what happens to a
 * project's answers when the project itself goes away.
 */

import type { Command, CommandEnvelope } from '@harness/contract'
import { defaultHostSettings, effectiveSettings } from '@harness/contract'
import { beforeEach, describe, expect, it } from 'bun:test'
import { Engine } from '../src/engine'
import { apply, emptyState, replay, workspaceSettings } from '../src/projections'
import { derivedId, reduce } from '../src/reducer'
import { MemoryStore } from '../src/store'

let clock = 1786000000000

function envelope(command: Command, id?: string): CommandEnvelope {
  return { id: id ?? `cmd_${++clock}`, command, at: clock }
}

async function bootedEngine(): Promise<{ engine: Engine, store: MemoryStore }> {
  const store = new MemoryStore()
  const engine = new Engine({ store, reducer: reduce })
  await engine.hydrate()
  return { engine, store }
}

/** Two projects on one host, which is the whole point of project scope. */
async function withProjects(engine: Engine): Promise<{ service: number, docs: number }> {
  const profileCmd = envelope({ type: 'profile.create', name: 'Personal' })
  await engine.dispatch(profileCmd)
  const profileId = derivedId(profileCmd.id)

  const serviceCmd = envelope({ type: 'workspace.add', profileId, path: '/tmp/service' })
  await engine.dispatch(serviceCmd)
  const docsCmd = envelope({ type: 'workspace.add', profileId, path: '/tmp/docs' })
  await engine.dispatch(docsCmd)
  return { service: derivedId(serviceCmd.id), docs: derivedId(docsCmd.id) }
}

beforeEach(() => {
  clock = 1786000000000
})

describe('project settings scope', () => {
  it('records only the keys the project pins, and leaves the host alone', async () => {
    const { engine } = await bootedEngine()
    const { service } = await withProjects(engine)

    const result = await engine.dispatch(envelope({
      type: 'settings.update',
      workspaceId: service,
      changes: { defaultDriver: 'codex', autoSettleAfterDays: 30 },
    }))

    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.payload).toEqual({
      type: 'settings.updated',
      workspaceId: service,
      changes: { defaultDriver: 'codex', autoSettleAfterDays: 30 },
    })
    expect(engine.current.workspaces.get(service)!.settings)
      .toEqual({ defaultDriver: 'codex', autoSettleAfterDays: 30 })
    expect(engine.current.settings.defaultDriver).toBe(defaultHostSettings.defaultDriver)
  })

  it('keeps one project out of another project and out of the host', async () => {
    const { engine } = await bootedEngine()
    const { service, docs } = await withProjects(engine)

    await engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'codex' } }))

    expect(workspaceSettings(engine.current, service).defaultDriver).toBe('codex')
    expect(workspaceSettings(engine.current, docs).defaultDriver).toBe(defaultHostSettings.defaultDriver)
    expect(workspaceSettings(engine.current, undefined).defaultDriver).toBe(defaultHostSettings.defaultDriver)
  })

  it('pins the agent the host happens to default to, so a later host change passes it by', async () => {
    const { engine } = await bootedEngine()
    const { service, docs } = await withProjects(engine)

    // Choosing the current host default is not a no-op: it stops following.
    await engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'claude' } }))
    await engine.dispatch(envelope({ type: 'settings.update', changes: { defaultDriver: 'codex' } }))

    expect(workspaceSettings(engine.current, service).defaultDriver).toBe('claude')
    expect(workspaceSettings(engine.current, docs).defaultDriver).toBe('codex')
  })

  it('hands a key back to the host and forgets the override entirely', async () => {
    const { engine } = await bootedEngine()
    const { service } = await withProjects(engine)

    await engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'codex' } }))
    await engine.dispatch(envelope({ type: 'settings.update', changes: { defaultDriver: 'cursor' } }))
    const result = await engine.dispatch(envelope({
      type: 'settings.update',
      workspaceId: service,
      changes: {},
      inherit: ['defaultDriver'],
    }))

    expect(result.events[0]!.payload).toEqual({
      type: 'settings.updated',
      workspaceId: service,
      changes: {},
      inherit: ['defaultDriver'],
    })
    // Not an empty object: a project that pins nothing is the same state as
    // one that never pinned anything.
    expect(engine.current.workspaces.get(service)!.settings).toBeUndefined()
    expect(workspaceSettings(engine.current, service).defaultDriver).toBe('cursor')
  })

  it('refuses a change that moves nothing, in either direction', async () => {
    const { engine } = await bootedEngine()
    const { service } = await withProjects(engine)

    await engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'codex' } }))

    expect(engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'codex' } })))
      .rejects.toThrow(/changes nothing/)
    // Nothing pinned autoSettleAfterDays, so there is nothing to hand back.
    expect(engine.dispatch(envelope({
      type: 'settings.update',
      workspaceId: service,
      changes: {},
      inherit: ['autoSettleAfterDays'],
    }))).rejects.toThrow(/changes nothing/)
  })

  it('refuses a project this host does not have open', async () => {
    const { engine } = await bootedEngine()
    await withProjects(engine)

    expect(engine.dispatch(envelope({ type: 'settings.update', workspaceId: 9999, changes: { defaultDriver: 'codex' } })))
      .rejects.toThrow(/not open on this host/)
  })

  it('replays an override, and drops a value this build stopped accepting', async () => {
    const { engine, store } = await bootedEngine()
    const { service } = await withProjects(engine)

    await engine.dispatch(envelope({ type: 'settings.update', workspaceId: service, changes: { defaultDriver: 'codex' } }))
    const replayed = replay(await store.readAll())
    expect(replayed.workspaces.get(service)!.settings).toEqual({ defaultDriver: 'codex' })

    // What an older build wrote and this one no longer accepts. The key falls
    // back to the host rather than landing in the projection as it stands.
    const poisoned = apply(replayed, {
      id: 'evt_retired',
      sessionId: 0,
      commandId: 'cmd_retired',
      seq: 999,
      at: clock,
      payload: { type: 'settings.updated', workspaceId: service, changes: { defaultDriver: 'abacus' } as never },
    })
    expect(poisoned.workspaces.get(service)!.settings).toEqual({ defaultDriver: 'codex' })
  })

  it('drops an override for a project that is no longer there', () => {
    const state = apply(emptyState(), {
      id: 'evt_orphan',
      sessionId: 0,
      commandId: 'cmd_orphan',
      seq: 1,
      at: clock,
      payload: { type: 'settings.updated', workspaceId: 404, changes: { defaultDriver: 'codex' } },
    })

    expect(state.workspaces.has(404)).toBe(false)
    expect(state.settings.defaultDriver).toBe(defaultHostSettings.defaultDriver)
  })

  it('layers the project over the host without touching either', () => {
    const host = { ...defaultHostSettings, snoozePresets: [...defaultHostSettings.snoozePresets] }
    const effective = effectiveSettings(host, { defaultDriver: 'codex' })

    expect(effective.defaultDriver).toBe('codex')
    expect(effective.followUpBehavior).toBe(host.followUpBehavior)
    expect(host.defaultDriver).toBe(defaultHostSettings.defaultDriver)
  })
})
