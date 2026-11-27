/**
 * The read model, derived from the log and nothing else.
 *
 * `apply` must be a pure function of (state, event). No clocks, no randomness,
 * no I/O — otherwise replaying the same log twice produces two different
 * states, and the whole reason for keeping a log evaporates.
 */

import type { ClaudeAccountCompaction, CodexTurnOptions, CodexTurnSelection, CombinedWorktreeIntent, ComposerAttachment, ConnectorApproval, ConversationRewindPoint, DriverKind, EventPayload, FollowUpQueue, ForkSource, HarnessEvent, HostSettings, InputQuestion, ModelFavorite, ProviderContextUsage, PullRequestCheckout, QuestionAttachment, RepositoryCheckpoint, RepositoryPullRequest, ThreadNavigation, ThreadUndoRecord, WorktreeIntent, WorktreeSelection } from '@harness/contract'

import { acceptedClaudeAccountCompaction, acceptedSettings, applyFollowUpEvent, hostSettings, pinOrder, threadDisplayTitle } from '@harness/contract'
import { projectThreadUndo } from './thread-undo'
import type { ThreadUndoStack } from './thread-undo'

export interface InputRequestState {
  attachments?: QuestionAttachment[]
  requestId: string
  turnId: number
  questions: InputQuestion[]
  outcome: 'pending' | 'answered' | 'declined' | 'interrupted'
}

interface ProviderConversation {
  providerSessionId: string
  throughTurnId: number
  resumeSessionAt?: string
  context?: { usage: ProviderContextUsage, reportedAt: number, model: string, serviceTier?: string }
}

