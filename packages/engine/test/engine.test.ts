import type { CommandEnvelope, Command } from '@harness/contract'
import { beforeEach, describe, expect, it } from 'bun:test'
import { CommandRejected, Engine } from '../src/engine'
import { activeThreadOrder, emptyState, replay, threadShelf } from '../src/projections'
import { derivedId, InvalidCommand, reduce } from '../src/reducer'
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

/** A profile with a trusted workspace — the precondition for any session. */
async function withWorkspace(engine: Engine): Promise<{ profileId: number, workspaceId: number }> {
  const profileCmd = envelope({ type: 'profile.create', name: 'Personal' })
  await engine.dispatch(profileCmd)
  const profileId = derivedId(profileCmd.id)

  const workspaceCmd = envelope({ type: 'workspace.add', profileId, path: '/tmp/repo' })
  await engine.dispatch(workspaceCmd)
  const workspaceId = derivedId(workspaceCmd.id)

  await engine.dispatch(envelope({ type: 'workspace.trust', workspaceId, trusted: true }))
  return { profileId, workspaceId }
}

beforeEach(() => {
  clock = 1786000000000
})

describe('Engine — the M1 exit criterion', () => {
  it('writes a profile and reads it back through a projection', async () => {
    const { engine } = await bootedEngine()
    const cmd = envelope({ type: 'profile.create', name: 'Personal' })

    const result = await engine.dispatch(cmd)

    expect(result.replayed).toBe(false)
    expect(result.events).toHaveLength(1)
    expect(engine.current.profiles.get(derivedId(cmd.id))?.name).toBe('Personal')
  })

  it('replays model favorites by profile and account without flipping a retried selection', async () => {
    const { engine, store } = await bootedEngine()
    const { profileId } = await withWorkspace(engine)
    const otherProfile = envelope({ type: 'profile.create', name: 'Other team' })
    await engine.dispatch(otherProfile)
    const defaultModel = { driverKind: 'codex', model: 'fixture-model' } as const
    const accountModel = { ...defaultModel, providerInstanceId: 42 }
    const change = (favorite: typeof defaultModel | typeof accountModel, selected: boolean) =>
      envelope({ type: 'profile.model-favorite.set', profileId, favorite, selected })
    const original = change(defaultModel, true)
    await engine.dispatch(original)
    expect((await engine.dispatch(original)).replayed).toBe(true)
    expect((await engine.dispatch(change(defaultModel, true))).events).toHaveLength(0)
    await engine.dispatch(change(accountModel, true))
    await engine.dispatch(change(defaultModel, false))

    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    expect(restarted.current.profiles.get(profileId)?.modelFavorites).toEqual([accountModel])
    expect(restarted.current.profiles.get(derivedId(otherProfile.id))?.modelFavorites).toBeUndefined()
  })

  it('replays a fork at the selected response with a separate, verified provider binding', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const created = envelope({ type: 'session.create', workspaceId, driverKind: 'codex', providerInstanceId: 8, model: 'initial' })
    await engine.dispatch(created)
    const source = derivedId(created.id)
    await engine.dispatchInternal(envelope({ type: 'thread.session.set', sessionId: source, providerSessionId: 'native-source' }))
    for (const turnId of [1, 2]) {
      await engine.dispatch(envelope({ type: 'session.turn.start', sessionId: source, text: `Prompt ${turnId}`, codexSelection: { model: `model-${turnId}` } }))
      await engine.dispatchInternal(envelope({ type: 'thread.message.assistant.delta', sessionId: source, turnId, text: `Response ${turnId}` }))
      await engine.dispatchInternal(envelope({ type: 'thread.turn.complete', sessionId: source, turnId, tokensIn: 0, tokensOut: 0, cost: 0, providerTurnId: `native-turn-${turnId}` }))
    }
    const request = envelope({ type: 'session.fork', sessionId: source, turnId: 1 })
    const target = derivedId(request.id)
    await engine.dispatch(request)
    expect((await engine.dispatch(request)).replayed).toBe(true)
    expect(engine.current.sessions.get(target)?.fork?.state).toBe('pending')
    await expect(engine.dispatch(envelope({ type: 'session.turn.start', sessionId: target, text: 'resume too early' }))).rejects.toThrow('must finish')
    await expect(engine.dispatchInternal(envelope({ type: 'thread.fork.finished', sessionId: target, providerSessionId: 'native-source' }))).rejects.toThrow('separate')
    await engine.dispatchInternal(envelope({ type: 'thread.fork.finished', sessionId: target, providerSessionId: 'native-fork' }))
    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    expect(restarted.current.sessions.get(target)).toMatchObject({
      fork: { state: 'ready', sessionId: source, turnId: 1, providerSessionId: 'native-source' },
      providerInstanceId: 8, providerSessionId: 'native-fork', model: 'model-2',
      turns: [{ response: 'Response 1', providerTurnId: 'native-turn-1', nativeFork: { providerSessionId: 'native-fork' } }],
    })
    expect(restarted.current.sessions.get(source)?.turns.map(turn => turn.response)).toEqual(['Response 1', 'Response 2'])
    const nested = envelope({ type: 'session.fork', sessionId: target, turnId: 1 })
    await restarted.dispatch(nested)
    expect(restarted.current.sessions.get(derivedId(nested.id))?.fork?.providerSessionId).toBe('native-fork')
    await restarted.dispatch(envelope({ type: 'session.turn.start', sessionId: target, text: 'Continue here' }))
    expect(restarted.current.sessions.get(source)?.turns[1]?.prompt).toBe('Prompt 2')
    expect(restarted.current.sessions.get(target)?.turns[1]?.prompt).toBe('Continue here')

    const cancelled = envelope({ type: 'session.fork', sessionId: source, turnId: 1 })
    const cancelledId = derivedId(cancelled.id)
    await restarted.dispatch(cancelled)
    await restarted.dispatch(envelope({ type: 'session.stop', sessionId: cancelledId }))
    const late = await restarted.dispatchInternal(envelope({
      type: 'thread.fork.finished', sessionId: cancelledId, providerSessionId: 'late-native-fork',
    }))
    expect(late.events).toHaveLength(0)
    expect(restarted.current.sessions.get(cancelledId)).toMatchObject({
      state: 'stopped', providerSessionId: '', fork: { state: 'failed', error: expect.stringContaining('stopped') },
    })

    await restarted.dispatch(envelope({ type: 'session.handoff', sessionId: source, afterTurnId: 2, driverKind: 'claude', text: 'Continue elsewhere' }))
    await restarted.dispatchInternal(envelope({ type: 'thread.session.set', sessionId: source, providerSessionId: 'native-claude' }))
    await restarted.dispatchInternal(envelope({ type: 'thread.message.assistant.delta', sessionId: source, turnId: 3, text: 'Claude response' }))
    await restarted.dispatchInternal(envelope({ type: 'thread.turn.complete', sessionId: source, turnId: 3, tokensIn: 0, tokensOut: 0, cost: 0 }))
    const portable = envelope({ type: 'session.fork', sessionId: source, turnId: 1 })
    await restarted.dispatch(portable)
    const portableId = derivedId(portable.id)
    const replay = new Engine({ store, reducer: reduce })
    await replay.hydrate()
    expect(replay.current.sessions.get(portableId)).toMatchObject({
      driverKind: 'claude', providerSessionId: '', fork: { state: 'ready', sessionId: source, turnId: 1 },
      handoff: { pending: true, afterTurnId: 1 }, turns: [{ prompt: 'Prompt 1', response: 'Response 1' }],
    })
    expect(replay.current.sessions.get(portableId)?.turns[0]?.nativeFork).toBeUndefined()
    expect(replay.current.sessions.get(source)?.providerSessionId).toBe('native-claude')
    expect(replay.current.sessions.get(source)?.turns).toHaveLength(3)
  })

  it('replays its log to an identical state', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)

    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)
    const sessionId = derivedId(sessionCmd.id)

    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'list the files' }))
    await engine.dispatchInternal(envelope({
      type: 'thread.message.assistant.delta',
      sessionId,
      turnId: 1,
      text: 'Here they are',
    }))

    // Fold the log independently and compare against the incrementally-built
    // state. A difference means a reducer and its projection disagree, which is
    // the failure mode event sourcing is supposed to make impossible.
    const rebuilt = emptyState()
    for (const id of await store.sessionIds())
      replay(await store.read(id), rebuilt)

    expect(rebuilt.sessions.get(sessionId)).toEqual(engine.current.sessions.get(sessionId)!)
    expect(rebuilt.profiles.size).toBe(engine.current.profiles.size)
    expect(rebuilt.workspaces.get(workspaceId)).toEqual(engine.current.workspaces.get(workspaceId)!)
  })

  it('hydrates a fresh engine from the same store to the same state', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const codexTurnOptions = { effort: 'high', serviceTier: 'fast' }
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'codex', model: 'fixture-model', codexTurnOptions })
    await engine.dispatch(sessionCmd)

    // What a server restart actually does.
    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()

    expect(restarted.current.sessions.get(derivedId(sessionCmd.id)))
      .toEqual(engine.current.sessions.get(derivedId(sessionCmd.id))!)
    expect(restarted.current.sessions.get(derivedId(sessionCmd.id))?.codexTurnOptions).toEqual(codexTurnOptions)
  })

  it('keeps a queued Codex model change through replay and rejects steering it into the old model', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const session = envelope({ type: 'session.create', workspaceId, driverKind: 'codex', model: 'first', codexTurnOptions: { effort: 'medium' } })
    const sessionId = derivedId(session.id)
    await engine.dispatch(session)
    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'First model' }))
    await engine.dispatchInternal(envelope({ type: 'thread.steer.ready', sessionId, turnId: 1 }))
    const codexSelection = { model: 'second', effort: 'high', serviceTier: 'fast' }
    const entry = envelope({ type: 'session.queue.add', sessionId, text: 'Use another model', codexSelection })
    await engine.dispatch(entry)
    await expect(engine.dispatch(envelope({ type: 'session.turn.steer', sessionId, turnId: 1, id: entry.id })))
      .rejects.toThrow('queued for a different model')
    await engine.dispatchInternal(envelope({ type: 'thread.turn.complete', sessionId, turnId: 1, tokensIn: 1, tokensOut: 1, cost: 0 }))

    const reopened = new Engine({ store, reducer: reduce })
    await reopened.hydrate()
    const turn = await reopened.dispatch(envelope({ type: 'session.queue.send', sessionId, id: entry.id }))
    expect(turn.events[0]?.payload).toMatchObject({ type: 'turn.started', queuedId: entry.id, codexSelection, modelChanged: true })
    const current = reopened.current.sessions.get(sessionId)!
    expect(current.turns.map(item => item.codexSelection)).toEqual([{ model: 'first', effort: 'medium' }, codexSelection])
    expect(current.model).toBe('second')
    expect(current.followUps.entries).toEqual([])
  })

  it('rejects Codex model options on an unselected model, a different provider, or an invalid tier', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const codexTurnOptions = { effort: 'high', serviceTier: 'fast' }
    await expect(engine.dispatch(envelope({ type: 'session.create', workspaceId, driverKind: 'codex', codexTurnOptions })))
      .rejects.toThrow('specific Codex model')
    await expect(engine.dispatch(envelope({ type: 'session.create', workspaceId, driverKind: 'claude', model: 'fixture', codexTurnOptions })))
      .rejects.toThrow('specific Codex model')
    await expect(engine.dispatch(envelope({
      type: 'session.create', workspaceId, driverKind: 'codex', model: 'fixture',
      codexTurnOptions: { serviceTier: 'bad tier' },
    }))).rejects.toThrow('valid speed tier')
    expect(engine.current.sessions.size).toBe(0)
  })
})

