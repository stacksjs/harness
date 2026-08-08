/**
 * The default reducer: which events each command causes.
 *
 * Pure by contract. Anything non-deterministic — ids, timestamps — is resolved
 * before dispatch and carried on the envelope, so replaying a log produces the
 * identical state rather than a similar one.
 */

import type { Command, CommandEnvelope } from '@harness/contract'
import { GLOBAL_SESSION_ID } from '@harness/contract'
import type { AppendableEvent } from './store'
import type { HarnessState } from './projections'

export class InvalidCommand extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidCommand'
  }
}

/**
 * Ids for rows the command creates.
 *
 * Derived from the command id rather than a counter or a clock, so the same
 * command always yields the same ids and a retry cannot mint a second profile.
 * A real deployment swaps this for the database's own sequence; what matters
 * here is that the reducer never invents one itself.
 */
function derivedId(commandId: string): number {
  let hash = 2166136261
  for (let i = 0; i < commandId.length; i++) {
    hash ^= commandId.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  // Positive, and clear of the reserved global session id.
  return (hash >>> 0) % 2147483647 + 1
}

export function reduce(state: HarnessState, command: Command, envelope: CommandEnvelope): AppendableEvent[] {
  const at = envelope.at
  const commandId = envelope.id

  switch (command.type) {
    case 'profile.create': {
      const profileId = derivedId(commandId)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'profile.created', profileId, name: command.name },
      }]
    }

    case 'profile.delete': {
      if (!state.profiles.has(command.profileId))
        throw new InvalidCommand(`no such profile: ${command.profileId}`)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'profile.deleted', profileId: command.profileId },
      }]
    }

    case 'workspace.add': {
      if (!state.profiles.has(command.profileId))
        throw new InvalidCommand(`no such profile: ${command.profileId}`)
      const workspaceId = derivedId(commandId)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'workspace.added',
          workspaceId,
          profileId: command.profileId,
          path: command.path,
        },
      }]
    }

    case 'workspace.trust': {
      if (!state.workspaces.has(command.workspaceId))
        throw new InvalidCommand(`no such workspace: ${command.workspaceId}`)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'workspace.trust-changed',
          workspaceId: command.workspaceId,
          trusted: command.trusted,
        },
      }]
    }

    case 'session.create': {
      const workspace = state.workspaces.get(command.workspaceId)
      if (!workspace)
        throw new InvalidCommand(`no such workspace: ${command.workspaceId}`)
      // The trust gate from PLAN.md §12. Refusing here rather than at the
      // driver means an untrusted workspace cannot start a session at all,
      // instead of starting one that fails confusingly later.
      if (!workspace.trusted)
        throw new InvalidCommand(`workspace ${command.workspaceId} is not trusted`)

      return [{
        sessionId: derivedId(commandId),
        commandId,
        at,
        payload: {
          type: 'session.created',
          workspaceId: command.workspaceId,
          driverKind: command.driverKind,
          // Omitted rather than sent empty, so "no preference" and "the empty
          // model" cannot be confused on replay.
          ...(command.model ? { model: command.model } : {}),
        },
      }]
    }

    case 'session.turn.start': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      if (session.state === 'running')
        throw new InvalidCommand('a turn is already running')
      if (session.state === 'stopped')
        throw new InvalidCommand('session is stopped')

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'turn.started',
          turnId: session.turns.length + 1,
          role: 'user',
          text: command.text,
        },
      }]
    }

    case 'session.turn.interrupt': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      const running = session.turns.find(t => t.status === 'running')
      // Interrupting an idle session is a no-op rather than an error: the user
      // pressed stop just as the turn finished, and telling them off for it
      // would be pedantic.
      if (!running) return []

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'turn.interrupted', turnId: running.id },
      }]
    }

    case 'session.stop': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      if (session.state === 'stopped') return []
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.stopped' },
      }]
    }

    case 'thread.message.assistant.delta':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'assistant.delta', turnId: command.turnId, text: command.text },
      }]

    case 'thread.tool.call.begin':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'tool.call.began',
          turnId: command.turnId,
          callId: command.callId,
          toolName: command.toolName,
        },
      }]

    case 'thread.tool.call.end':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'tool.call.ended',
          turnId: command.turnId,
          callId: command.callId,
          ok: command.ok,
        },
      }]

    case 'thread.approval.request': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'approval.requested',
          // Derived from the command id, so a replayed provider event cannot
          // mint a second approval row for the same request.
          approvalId: derivedId(commandId),
          requestId: command.requestId,
          toolName: command.toolName,
        },
      }]
    }

    case 'thread.turn.complete': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      // A turn that already settled (interrupted, failed) stays settled — a
      // late completion from a provider we already stopped listening to must
      // not resurrect it as complete.
      const turn = session.turns.find(t => t.id === command.turnId)
      if (!turn || turn.status !== 'running') return []
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'turn.completed',
          turnId: command.turnId,
          tokensIn: command.tokensIn,
          tokensOut: command.tokensOut,
          cost: command.cost,
        },
      }]
    }

    case 'session.approval.respond': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'approval.resolved',
          approvalId: command.approvalId,
          decision: command.decision,
          scope: command.scope,
        },
      }]
    }

    case 'thread.session.set':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.provider-bound', providerSessionId: command.providerSessionId },
      }]

    case 'thread.error':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.failed', message: command.message },
      }]

    default:
      // Not every command has a reducer yet. Producing nothing is correct for
      // an unimplemented one — it leaves no trace in the log, so implementing
      // it later does not have to reckon with half-events already written.
      return []
  }
}

export { derivedId }
