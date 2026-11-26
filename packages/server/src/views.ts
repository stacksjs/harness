/**
 * Server-rendered views.
 *
 * The projection is already in memory — hydrated from the log before the socket
 * opens — so rendering a page is a fold over `engine.current`, not a database
 * round trip. That is what makes the session list paint before anything async
 * has run.
 */

import type { ClaudeAccountCompaction, HostSettings, ThreadNavigation } from '@harness/contract'
import { codexSelectionLabel } from '@harness/contract'
import type { HarnessState, SessionState } from '@harness/engine'
import { checkpointReviewRepositories, claudeIdleCompaction, conversationRewindPoint, isForkableResponse, isolatedRewindScope, providerConversation } from '@harness/engine'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ariaKeyshortcuts, formatChord, keybindingCommands, parseChord } from './keybindings'
import { settingsSections } from './settings-location'
import type { SettingsSection } from './settings-location'
import { threadTitle } from './thread-search'
import { threadSidebarLayout } from './thread-sidebar'
import { escapeTranscriptText } from './transcript-markdown'

interface ProjectSummary {
  id: number
  name: string
  trusted: boolean
}

export interface ViewProps {
  profiles: Array<{
    id: number
    name: string
    icon?: string
    tint?: string
    workspaces: ProjectSummary[]
    sessions: Array<{ id: number, workspaceId: number, title: string, state: string, navigation?: ThreadNavigation }>
    sidebar: ReturnType<typeof threadSidebarLayout>
  }>
  activeProfile: string
  providerProfileId: number | null
  claudeCompactionByAccount: Record<number, ClaudeAccountCompaction>
  draftWorkspace: ProjectSummary | null
  draftWithoutProject: boolean
  activeSession: {
    turns: ReadonlyArray<{ id: number, response: string, status: string }>
    [key: string]: unknown
  } | null
  /**
   * Paired devices, for the settings sheet's Access section. The token hash
   * stays server-side — the page needs to name a device, never to match one.
   */
  devices: Array<{ id: string, name: string, pairedAt: number }>
  /** Whether this server accepts paired devices, which gates the pairing UI. */
  remoteEnabled: boolean
  canLaunchWorkspaceEditor: boolean
  settingsSection: SettingsSection | null
  settingsSections: typeof settingsSections
  /**
   * Host settings, rendered rather than read from the browser store: they
   * belong to this host, so the page must not paint one client's idea of them
   * and then correct itself.
   */
  hostSettings: HostSettings
  /**
   * The keyboard registry, rendered into the Keyboard section.
   *
   * Both platform spellings travel with each row because the server cannot
   * know which keyboard is at the other end, and a row that waited for the
   * island to format it would paint as raw `Mod+K`.
   */
  keybindings: Array<{
    id: string
    label: string
    description: string
    chord: string
    scope?: 'terminal' | 'global'
    apple: string
    other: string
    /** `aria-keyshortcuts` value, for the controls that advertise a chord. */
    aria: string
  }>
  serverUrl: string
  /** URL of the browser CBOR bundle, or '' when it could not be built. */
  codecUrl: string
  /**
   * The last sequence this render already contains.
   *
   * The socket resumes from here, so a page load replays only the gap. Without
   * it the client subscribes from 0 and the server replays the whole session on
   * top of a transcript the server already rendered — every delta appended
   * twice.
   */
  sinceSeq: number
}

/**
 * Shape the read model for the view.
 *
 * Sessions are grouped under the profile that owns their workspace, because
 * that is the unit the sidebar swipes between — a session list that ignored
 * profiles would show every project at once.
 */