export interface SessionState {
  id: number
  workspaceId: number
  driverKind: DriverKind
  providerInstanceId?: number
  /** Model override for this session. Empty means the provider's own default. */
  model: string
  codexTurnOptions?: CodexTurnOptions
  providerSessionId: string
  /** Last confirmed native conversation and coverage for each provider account. */
  providerConversations?: Record<string, ProviderConversation>
  handoff?: { afterTurnId: number, pending: boolean }
  fork?: ForkSource & { state: 'pending' | 'ready' | 'failed', nativeSessionId?: string, error?: string }
  pullRequest?: PullRequestCheckout
  linkedPullRequests?: RepositoryPullRequest[]
  state: 'idle' | 'running' | 'awaiting-approval' | 'awaiting-input' | 'stopped' | 'failed'
  lastError?: string
  lastSeq: number
  lastActivityAt?: number
  keepActiveUntilTurn?: boolean
  navigation?: ThreadNavigation
  turns: TurnState[]
  lastTurnId?: number
  conversationRewind?: { operation: string, turnId: number, point: ConversationRewindPoint, checkpointId?: number, status: 'running' | 'restoring-files' | 'uncertain' }
  rewoundPrompt?: { operation: string, text: string, attachments: ComposerAttachment[] }
  conversationRewindNotice?: string
  followUps: FollowUpQueue
  /** Oldest first, so the newest revert target is the last one. */
  checkpoints: CheckpointState[]
  pendingRewind?: { checkpointId: number, operation: string }
  rewindNotice?: string
  /**
   * Outstanding tool decisions in arrival order.
   *
   * Projected rather than left to the socket, because the client that raised it
   * may be gone. An approval only ever reached the browser that happened to be
   * connected when it fired; anyone arriving afterwards saw a session marked
   * `awaiting-approval` with nothing to act on, and the turn waited forever.
   */
  pendingApprovals: Array<{ approvalId: number, toolName: string, connector?: ConnectorApproval }>
  pendingInputs: InputRequestState[]
  /** Whether this session asked for a checkout of its own. */
  isolate: boolean
  worktree?: WorktreeSelection
  worktreeIntent?: WorktreeIntent
  combinedWorktree?: CombinedWorktreeIntent
  /**
   * Where the agent actually runs, once isolated.
   *
   * Empty until the worktree exists — it is made on the first turn rather than
   * at session creation, so a session nobody ever runs does not leave a
   * checkout behind.
   */
  worktreePath: string
  settledSeq?: number
  /** The branch its work lands on. Empty until isolated. */
  branch: string
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

/**
 * A workspace snapshot taken around a turn.
 *
 * `vcsRef` is a dangling commit, so it survives until `git gc` and depends on
 * nothing. A checkpoint whose ref has been collected simply fails to restore,
 * which is why the runtime reports rather than assumes.
 */
export interface CheckpointState {
  id: number
  turnId: number
  kind: 'turn-start' | 'turn-end' | 'manual'
  vcsRef: string
  tree?: string
  repositories?: RepositoryCheckpoint[]
  /** Set once this checkpoint has been reverted to at least once. */
  reverted: boolean
}

/** Repository keys whose working-tree contents changed between recorded checkpoints. */
export function checkpointReviewRepositories(start?: CheckpointState, end?: CheckpointState): string[] {
  if (!start || !end) return []
  const snapshots = (point: CheckpointState) => point.repositories ?? [{ key: '', vcsRef: point.vcsRef, tree: point.tree }]
  const before = new Map(snapshots(start).map(point => [point.key, point]))
  return snapshots(end).flatMap((point) => {
    const previous = before.get(point.key)
    if (!previous) return []
    // Older events recorded only the commit. Those checkpoints still support review.
    const changed = previous.tree && point.tree ? previous.tree !== point.tree : previous.vcsRef !== point.vcsRef
    return changed ? [point.key] : []
  })
}

interface NativeForkTarget {
  driverKind: 'claude' | 'codex'
  providerSessionId: string
  providerInstanceId?: number
}

export interface TurnState {
  id: number
  role: 'user' | 'assistant'
  status: 'pending' | 'running' | 'complete' | 'interrupted' | 'failed'
  codexSelection?: CodexTurnSelection
  providerTurnId?: string
  nativeFork?: NativeForkTarget
  compaction?: true
  automaticCompaction?: true
  freshContext?: true
  contextCompacted?: true
  modelChanged?: boolean
  switchedProvider?: DriverKind
  /** What the user asked. Set once, at `turn.started`. */
  prompt: string
  attachments?: ComposerAttachment[]
  steerable?: boolean
  steered?: Array<{ id: string, text: string }>
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
  inputRequests?: InputRequestState[]
  tokensIn: number
  tokensOut: number
  cost: number
}

/** An MCP server attached to a profile. See server/mcp.ts for the value rules. */
export interface McpServerState {
  name: string
  transport: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled: boolean
}

export interface ProfileState {
  id: number
  name: string
  /** SF Symbol or iconify class for the switcher. Empty means the default. */
  icon: string
  /**
   * The profile's colour — the thing that makes an Arc space a *space*.
   *
   * A seed (`blue`, `#5aa9ee`, an oklch string) or a full palette as JSON;
   * `<Sidebar :spaces>` accepts both, so it is stored as given rather than
   * flattened on the way in. Empty means the sidebar picks.
   */
  tint: string
  /** Order in the switcher. Lower is further left. */
  position: number
  workspaceIds: number[]
  /** In the order they were attached. */
  mcpServers: McpServerState[]
  modelFavorites?: ModelFavorite[]
  claudeCompactionByAccount?: Record<number, ClaudeAccountCompaction>
  threadUndo?: ThreadUndoRecord
  threadUndoStacks?: Map<string, ThreadUndoStack>
}

export function modelFavoriteIndex(favorites: readonly ModelFavorite[], favorite: ModelFavorite): number {
  return favorites.findIndex(entry => entry.driverKind === favorite.driverKind
    && entry.providerInstanceId === favorite.providerInstanceId && entry.model === favorite.model)
}

export interface WorkspaceState {
  id: number
  profileId: number
  path: string
  trusted: boolean
  scratch?: boolean
}

/**
 * A device allowed to reach this server from somewhere other than loopback.
 *
 * The token itself is never here: `tokenHash` is what the log holds, so a
 * leaked database reveals who paired and when, not how to connect.
 */
export interface DeviceState {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
}

export interface HarnessState {
  sessions: Map<number, SessionState>
  profiles: Map<number, ProfileState>
  workspaces: Map<number, WorkspaceState>
  devices: Map<string, DeviceState>
  /** Host-wide preferences, at their defaults until something changes one. */
  settings: HostSettings
}

export function profilePinnedThreads(state: HarnessState, profileId: number | undefined): SessionState[] {
  return [...state.sessions.values()].filter(session => session.navigation?.pinnedOrder != null
    && state.workspaces.get(session.workspaceId)?.profileId === profileId).sort(pinOrder)
}

export function isVisiblePin(session: SessionState): boolean {
  return !session.navigation?.archivedAt && !session.navigation?.snoozedUntil
}

export function threadShelf(session: SessionState) {
  const navigation = session.navigation
  if (navigation?.archivedAt) return 'archived'
  if (navigation?.snoozedUntil) return 'snoozed'
  if (navigation?.pinnedOrder != null) return 'pinned'
  if (navigation?.settledAt || session.state === 'stopped') return 'settled'
  return session.state === 'running' ? 'working' : 'active'
}

export function activeThreadOrder(first: SessionState, second: SessionState): number {
  return (first.navigation?.activeOrder ?? 0) - (second.navigation?.activeOrder ?? 0)
}

export function emptyState(): HarnessState {
  return { sessions: new Map(), profiles: new Map(), workspaces: new Map(), devices: new Map(), settings: hostSettings() }
}

/** A native conversation belongs to one selected account within this Harness thread. */
function providerConversationKey(session: Pick<SessionState, 'driverKind' | 'providerInstanceId'>): string {
  return session.providerInstanceId === undefined ? session.driverKind : `${session.driverKind}:${session.providerInstanceId}`
}

export function providerConversation(session: SessionState) {
  return session.providerConversations?.[providerConversationKey(session)]
}

function forgetProviderConversation(session: SessionState): void {
  if (session.providerConversations) delete session.providerConversations[providerConversationKey(session)]
}

function forgetUnconfirmedProviderTurn(session: SessionState): void {
  const conversation = providerConversation(session)
  if (conversation?.resumeSessionAt && conversation.providerSessionId === session.providerSessionId) return
  forgetProviderConversation(session)
}

export function sharesCheckout(state: HarnessState, first: SessionState, second: SessionState): boolean {
  if (first.id === second.id) return true
  const path = (session: SessionState) => {
    const value = (session.worktreePath || state.workspaces.get(session.workspaceId)?.path)?.replaceAll('\\', '/').replace(/\/+$/u, '')
    return value && /^[a-z]:\//iu.test(value) ? value.toLowerCase() : value
  }
  const a = path(first)
  const b = path(second)
  if (a === undefined || b === undefined) return false
  const contains = (parent: string, child: string) => child.startsWith(`${parent}/`)
    && !child.slice(parent.length + 1).split('/').includes('.git')
  return a === b || contains(a, b) || contains(b, a)
}

export function isolatedRewindScope(state: HarnessState, session: SessionState): 'files' | 'repositories' | undefined {
  if (!session.isolate || !session.worktreePath || !state.workspaces.get(session.workspaceId)?.trusted) return undefined
  for (const other of state.sessions.values()) {
    if (other.id !== session.id && sharesCheckout(state, session, other)) return undefined
  }
  const combined = session.combinedWorktree
  return combined && !combined.checkouts.some(checkout => !checkout.key) ? 'repositories' : 'files'
}

export function conversationRewindPoint(session: SessionState, index: number): ConversationRewindPoint | undefined {
  const claude = session.driverKind === 'claude'
  if ((!claude && session.driverKind !== 'codex') || !session.providerSessionId || session.handoff?.pending) return undefined
  const selected = session.turns[index]
  const newest = session.turns.at(-1)
  const conversation = claude ? providerConversation(session) : undefined
  const pinned = conversation?.providerSessionId === session.providerSessionId ? conversation.resumeSessionAt : undefined
  const belongs = (turn: TurnState | undefined) => {
    const native = turn?.nativeFork
    return native && native.providerSessionId === session.providerSessionId && native.driverKind === session.driverKind
      && native.providerInstanceId === session.providerInstanceId
  }
  if (selected?.role !== 'user' || !selected.providerTurnId || selected.compaction || !belongs(selected)) return undefined
  const newestTurnId = pinned || (belongs(newest) ? newest?.providerTurnId : undefined)
  if (!newestTurnId) return undefined
  let preceding = index - 1
  // A completed Claude compaction records no assistant cursor of its own.
  while (claude && session.turns[preceding]?.contextCompacted) preceding--
  const earlier = session.turns[preceding]
  if (earlier && !selected.freshContext && (!earlier.providerTurnId || !belongs(earlier))) return undefined
  return { providerSessionId: session.providerSessionId, beforeTurnId: selected.providerTurnId, newestTurnId,
    ...(earlier?.providerTurnId && !selected.freshContext && { retainedTurnId: earlier.providerTurnId }),
  }
}

export function isForkableResponse(turn: TurnState): boolean {
  return turn.status === 'complete' && !turn.compaction && Boolean(turn.response.trim())
}

export function forkResponsePoint(session: SessionState | undefined, turnId: number): TurnState | undefined {
  if (!session || session.navigation?.archivedAt || (session.fork && session.fork.state !== 'ready')) return undefined
  const turn = session.turns.find(turn => turn.id === turnId)
  return turn && isForkableResponse(turn) ? turn : undefined
}

export function isTurnActive(state: SessionState['state']): boolean {
  return state === 'running' || state === 'awaiting-approval' || state === 'awaiting-input'
}

export function inactivityDeadline(session: SessionState, settings: HostSettings): number | undefined {
  const navigation = session.navigation
  if (settings.autoSettleAfterDays == null || session.lastActivityAt === undefined
    || session.keepActiveUntilTurn || session.state === 'stopped' || isTurnActive(session.state)
    || navigation?.archivedAt || navigation?.settledAt || navigation?.pinnedOrder != null
    || navigation?.snoozedUntil != null || navigation?.autoSettle === 'never'
    || session.pendingApprovals.length || session.pendingInputs.length || session.followUps.entries.length
    || session.pendingRewind || session.conversationRewind || session.fork?.state === 'pending') return
  return session.lastActivityAt + Math.round(settings.autoSettleAfterDays * 86_400_000)
}

export function recordsThreadActivity(payload: EventPayload): boolean {
  return payload.type === 'session.created' || payload.type === 'turn.started' || payload.type === 'turn.completed'
    || payload.type === 'turn.interrupted' || payload.type === 'turn.failed' || payload.type === 'session.failed'
    || payload.type === 'session.fork-finished' || payload.type === 'session.fork-failed'
    || (payload.type === 'session.navigation-changed' && payload.changes.snoozedUntil === null)
}

function syncTurnWaitingState(session: SessionState): void {
  session.state = session.pendingApprovals.length ? 'awaiting-approval'
    : session.pendingInputs.length ? 'awaiting-input' : 'running'
}

function clearTurnRequests(session: SessionState): void {
  session.pendingApprovals = []
  for (const request of session.pendingInputs) request.outcome = 'interrupted'
  session.pendingInputs = []
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
  const observedAt = event.recordedAt === undefined ? event.at : event.recordedAt
  const beforeNavigation = p.type === 'session.navigation-changed' ? state.sessions.get(event.sessionId)?.navigation : undefined

  switch (p.type) {
    case 'settings.updated': {
      // Filtered on the way in as well as on the way out: a value this build
      // no longer accepts was written by one that did, and replaying it
      // verbatim would put the projection somewhere the type says it cannot
      // be. The setting falls back to its default instead.
      Object.assign(state.settings, acceptedSettings(p.changes))
      return state
    }

    case 'profile.created':
      state.profiles.set(p.profileId, {
        id: p.profileId,
        name: p.name,
        icon: p.icon ?? '',
        tint: p.tint ?? '',
        position: 0,
        workspaceIds: [],
        mcpServers: [],
      })
      break

    case 'profile.updated': {
      const profile = state.profiles.get(p.profileId)
      if (!profile) break
      // Absent means unchanged, which is what makes a recolour and a rename
      // independent rather than one clobbering the other.
      if (p.name !== undefined) profile.name = p.name
      if (p.icon !== undefined) profile.icon = p.icon
      if (p.tint !== undefined) profile.tint = p.tint
      if (p.position !== undefined) profile.position = p.position
      break
    }

    case 'profile.claude-compaction.updated': {
      const profile = state.profiles.get(p.profileId)
      if (!profile) break
      const accounts = profile.claudeCompactionByAccount ??= {}
      accounts[p.providerInstanceId] = {
        ...accounts[p.providerInstanceId], ...acceptedClaudeAccountCompaction(p.changes),
      }
      break
    }

    case 'profile.model-favorite.changed': {
      const profile = state.profiles.get(p.profileId)
      if (!profile) break
      const favorites = profile.modelFavorites ??= []
      const index = modelFavoriteIndex(favorites, p.favorite)
      if (p.selected && index < 0) favorites.push(p.favorite)
      else if (!p.selected && index >= 0) favorites.splice(index, 1)
      break
    }

    case 'profile.deleted':
      state.profiles.delete(p.profileId)
      // `?? []` so a `profile.deleted` written before the cascade existed still
      // replays — it removed nothing then and must remove nothing now.
      for (const id of p.workspaceIds ?? []) state.workspaces.delete(id)
      for (const id of p.sessionIds ?? []) state.sessions.delete(id)
      break

    case 'mcp.added': {
      const profile = state.profiles.get(p.profileId)
      if (!profile) break
      // Ignore a duplicate name rather than shadowing: the reducer refuses one,
      // so seeing it here means a replay of the same event.
      if (profile.mcpServers.some(server => server.name === p.name)) break
      profile.mcpServers.push({
        name: p.name,
        transport: p.transport,
        ...(p.command ? { command: p.command } : {}),
        ...(p.args ? { args: p.args } : {}),
        ...(p.env ? { env: p.env } : {}),
        ...(p.url ? { url: p.url } : {}),
        ...(p.headers ? { headers: p.headers } : {}),
        // Attached means wanted. Adding a server disabled would make the common
        // case two commands.
        enabled: true,
      })
      break
    }

    case 'mcp.removed': {
      const profile = state.profiles.get(p.profileId)
      if (!profile) break
      profile.mcpServers = profile.mcpServers.filter(server => server.name !== p.name)
      break
    }

    case 'mcp.enabledChanged': {
      const profile = state.profiles.get(p.profileId)
      const server = profile?.mcpServers.find(s => s.name === p.name)
      if (server) server.enabled = p.enabled
      break
    }

    case 'workspace.added': {
      state.workspaces.set(p.workspaceId, {
        id: p.workspaceId,
        profileId: p.profileId,
        path: p.path,
        trusted: false,
        ...(p.scratch ? { scratch: true } : {}),
      })
      const profile = state.profiles.get(p.profileId)
      // Idempotent on the profile side too: replaying must not double-list a
      // workspace, and `apply` is called again on every replay.
      if (profile && !profile.workspaceIds.includes(p.workspaceId))
        profile.workspaceIds.push(p.workspaceId)
      break
    }

    case 'workspace.promoted': {
      const workspace = state.workspaces.get(p.workspaceId)
      if (workspace) delete workspace.scratch
      break
    }

    case 'device.paired':
      state.devices.set(p.deviceId, {
        id: p.deviceId,
        name: p.name,
        tokenHash: p.tokenHash,
        pairedAt: p.at,
      })
      break

    case 'device.revoked':
      state.devices.delete(p.deviceId)
      break

    case 'workspace.trust-changed': {
      const workspace = state.workspaces.get(p.workspaceId)
      if (workspace) workspace.trusted = p.trusted
      break
    }

    case 'session.created': {
      const fork = p.forkFrom
      const source = fork && state.sessions.get(fork.sessionId)
      const copied = source && fork ? structuredClone(source.turns.filter(turn => turn.id <= fork.turnId)) : []
      for (const turn of copied) {
        // Attachments are retained by the source session and its access route.
        for (const request of turn.inputRequests ?? []) delete request.attachments
        // The fork owns only the native history copied from its chosen account.
        if (turn.nativeFork?.providerSessionId !== fork?.providerSessionId
          || turn.nativeFork?.providerInstanceId !== p.providerInstanceId) delete turn.nativeFork
      }
      state.sessions.set(event.sessionId, {
        id: event.sessionId,
        workspaceId: p.workspaceId,
        driverKind: p.driverKind,
        ...(p.providerInstanceId !== undefined ? { providerInstanceId: p.providerInstanceId } : {}),
        model: p.model ?? '',
        ...(p.codexTurnOptions ? { codexTurnOptions: p.codexTurnOptions } : {}),
        providerSessionId: '',
        ...(fork ? {
          fork: { ...fork, state: fork.providerSessionId ? 'pending' : 'ready' },
          ...(!fork.providerSessionId ? { handoff: { afterTurnId: fork.turnId, pending: true } } : {}),
          navigation: { title: threadDisplayTitle(source?.navigation?.title, source?.turns[0]?.prompt) + ' fork' },
        } : {}),
        ...(p.pullRequest && {
          pullRequest: p.pullRequest,
          navigation: { title: p.pullRequest.repository + '#' + p.pullRequest.number },
        }),
        state: 'idle',
        lastSeq: 0,
        turns: copied,
        followUps: { entries: [], held: false },
        checkpoints: [],
        pendingApprovals: [],
        pendingInputs: [],
        isolate: p.isolate === true,
        ...(p.worktree && { worktree: p.worktree }),
        worktreePath: '',
        branch: '',
      })
      break
    }

    case 'session.fork-finished': {
      const session = state.sessions.get(event.sessionId)
      if (session?.fork?.state === 'pending') {
        session.providerSessionId = p.providerSessionId
        session.fork.nativeSessionId = p.providerSessionId
        session.providerConversations = {
          [providerConversationKey(session)]: {
            providerSessionId: p.providerSessionId,
            throughTurnId: session.fork.turnId,
          },
        }
        for (const turn of session.turns) {
          if (!turn.nativeFork) continue
          if (turn.nativeFork.driverKind === 'claude') {
            const copiedId = turn.providerTurnId && p.copiedProviderTurnIds?.[turn.providerTurnId]
            if (!copiedId) {
              delete turn.nativeFork
              continue
            }
            turn.providerTurnId = copiedId
          }
          turn.nativeFork.providerSessionId = p.providerSessionId
        }
        session.fork.state = 'ready'
      }
      break
    }

    case 'session.fork-portable': {
      const session = state.sessions.get(event.sessionId)
      if (session?.fork?.state === 'pending') {
        delete session.fork.providerSessionId
        for (const turn of session.turns) delete turn.nativeFork
        session.handoff = { afterTurnId: session.fork.turnId, pending: true }
        session.fork.state = 'ready'
      }
      break
    }

    case 'session.fork-failed': {
      const session = state.sessions.get(event.sessionId)
      if (session?.fork?.state === 'pending') {
        session.fork.state = 'failed'
        session.fork.error = p.message
      }
      break
    }

    case 'session.navigation-changed': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      session.navigation = { ...session.navigation, ...p.changes }
      if ('settledAt' in p.changes) {
        session.settledSeq = typeof p.changes.settledAt === 'number' ? event.seq : undefined
        if (p.changes.settledAutomatically === undefined) delete session.navigation.settledAutomatically
        if (beforeNavigation?.settledAt && p.changes.settledAt === null && p.changes.snoozedUntil === undefined)
          session.keepActiveUntilTurn = true
      }
      const workspace = state.workspaces.get(session.workspaceId)
      const profile = workspace && state.profiles.get(workspace.profileId)
      if (profile) projectThreadUndo(profile, event.sessionId, event.at, p)
      break
    }

    case 'session.provider-bound': {
      const session = state.sessions.get(event.sessionId)
      if (session) {
        if (session.providerSessionId !== p.providerSessionId) forgetProviderConversation(session)
        session.providerSessionId = p.providerSessionId
      }
      break
    }

    case 'session.stopped': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      session.state = 'stopped'
      clearTurnRequests(session)
      break
    }