describe('Thread navigation', () => {
  it('undoes consecutive unpins together, keeps the preceding action, and preserves each rank after restart', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    async function create(): Promise<number> {
      const command = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
      await engine.dispatch(command)
      return derivedId(command.id)
    }
    const first = await create()
    const second = await create()
    const third = await create()
    const undoScope = 'tab-a'
    for (const sessionId of [first, second, third])
      await engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'pin' }))
    const until = clock + 60_000
    const snooze = envelope({ type: 'session.organize', sessionId: third, action: 'snooze', until, undoScope })
    const unpinFirst = envelope({ type: 'session.organize', sessionId: first, action: 'unpin', undoScope })
    await engine.dispatch(snooze)
    await engine.dispatch(unpinFirst)
    clock += 4000
    const unpinSecond = envelope({ type: 'session.organize', sessionId: second, action: 'unpin', undoScope })
    await engine.dispatch(unpinSecond)
    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    clock += 2000
    const undo = envelope({ type: 'session.organize', sessionId: second, action: 'undo', sourceCommandId: unpinSecond.id, undoScope })
    await expect(restarted.dispatch({ ...undo, at: unpinSecond.at + 5000 })).rejects.toThrow('can no longer be undone')
    expect((await restarted.dispatch(undo)).events).toHaveLength(2)
    expect((await restarted.dispatch(undo)).replayed).toBe(true)
    expect([first, second].map(id => restarted.current.sessions.get(id)?.navigation?.pinnedOrder)).toEqual([1, 2])
    expect(restarted.current.sessions.get(third)?.navigation?.snoozedUntil).toBe(until)
    await restarted.dispatch(envelope({ type: 'session.organize', sessionId: third, action: 'undo', sourceCommandId: snooze.id, undoScope }))
    expect(restarted.current.sessions.get(third)?.navigation?.snoozedUntil).toBeNull()
  })

  it('keeps same-kind host actions in separate groups across a local Undo boundary', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const first = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    const second = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(first)
    await engine.dispatch(second)
    const ids = [derivedId(first.id), derivedId(second.id)]
    const undoScope = 'tab-a'
    const actions = ids.map((sessionId, index) => envelope({
      type: 'session.organize', sessionId, action: 'settle', undoScope,
      ...(index ? { undoBatch: 'after-discard' } : {}),
    }))
    for (const action of actions) await engine.dispatch(action)
    for (const index of [1, 0]) {
      const result = await engine.dispatch(envelope({
        type: 'session.organize', sessionId: ids[index]!, action: 'undo', undoScope, sourceCommandId: actions[index]!.id,
      }))
      expect(result.events).toHaveLength(1)
      expect(engine.current.sessions.get(ids[index]!)?.navigation?.settledAt).toBeNull()
      if (index === 1) expect(engine.current.sessions.get(ids[0]!)?.navigation?.settledAt).toBe(actions[0]!.at)
    }
  })

  it('restores the safe members of an Undo group while preserving another tab’s newer rank and snooze', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const ids: number[] = []
    for (let index = 0; index < 5; index++) {
      const create = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
      await engine.dispatch(create)
      const sessionId = derivedId(create.id)
      ids.push(sessionId)
      if (index < 4) await engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'pin' }))
    }
    const [safe, retained, occupied, changed, newcomer] = ids as [number, number, number, number, number]
    const undoScope = 'tab-a'
    const unpin = (sessionId: number) => envelope({ type: 'session.organize', sessionId, action: 'unpin', undoScope })
    await engine.dispatch(unpin(safe))
    await engine.dispatch(unpin(changed))
    const latest = unpin(occupied)
    await engine.dispatch(latest)
    const otherScope = 'tab-b'
    const until = clock + 60_000
    const snooze = envelope({ type: 'session.organize', sessionId: changed, action: 'snooze', until, undoScope: otherScope })
    await engine.dispatch(snooze)
    await engine.dispatch(envelope({ type: 'session.organize', sessionId: newcomer, action: 'pin', undoScope: otherScope }))
    const undo = (scope: string) => envelope({
      type: 'session.organize', sessionId: occupied, action: 'undo', sourceCommandId: latest.id, undoScope: scope,
    })
    await expect(engine.dispatch(undo(otherScope))).rejects.toThrow('can no longer be undone')
    const result = await engine.dispatch(undo(undoScope))
    expect(result.events.at(-1)?.payload).toMatchObject({ undoScope: { result: { restored: 1, skipped: 2 } } })
    expect(ids.map(id => engine.current.sessions.get(id)?.navigation?.pinnedOrder)).toEqual([1, 2, null, null, 3])
    expect(engine.current.sessions.get(changed)?.navigation?.snoozedUntil).toBe(until)
    expect(engine.current.sessions.get(retained)?.navigation?.pinnedOrder).toBe(2)
    await engine.dispatch(envelope({
      type: 'session.organize', sessionId: changed, action: 'undo', sourceCommandId: snooze.id, undoScope: otherScope,
    }))
    expect(engine.current.sessions.get(changed)?.navigation?.snoozedUntil).toBeNull()
  })

  it('restores a multi-row drop exactly after restart without overwriting a later rename', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const first = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    const second = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(first)
    await engine.dispatch(second)
    const firstId = derivedId(first.id)
    const secondId = derivedId(second.id)
    const organize = (sessionId: number, action: 'pin' | 'settle' | 'archive') =>
      envelope({ type: 'session.organize', sessionId, action })
    const undo = (sessionId: number, sourceCommandId: string) =>
      envelope({ type: 'session.organize', sessionId, action: 'undo', sourceCommandId })
    await engine.dispatch(organize(firstId, 'pin'))
    const drop = envelope({
      type: 'session.organize', sessionId: firstId, action: 'drop', destination: 'active',
      anchor: { sessionId: secondId, placement: 'before' },
    })
    expect((await engine.dispatch(drop)).events).toHaveLength(2)
    await engine.dispatch(envelope({ type: 'session.organize', sessionId: firstId, action: 'rename', title: 'Later title' }))

    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    await expect(restarted.dispatch(undo(secondId, drop.id))).rejects.toThrow('can no longer be undone')
    const undoDrop = undo(firstId, drop.id)
    expect((await restarted.dispatch(undoDrop)).events).toHaveLength(2)
    expect((await restarted.dispatch(undoDrop)).replayed).toBe(true)
    expect(restarted.current.sessions.get(firstId)?.navigation).toMatchObject({ title: 'Later title', pinnedOrder: 1, activeOrder: null })
    expect(restarted.current.sessions.get(secondId)?.navigation?.activeOrder).toBeNull()

    const settle = organize(firstId, 'settle')
    await restarted.dispatch(settle)
    const archive = organize(firstId, 'archive')
    await restarted.dispatch(archive)
    await expect(restarted.dispatch(undo(firstId, settle.id))).rejects.toThrow('can no longer be undone')
    const late = undo(firstId, archive.id)
    await expect(restarted.dispatch({ ...late, at: archive.at + 5000 })).rejects.toThrow('can no longer be undone')
    await restarted.dispatch(undo(firstId, archive.id))
    expect(restarted.current.sessions.get(firstId)?.navigation).toMatchObject({ archivedAt: null, settledAt: settle.at })
  })

  it('rejects Undo once provider activity clears the snooze', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const create = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(create)
    const sessionId = derivedId(create.id)
    const snooze = envelope({ type: 'session.organize', sessionId, action: 'snooze', until: clock + 60_000 })
    await engine.dispatch(snooze)
    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'Wake and continue' }))
    expect(engine.current.sessions.get(sessionId)?.navigation?.snoozedUntil).toBeNull()
    await expect(engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'undo', sourceCommandId: snooze.id })))
      .rejects.toThrow('can no longer be undone')
  })

  it('moves a thread through shelves and preserves its chosen active position after replay', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const other = await withWorkspace(engine)
    async function create(workspace: number): Promise<number> {
      const command = envelope({ type: 'session.create', workspaceId: workspace, driverKind: 'claude' })
      await engine.dispatch(command)
      return derivedId(command.id)
    }
    const first = await create(workspaceId)
    const second = await create(workspaceId)
    const foreign = await create(other.workspaceId)
    const drop = (sessionId: number, destination: 'active' | 'pinned' | 'settled', before?: number) => envelope({
      type: 'session.organize', sessionId, action: 'drop', destination,
      ...(before === undefined ? {} : { anchor: { sessionId: before, placement: 'before' } }),
    })
    await expect(engine.dispatch(drop(first, 'active', foreign))).rejects.toThrow('destination thread in this section')
    await engine.dispatch(drop(first, 'active', second))
    await engine.dispatch(drop(first, 'pinned'))
    await engine.dispatch(envelope({ type: 'session.organize', sessionId: second, action: 'snooze', until: clock + 60_000 }))
    await engine.dispatch(drop(second, 'pinned', first))
    expect(engine.current.sessions.get(second)?.navigation).toMatchObject({ pinnedOrder: 1, activeOrder: 2, snoozedUntil: null })
    expect(engine.current.sessions.get(first)?.navigation).toMatchObject({ pinnedOrder: 2, activeOrder: 1 })
    await engine.dispatch(drop(first, 'settled'))
    expect(engine.current.sessions.get(first)?.navigation).toMatchObject({ pinnedOrder: null, activeOrder: null })
    await engine.dispatch(drop(second, 'active'))
    const resume = drop(first, 'active', second)
    await engine.dispatch(resume)
    expect((await engine.dispatch(resume)).replayed).toBe(true)
    const newest = await create(workspaceId)
    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    expect([...restarted.current.sessions.values()].filter(session => session.workspaceId === workspaceId && threadShelf(session) === 'active')
      .reverse().sort(activeThreadOrder).map(session => session.id)).toEqual([newest, first, second])
  })

  it('moves a pinned thread past multiple rows and preserves the saved order after replay', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const otherWorkspace = await withWorkspace(engine)
    async function pin(workspaceId: number): Promise<number> {
      const create = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
      const sessionId = derivedId(create.id)
      await engine.dispatch(create)
      await engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'pin' }))
      return sessionId
    }
    const first = await pin(workspaceId)
    const hidden = await pin(workspaceId)
    const third = await pin(workspaceId)
    const last = await pin(workspaceId)
    const foreign = await pin(otherWorkspace.workspaceId)
    await engine.dispatch(envelope({ type: 'session.organize', sessionId: hidden, action: 'archive' }))
    const move = (targetSessionId: number) => envelope({
      type: 'session.organize', sessionId: last, action: 'reorder-pin', targetSessionId, placement: 'before',
    })
    await expect(engine.dispatch(move(foreign))).rejects.toThrow('Choose a visible pin in this profile')
    await expect(engine.dispatch(move(hidden))).rejects.toThrow('Choose a visible pin in this profile')
    const command = move(first)
    const result = await engine.dispatch(command)
    expect(result.events).toHaveLength(3)
    expect((await engine.dispatch(command)).replayed).toBe(true)
    expect((await engine.dispatch(move(first))).events).toHaveLength(0)

    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    expect([last, hidden, first, third, foreign].map(id => restarted.current.sessions.get(id)?.navigation?.pinnedOrder))
      .toEqual([1, 2, 3, 4, 1])
  })

  it('keeps pin order, archives and restores a seen thread across replay', async () => {
    const { engine, store } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const first = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    const second = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(first)
    await engine.dispatch(second)
    const firstId = derivedId(first.id)
    const secondId = derivedId(second.id)
    const organize = (sessionId: number, action: 'pin' | 'archive' | 'restore' | 'settle') =>
      envelope({ type: 'session.organize', sessionId, action })

    const rename = envelope({ type: 'session.organize', sessionId: firstId, action: 'rename', title: '  Release review ' })
    await engine.dispatch(rename)
    expect((await engine.dispatch(rename)).replayed).toBe(true)
    await Promise.all([engine.dispatch(organize(firstId, 'pin')), engine.dispatch(organize(secondId, 'pin'))])
    const swap = await engine.dispatch(envelope({ type: 'session.organize', sessionId: secondId, action: 'move-pin', direction: 'up' }))
    expect(swap.events.map(event => event.sessionId)).toEqual([secondId, firstId])
    const archive = organize(firstId, 'archive')
    await engine.dispatch(archive)
    await expect(engine.dispatch(envelope({ type: 'session.turn.start', sessionId: firstId, text: 'Blocked' }))).rejects.toThrow('Restore this thread')

    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()
    expect(restarted.current.sessions.get(firstId)?.navigation).toEqual({
      title: 'Release review', pinnedOrder: 2, archivedAt: archive.at,
    })
    expect(restarted.current.sessions.get(secondId)?.navigation?.pinnedOrder).toBe(1)
    await restarted.dispatch(organize(firstId, 'restore'))
    expect(restarted.current.sessions.get(firstId)?.navigation?.pinnedOrder).toBe(2)
    await restarted.dispatch(organize(firstId, 'settle'))
    expect(restarted.current.sessions.get(firstId)?.navigation?.pinnedOrder).toBeNull()
  })

  it('rejects stale wake events and wakes early when the agent requests a decision', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const create = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(create)
    const sessionId = derivedId(create.id)
    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'Work in the background' }))
    const oldWake = clock + 100
    const newWake = clock + 200
    await engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'snooze', until: oldWake }))
    await engine.dispatch(envelope({ type: 'session.organize', sessionId, action: 'snooze', until: newWake }))
    const stale = envelope({ type: 'thread.snooze.elapsed', sessionId, until: oldWake })
    await expect(engine.dispatch({ ...stale, at: oldWake })).rejects.toThrow(CommandRejected)
    expect((await engine.dispatchInternal({ ...stale, at: oldWake })).events).toEqual([])
    expect(engine.current.sessions.get(sessionId)?.navigation?.snoozedUntil).toBe(newWake)

    await engine.dispatchInternal(envelope({
      type: 'thread.approval.request', sessionId, requestId: 'approval-1', toolName: 'Fixture', args: {},
    }))
    expect(engine.current.sessions.get(sessionId)?.navigation?.snoozedUntil).toBeNull()
    expect(engine.current.sessions.get(sessionId)?.state).toBe('awaiting-approval')
  })
})

