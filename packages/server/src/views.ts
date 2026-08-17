/**
 * Server-rendered views.
 *
 * The projection is already in memory — hydrated from the log before the socket
 * opens — so rendering a page is a fold over `engine.current`, not a database
 * round trip. That is what makes the session list paint before anything async
 * has run.
 */

import type { HarnessState } from '@harness/engine'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ViewProps {
  profiles: Array<{
    id: number
    name: string
    icon?: string
    tint?: string
    workspaces: Array<{ id: number, name: string }>
    sessions: Array<{ id: number, title: string, state: string }>
  }>
  activeProfile: string
  activeSession: unknown
  /**
   * Paired devices, for the settings sheet's Access section. The token hash
   * stays server-side — the page needs to name a device, never to match one.
   */
  devices: Array<{ id: string, name: string, pairedAt: number }>
  /** Whether this server accepts paired devices, which gates the pairing UI. */
  remoteEnabled: boolean
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
  serverUrl: string
  codecUrl?: string
  remoteEnabled?: boolean
}): ViewProps {
  const profiles = [...state.profiles.values()].map((profile) => {
    const workspaces = profile.workspaceIds
      .map(id => state.workspaces.get(id))
      .filter((w): w is NonNullable<typeof w> => Boolean(w))

    const workspaceIds = new Set(workspaces.map(w => w.id))
    const sessions = [...state.sessions.values()]
      .filter(session => workspaceIds.has(session.workspaceId))
      .map(session => ({
        id: session.id,
        // A session with no title yet is named by its first prompt — the same
        // thing a person would call it.
        title: session.turns[0]?.prompt?.slice(0, 60) ?? `Session ${session.id}`,
        state: session.state,
      }))

    return {
      id: profile.id,
      name: profile.name,
      // Declared on this type since M1 and never populated, because the
      // projection did not carry them — so every Arc space rendered blue.
      icon: profile.icon || undefined,
      tint: profile.tint || undefined,
      workspaces: workspaces.map(w => ({
        id: w.id,
        // The last path segment reads better in a tile than the absolute path.
        name: w.path.split('/').filter(Boolean).pop() ?? w.path,
      })),
      sessions,
    }
  })

  const active = options.sessionId ? state.sessions.get(options.sessionId) : undefined

  return {
    profiles,
    devices: [...state.devices.values()].map(device => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
    })),
    remoteEnabled: options.remoteEnabled === true,
    activeProfile: String(
      // The requested profile, the one owning the open session, then the first.
      profiles.find(p => p.id === options.profileId)?.id
      ?? (active ? profiles.find(p => p.sessions.some(session => session.id === active.id))?.id : undefined)
      ?? profiles[0]?.id
      ?? '',
    ),
    activeSession: active
      ? {
          id: active.id,
          title: active.turns[0]?.prompt?.slice(0, 60) ?? `Session ${active.id}`,
          state: active.state,
          // Which agent this session runs — shown in the header and preselected
          // in the composer's picker, so switching has a visible ground truth.
          driverKind: active.driverKind,
          lastSeq: active.lastSeq,
          // For the terminal: a shell opens in the session's workspace, and
          // the island should not have to reverse-engineer it from the DOM.
          workspaceId: active.workspaceId,
          // Rendered server-side so a decision survives the client that raised
          // it. Previously an approval only reached whichever browser happened
          // to be connected when it fired, and the turn waited forever if that
          // one went away.
          pendingApproval: active.pendingApproval,
          // Shown in the header when the session has a checkout of its own, so
          // it is obvious the agent is not editing the workspace directly.
          branch: active.branch,
          turns: active.turns.map(turn => ({
            id: turn.id,
            prompt: turn.prompt,
            response: turn.response,
            status: turn.status,
            // What the agent actually did. A reply without these is a summary
            // of work you cannot review.
            // The snapshot taken before this turn ran, which is what "undo
            // this turn" reverts to. 0 when there is none — a workspace that
            // is not a repository, or a turn from before checkpointing.
            checkpointId: active.checkpoints.find(c => c.turnId === turn.id && c.kind === 'turn-start')?.id ?? 0,
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
  // Imported lazily, not at module load. `@stacksjs/stx` pulls in the whole
  // template and CSS toolchain; loading it eagerly made every socket test pay
  // for a renderer it never calls, to the point of being OOM-killed.
  const { renderView } = await import('@stacksjs/stx')
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
  return renderView(path, props as unknown as Record<string, unknown>, {
    ...ui,
    componentsDir: join(process.cwd(), 'node_modules/@stacksjs/components/src/ui'),
  })
}
