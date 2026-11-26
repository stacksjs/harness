import type { SessionState, WorkspaceState } from '@harness/engine'
import { pinOrder } from '@harness/contract'
import { activeThreadOrder, threadShelf } from '@harness/engine'

export function threadSidebarLayout(profileId: number, workspaces: WorkspaceState[], sessions: SessionState[]) {
  const activeSections = new Map(workspaces.filter(workspace => !workspace.scratch)
    .map(workspace => [workspace.id, `project-${workspace.id}`]))
  const projectless = `projectless-${profileId}`
  const shelves = { pinned: [], working: [], active: [], snoozed: [], settled: [], archived: [] } as Record<ReturnType<typeof threadShelf>, SessionState[]>
  for (const session of [...sessions].reverse()) shelves[threadShelf(session)].push(session)
  shelves.pinned.sort(pinOrder)
  shelves.active.sort(activeThreadOrder)
  shelves.snoozed.sort((a, b) => (a.navigation?.snoozedUntil ?? 0) - (b.navigation?.snoozedUntil ?? 0))
  shelves.settled.sort((a, b) => (b.navigation?.settledAt ?? 0) - (a.navigation?.settledAt ?? 0))

  const active = new Map<string, SessionState[]>([...activeSections.values(), projectless].map(section => [section, []]))
  for (const session of shelves.active) active.get(activeSections.get(session.workspaceId) ?? projectless)?.push(session)
  const items = (rows: SessionState[]) => rows.map(session => ({
    id: session.id,
    activeSection: activeSections.get(session.workspaceId) ?? projectless,
  }))
  return [
    { id: `pinned-${profileId}`, label: 'Pinned', rows: items(shelves.pinned) },
    { id: `working-${profileId}`, label: 'Working', rows: items(shelves.working) },
    ...[...activeSections].map(([workspaceId, id]) => ({ id, workspaceId, label: '', rows: items(active.get(id) ?? []) })),
    { id: projectless, label: 'Without a project', rows: items(active.get(projectless) ?? []) },
    { id: `snoozed-${profileId}`, label: 'Snoozed', rows: items(shelves.snoozed) },
    { id: `settled-${profileId}`, label: `Settled (${shelves.settled.length})`, rows: items(shelves.settled) },
  ]
}
