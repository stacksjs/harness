import type { HarnessState, WorkspaceState } from '@harness/engine'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { linkedRepository, repositoryFromRemote } from './prompt-links'

const exec = promisify(execFile)

async function remoteOf(path: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'config', '--local', '--get', 'remote.origin.url'], {
      timeout: 1000, maxBuffer: 4096,
    })
    return repositoryFromRemote(stdout)
  }
  catch { return null }
}

async function projectRemote(workspace: WorkspaceState, named?: string): Promise<string | null> {
  if (!workspace.trusted || workspace.scratch) return null
  const rootRemote = await remoteOf(workspace.path)
  if (!named || rootRemote?.toLowerCase() === named) return rootRemote
  for (const repository of await scanProjectRepositories(workspace.path)) {
    const path = await resolveProjectRepository(workspace.path, repository.key)
    if (path && (await remoteOf(path))?.toLowerCase() === named) return named
  }
  return null
}

export async function promptLinkProjects(state: HarnessState, params: URLSearchParams): Promise<Response> {
  const options = { headers: { 'cache-control': 'no-store' } }
  if (params.has('workspace')) {
    const workspace = state.workspaces.get(Number(params.get('workspace')))
    return Response.json({ repository: workspace ? await projectRemote(workspace) : null }, options)
  }
  const named = linkedRepository(params.get('repo') ?? '')?.toLowerCase()
  if (!named) return Response.json({ error: 'Invalid GitHub repository.' }, { ...options, status: 400 })
  const recent = new Map<number, number>()
  for (const session of state.sessions.values()) {
    recent.set(session.workspaceId, Math.max(recent.get(session.workspaceId) ?? 0, session.lastSeq))
  }
  const workspaces = [...state.workspaces.values()].filter(workspace => workspace.trusted && !workspace.scratch)
    .sort((left, right) => (recent.get(right.id) ?? 0) - (recent.get(left.id) ?? 0))
  for (const workspace of workspaces) {
    if (await projectRemote(workspace, named)) {
      return Response.json({ project: { id: workspace.id, profile: workspace.profileId, name: basename(workspace.path) } }, options)
    }
  }
  return Response.json({ project: null }, options)
}
