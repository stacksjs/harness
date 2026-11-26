/**
 * The default reducer: which events each command causes.
 *
 * Pure by contract. Anything non-deterministic — ids, timestamps — is resolved
 * before dispatch and carried on the envelope, so replaying a log produces the
 * identical state rather than a similar one.
 */

import type { CodexTurnOptions, CodexTurnSelection, Command, ComposerAttachment, CommandEnvelope, EventPayload, ThreadNavigation, ThreadUndoRecord } from '@harness/contract'
import { acceptedClaudeAccountCompaction, GLOBAL_SESSION_ID, inputResponseValues, isClearCommand, isCompactCommand, maximumThreadSnooze, settingsDelta, threadPlacementKeys, threadUndoDuration, validInputAnswers } from '@harness/contract'
import { activeThreadOrder, checkpointReviewRepositories, conversationRewindPoint, forkResponsePoint, isTurnActive, isVisiblePin, modelFavoriteIndex, profilePinnedThreads, providerConversation, threadShelf } from './projections'
import { claudeIdleCompaction, effectiveClaudeCompaction } from './idle-compaction'
import type { AppendableEvent } from './store'
import type { HarnessState, SessionState } from './projections'
import { restoreThreadUndoGroup } from './thread-undo'

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

function followUpText(value: unknown, hasAttachments = false): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text && !hasAttachments) throw new InvalidCommand('Enter a message to queue.')
  return text
}

function sessionModel(command: { driverKind: unknown, model?: string, codexTurnOptions?: CodexTurnOptions }): {
  model?: string
  codexTurnOptions?: CodexTurnOptions
} {
  const model = command.model ? { model: command.model } : {}
  const options = command.codexTurnOptions
  if (options === undefined) return model
  if (command.driverKind !== 'codex' || typeof command.model !== 'string' || !command.model.trim()
    || !options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'effort' && key !== 'serviceTier'))
    throw new InvalidCommand('Model options require a specific Codex model.')

  const { effort, serviceTier } = options
  if (effort !== undefined && (typeof effort !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(effort)))
    throw new InvalidCommand('Choose a valid reasoning effort.')
  if (serviceTier !== undefined && (typeof serviceTier !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(serviceTier)))
    throw new InvalidCommand('Choose a valid speed tier.')
  return effort || serviceTier ? { ...model, codexTurnOptions: { ...(effort ? { effort } : {}), ...(serviceTier ? { serviceTier } : {}) } } : model
}

function requestedCodexSelection(session: SessionState, selection: CodexTurnSelection | undefined): CodexTurnSelection | undefined {
  if (selection === undefined) return undefined
  if (session.driverKind !== 'codex' || !selection || typeof selection.model !== 'string'
    || !selection.model.trim() || selection.model.length > 200)
    throw new InvalidCommand('Choose a model for this Codex conversation.')
  const { model, ...options } = selection
  const { codexTurnOptions } = sessionModel({ driverKind: session.driverKind, model, codexTurnOptions: options })
  return { model, ...codexTurnOptions }
}

function turnStarted(session: SessionState, text: string, codexSelection?: CodexTurnSelection, queuedId?: string, freshContext = false, attachments?: ComposerAttachment[]): Extract<EventPayload, { type: 'turn.started' }> {
  const compaction = isCompactCommand(text)
  if (freshContext && (typeof text !== 'string' || (!text.trim() && !attachments?.length) || isClearCommand(text) || compaction))
    throw new InvalidCommand('Write a message to start the fresh provider session.')
  const selection = compaction ? undefined : codexSelection ?? (session.driverKind === 'codex' && session.model
    ? { model: session.model, ...session.codexTurnOptions } : undefined)
  const modelChanged = selection && session.turns.length > 0 && (selection.model !== session.model
    || selection.effort !== session.codexTurnOptions?.effort || selection.serviceTier !== session.codexTurnOptions?.serviceTier)
  return {
    type: 'turn.started', turnId: (session.lastTurnId ?? session.turns.at(-1)?.id ?? 0) + 1, role: 'user', text,
    ...(attachments?.length ? { attachments } : {}),
    ...(queuedId ? { queuedId } : {}),
    ...(freshContext ? { freshContext: true } : {}),
    ...(compaction ? { compaction: true } : {}),
    ...(selection ? { codexSelection: selection } : {}),
    ...(modelChanged ? { modelChanged: true } : {}),
  }
}

function sharesCheckout(state: HarnessState, first: SessionState, second: SessionState): boolean {
  if (first.id === second.id) return true
  const path = (session: SessionState) => (session.worktreePath ?? state.workspaces.get(session.workspaceId)?.path)
    ?.replaceAll('\\', '/').replace(/\/+$/u, '')
  const a = path(first)
  const b = path(second)
  return a !== undefined && b !== undefined && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
}

function checkoutRewindPending(state: HarnessState, session: SessionState): boolean {
  return [...state.sessions.values()].some(other => other.pendingRewind && sharesCheckout(state, session, other))
}

type OrganizeThreadCommand = Extract<Command, { type: 'session.organize' }>