describe('Engine — idempotency', () => {
  it('does not re-run a command with a receipt', async () => {
    const { engine } = await bootedEngine()
    const cmd = envelope({ type: 'profile.create', name: 'Personal' })

    const first = await engine.dispatch(cmd)
    const second = await engine.dispatch(cmd)

    expect(first.replayed).toBe(false)
    expect(second.replayed).toBe(true)
    // One profile, not two — the point of the whole mechanism.
    expect(engine.current.profiles.size).toBe(1)
  })

  it('returns the original events on a retry', async () => {
    const { engine } = await bootedEngine()
    const cmd = envelope({ type: 'profile.create', name: 'Personal' })

    const first = await engine.dispatch(cmd)
    const second = await engine.dispatch(cmd)

    expect(second.events.map(e => e.seq)).toEqual(first.events.map(e => e.seq))
  })

  it('does not start a second agent run when a turn command is retried', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)
    const sessionId = derivedId(sessionCmd.id)

    const turnCmd = envelope({ type: 'session.turn.start', sessionId, text: 'go' })
    await engine.dispatch(turnCmd)
    // The client never saw the ack and resent. Without the receipt this would
    // be rejected as "a turn is already running" -- or worse, run twice.
    const retry = await engine.dispatch(turnCmd)

    expect(retry.replayed).toBe(true)
    expect(engine.current.sessions.get(sessionId)!.turns).toHaveLength(1)
  })
})