export function viewProps(state: HarnessState, options: {
  sessionId?: number
  /**
   * Profile to open the sidebar on.
   *
   * Addressable because spaces beyond the active one's neighbours render
   * without their rows: swiping to a distant space navigates here so the
   * server can render it in full, rather than the client rebuilding rows the
   * server already knows how to render.
   */
  profileId?: number
  workspaceId?: number
  withoutProject?: boolean
  serverUrl: string
  codecUrl?: string
  remoteEnabled?: boolean
  canLaunchWorkspaceEditor?: boolean
  settingsSection?: SettingsSection
}): ViewProps {
  const profiles = [...state.profiles.values()].map((profile) => {
    const workspaces = profile.workspaceIds
      .map(id => state.workspaces.get(id))
      .filter((w): w is NonNullable<typeof w> => Boolean(w))

    const workspaceIds = new Set(workspaces.map(w => w.id))
    const profileSessions = [...state.sessions.values()].filter(session => workspaceIds.has(session.workspaceId))
    const sessions = profileSessions
      .map(session => ({
        id: session.id,
        workspaceId: session.workspaceId,
        // A session with no title yet is named by its first prompt — the same
        // thing a person would call it. Before that it is simply new: the
        // derived id is a hash, and a hash is not a name.
        title: threadTitle(session),
        state: session.state,
        ...(session.navigation && { navigation: session.navigation }),
      }))

    return {
      id: profile.id,
      name: profile.name,
      // Declared on this type since M1 and never populated, because the
      // projection did not carry them — so every Arc space rendered blue.
      icon: profile.icon || undefined,
      tint: profile.tint || undefined,
      workspaces: workspaces.filter(w => !w.scratch).map(w => ({
        id: w.id,
        // The last path segment reads better in the sidebar than the absolute path.
        name: basename(w.path) || w.path,
        trusted: w.trusted,
      })),
      sessions,
      sidebar: threadSidebarLayout(profile.id, workspaces, profileSessions),
    }
  })

  const active = options.sessionId ? state.sessions.get(options.sessionId) : undefined
  const checkpointStarts = new Map<number, SessionState['checkpoints'][number]>()
  const checkpointEnds = new Map<number, SessionState['checkpoints'][number]>()
  for (const point of active?.checkpoints ?? []) {
    if (point.kind === 'turn-start' && !checkpointStarts.has(point.turnId)) checkpointStarts.set(point.turnId, point)
    if (point.kind === 'turn-end') checkpointEnds.set(point.turnId, point)
  }
  const activeWorkspaceTrusted = active && state.workspaces.get(active.workspaceId)?.trusted
  const requestedWorkspace = !active && options.workspaceId ? state.workspaces.get(options.workspaceId) : undefined
  const selectedProfile = profiles.find(p => p.id === (requestedWorkspace?.profileId ?? options.profileId))
    ?? profiles.find(p => active && p.sessions.some(session => session.id === active.id))
    ?? profiles[0]
  const draftWithoutProject = !active && options.withoutProject === true
  const draftWorkspace = draftWithoutProject ? null : selectedProfile?.workspaces.find(w => w.id === requestedWorkspace?.id)
    ?? selectedProfile?.workspaces.find(w => w.id === active?.workspaceId)
    ?? selectedProfile?.workspaces.find(w => w.trusted)
    ?? selectedProfile?.workspaces[0]
    ?? null

  const providerProfileId = (active ? state.workspaces.get(active.workspaceId)?.profileId : undefined) ?? selectedProfile?.id ?? null
  return {
    profiles,
    providerProfileId,
    claudeCompactionByAccount: providerProfileId === null ? {} : state.profiles.get(providerProfileId)?.claudeCompactionByAccount ?? {},
    devices: [...state.devices.values()].map(device => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
    })),
    remoteEnabled: options.remoteEnabled === true,
    canLaunchWorkspaceEditor: options.canLaunchWorkspaceEditor === true,
    settingsSection: options.settingsSection ?? null,
    settingsSections,
    hostSettings: { ...state.settings },
    keybindings: keybindingCommands.map((command) => {
      const chord = parseChord(command.chord)
      const appleChord = parseChord(command.appleChord ?? command.chord)
      return {
        id: command.id,
        label: command.label,
        description: command.description,
        chord: command.chord,
        scope: command.scope,
        apple: appleChord ? formatChord(appleChord, true) : command.chord,
        other: chord ? formatChord(chord, false) : command.chord,
        aria: chord ? ariaKeyshortcuts(chord) : '',
      }
    }),
    activeProfile: String(selectedProfile?.id ?? ''),
    draftWorkspace,
    draftWithoutProject,
    activeSession: active
      ? {
          id: active.id,
          title: threadTitle(active),
          navigation: active.navigation,
          fork: active.fork ? {
            sourceSessionId: active.fork.sessionId,
            sourceTurnId: active.fork.turnId,
            state: active.fork.state,
            error: active.fork.error,
          } : undefined,
          state: active.state,
          lastError: active.state === 'failed' ? active.lastError : undefined,
          pendingRewind: active.pendingRewind?.checkpointId ?? 0,
          rewindNotice: active.rewindNotice ?? '',
          conversationRewind: active.conversationRewind ? {
            status: active.conversationRewind.status,
            turnId: active.conversationRewind.turnId,
          } : undefined,
          conversationRewindNotice: active.conversationRewindNotice ?? '',
          isolatedRewindScope: isolatedRewindScope(state, active) ?? '',
          rewoundPrompt: active.rewoundPrompt ? {
            operation: active.rewoundPrompt.operation,
            text: active.rewoundPrompt.text,
            attachments: active.rewoundPrompt.attachments.length,
          } : undefined,
          worktreeSetup: Boolean(active.worktreeIntent && 'checkouts' in active.worktreeIntent && active.worktreeIntent.layout),
          // Which agent this session runs — shown in the header and preselected
          // in the composer's picker, so switching has a visible ground truth.
          driverKind: active.driverKind,
          model: active.model,
          codexTurnOptions: active.codexTurnOptions,
          providerInstanceId: active.providerInstanceId,
          contextUsage: activeContextUsage(active),
          idleCompaction: claudeIdleCompaction(active, Date.now()),
          lastSeq: active.lastSeq,
          // For the terminal: a shell opens in the session's workspace, and
          // the island should not have to reverse-engineer it from the DOM.
          workspaceId: active.workspaceId,
          scratch: state.workspaces.get(active.workspaceId)?.scratch === true,
          // Rendered server-side so a decision survives the client that raised
          // it. Previously an approval only reached whichever browser happened
          // to be connected when it fired, and the turn waited forever if that
          // one went away.
          followUps: active.followUps,
          pendingApprovals: active.pendingApprovals,
          pendingInputs: active.pendingInputs,
          // Shown in the header when the session has a checkout of its own, so
          // it is obvious the agent is not editing the workspace directly.
          branch: active.branch,
          turns: active.turns.map((turn, index) => ({
            id: turn.id,
            prompt: turn.prompt,
            attachments: (turn.attachments ?? []).map(({ id, name, image }) => ({ id, image, nameHtml: escapeTranscriptText(name) })),
            response: turn.response,
            status: turn.status,
            ...(turn.contextCompacted ? { contextCompacted: true } : {}),
            ...(turn.automaticCompaction ? { automaticCompaction: true } : {}),
            ...(turn.freshContext ? { freshContext: true } : {}),
            forkable: isForkableResponse(turn),
            canRewindConversation: Boolean(activeWorkspaceTrusted && conversationRewindPoint(active, index)),
            switchedProvider: turn.switchedProvider,
            modelChange: turn.modelChanged && turn.codexSelection ? codexSelectionLabel(turn.codexSelection) : undefined,
            steerable: turn.steerable === true,
            steered: turn.steered ?? [],
            inputRequests: (turn.inputRequests ?? []).map(request => ({
              requestId: request.requestId,
              outcome: request.outcome,
              attachments: (request.attachments ?? []).map(file => ({ ...file, nameHtml: escapeTranscriptText(file.name) })),
            })),
            // What the agent actually did. A reply without these is a summary
            // of work you cannot review.
            // The snapshot taken before this turn ran, which is what "undo
            // this turn" reverts to. 0 when there is none — a workspace that
            // is not a repository, or a turn from before checkpointing.
            checkpointId: activeWorkspaceTrusted ? checkpointStarts.get(turn.id)?.id ?? 0 : 0,
            checkpointResetsStaging: Boolean(checkpointStarts.get(turn.id)?.repositories),
            reviewRepositories: activeWorkspaceTrusted && turn.status === 'complete'
              ? checkpointReviewRepositories(checkpointStarts.get(turn.id), checkpointEnds.get(turn.id)) : [],
            toolCalls: turn.toolCalls.map(call => ({
              callId: call.callId,
              name: call.name,
              // Three states, not two: running, succeeded, failed.
              state: call.ok === null ? 'running' : call.ok ? 'ok' : 'failed',
            })),
          })),
        }
      : null,
    serverUrl: options.serverUrl,
    codecUrl: options.codecUrl ?? '',
    sinceSeq: active?.lastSeq ?? 0,
  }
}

