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
  serverUrl: string
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
  serverUrl: string
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
    activeProfile: profiles[0] ? String(profiles[0].id) : '',
    activeSession: active
      ? {
          id: active.id,
          title: active.turns[0]?.prompt?.slice(0, 60) ?? `Session ${active.id}`,
          state: active.state,
          turns: active.turns.map(turn => ({
            id: turn.id,
            prompt: turn.prompt,
            response: turn.response,
            status: turn.status,
          })),
        }
      : null,
    serverUrl: options.serverUrl,
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
    componentsDir: join(process.cwd(), 'node_modules/@stacksjs/components/src/ui'),
  })
}
