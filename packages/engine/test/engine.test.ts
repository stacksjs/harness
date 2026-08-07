import type { CommandEnvelope, Command } from '@harness/contract'
import { beforeEach, describe, expect, it } from 'bun:test'
import { CommandRejected, Engine } from '../src/engine'
import { emptyState, replay } from '../src/projections'
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
    const sessionCmd = envelope({ type: 'session.create', workspaceId, driverKind: 'codex' })
    await engine.dispatch(sessionCmd)

    // What a server restart actually does.
    const restarted = new Engine({ store, reducer: reduce })
    await restarted.hydrate()

    expect(restarted.current.sessions.get(derivedId(sessionCmd.id)))
      .toEqual(engine.current.sessions.get(derivedId(sessionCmd.id))!)
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
