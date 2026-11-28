import type { WorkspaceState } from '@harness/engine'
import { isWorkspaceGitRoot } from './diff'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { repositoryFromRemote } from './prompt-links'
import { repositoryGit } from './repository-commit'

export type GitHubWorkspaceRepository = { name: string, path: string, workspace: WorkspaceState }

async function repositoryRemotes(path: string) {
  const result = await repositoryGit(path, ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']).catch(() => null)
  return (result?.stdout ?? '').split('\0').flatMap((entry) => {
    const split = entry.indexOf('\n')
    return split >= 0 ? [entry.slice(split + 1)] : []
  })
}

interface GitHubProjectRepositories {
  workspace: WorkspaceState
  repositories: Map<string, GitHubWorkspaceRepository>
}

export async function trustedProjectGitRemotes(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  const projects: { workspace: WorkspaceState, remotes: { path: string, url: string }[] }[] = []
  for (const workspace of workspaces) {
    if (workspace.profileId !== profile || !workspace.trusted || workspace.scratch) continue
    signal.throwIfAborted()
    const roots = await scanProjectRepositories(workspace.path)
    const paths = await Promise.all(roots.map(root => resolveProjectRepository(workspace.path, root.key)))
    if (await isWorkspaceGitRoot(workspace.path)) paths.unshift(workspace.path)
    const remotes = []
    for (const path of paths) {
      if (!path) continue
      signal.throwIfAborted()
      for (const url of await repositoryRemotes(path)) remotes.push({ path, url })
    }
    projects.push({ workspace, remotes })
  }
  return projects
}

export async function trustedGitHubProjectRepositories(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  const projects: GitHubProjectRepositories[] = []
  for (const { workspace, remotes } of await trustedProjectGitRemotes(workspaces, profile, signal)) {
    const repositories = new Map<string, GitHubWorkspaceRepository>()
    for (const { path, url } of remotes) {
      const name = repositoryFromRemote(url)
      const key = name?.toLowerCase()
      if (key && name && !repositories.has(key)) repositories.set(key, { name, path, workspace })
    }
    projects.push({ workspace, repositories })
  }
  return projects
}

export function mergeGitHubProjectRepositories(projects: Iterable<GitHubProjectRepositories>) {
  const repositories = new Map<string, GitHubWorkspaceRepository>()
  for (const project of projects) {
    for (const [key, repository] of project.repositories) {
      if (!repositories.has(key)) repositories.set(key, repository)
    }
  }
  return repositories
}

export async function trustedGitHubRepositories(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  return mergeGitHubProjectRepositories(await trustedGitHubProjectRepositories(workspaces, profile, signal))
}
