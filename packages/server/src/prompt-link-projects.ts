import type { HarnessState, WorkspaceState } from '@harness/engine'
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { isWorkspaceGitRoot } from './diff'
import { issueReference, issueRepositoryKey } from '@harness/contract'
import { trustedGitHubRepositories } from './github-workspace-repositories'
import { trustedIssueRepositories } from './issue-repositories'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { linkedRepository, repositoryFromRemote } from './prompt-links'

const exec = promisify(execFile)

async function remoteOf(path: string, name = 'origin'): Promise<{ url: string, repository: string } | null> {
  try {
    const { stdout } = await exec('git', ['-C', path, 'config', '--local', '--get', 'remote.' + name + '.url'], {
      timeout: 1000, maxBuffer: 4096,
    })
    const url = stdout.trim()
    const repository = repositoryFromRemote(url)
    return repository ? { url, repository } : null
  }
  catch { return null }
}

async function matchingRemote(path: string, named: string, names: string[]) {
  for (const name of names) {
    const remote = await remoteOf(path, name)
    if (remote?.repository.toLowerCase() === named) return remote
  }
  return null
}

export function linkedProject(workspace: WorkspaceState) {
  return { id: workspace.id, profile: workspace.profileId, name: basename(workspace.path) }
}

export async function findPromptLinkProject(state: HarnessState, repository: string, options?: { pullRequest?: boolean, workspaceId?: number, profileId?: number }) {
  const named = repository.toLowerCase()
  const recent = new Map<number, number>()
  for (const session of state.sessions.values()) {
    const activity = options?.pullRequest ? session.lastActivityAt ?? 0 : session.lastSeq
    recent.set(session.workspaceId, Math.max(recent.get(session.workspaceId) ?? 0, activity))
  }
  const workspaces = [...state.workspaces.values()].filter(workspace => workspace.trusted && !workspace.scratch
    && (options?.workspaceId === undefined || workspace.id === options.workspaceId)
    && (options?.profileId === undefined || workspace.profileId === options.profileId))
    .sort((left, right) => (recent.get(right.id) ?? 0) - (recent.get(left.id) ?? 0))
  const names = options?.pullRequest ? ['origin', 'upstream'] : ['origin']
  for (const workspace of workspaces) {
    const root = workspace.path
    const remote = !options?.pullRequest || await isWorkspaceGitRoot(root) ? await matchingRemote(root, named, names) : null
    if (remote) return { workspace, path: root, repositoryKey: '', remote: remote.url }
    for (const repository of await scanProjectRepositories(root)) {
      const path = await resolveProjectRepository(root, repository.key)
      const remote = path && await matchingRemote(path, named, names)
      if (remote) return { workspace, path, repositoryKey: repository.key, remote: remote.url }
    }
  }
  return null
}

export async function promptLinkProjects(state: HarnessState, params: URLSearchParams, signal: AbortSignal): Promise<Response> {
  const options = { headers: { 'cache-control': 'no-store' } }
  if (params.has('workspace')) {
    const workspace = state.workspaces.get(Number(params.get('workspace')))
    const remote = workspace?.trusted && !workspace.scratch ? await remoteOf(workspace.path) : null
    return Response.json({ repository: remote?.repository ?? null }, options)
  }
  const key = params.get('repo') ?? ''
  const gitlab = /^gitlab:([^/]+)\/(.+)$/iu.exec(key)
  const issue = gitlab ? issueReference({ tracker: 'gitlab', host: gitlab[1], repository: gitlab[2], number: 1 }) : null
  const named = issue ? issueRepositoryKey(issue) : linkedRepository(key)?.toLowerCase()
  if (!named || (issue && !params.has('profile'))) return Response.json({ error: 'Invalid linked repository.' }, { ...options, status: 400 })
  if (params.has('profile')) {
    const profile = Number(params.get('profile'))
    const projects = issue ? await trustedIssueRepositories(state.workspaces.values(), profile, signal)
      : await trustedGitHubRepositories(state.workspaces.values(), profile, signal)
    const match = projects.get(named)
    return Response.json({ project: match ? linkedProject(match.workspace) : null }, options)
  }
  const match = await findPromptLinkProject(state, named)
  return Response.json({ project: match ? linkedProject(match.workspace) : null }, options)
}