    case 'session.failed': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      const active = session.turns.at(-1)
      if (active?.status === 'running') {
        active.status = 'failed'
        if (session.providerSessionId) forgetUnconfirmedProviderTurn(session)
      }
      if (session.navigation?.snoozedUntil) session.navigation.snoozedUntil = null
      session.state = 'failed'
      session.lastError = p.message
      clearTurnRequests(session)
      break
    }

    case 'session.provider-switched': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      session.driverKind = p.driverKind
      if (p.providerInstanceId === undefined) delete session.providerInstanceId
      else session.providerInstanceId = p.providerInstanceId
      session.model = p.model ?? ''
      if (p.codexTurnOptions === undefined) delete session.codexTurnOptions
      else session.codexTurnOptions = p.codexTurnOptions
      session.providerSessionId = ''
      session.handoff = { afterTurnId: p.afterTurnId, pending: true }
      break
    }

    case 'turn.rewind-requested': {
      const session = state.sessions.get(event.sessionId)
      if (session) {
        session.conversationRewind = { operation: p.operation, point: p.point, turnId: p.turnId, checkpointId: p.checkpointId, status: 'running' }
        delete session.conversationRewindNotice
      }
      break
    }

    case 'turn.rewind-provider-confirmed': {
      const pending = state.sessions.get(event.sessionId)?.conversationRewind
      if (pending?.operation === p.operation) pending.status = 'restoring-files'
      break
    }

    case 'turn.rewind-settled': {
      const session = state.sessions.get(event.sessionId)
      const pending = session?.conversationRewind
      if (!session || !pending || pending.operation !== p.operation) break
      session.conversationRewindNotice = p.message
      if (p.outcome === 'uncertain') {
        pending.status = 'uncertain'
        break
      }
      delete session.conversationRewind
      if (p.outcome !== 'rewound') break
      const selected = turn(session, pending.turnId)
      if (!selected) break
      session.rewoundPrompt = { operation: p.operation, text: selected.prompt, attachments: selected.attachments ?? [] }
      session.turns = session.turns.filter(point => point.id < selected.id)
      session.checkpoints = session.checkpoints.filter(point => point.turnId < selected.id)
      const retained = session.turns.find(point => point.providerTurnId === pending.point.retainedTurnId && point.providerTurnId !== undefined)
      if (session.providerConversations) {
        for (const [key, conversation] of Object.entries(session.providerConversations)) {
          if (conversation.throughTurnId >= selected.id) delete session.providerConversations[key]
        }
      }
      if (session.driverKind === 'claude' && !pending.point.retainedTurnId) {
        session.providerSessionId = ''
        forgetProviderConversation(session)
      }
      else {
        session.providerConversations ??= {}
        session.providerConversations[providerConversationKey(session)] = {
          providerSessionId: pending.point.providerSessionId, throughTurnId: retained?.id ?? 0,
          ...(session.driverKind === 'claude' && { resumeSessionAt: pending.point.retainedTurnId }),
        }
      }
      session.state = 'idle'
      delete session.lastError
      clearTurnRequests(session)
      break
    }

    case 'turn.started': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      if (p.freshContext) {
        session.providerSessionId = ''
        delete session.providerConversations
        delete session.handoff
      }
      session.state = 'running'
      delete session.lastError
      if (p.codexSelection) {
        const { model, ...options } = p.codexSelection
        session.model = model
        session.codexTurnOptions = options
      }
      if (session.navigation?.settledAt || session.navigation?.snoozedUntil) {
        session.navigation.settledAt = null
        session.navigation.snoozedUntil = null
        delete session.navigation.settledAutomatically
      }
      if (!p.automaticCompaction) delete session.keepActiveUntilTurn
      session.settledSeq = undefined
      clearTurnRequests(session)
      session.lastTurnId = Math.max(session.lastTurnId ?? 0, p.turnId)
      session.turns.push({
        id: p.turnId,
        role: p.role,
        status: 'running',
        prompt: p.text ?? '',
        ...(p.attachments?.length ? { attachments: p.attachments } : {}),
        ...(p.compaction ? { compaction: true } : {}),
        ...(p.automaticCompaction ? { automaticCompaction: true } : {}),
        ...(p.freshContext ? { freshContext: true } : {}),
        ...(p.codexSelection ? { codexSelection: p.codexSelection } : {}),
        ...(p.modelChanged ? { modelChanged: true } : {}),
        ...(p.switchedProvider ? { switchedProvider: p.switchedProvider } : {}),
        response: '',
        toolCalls: [],
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      })
      break
    }

    case 'turn.steering-ready': {
      const session = state.sessions.get(event.sessionId)
      const active = session && turn(session, p.turnId)
      if (active) active.steerable = true
      break
    }

    case 'turn.steer.resolved': {
      const session = state.sessions.get(event.sessionId)
      const active = session && turn(session, p.turnId)
      if (active && p.outcome === 'delivered') (active.steered ??= []).push({ id: p.id, text: p.text })
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

    case 'session.pull-request-linked': {
      const session = state.sessions.get(event.sessionId)
      if (session) (session.linkedPullRequests ??= []).push(p.pullRequest)
      break
    }

    case 'session.worktree-reserved': {
      const session = state.sessions.get(event.sessionId)
      if (session) session.worktreeIntent = p.intent
      break
    }

    case 'session.isolated': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      session.worktreePath = p.worktreePath
      session.branch = p.branch
      if (session.pullRequest && !session.turns.length && session.state === 'failed') {
        session.state = 'idle'
        delete session.lastError
      }
      if (p.combined) session.combinedWorktree = p.combined
      delete session.worktreeIntent
      break
    }

    case 'checkpoint.captured': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      // Ignore a duplicate id rather than listing the same snapshot twice.
      if (session.checkpoints.some(c => c.id === p.checkpointId)) break
      session.checkpoints.push({
        id: p.checkpointId,
        turnId: p.turnId,
        kind: p.kind,
        vcsRef: p.vcsRef,
        ...(p.tree && { tree: p.tree }),
        ...(p.repositories && { repositories: p.repositories }),
        reverted: false,
      })
      break
    }

    case 'checkpoint.reverted': {
      const session = state.sessions.get(event.sessionId)
      const checkpoint = session?.checkpoints.find(c => c.id === p.checkpointId)
      if (session && checkpoint && p.coordinated) {
        session.pendingRewind = { checkpointId: p.checkpointId, operation: event.commandId }
        delete session.rewindNotice
      }
      else if (checkpoint) checkpoint.reverted = true
      break
    }

    case 'checkpoint.restored':
    case 'checkpoint.restore-failed': {
      const session = state.sessions.get(event.sessionId)
      if (session?.pendingRewind?.checkpointId !== p.checkpointId) break
      delete session.pendingRewind
      const checkpoint = session.checkpoints.find(point => point.id === p.checkpointId)
      if (p.type === 'checkpoint.restore-failed') session.rewindNotice = p.message
      else {
        if (checkpoint) checkpoint.reverted = true
        if (p.skipped?.length) session.rewindNotice = `Rewind finished. No earlier checkpoint for ${p.skipped.join(', ')}.`
      }
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
      // A finished turn cannot still be blocked on a decision.
      clearTurnRequests(session)
      const t = turn(session, p.turnId)
      if (t) {
        t.status = 'complete'
        if (p.contextCompacted) t.contextCompacted = true
        if (session.providerSessionId) {
          if ((session.driverKind === 'codex' || (session.driverKind === 'claude' && p.providerTurnId)) && isForkableResponse(t)) {
            t.nativeFork = {
              driverKind: session.driverKind,
              providerSessionId: session.providerSessionId,
              ...(session.providerInstanceId === undefined ? {} : { providerInstanceId: session.providerInstanceId }),
            }
          }
          session.providerConversations ??= {}
          session.providerConversations[providerConversationKey(session)] = {
            providerSessionId: session.providerSessionId,
            throughTurnId: t.id,
            ...(p.contextUsage ? {
              context: { usage: p.contextUsage, reportedAt: event.at, model: session.model, serviceTier: session.codexTurnOptions?.serviceTier },
            } : {}),
          }
        }
        if (session.handoff && p.turnId > session.handoff.afterTurnId) session.handoff.pending = false
        if (p.providerTurnId) t.providerTurnId = p.providerTurnId
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
      if (t) {
        t.status = 'interrupted'
        if (session.providerSessionId) forgetUnconfirmedProviderTurn(session)
      }
      session.state = 'idle'
      // Nothing is waiting on a decision once the turn is gone.
      clearTurnRequests(session)
      break
    }

    case 'turn.failed': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      const t = turn(session, p.turnId)
      if (t) {
        t.status = 'failed'
        if (session.providerSessionId) forgetUnconfirmedProviderTurn(session)
      }
      session.state = 'idle'
      if (session.navigation?.snoozedUntil) session.navigation.snoozedUntil = null
      clearTurnRequests(session)
      break
    }

    case 'approval.requested': {
      const session = state.sessions.get(event.sessionId)
      if (!session) break
      if (session.navigation?.snoozedUntil) session.navigation.snoozedUntil = null
      session.state = 'awaiting-approval'
      session.pendingApprovals.push({ approvalId: p.approvalId, toolName: p.toolName, ...(p.connector ? { connector: p.connector } : {}) })
      break
    }

    case 'approval.resolved': {
      const session = state.sessions.get(event.sessionId)
      if (!session || session.state !== 'awaiting-approval') break
      const index = session.pendingApprovals.findIndex(request => request.approvalId === p.approvalId)
      if (index === -1) break
      session.pendingApprovals.splice(index, 1)
      syncTurnWaitingState(session)
      break
    }

    case 'input.requested': {
      const session = state.sessions.get(event.sessionId)
      const activeTurn = session && turn(session, p.turnId)
      if (!session || activeTurn?.status !== 'running' || !isTurnActive(session.state)) break
      const request: InputRequestState = {
        requestId: p.requestId,
        turnId: p.turnId,
        questions: p.questions,
        outcome: 'pending',
      }
      activeTurn.inputRequests ??= []
      activeTurn.inputRequests.push(request)
      if (session.navigation?.snoozedUntil) session.navigation.snoozedUntil = null
      session.pendingInputs.push(request)
      syncTurnWaitingState(session)
      break
    }

    case 'input.resolved': {
      const session = state.sessions.get(event.sessionId)
      if (!session || !isTurnActive(session.state)) break
      const index = session.pendingInputs.findIndex(request => request.requestId === p.requestId && request.turnId === p.turnId)
      if (index === -1) break
      if (p.outcome === 'answered' && session.navigation?.snoozedUntil) session.navigation.snoozedUntil = null
      session.pendingInputs[index]!.outcome = p.outcome
      if (p.attachments?.length) session.pendingInputs[index]!.attachments = p.attachments
      session.pendingInputs.splice(index, 1)
      syncTurnWaitingState(session)
      break
    }

    default:
      break
  }

  const session = state.sessions.get(event.sessionId)
  if (session) {
    session.lastSeq = Math.max(session.lastSeq, event.seq)
    session.followUps = applyFollowUpEvent(session.followUps, p)
    if (observedAt != null && observedAt > 0 && Number.isFinite(observedAt) && recordsThreadActivity(p)) {
      const endedTurn = 'turnId' in p && turn(session, p.turnId)
      const woke = p.type === 'session.navigation-changed' ? beforeNavigation?.snoozedUntil : undefined
      if ((p.type !== 'session.navigation-changed' || woke != null) && (!endedTurn || !endedTurn.automaticCompaction)) {
        const activityAt = woke != null ? Math.min(observedAt, woke) : observedAt
        session.lastActivityAt = Math.max(session.lastActivityAt ?? activityAt, activityAt)
      }
    }
  }

  return state
}

/** Fold a whole log. This is what "replay" means. */
export function replay(events: Iterable<HarnessEvent>, into: HarnessState = emptyState()): HarnessState {
  let state = into
  for (const event of events) state = apply(state, event)
  return state
}
