import type { SessionState, WorkspaceState } from '@harness/engine'
import { pinOrder } from '@harness/contract'
import { activeThreadOrder, isTurnActive, threadShelf } from '@harness/engine'
import { basename } from 'node:path'
import { threadTitle } from './thread-search'

export function threadSidebarLayout(profileId: number, workspaces: WorkspaceState[], sessions: SessionState[]) {
  const activeSections = new Map(workspaces.filter(workspace => !workspace.scratch)
    .map(workspace => [workspace.id, `project-${workspace.id}`]))
  const projectNames = new Map(workspaces.map(workspace => [workspace.id, basename(workspace.path) || workspace.path]))
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
    seq: session.lastSeq,
    activeSection: activeSections.get(session.workspaceId) ?? projectless,
    title: threadTitle(session),
    icon: session.state === 'awaiting-approval' || session.state === 'awaiting-input' ? 'i-hugeicons-help-circle'
      : session.state === 'running' ? 'i-hugeicons-loading-03' : 'i-hugeicons-message-01',
    canSettle: !isTurnActive(session.state),
    canActivate: session.state !== 'stopped' && session.state !== 'running',
    canPin: session.state !== 'stopped',
  }))
  return [
    { id: `pinned-${profileId}`, label: 'Pinned', rows: items(shelves.pinned) },
    { id: `working-${profileId}`, label: 'Working', rows: items(shelves.working) },
    ...[...activeSections].map(([workspaceId, id]) => ({ id, workspaceId, label: projectNames.get(workspaceId) ?? 'Project', rows: items(active.get(id) ?? []) })),
    { id: projectless, label: 'Without a project', rows: items(active.get(projectless) ?? []) },
    { id: `snoozed-${profileId}`, label: 'Snoozed', rows: items(shelves.snoozed) },
    { id: `settled-${profileId}`, label: `Settled (${shelves.settled.length})`, rows: items(shelves.settled) },
  ]
}