function organizeThread(state: HarnessState, command: OrganizeThreadCommand, envelope: CommandEnvelope): AppendableEvent[] {
  const session = state.sessions.get(command.sessionId)
  if (!session) throw new InvalidCommand('This thread no longer exists.')
  const profileId = state.workspaces.get(session.workspaceId)?.profileId

  if (command.action === 'undo') {
    if (command.undoScope) {
      const events = restoreThreadUndoGroup(state, profileId, command.undoScope, session.id, command.sourceCommandId, envelope)
      if (!events.length) throw new InvalidCommand('This action can no longer be undone.')
      return events
    }
    const record = profileId === undefined ? undefined : state.profiles.get(profileId)?.threadUndo
    if (!record || record.sourceCommandId !== command.sourceCommandId || record.sessionId !== session.id
      || record.expiresAt <= envelope.at || record.entries.some(entry => {
        const current = state.sessions.get(entry.sessionId)
        return !current || state.workspaces.get(current.workspaceId)?.profileId !== profileId
          || threadPlacementKeys.some(key => key in entry.after && (current.navigation?.[key] ?? null) !== entry.after[key])
      })) throw new InvalidCommand('This action can no longer be undone.')
    return record.entries.map(({ sessionId, before }) => ({
      sessionId, commandId: envelope.id, at: envelope.at, payload: {
        type: 'session.navigation-changed', changes: {
          ...before,
          ...(before.snoozedUntil != null && before.snoozedUntil <= envelope.at && { snoozedUntil: null }),
        },
      },
    }))
  }

  const events = organizeThreadEvents(state, session, command, envelope)
  let action: ThreadUndoRecord['action'] | undefined
  if (command.action === 'archive') action = 'archived'
  else if (command.action === 'snooze') action = 'snoozed'
  else if (command.action === 'settle' || (command.action === 'drop' && command.destination === 'settled')) action = 'settled'
  else if (command.action === 'unpin' || (command.action === 'drop' && command.destination === 'active'
    && session.navigation?.pinnedOrder != null)) action = 'unpinned'
  const last = events.at(-1)?.payload
  if (action && last?.type === 'session.navigation-changed') {
    const entries = events.flatMap(({ sessionId, payload }) => {
      if (payload.type !== 'session.navigation-changed') return []
      const navigation = state.sessions.get(sessionId)?.navigation
      const before: Omit<ThreadNavigation, 'title'> = {}
      const after: Omit<ThreadNavigation, 'title'> = {}
      for (const key of threadPlacementKeys) {
        if (key in payload.changes) {
          before[key] = navigation?.[key] ?? null
          after[key] = payload.changes[key] ?? null
        }
      }
      return [{ sessionId, before, after }]
    })
    const batch = typeof command.undoBatch === 'string' && /^[a-z0-9_-]{1,80}$/.test(command.undoBatch) ? command.undoBatch : undefined
    last.undo = {
      sourceCommandId: envelope.id, sessionId: session.id, action, expiresAt: envelope.at + threadUndoDuration, entries,
      ...(batch ? { batch } : {}),
    }
    if (command.undoScope) {
      for (const event of events) {
        if (event.payload.type === 'session.navigation-changed') event.payload.undoScope = { key: command.undoScope }
      }
    }
  }
  return events
}

function organizeThreadEvents(state: HarnessState, session: SessionState, command: Exclude<OrganizeThreadCommand, { action: 'undo' }>, envelope: CommandEnvelope): AppendableEvent[] {
  const { archivedAt, settledAt, snoozedUntil, pinnedOrder } = session.navigation ?? {}
  const { id: commandId, at } = envelope
  const change = (changes: Partial<ThreadNavigation>, sessionId = session.id): AppendableEvent => ({
    sessionId, commandId, at, payload: { type: 'session.navigation-changed', changes },
  })

  if (archivedAt && command.action !== 'restore')
    throw new InvalidCommand('Restore this thread before changing it.')
  switch (command.action) {
    case 'drop': {
      const { destination, anchor } = command
      if (destination !== 'pinned' && destination !== 'active' && destination !== 'settled')
        throw new InvalidCommand('Choose a thread destination.')
      if (anchor !== undefined && (!anchor || !Number.isSafeInteger(anchor.sessionId)
        || (anchor.placement !== 'before' && anchor.placement !== 'after') || destination === 'settled'))
        throw new InvalidCommand('Choose a valid place for this thread.')
      if (threadShelf(session) === 'working') throw new InvalidCommand('Wait for the thread to leave Working before moving it.')
      if (destination === 'settled') {
        if (isTurnActive(session.state)) throw new InvalidCommand('Wait for the turn to finish before settling.')
        if (threadShelf(session) === 'settled') return []
        return [change({ settledAt: at, activeOrder: null, pinnedOrder: null, snoozedUntil: null })]
      }
      if (session.state === 'stopped' || (destination === 'active' && session.state === 'running'))
        throw new InvalidCommand('This thread cannot move to that section in its current state.')
      const workspace = state.workspaces.get(session.workspaceId)
      if (!workspace) throw new InvalidCommand('This thread has no project on the host.')
      const sameActiveGroup = (candidate: SessionState): boolean => {
        const other = state.workspaces.get(candidate.workspaceId)
        return other?.profileId === workspace.profileId && (workspace.scratch ? other.scratch === true : other.id === workspace.id)
      }

      const pinned = destination === 'pinned' ? profilePinnedThreads(state, workspace.profileId) : []
      const group = destination === 'pinned' ? pinned.filter(isVisiblePin)
        : [...state.sessions.values()].reverse().filter(candidate => sameActiveGroup(candidate)
          && candidate.state !== 'stopped' && !candidate.navigation?.settledAt).sort(activeThreadOrder)
      const target = anchor ? group.find(candidate => candidate.id === anchor.sessionId && threadShelf(candidate) === destination)
        : group.find(candidate => candidate !== session && threadShelf(candidate) === destination)
      if (anchor && !target) throw new InvalidCommand('Choose a destination thread in this section.')
      if (target === session) return []
      const ordered = group.filter(candidate => candidate !== session)
      ordered.splice(target ? ordered.indexOf(target) + (anchor?.placement === 'after' ? 1 : 0) : 0, 0, session)

      const ranks = group.map(candidate => candidate.navigation?.pinnedOrder ?? 0)
      if (destination === 'pinned' && ordered.length > group.length) ranks.push((pinned.at(-1)?.navigation?.pinnedOrder ?? 0) + 1)
      return ordered.flatMap((candidate, index) => {
        const fields: Partial<ThreadNavigation> = destination === 'pinned'
          ? { pinnedOrder: ranks[index] } : { activeOrder: index + 1 }
        if (candidate === session) {
          if (snoozedUntil) fields.snoozedUntil = null
          if (settledAt) fields.settledAt = null
          if (destination === 'active' && pinnedOrder != null) fields.pinnedOrder = null
        }
        return Object.entries(fields).every(([key, value]) => candidate.navigation?.[key as keyof ThreadNavigation] === value)
          ? [] : [change(fields, candidate.id)]
      })
    }
    case 'rename': {
      const title = typeof command.title === 'string' ? command.title.trim() : ''
      if (!title || title.length > 120) throw new InvalidCommand('Enter a title of 1 to 120 characters.')
      return title === session.navigation?.title ? [] : [change({ title })]
    }
    case 'pin':
    case 'reorder-pin':
    case 'move-pin': {
      if (settledAt || snoozedUntil) throw new InvalidCommand('Bring this thread back to active work before pinning it.')
      const profileId = state.workspaces.get(session.workspaceId)?.profileId
      const pins = profilePinnedThreads(state, profileId)
      if (command.action === 'pin') {
        if (pinnedOrder != null) return []
        const lastPin = pins.at(-1)?.navigation?.pinnedOrder ?? 0
        return [change({ pinnedOrder: lastPin + 1 })]
      }
      const visiblePins = pins.filter(isVisiblePin)
      if (command.action === 'reorder-pin') {
        const { targetSessionId, placement } = command
        const target = visiblePins.find(candidate => candidate.id === targetSessionId)
        if (!target || pinnedOrder == null || (placement !== 'before' && placement !== 'after'))
          throw new InvalidCommand('Choose a visible pin in this profile.')
        if (target === session) return []
        const ordered = visiblePins.filter(candidate => candidate !== session)
        ordered.splice(ordered.indexOf(target) + (placement === 'after' ? 1 : 0), 0, session)
        return ordered.flatMap((pin, index) => {
          const order = visiblePins[index]!.navigation!.pinnedOrder!
          return pin.navigation!.pinnedOrder === order ? [] : [change({ pinnedOrder: order }, pin.id)]
        })
      }
      if (pinnedOrder == null || !('direction' in command) || (command.direction !== 'up' && command.direction !== 'down'))
        throw new InvalidCommand('Choose a direction for a pinned thread.')
      const index = visiblePins.findIndex(candidate => candidate.id === session.id)
      const neighbor = visiblePins[index + (command.direction === 'up' ? -1 : 1)]
      return neighbor ? [change({ pinnedOrder: neighbor.navigation!.pinnedOrder! }), change({ pinnedOrder }, neighbor.id)] : []
    }
    case 'unpin':
      return pinnedOrder == null ? [] : [change({ pinnedOrder: null })]
    case 'settle':
      if (isTurnActive(session.state)) throw new InvalidCommand('Wait for the turn to finish before settling.')
      return settledAt ? [] : [change({ settledAt: at, ...(session.navigation?.activeOrder != null && { activeOrder: null }), pinnedOrder: null, snoozedUntil: null })]
    case 'unsettle':
      return settledAt ? [change({ settledAt: null })] : []
    case 'archive':
      if (isTurnActive(session.state) || session.conversationRewind)
        throw new InvalidCommand('Wait for the turn or conversation rewind to finish before archiving.')
      return [change({ archivedAt: at })]
    case 'restore':
      return archivedAt ? [change({ archivedAt: null })] : []
    case 'snooze':
      if (!Number.isSafeInteger(command.until) || command.until <= at || command.until - at > maximumThreadSnooze)
        throw new InvalidCommand('Choose a wake time within the next year.')
      return [change({ snoozedUntil: command.until })]
    case 'wake':
      return snoozedUntil ? [change({ snoozedUntil: null, settledAt: null })] : []
    default:
      throw new InvalidCommand('Unknown thread action.')
  }
}

