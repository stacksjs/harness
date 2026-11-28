import type { WorkspaceState } from '@harness/engine'
import { isWorkspaceGitRoot } from './diff'
import { resolveProjectRepository, scanProjectRepositories } from './project-repositories'
import { repositoryFromRemote } from './prompt-links'
import { repositoryGit } from './repository-commit'

export type GitHubWorkspaceRepository = { name: string, path: string, workspace: WorkspaceState }

async function repositoryNames(path: string) {
  const result = await repositoryGit(path, ['config', '--local', '--null', '--get-regexp', '^remote\\..*\\.(url|pushurl)$']).catch(() => null)
  return (result?.stdout ?? '').split('\0').flatMap((entry) => {
    const split = entry.indexOf('\n')
    const name = split >= 0 ? repositoryFromRemote(entry.slice(split + 1)) : null
    return name ? [name] : []
  })
}

export async function trustedGitHubRepositories(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  const found = new Map<string, GitHubWorkspaceRepository>()
  for (const workspace of workspaces) {
    if (workspace.profileId !== profile || !workspace.trusted || workspace.scratch) continue
    signal.throwIfAborted()
    const roots = await scanProjectRepositories(workspace.path)
    const paths = await Promise.all(roots.map(root => resolveProjectRepository(workspace.path, root.key)))
    if (await isWorkspaceGitRoot(workspace.path)) paths.unshift(workspace.path)
    for (const path of paths) {
      if (!path) continue
      signal.throwIfAborted()
      for (const name of await repositoryNames(path)) if (!found.has(name.toLowerCase())) found.set(name.toLowerCase(), { name, path, workspace })
    }
  }
  return found
}