describe('Engine — ordering', () => {
  it('assigns sequence numbers per session, starting at 1', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)

    const a = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    const b = envelope({ type: 'session.create', workspaceId, driverKind: 'codex' })
    await engine.dispatch(a)
    await engine.dispatch(b)

    // Two independent sessions, each starting its own count.
    expect(engine.current.sessions.get(derivedId(a.id))!.lastSeq).toBe(1)
    expect(engine.current.sessions.get(derivedId(b.id))!.lastSeq).toBe(1)
  })

  it('totally orders concurrently dispatched commands', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)
    const sessionId = derivedId(sessionCmd.id)
    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'go' }))

    // Fire ten deltas without awaiting between them.
    const deltas = Array.from({ length: 10 }, (_, i) =>
      engine.dispatchInternal(envelope({
        type: 'thread.message.assistant.delta',
        sessionId,
        turnId: 1,
        text: String(i),
      })))
    await Promise.all(deltas)

    // Concatenated in dispatch order, not interleaved or reordered.
    const turn = engine.current.sessions.get(sessionId)!.turns[0]!
    expect(turn.response).toBe('0123456789')
    // And the prompt is untouched by them, which is why the two are separate
    // fields: appending deltas onto the prompt would leave a transcript nobody
    // can render and a prompt nobody can resend.
    expect(turn.prompt).toBe('go')
  })

  it('keeps draining after a command is rejected', async () => {
    const { engine } = await bootedEngine()

    const bad = engine.dispatch(envelope({ type: 'profile.delete', profileId: 999 }))
    await expect(bad).rejects.toThrow(InvalidCommand)

    // A poisoned queue would hang here instead of resolving.
    const good = await engine.dispatch(envelope({ type: 'profile.create', name: 'Still works' }))
    expect(good.events).toHaveLength(1)
  })
})