export function reduce(state: HarnessState, command: Command, envelope: CommandEnvelope, attachments?: ComposerAttachment[]): AppendableEvent[] {
  if (command.type === 'thread.composer.submit') {
    if (isClearCommand(command.intent.text) || isCompactCommand(command.intent.text))
      throw new InvalidCommand('Remove the attachments before running this command.')
    return reduce(state, command.intent, envelope, command.attachments)
  }
  const at = envelope.at
  const commandId = envelope.id

  switch (command.type) {
    case 'settings.update': {
      // Only what actually moves. A client that re-sends the whole settings
      // object on every keystroke would otherwise fill the log with events
      // that changed nothing, and "when did this change?" would stop having
      // an answer.
      const changes = settingsDelta(state.settings, command.changes)
      if (Object.keys(changes).length === 0)
        throw new InvalidCommand('settings.update changes nothing')

      return [{ sessionId: GLOBAL_SESSION_ID, commandId, at, payload: { type: 'settings.updated', changes } }]
    }

    case 'profile.create': {
      const profileId = derivedId(commandId)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'profile.created',
          profileId,
          name: command.name,
          // Omitted rather than sent empty, so "no icon given" and "the empty
          // icon" cannot be confused on replay.
          ...(command.icon ? { icon: command.icon } : {}),
          ...(command.tint ? { tint: command.tint } : {}),
        },
      }]
    }

    case 'profile.update': {
      if (!state.profiles.has(command.profileId))
        throw new InvalidCommand(`no such profile: ${command.profileId}`)

      // Only what was actually asked for. Restating unchanged fields would make
      // the log unable to answer "what did this change?".
      const changed = {
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.icon !== undefined ? { icon: command.icon } : {}),
        ...(command.tint !== undefined ? { tint: command.tint } : {}),
        ...(command.position !== undefined ? { position: command.position } : {}),
      }
      if (Object.keys(changed).length === 0)
        throw new InvalidCommand('profile.update changes nothing')

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'profile.updated', profileId: command.profileId, ...changed },
      }]
    }

    case 'profile.claude-compaction.update': {
      const profile = state.profiles.get(command.profileId)
      const { providerInstanceId } = command
      if (!profile || !Number.isSafeInteger(providerInstanceId) || providerInstanceId <= 0)
        throw new InvalidCommand('Choose an available Claude account.')
      const changes = acceptedClaudeAccountCompaction(command.changes)
      if (!Object.keys(changes).length) throw new InvalidCommand('Enter valid Claude compaction settings.')
      const previous = profile.claudeCompactionByAccount?.[providerInstanceId]
      if (Object.entries(changes).every(([key, value]) => (previous?.[key as keyof typeof changes] ?? null) === value))
        return []

      return [{ sessionId: GLOBAL_SESSION_ID, commandId, at, payload: {
        type: 'profile.claude-compaction.updated', profileId: profile.id, providerInstanceId, changes,
      } }]
    }

    case 'profile.model-favorite.set': {
      const profile = state.profiles.get(command.profileId)
      if (!profile) throw new InvalidCommand('This profile is unavailable.')
      const { favorite, selected } = command
      if (!favorite || typeof favorite.driverKind !== 'string' || !favorite.driverKind
        || typeof favorite.model !== 'string' || !favorite.model.trim() || favorite.model.length > 200
        || typeof selected !== 'boolean' || (favorite.providerInstanceId !== undefined
          && (!Number.isSafeInteger(favorite.providerInstanceId) || favorite.providerInstanceId <= 0)))
        throw new InvalidCommand('Choose a model to save.')

      const favorites = profile.modelFavorites ?? []
      const exists = modelFavoriteIndex(favorites, favorite) >= 0
      if (exists === selected) return []
      const { driverKind, providerInstanceId, model } = favorite
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'profile.model-favorite.changed', profileId: profile.id, selected,
          favorite: { driverKind, model, ...(providerInstanceId === undefined ? {} : { providerInstanceId }) },
        },
      }]
    }

    case 'profile.delete': {
      const profile = state.profiles.get(command.profileId)
      if (!profile)
        throw new InvalidCommand(`no such profile: ${command.profileId}`)

      // Everything the profile owned goes with it. Removing only the profile
      // left its workspaces pointing at an id that no longer existed and its
      // sessions reachable by nothing — present in the state, absent from every
      // view, and impossible to delete afterwards because the only handle on
      // them was the profile.
      const workspaceIds = [...profile.workspaceIds]
      const owned = new Set(workspaceIds)
      if ([...state.sessions.values()].some(session => (session.pendingRewind || session.conversationRewind) && owned.has(session.workspaceId)))
        throw new InvalidCommand('Wait for the current rewind to finish before deleting this profile.')
      const sessionIds = [...state.sessions.values()]
        .filter(session => owned.has(session.workspaceId))
        .map(session => session.id)

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'profile.deleted', profileId: command.profileId, workspaceIds, sessionIds },
      }]
    }

    case 'mcp.add': {
      const profile = state.profiles.get(command.profileId)
      if (!profile)
        throw new InvalidCommand(`no such profile: ${command.profileId}`)
      if (!command.name.trim())
        throw new InvalidCommand('an MCP server needs a name')
      // The name is the key the provider addresses tools by, so two servers
      // sharing one would make which tools an agent gets depend on ordering.
      if (profile.mcpServers.some(server => server.name === command.name))
        throw new InvalidCommand(`${command.name} is already attached to this profile`)
      if (command.transport === 'stdio' ? !command.command : !command.url)
        throw new InvalidCommand(
          command.transport === 'stdio'
            ? 'a stdio server needs a command'
            : `an ${command.transport} server needs a url`,
        )

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'mcp.added',
          profileId: command.profileId,
          name: command.name,
          transport: command.transport,
          ...(command.command ? { command: command.command } : {}),
          ...(command.args?.length ? { args: command.args } : {}),
          ...(command.env && Object.keys(command.env).length ? { env: command.env } : {}),
          ...(command.url ? { url: command.url } : {}),
          ...(command.headers && Object.keys(command.headers).length ? { headers: command.headers } : {}),
        },
      }]
    }

    case 'mcp.remove': {
      const profile = state.profiles.get(command.profileId)
      if (!profile)
        throw new InvalidCommand(`no such profile: ${command.profileId}`)
      if (!profile.mcpServers.some(server => server.name === command.name))
        throw new InvalidCommand(`no MCP server named ${command.name} on this profile`)

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'mcp.removed', profileId: command.profileId, name: command.name },
      }]
    }

    case 'mcp.setEnabled': {
      const profile = state.profiles.get(command.profileId)
      if (!profile)
        throw new InvalidCommand(`no such profile: ${command.profileId}`)
      if (!profile.mcpServers.some(server => server.name === command.name))
        throw new InvalidCommand(`no MCP server named ${command.name} on this profile`)

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'mcp.enabledChanged',
          profileId: command.profileId,
          name: command.name,
          enabled: command.enabled,
        },
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

    case 'workspace.register': {
      const existingProfile = command.profileId ?? state.profiles.keys().next().value
      const profileId = existingProfile ?? derivedId(commandId)
      if (existingProfile !== undefined && !state.profiles.has(profileId))
        throw new InvalidCommand('This profile is no longer available.')
      if ([...state.workspaces.values()].some(w => w.profileId === profileId && w.path === command.path))
        throw new InvalidCommand('This folder is already in the profile.')

      const workspaceId = derivedId(commandId)
      const event = { sessionId: GLOBAL_SESSION_ID, commandId, at }
      const events: AppendableEvent[] = []
      if (existingProfile === undefined)
        events.push({ ...event, payload: { type: 'profile.created', profileId, name: 'Projects' } })
      events.push({ ...event, payload: { type: 'workspace.added', workspaceId, profileId, path: command.path } })
      if (command.trusted === true)
        events.push({ ...event, payload: { type: 'workspace.trust-changed', workspaceId, trusted: true } })
      return events
    }

    case 'device.pair': {
      if (!command.deviceId.trim() || !command.tokenHash.trim())
        throw new InvalidCommand('a paired device needs an id and a token hash')
      // Re-pairing under an existing id would leave two devices answering to
      // one name with only the newer token working, and revoking the visible
      // one would not close the older grant.
      if (state.devices.has(command.deviceId))
        throw new InvalidCommand(`device ${command.deviceId} is already paired`)

      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: {
          type: 'device.paired',
          deviceId: command.deviceId,
          name: command.name || 'a device',
          tokenHash: command.tokenHash,
          at,
        },
      }]
    }

    case 'device.revoke': {
      if (!state.devices.has(command.deviceId))
        throw new InvalidCommand(`no such device: ${command.deviceId}`)
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'device.revoked', deviceId: command.deviceId },
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

    case 'workspace.promote': {
      const workspace = state.workspaces.get(command.workspaceId)
      if (!workspace) throw new InvalidCommand('This workspace is no longer available.')
      if (!workspace.scratch) return []
      return [{
        sessionId: GLOBAL_SESSION_ID,
        commandId,
        at,
        payload: { type: 'workspace.promoted', workspaceId: command.workspaceId },
      }]
    }

    case 'session.scratch.create':
      throw new InvalidCommand('A projectless session needs a host scratch folder.')

    case 'thread.scratch.create': {
      const existingProfile = command.profileId ?? state.profiles.keys().next().value
      const sessionId = derivedId(commandId)
      const profileId = existingProfile ?? sessionId
      if (existingProfile !== undefined && !state.profiles.has(existingProfile))
        throw new InvalidCommand('This profile is no longer available.')
      if (state.sessions.has(sessionId) || state.workspaces.has(sessionId))
        throw new InvalidCommand('This session ID is already in use.')

      const event = { sessionId: GLOBAL_SESSION_ID, commandId, at }
      const events: AppendableEvent[] = []
      if (existingProfile === undefined)
        events.push({ ...event, payload: { type: 'profile.created', profileId, name: 'Projects' } })
      events.push(
        { ...event, payload: { type: 'workspace.added', workspaceId: sessionId, profileId, path: command.path, scratch: true } },
        { ...event, payload: { type: 'workspace.trust-changed', workspaceId: sessionId, trusted: true } },
        {
          ...event,
          sessionId,
          payload: {
            type: 'session.created',
            workspaceId: sessionId,
            driverKind: command.driverKind,
            ...sessionModel(command),
          },
        },
      )
      return events
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

      const selection = command.worktree
      if (selection !== undefined && (!command.isolate || !selection || typeof selection !== 'object'
        || (selection.baseBranch !== undefined && (typeof selection.baseBranch !== 'string' || selection.baseBranch.length > 255))
        || (selection.repositories !== undefined && (!Array.isArray(selection.repositories) || selection.repositories.length > 128
          || selection.repositories.some(key => typeof key !== 'string' || !key || key.length > 4096)))))
        throw new InvalidCommand('Choose valid repositories and a base branch for this worktree.')

      return [{
        sessionId: derivedId(commandId),
        commandId,
        at,
        payload: {
          type: 'session.created',
          workspaceId: command.workspaceId,
          driverKind: command.driverKind,
          ...(command.providerInstanceId !== undefined ? { providerInstanceId: command.providerInstanceId } : {}),
          ...sessionModel(command),
          ...(command.isolate ? { isolate: true } : {}),
          ...(selection && { worktree: selection }),
        },
      }]
    }

    case 'session.fork': {
      const source = state.sessions.get(command.sessionId)
      const turn = forkResponsePoint(source, command.turnId)
      if (!source || !turn || source.conversationRewind)
        throw new InvalidCommand('Choose a completed response in an available conversation.')
      if (!state.workspaces.get(source.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before forking a conversation.')

      const sessionId = derivedId(commandId)
      if (state.sessions.has(sessionId)) throw new InvalidCommand('This fork ID is already in use.')
      const native = turn.nativeFork
      const providerSessionId = native?.driverKind === source.driverKind
        && native.providerInstanceId === source.providerInstanceId && !isTurnActive(source.state)
        ? native.providerSessionId : undefined
      return [{
        sessionId,
        commandId,
        at,
        payload: {
          type: 'session.created',
          workspaceId: source.workspaceId,
          driverKind: source.driverKind,
          ...(source.providerInstanceId !== undefined ? { providerInstanceId: source.providerInstanceId } : {}),
          ...sessionModel(source),
          ...(source.isolate ? { isolate: true } : {}),
          forkFrom: { sessionId: source.id, turnId: turn.id, ...(providerSessionId ? { providerSessionId } : {}) },
        },
      }]
    }

    case 'thread.fork.finished':
    case 'thread.fork.portable':
    case 'thread.fork.failed': {
      const session = state.sessions.get(command.sessionId)
      if (session?.fork?.state !== 'pending') return []
      if (command.type === 'thread.fork.failed')
        return [{ sessionId: session.id, commandId, at, payload: { type: 'session.fork-failed', message: command.message } }]
      if (!state.workspaces.get(session.workspaceId)?.trusted || session.navigation?.archivedAt)
        throw new InvalidCommand('The fork was interrupted. Restore access to the thread and retry from the source response.')
      if (command.type === 'thread.fork.portable')
        return [{ sessionId: session.id, commandId, at, payload: { type: 'session.fork-portable' } }]
      if (!command.providerSessionId || command.providerSessionId === session.fork.providerSessionId)
        throw new InvalidCommand('The fork must have a separate provider conversation.')
      return [{ sessionId: session.id, commandId, at, payload: {
        type: 'session.fork-finished', providerSessionId: command.providerSessionId,
        ...(command.copiedProviderTurnIds ? { copiedProviderTurnIds: command.copiedProviderTurnIds } : {}),
      } }]
    }

    case 'thread.worktree.reserve': {
      const session = state.sessions.get(command.sessionId)
      if (!session?.isolate || !state.workspaces.get(session.workspaceId)?.trusted || session.navigation?.archivedAt)
        throw new InvalidCommand('The session must have a trusted workspace to create a worktree.')
      if (session.worktreePath || session.worktreeIntent) return []
      return [{ sessionId: session.id, commandId, at, payload: { type: 'session.worktree-reserved', intent: command.intent } }]
    }

    case 'thread.worktree.set': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      if (session.worktreePath === command.worktreePath && session.branch === command.branch) return []
      const intent = session.worktreeIntent
      if (intent && (intent.path !== command.worktreePath || intent.branch !== command.branch
        || !state.workspaces.get(session.workspaceId)?.trusted || session.navigation?.archivedAt))
        throw new InvalidCommand('This checkout does not match the session’s trusted worktree reservation.')

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'session.isolated',
          worktreePath: command.worktreePath,
          branch: command.branch,
          ...(intent && 'checkouts' in intent && { combined: intent }),
        },
      }]
    }

    case 'thread.checkpoint.restored': {
      if (!state.sessions.has(command.sessionId))
        throw new InvalidCommand(`no such session: ${command.sessionId}`)

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'checkpoint.restored',
          checkpointId: command.checkpointId,
          restored: command.restored,
          removed: command.removed,
          ...(command.skipped?.length && { skipped: command.skipped }),
        },
      }]
    }

    case 'thread.checkpoint.restore-failed': {
      const session = state.sessions.get(command.sessionId)
      if (!session?.checkpoints.some(point => point.id === command.checkpointId)) return []
      return [{ sessionId: command.sessionId, commandId, at, payload: {
        type: 'checkpoint.restore-failed', checkpointId: command.checkpointId, message: command.message,
      } }]
    }

    case 'thread.checkpoint.capture': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'checkpoint.captured',
          checkpointId: derivedId(commandId),
          turnId: command.turnId,
          kind: command.kind,
          vcsRef: command.vcsRef,
          ...(command.tree && { tree: command.tree }),
          ...(command.repositories && { repositories: command.repositories }),
        },
      }]
    }

    case 'session.turn.rewind': {
      const session = state.sessions.get(command.sessionId)
      if (!session || session.state === 'stopped' || session.navigation?.archivedAt || (session.fork && session.fork.state !== 'ready'))
        throw new InvalidCommand('This thread is unavailable for conversation rewind.')
      if (!state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before rewinding the conversation.')
      if (isTurnActive(session.state) || session.followUps.entries.length || checkoutRewindPending(state, session))
        throw new InvalidCommand('Finish the active turn, queued messages, and file rewind before editing an earlier prompt.')
      const existing = session.conversationRewind
      if (command.verifyOnly === true) {
        if (existing?.status !== 'uncertain' || existing.turnId !== command.turnId)
          throw new InvalidCommand('There is no interrupted conversation rewind to check.')
        return [{ sessionId: session.id, commandId, at, payload: {
          type: 'turn.rewind-requested', turnId: existing.turnId, operation: existing.operation, point: existing.point,
        } }]
      }
      if (existing) throw new InvalidCommand('Check the current conversation rewind before starting another one.')
      const index = session.turns.findIndex(turn => turn.id === command.turnId)
      const point = conversationRewindPoint(session, index)
      if (!point) throw new InvalidCommand('Choose a completed prompt in the current Codex conversation.')
      return [{ sessionId: session.id, commandId, at, payload: {
        type: 'turn.rewind-requested', turnId: command.turnId, operation: commandId, point,
      } }]
    }

    case 'thread.turn.rewind-result': {
      const session = state.sessions.get(command.sessionId)
      if (session?.conversationRewind?.operation !== command.operation) return []
      return [{ sessionId: session.id, commandId, at, payload: {
        type: 'turn.rewind-settled', operation: command.operation, outcome: command.outcome,
        ...(command.message && { message: command.message }),
      } }]
    }

    case 'session.checkpoint.revert': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)

      const checkpoint = session.checkpoints.find(c => c.id === command.checkpointId)
      if (!checkpoint)
        throw new InvalidCommand(`no such checkpoint: ${command.checkpointId}`)
      if (!state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before rewinding its files.')
      if (session.conversationRewind || checkoutRewindPending(state, session)) throw new InvalidCommand('Wait for the current rewind to finish.')
      if ([...state.sessions.values()].some(other => isTurnActive(other.state) && sharesCheckout(state, session, other)))
        throw new InvalidCommand('Finish the active turn in this checkout before rewinding its files.')

      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'checkpoint.reverted', checkpointId: command.checkpointId, coordinated: true },
      }]
    }

    case 'session.organize':
      return organizeThread(state, command, envelope)

    case 'thread.snooze.elapsed': {
      const session = state.sessions.get(command.sessionId)
      if (!session?.navigation?.snoozedUntil || session.navigation.snoozedUntil !== command.until || command.until > at) return []
      return [{ sessionId: session.id, commandId, at, payload: { type: 'session.navigation-changed', changes: { snoozedUntil: null, settledAt: null } } }]
    }

    case 'session.handoff': {
      const session = state.sessions.get(command.sessionId)
      if (!session || session.state === 'stopped' || session.navigation?.archivedAt
        || (session.fork && session.fork.state !== 'ready'))
        throw new InvalidCommand('This thread is unavailable for a provider switch.')
      if (!state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before switching providers.')
      if (session.conversationRewind || checkoutRewindPending(state, session)) throw new InvalidCommand('Wait for the current rewind to finish.')
      if (isTurnActive(session.state) || session.followUps.entries.length)
        throw new InvalidCommand('Finish the current turn and queued messages before switching providers.')
      if (command.afterTurnId !== (session.turns.at(-1)?.id ?? 0))
        throw new InvalidCommand('This conversation changed on another device. Review the latest turn and send again.')
      if (command.driverKind === session.driverKind && command.providerInstanceId === session.providerInstanceId
        && (command.driverKind === 'codex' || (command.model ?? '') === session.model))
        throw new InvalidCommand('Choose another provider, account, or model.')
      if (typeof command.text !== 'string' || (!command.text.trim() && !attachments?.length) || isClearCommand(command.text))
        throw new InvalidCommand('Enter a message to switch providers.')
      if (isCompactCommand(command.text))
        throw new InvalidCommand('Send a message to switch providers before compacting the new conversation.')
      if (command.model !== undefined && (typeof command.model !== 'string' || !command.model.trim() || command.model.length > 200))
        throw new InvalidCommand('Choose a valid model for this conversation.')
      const model = sessionModel(command)
      const event = { sessionId: session.id, commandId, at }
      return [
        { ...event, payload: {
          type: 'session.provider-switched',
          afterTurnId: command.afterTurnId,
          driverKind: command.driverKind,
          ...(command.providerInstanceId === undefined ? {} : { providerInstanceId: command.providerInstanceId }),
          ...model,
        } },
        { ...event, payload: {
          ...turnStarted({ ...session, driverKind: command.driverKind, model: model.model ?? '', codexTurnOptions: model.codexTurnOptions }, command.text, undefined, undefined, command.freshContext === true, attachments),
          switchedProvider: command.driverKind,
        } },
      ]
    }

    case 'session.turn.start': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      if (session.conversationRewind || checkoutRewindPending(state, session)) throw new InvalidCommand('Wait for the current rewind to finish.')
      if (session.fork && session.fork.state !== 'ready')
        throw new InvalidCommand('This fork must finish before it can accept messages.')
      if (session.navigation?.archivedAt)
        throw new InvalidCommand('Restore this thread before sending a message.')
      if (isTurnActive(session.state))
        throw new InvalidCommand('a turn is already running')
      if (session.state === 'stopped')
        throw new InvalidCommand('session is stopped')
      if (!state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before sending a message.')

      if (isClearCommand(command.text)) throw new InvalidCommand('Use a fresh session with the next message.')
      const freshContext = command.freshContext === true
      if (freshContext && session.followUps.entries.length)
        throw new InvalidCommand('Queue this message after the existing follow-ups.')
      const turn = turnStarted(session, command.text, requestedCodexSelection(session, command.codexSelection), undefined, freshContext, attachments)
      const base = { sessionId: session.id, commandId, at }
      if (!freshContext && command.compactAfterTurnId !== undefined && effectiveClaudeCompaction(state, session).idleCompaction !== 'off'
        && !isCompactCommand(command.text)) {
        const eligible = claudeIdleCompaction(session, at)
        if (eligible && eligible.afterTurnId === command.compactAfterTurnId && eligible.availableAt <= at) {
          return [
            { ...base, payload: { ...turnStarted(session, '/compact'), automaticCompaction: true } },
            { ...base, payload: { type: 'queue.added', entry: { id: commandId, text: followUpText(command.text, Boolean(attachments?.length)), ...(attachments?.length ? { attachments } : {}) } } },
          ]
        }
      }
      return [{ ...base, payload: turn }]
    }

    case 'thread.compact.idle': {
      const session = state.sessions.get(command.sessionId)
      if (!session || effectiveClaudeCompaction(state, session).idleCompaction !== 'beforeCacheExpires'
        || !state.workspaces.get(session.workspaceId)?.trusted) return []
      if (session.conversationRewind || checkoutRewindPending(state, session)) return []
      const eligible = claudeIdleCompaction(session, at)
      if (!eligible || eligible.afterTurnId !== command.afterTurnId || eligible.startsAt === undefined
        || at < eligible.startsAt || eligible.expiresAt === undefined || at >= eligible.expiresAt) return []

      return [{ sessionId: session.id, commandId, at, payload: { ...turnStarted(session, '/compact'), automaticCompaction: true } }]
    }

    case 'session.queue.add':
    case 'session.queue.edit':
    case 'session.queue.move':
    case 'session.queue.remove': {
      const session = state.sessions.get(command.sessionId)
      if (!session || session.state === 'stopped')
        throw new InvalidCommand('This session is unavailable.')
      const emit = (payload: EventPayload): AppendableEvent[] => [{ sessionId: session.id, commandId, at, payload }]
      const entries = session.followUps.entries
      if (command.type === 'session.queue.add') {
        if (session.fork && session.fork.state !== 'ready')
          throw new InvalidCommand('This fork must finish before it can accept messages.')
        if (session.navigation?.archivedAt)
          throw new InvalidCommand('Restore this thread before queuing a message.')
        if (!state.workspaces.get(session.workspaceId)?.trusted)
          throw new InvalidCommand('Trust this workspace before queuing a message.')
        const codexSelection = requestedCodexSelection(session, command.codexSelection)
        const text = followUpText(command.text, Boolean(attachments?.length))
        const freshContext = command.freshContext === true
        if (isClearCommand(text) || (freshContext && isCompactCommand(text)))
          throw new InvalidCommand('Write a message to start the fresh provider session.')
        return emit({ type: 'queue.added', entry: {
          id: commandId, text, ...(attachments?.length ? { attachments } : {}), ...(codexSelection ? { codexSelection } : {}), ...(freshContext ? { freshContext: true } : {}),
        } })
      }

      const index = entries.findIndex(entry => entry.id === command.id)
      const entry = entries[index]
      if (!entry) throw new InvalidCommand('This message is no longer queued.')
      if (entry.steering) throw new InvalidCommand('Wait for the provider to confirm this message.')

      if (command.type === 'session.queue.remove')
        return emit({ type: 'queue.removed', id: entry.id })
      if (command.type === 'session.queue.edit') {
        if (entry.text !== command.previousText)
          throw new InvalidCommand('This message was edited on another device. Reopen it to make changes.')
        const text = followUpText(command.text, Boolean(entry.attachments?.length))
        if ((entry.attachments?.length && isCompactCommand(text)) || isClearCommand(text) || (entry.freshContext && isCompactCommand(text)))
          throw new InvalidCommand('Write a message to start the fresh provider session.')
        return emit({ type: 'queue.edited', id: entry.id, text })
      }

      if (command.direction !== 'up' && command.direction !== 'down')
        throw new InvalidCommand('Choose a direction to move the queued message.')
      const toIndex = index + (command.direction === 'up' ? -1 : 1)
      return toIndex < 0 || toIndex >= entries.length ? [] : emit({ type: 'queue.moved', id: entry.id, toIndex })
    }

    case 'thread.steer.ready': {
      const session = state.sessions.get(command.sessionId)
      const turn = session?.turns.at(-1)
      if (!session || turn?.id !== command.turnId || turn.status !== 'running' || turn.steerable) return []
      return [{ sessionId: session.id, commandId, at, payload: { type: 'turn.steering-ready', turnId: turn.id } }]
    }

    case 'session.turn.steer': {
      const session = state.sessions.get(command.sessionId)
      const turn = session?.turns.at(-1)
      if (!session || session.state !== 'running' || !turn?.steerable || turn.id !== command.turnId)
        throw new InvalidCommand('This turn is no longer available to steer.')
      if (!state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('Trust this workspace before steering the agent.')
      const entries = session.followUps.entries
      if (entries.some(entry => entry.steering))
        throw new InvalidCommand('Wait for the agent to confirm the previous steer.')

      const event = { sessionId: session.id, commandId, at }
      const entry = 'id' in command
        ? entries.find(entry => entry.id === command.id)
        : { id: commandId, text: followUpText(command.text) }
      if (!entry) throw new InvalidCommand('This message is no longer queued.')
      if ('freshContext' in entry && entry.freshContext)
        throw new InvalidCommand('A fresh session must wait for the current turn to finish.')
      if (isClearCommand(entry.text))
        throw new InvalidCommand('Use a fresh session with the next message.')
      if (isCompactCommand(entry.text))
        throw new InvalidCommand('Compaction must wait for the current turn to finish.')
      const selection = 'codexSelection' in entry ? entry.codexSelection : undefined
      if (selection && (selection.model !== session.model || selection.effort !== session.codexTurnOptions?.effort
        || selection.serviceTier !== session.codexTurnOptions?.serviceTier))
        throw new InvalidCommand('This message is queued for a different model or settings.')
      if ('attachments' in entry && entry.attachments?.length)
        throw new InvalidCommand('Messages with attachments wait for the current turn to finish.')
      if (entry.steeringIssue === 'uncertain')
        throw new InvalidCommand('Review this message before sending it again.')
      return [
        ...('id' in command ? [] : [{ ...event, payload: { type: 'queue.added' as const, entry } }]),
        { ...event, payload: { type: 'turn.steer.requested', turnId: turn.id, id: entry.id, requestId: commandId, text: entry.text } },
      ]
    }

    case 'thread.steer.settle': {
      const session = state.sessions.get(command.sessionId)
      const entry = session?.followUps.entries.find(entry => entry.id === command.id)
      if (!session || !entry?.steering || entry.steering.requestId !== command.requestId) return []
      return [{
        sessionId: session.id,
        commandId,
        at,
        payload: { type: 'turn.steer.resolved', turnId: entry.steering.turnId, id: entry.id, outcome: command.outcome, text: entry.text },
      }]
    }

    case 'thread.queue.hold': {
      const session = state.sessions.get(command.sessionId)
      if (!session?.followUps.entries.length || session.followUps.held) return []
      return [{ sessionId: session.id, commandId, at, payload: { type: 'queue.held' } }]
    }

    case 'session.queue.send':
    case 'thread.queue.advance': {
      const automatic = command.type === 'thread.queue.advance'
      const session = state.sessions.get(command.sessionId)
      if (automatic && (!session || session.followUps.held || !session.followUps.entries.length)) return []
      if (session && (session.conversationRewind || checkoutRewindPending(state, session))) {
        if (automatic) return []
        throw new InvalidCommand('Wait for the current rewind to finish.')
      }
      if (session?.fork && session.fork.state !== 'ready') {
        if (automatic) return []
        throw new InvalidCommand('This fork must finish before it can accept messages.')
      }
      if (session?.navigation?.archivedAt) {
        if (automatic) return []
        throw new InvalidCommand('Restore this thread before sending a message.')
      }
      if (automatic && (session?.navigation?.settledAt || session?.navigation?.snoozedUntil)) return []
      if (!session || session.state === 'stopped' || isTurnActive(session.state)) {
        if (automatic) return []
        throw new InvalidCommand('Wait for the current turn to finish before sending this message.')
      }
      if (!state.workspaces.get(session.workspaceId)?.trusted) {
        if (automatic) return [{ sessionId: session.id, commandId, at, payload: { type: 'queue.held' } }]
        throw new InvalidCommand('Trust this workspace before sending a queued message.')
      }
      if (session.followUps.entries.some(entry => entry.steering)) {
        if (automatic) return []
        throw new InvalidCommand('Wait for the provider to confirm the message being sent.')
      }
      const id = automatic ? undefined : command.id
      const entry = id === undefined ? session.followUps.entries[0] : session.followUps.entries.find(entry => entry.id === id)
      if (!entry) throw new InvalidCommand('This message is no longer queued.')
      if (entry.steeringIssue === 'uncertain') {
        if (automatic) return [{ sessionId: session.id, commandId, at, payload: { type: 'queue.held' } }]
        if (!id || command.confirmResend !== true)
          throw new InvalidCommand('Use Send again on the message whose delivery could not be confirmed.')
      }
      return [{ sessionId: session.id, commandId, at, payload: turnStarted(session, entry.text, entry.codexSelection, entry.id, entry.freshContext === true, entry.attachments) }]
    }

    case 'session.turn.interrupt': {
      const session = state.sessions.get(command.sessionId)
      if (!session)
        throw new InvalidCommand(`no such session: ${command.sessionId}`)
      const running = session.turns.findLast(t => t.status === 'running')
      // Interrupting an idle session is a no-op rather than an error: the user
      // pressed stop just as the turn finished, and telling them off for it
      // would be pedantic.
      if (!running) {
        return session.followUps.entries.length && !session.followUps.held
          ? [{ sessionId: session.id, commandId, at, payload: { type: 'queue.held' } }]
          : []
      }

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
      const stopped: AppendableEvent = {
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.stopped' },
      }
      if (session.fork?.state !== 'pending') return [stopped]
      if (state.sessions.get(command.sessionId)?.conversationRewind)
        throw new InvalidCommand('Wait for the current conversation rewind to finish.')

      return [stopped, {
        sessionId: session.id, commandId, at,
        payload: { type: 'session.fork-failed', message: 'The fork was stopped. Return to the source response to try again.' },
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
          ...(command.connector ? { connector: command.connector } : {}),
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
      const start = session.checkpoints.find(point => point.turnId === turn.id && point.kind === 'turn-start')
      const end = session.checkpoints.findLast(point => point.turnId === turn.id && point.kind === 'turn-end')
      const reviewRepositories = checkpointReviewRepositories(start, end)
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
          ...(command.providerTurnId ? { providerTurnId: command.providerTurnId } : {}),
          ...(turn.response.trim() && !turn.compaction ? { responseForkable: true } : {}),
          ...(reviewRepositories.length && { reviewRepositories }),
          ...(command.contextCompacted ? { contextCompacted: true } : {}),
          ...(command.contextUsage ? { contextUsage: command.contextUsage } : {}),
        },
      }]
    }

    case 'thread.input.request': {
      const session = state.sessions.get(command.sessionId)
      const turn = session?.turns.at(-1)
      if (!session || !isTurnActive(session.state) || turn?.id !== command.turnId || turn.status !== 'running') return []
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'input.requested', requestId: commandId, turnId: command.turnId, questions: command.questions },
      }]
    }

    case 'thread.input.cancel':
    case 'thread.input.answer':
    case 'session.input.respond': {
      const session = state.sessions.get(command.sessionId)
      const request = session?.pendingInputs.find(request => request.requestId === command.requestId)
      let outcome: 'answered' | 'declined' | 'interrupted' = 'interrupted'
      if (command.type !== 'thread.input.cancel') {
        if (!request) throw new InvalidCommand('This question is no longer pending.')
        const answers = inputResponseValues(command, request.questions)
        if (answers !== null && !validInputAnswers(request.questions, answers))
          throw new InvalidCommand('Complete all required questions with valid answers.')
        if (command.type === 'session.input.respond' && answers?.some(answer => answer.attachmentIds?.length))
          throw new InvalidCommand('Question attachments must be resolved by the host.')
        outcome = answers === null ? 'declined' : 'answered'
      }
      if (!request) return []
      // The receipt stores that the response was accepted. Only the live
      // provider receives its values, which may include private information.
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'input.resolved',
          requestId: request.requestId,
          turnId: request.turnId,
          outcome,
          ...(command.type === 'thread.input.answer' && command.attachments.length ? { attachments: command.attachments } : {}),
        },
      }]
    }

    case 'thread.approval.cancel':
    case 'session.approval.respond': {
      const session = state.sessions.get(command.sessionId)
      const request = session?.pendingApprovals.find(request => request.approvalId === command.approvalId)
      const cancelled = command.type === 'thread.approval.cancel'
      if (!session || session.state !== 'awaiting-approval' || !request) {
        if (cancelled) return []
        if (!session) throw new InvalidCommand(`no such session: ${command.sessionId}`)
        throw new InvalidCommand('This approval is no longer pending.')
      }
      const decision = cancelled ? 'cancelled' : command.decision
      const scope = cancelled ? 'once' : command.scope
      if (!cancelled) {
        if (request.connector) {
          if (!request.connector.choices.some(choice => choice.decision === decision && choice.scope === scope))
            throw new InvalidCommand('This connector did not offer that approval choice.')
        }
        else if (decision !== 'allowed' && decision !== 'denied') {
          throw new InvalidCommand('Invalid approval decision.')
        }
      }
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: {
          type: 'approval.resolved',
          approvalId: command.approvalId,
          decision,
          scope,
        },
      }]
    }

    case 'thread.handoff.claim': {
      const session = state.sessions.get(command.sessionId)
      const turn = session?.turns.at(-1)
      if (!session || !session.handoff?.pending || session.providerSessionId
        || turn?.id !== command.turnId || turn.status !== 'running'
        || providerConversation(session)?.providerSessionId !== command.providerSessionId
        || !state.workspaces.get(session.workspaceId)?.trusted)
        throw new InvalidCommand('The saved provider conversation is no longer available for this turn.')
      return [{
        sessionId: session.id,
        commandId,
        at,
        payload: { type: 'session.provider-bound', providerSessionId: command.providerSessionId },
      }]
    }

    case 'thread.session.set':
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.provider-bound', providerSessionId: command.providerSessionId },
      }]

    case 'thread.error': {
      if (command.turnId !== undefined) {
        const turn = state.sessions.get(command.sessionId)?.turns.at(-1)
        if (turn?.id !== command.turnId || turn.status !== 'running') return []
      }
      return [{
        sessionId: command.sessionId,
        commandId,
        at,
        payload: { type: 'session.failed', message: command.message },
      }]
    }

    default:
      // Not every command has a reducer yet. Producing nothing is correct for
      // an unimplemented one — it leaves no trace in the log, so implementing
      // it later does not have to reckon with half-events already written.
      return []
  }
}

export { derivedId }