function activeContextUsage(session: SessionState) {
  const conversation = providerConversation(session)
  const context = conversation?.context
  if (conversation?.providerSessionId !== session.providerSessionId || context?.model !== session.model
    || context?.serviceTier !== session.codexTurnOptions?.serviceTier) return undefined
  return context?.usage
}

let viewPath: string | null | undefined

/** Resolve the template once; a missing one is a 404, not a crash. */
function resolveView(): string | null {
  if (viewPath !== undefined) return viewPath
  const candidate = join(process.cwd(), 'resources/views/harness.stx')
  viewPath = existsSync(candidate) ? candidate : null
  return viewPath
}

export async function renderHarnessView(props: ViewProps): Promise<string | null> {
  const path = resolveView()
  if (!path) return null
  // Socket-only hosts never need the renderer. Web requests load its STX
  // subpath directly so rendering does not also load the other SDK features.
  const { renderView } = await import('@stacksjs/stx/build-views')
  // The app's stx config, loaded explicitly: `renderView` builds its options
  // from `defaultConfig` alone and never reads `config/ui.ts`, so without
  // this spread the config was decorative — `autoShell`, `app.head` and
  // `stateDir` all unreachable, and the page shipped as a bare fragment with
  // no doctype, no title and no charset (stx-standards §2, §4).
  const uiPath = join(process.cwd(), 'config/ui.ts')
  const ui = existsSync(uiPath) ? (await import(uiPath)).default : {}
  // `renderView` resolves components by filename, and searches only the app's
  // own directories plus stx's built-ins — so `<Sidebar>` renders as a
  // "component not found" block unless it is pointed at the library.
  //
  // It must point at `src/`, not `dist/`: the published dist ships hashed
  // filenames (`Sidebar-56px4jha.stx`) that plain-name lookup cannot find,
  // while `src/ui/<name>/<Name>.stx` keeps the tag name. That is also what the
  // package's own stx plugin registers, so this matches how a configured stx
  // build resolves them.
  const html = await renderView(path, props as unknown as Record<string, unknown>, {
    ...ui,
    buildMode: 'serve',
    componentsDir: join(process.cwd(), 'node_modules/@stacksjs/components/src/ui'),
  })
  const responses = props.activeSession?.turns.filter(turn => turn.response)
  if (!responses?.length) return html

  // Inject generated Markdown after stx has processed the template, so its
  // content cannot become a template directive or interpolation.
  const { renderTranscriptMarkdown } = await import('./transcript-markdown')
  const byTurn = new Map(responses.map(turn => [String(turn.id), turn]))
  return new HTMLRewriter().on('[data-ssr-response]', {
    element(element) {
      const turn = byTurn.get(element.getAttribute('data-ssr-response') ?? '')
      if (!turn) return
      if (turn.status === 'running' && element.hasAttribute('data-live-response')) {
        // HTMLRewriter escapes the attribute's quotes. Encode existing
        // ampersands so the browser preserves the original Markdown source.
        element.setAttribute('data-response-source', JSON.stringify(turn.response).replaceAll('&', '&amp;').replaceAll('<', '&lt;'))
      }
      element.setInnerContent(renderTranscriptMarkdown(turn.response), { html: true })
    },
  }).transform(html)
}