describe('Engine — the client/internal boundary', () => {
  it('refuses an internal command dispatched by a client', async () => {
    const { engine } = await bootedEngine()

    // Forging assistant text is exactly what this boundary exists to stop.
    const forged = engine.dispatch(envelope({
      type: 'thread.message.assistant.delta',
      sessionId: 1,
      turnId: 1,
      text: 'I have deleted your database',
    }))

    await expect(forged).rejects.toThrow(CommandRejected)
  })

  it('accepts the same command from the server', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)
    const sessionId = derivedId(sessionCmd.id)
    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'go' }))

    const result = await engine.dispatchInternal(envelope({
      type: 'thread.message.assistant.delta',
      sessionId,
      turnId: 1,
      text: 'ok',
    }))

    expect(result.events).toHaveLength(1)
  })

  it('refuses to dispatch before hydrating', async () => {
    const engine = new Engine({ store: new MemoryStore(), reducer: reduce })
    await expect(engine.dispatch(envelope({ type: 'profile.create', name: 'x' })))
      .rejects.toThrow(/hydrate/)
  })
})

describe('Host settings', () => {
  it('records only what changed and replays to the same state', async () => {
    const { engine, store } = await bootedEngine()
    expect(engine.current.settings).toEqual({ defaultDriver: 'claude', followUpBehavior: 'queue', terminalShell: 'system', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })

    await engine.dispatch(envelope({ type: 'settings.update', changes: { defaultDriver: 'codex', followUpBehavior: 'queue' } }))
    expect(engine.current.settings).toEqual({ defaultDriver: 'codex', followUpBehavior: 'queue', terminalShell: 'system', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })

    // `followUpBehavior` was already queue, so the log records the one field
    // that moved. Restating the rest would make the log unable to answer what
    // this command changed.
    const events = await store.read(0)
    const updates = events.filter(event => event.payload.type === 'settings.updated')
    expect(updates).toHaveLength(1)
    expect(updates[0]!.payload).toEqual({ type: 'settings.updated', changes: { defaultDriver: 'codex' } })

    expect(replay(events).settings).toEqual(engine.current.settings)
  })

  it('refuses an update that changes nothing, including one made of junk', async () => {
    const { engine } = await bootedEngine()
    await expect(engine.dispatch(envelope({ type: 'settings.update', changes: { defaultDriver: 'claude' } })))
      .rejects.toThrow(/changes nothing/)
    // Unknown keys and unusable values are dropped, which leaves nothing to
    // record rather than a settings row with a field no build understands.
    await expect(engine.dispatch(envelope({ type: 'settings.update', changes: { defaultDriver: 'emacs', terminalShell: '/bin/bash', nonsense: 1 } as never })))
      .rejects.toThrow(/changes nothing/)
    expect(engine.current.settings.defaultDriver).toBe('claude')
  })

  it('falls back to the default for a value a later build stopped accepting', () => {
    // Written by a build that still had this driver. Replaying it verbatim
    // would put the projection somewhere its own type forbids.
    const state = replay([{
      seq: 1,
      sessionId: 0,
      commandId: 'cmd_old',
      at: clock,
      payload: { type: 'settings.updated', changes: { defaultDriver: 'retired-agent', followUpBehavior: 'steer' } as never },
    }], emptyState())
    expect(state.settings).toEqual({ defaultDriver: 'claude', followUpBehavior: 'steer', terminalShell: 'system', claudeIdleCompaction: 'whenReturning', claudeAutoCompactAfter: null })
  })
})

