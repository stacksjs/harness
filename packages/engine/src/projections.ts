/**
 * The read model, derived from the log and nothing else.
 *
 * `apply` must be a pure function of (state, event). No clocks, no randomness,
 * no I/O — otherwise replaying the same log twice produces two different
 * states, and the whole reason for keeping a log evaporates.
 */

import type { DriverKind, HarnessEvent } from '@harness/contract'

export interface SessionState {
  id: number
  workspaceId: number
  driverKind: DriverKind
  /** Model override for this session. Empty means the provider's own default. */
  model: string
  providerSessionId: string
  state: 'idle' | 'running' | 'awaiting-approval' | 'awaiting-input' | 'stopped' | 'failed'
  lastSeq: number
  turns: TurnState[]
}

/**
 * One tool the agent ran during a turn.
 *
 * Projected from the log rather than derived at render time, because a turn's
 * tool calls are what the transcript is *for* — an agent harness that shows the
 * reply but not the six commands behind it is hiding the part you actually need
 * to review.
 */
export interface ToolCallState {
  /** The provider's own id, which is what pairs a result with its call. */
  callId: string
  name: string
  /** `null` until the call ends — that is what "still running" looks like. */
  ok: boolean | null
}

export interface TurnState {
  id: number
  role: 'user' | 'assistant'
  status: 'pending' | 'running' | 'complete' | 'interrupted' | 'failed'
  /** What the user asked. Set once, at `turn.started`. */
  prompt: string
  /**
   * What the agent replied, accumulated from deltas.
   *
   * Separate from `prompt` because a turn is an *exchange*: folding both into
   * one string makes the transcript unrenderable (you cannot tell where the
   * question ends) and makes "resend this prompt" impossible.
   */
  response: string
  /** In the order the agent ran them. */
  toolCalls: ToolCallState[]
  tokensIn: number
  tokensOut: number
  cost: number
}

export interface ProfileState {
  id: number
  name: string
  workspaceIds: number[]
}

export interface WorkspaceState {
  id: number
  profileId: number
  path: string
  trusted: boolean
}

export interface HarnessState {
  sessions: Map<number, SessionState>
  profiles: Map<number, ProfileState>
  workspaces: Map<number, WorkspaceState>
}

export function emptyState(): HarnessState {
  return { sessions: new Map(), profiles: new Map(), workspaces: new Map() }
}

function turn(session: SessionState, turnId: number): TurnState | undefined {
  return session.turns.find(t => t.id === turnId)
}

/**
 * Fold one event into the state, in place.
 *
 * Unknown event types are ignored rather than thrown on: a client or a replay
 * running older code than the log it is reading should degrade to missing
 * detail, not refuse to start.
 */
export function apply(state: HarnessState, event: HarnessEvent): HarnessState {
  const p = event.payload

  switch (p.type) {
    case 'profile.created':
      state.profiles.set(p.profileId, { id: p.profileId, name: p.name, workspaceIds: [] })
      break

    case 'profile.deleted':
      state.profiles.delete(p.profileId)
      break

    case 'workspace.added': {
      state.workspaces.set(p.workspaceId, {
        id: p.workspaceId,
        profileId: p.profileId,
        path: p.path,
        trusted: false,
      })
      const profile = state.profiles.get(p.profileId)
      // Idempotent on the profile side too: replaying must not double-list a
      // workspace, and `apply` is called again on every replay.
      if (profile && !profile.workspaceIds.includes(p.workspaceId))
        profile.workspaceIds.push(p.workspaceId)
      break
    }

    case 'workspace.trust-changed': {
      const workspace = state.workspaces.get(p.workspaceId)
      if (workspace) workspace.trusted = p.trusted
      break
    }

    case 'session.created':
      state.sessions.set(event.sessionId, {
        id: event.sessionId,
        workspaceId: p.workspaceId,
        driverKind: p.driverKind,
        model: p.model ?? '',
        providerSessionId: '',
        state: 'idle',
        lastSeq: 0,
        turns: [],
      })
      break

    case 'session.provider-bound': {
      const session = state.sessions.get(event.sessionId)
      if (session) session.providerSessionId = p.providerSessionId
      break
    }

    case 'session.stopped': {
      const session = state.sessions.get(event.sessionId)
      if (session) session.state = 'stopped'
      break
    }

    case 'session.failed': {
      const session = state.sessions.get(event.sessionId)
      if (session) session.state = 'failed'
      break
    }

    case 'turn.started': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      session.state = 'running'
      session.turns.push({
        id: p.turnId,
        role: p.role,
        status: 'running',
        prompt: p.text ?? '',
        response: '',
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      })
      break
    }

    case 'assistant.delta': {
      const session = state.sessions.get(event.sessionId)
      const t = session && turn(session, p.turnId)
      // Append rather than replace: a transcript is built from deltas, and the
      // order is guaranteed by the sequence, not by arrival.
      if (t) t.response += p.text
      break
    }

    case 'tool.call.began': {
      const session = state.sessions.get(event.sessionId)
      const t = session && turn(session, p.turnId)
      if (!t) break
      // Ignore a duplicate id rather than showing the same call twice: a
      // reconnect can replay, and the log is the same either way.
      if (t.toolCalls.some(call => call.callId === p.callId)) break
      t.toolCalls.push({ callId: p.callId, name: p.toolName, ok: null })
      break
    }

    case 'tool.call.ended': {
      const session = state.sessions.get(event.sessionId)
      const t = session && turn(session, p.turnId)
      const call = t?.toolCalls.find(c => c.callId === p.callId)
      // A result whose call was never seen is dropped, not invented: the driver
      // conformance suite refuses that ordering, so its appearance here would
      // mean the log itself is wrong and a fabricated row would hide it.
      if (call) call.ok = p.ok
      break
    }

    case 'turn.completed': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      const t = turn(session, p.turnId)
      if (t) {
        t.status = 'complete'
        t.tokensIn = p.tokensIn
        t.tokensOut = p.tokensOut
        t.cost = p.cost
      }
      session.state = 'idle'
      break
    }

    case 'turn.interrupted': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      const t = turn(session, p.turnId)
      if (t) t.status = 'interrupted'
      session.state = 'idle'
      break
    }

    case 'turn.failed': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      const t = turn(session, p.turnId)
      if (t) t.status = 'failed'
      session.state = 'idle'
      break
    }

    case 'approval.requested': {
      const session = state.sessions.get(event.sessionId)
      if (session) session.state = 'awaiting-approval'
      break
    }

    case 'approval.resolved': {
      const session = state.sessions.get(event.sessionId)
      // Back to running, not idle: the turn that raised the approval is still
      // in flight and the provider resumes it.
      if (session) session.state = 'running'
      break
    }

    default:
      break
  }

  const session = state.sessions.get(event.sessionId)
  if (session) session.lastSeq = Math.max(session.lastSeq, event.seq)

  return state
}

/** Fold a whole log. This is what "replay" means. */
export function replay(events: Iterable<HarnessEvent>, into: HarnessState = emptyState()): HarnessState {
  let state = into
  for (const event of events) state = apply(state, event)
  return state
}