describe('Engine — rules the reducer enforces', () => {
  it('refuses a session in an untrusted workspace', async () => {
    const { engine } = await bootedEngine()
    const profileCmd = envelope({ type: 'profile.create', name: 'Personal' })
    await engine.dispatch(profileCmd)
    const workspaceCmd = envelope({
      type: 'workspace.add',
      profileId: derivedId(profileCmd.id),
      path: '/tmp/untrusted',
    })
    await engine.dispatch(workspaceCmd)

    // Never trusted. An agent harness is a code-execution surface; the gate is
    // at session creation, not somewhere deeper where the failure is confusing.
    await expect(engine.dispatch(envelope({
      type: 'session.create',
      workspaceId: derivedId(workspaceCmd.id),
      driverKind: 'claude',
    }))).rejects.toThrow(/not trusted/)
  })

  it('refuses a second turn while one is running', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)
    const sessionId = derivedId(sessionCmd.id)

    await engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'first' }))
    await expect(engine.dispatch(envelope({ type: 'session.turn.start', sessionId, text: 'second' })))
      .rejects.toThrow(/already running/)
  })

  it('treats interrupting an idle session as a no-op, not an error', async () => {
    const { engine } = await bootedEngine()
    const { workspaceId } = await withWorkspace(engine)
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'claude' })
    await engine.dispatch(sessionCmd)

    // The user hit stop just as the turn finished. Telling them off would be
    // pedantic; the result is simply no event.
    const result = await engine.dispatch(envelope({
      type: 'session.turn.interrupt',
      sessionId: derivedId(sessionCmd.id),
    }))
    expect(result.events).toHaveLength(0)
  })

  it('refuses commands against a session that does not exist', async () => {
    const { engine } = await bootedEngine()
    await expect(engine.dispatch(envelope({ type: 'session.turn.start', sessionId: 4242, text: 'go' })))
      .rejects.toThrow(/no such session/)
  })
})

describe('Engine — determinism', () => {
  it('derives the same ids from the same command id', () => {
    expect(derivedId('cmd_abc')).toBe(derivedId('cmd_abc'))
    expect(derivedId('cmd_abc')).not.toBe(derivedId('cmd_abd'))
  })

  it('never derives the reserved global session id', () => {
    // Global events use session 0; a derived id colliding with it would mix
    // profile events into a real session's log.
    for (let i = 0; i < 2000; i++)
      expect(derivedId(`cmd_${i}`)).toBeGreaterThan(0)
  })
})
