import type { WorkspaceState } from '@harness/engine'
import { gitLabProject } from '@harness/contract'
import { trustedProjectGitRemotes } from './github-workspace-repositories'
import { repositoryFromRemote } from './prompt-links'

type Target = { key: string, name: string, path: string, workspace: WorkspaceState }
export type GitHubIssueRepository = Target & { tracker: 'github' }
export type GitLabIssueRepository = Target & { tracker: 'gitlab', host: string }
export type IssueRepository = GitHubIssueRepository | GitLabIssueRepository

type RemoteProject = { host: string, name: string }

function gitLabRemote(remote: string): RemoteProject | null {
  const scp = /^git@([^/:]+):(.+)$/u.exec(remote)
  const location = scp ? 'ssh://git@' + scp[1] + '/' + scp[2] : remote
  let url: URL
  try { url = new URL(location) }
  catch { return null }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || url.search || url.hash) return null
  const name = url.pathname.replace(/^\//u, '').replace(/\/$/u, '').replace(/\.git$/iu, '')
  const project = gitLabProject(url.host, name)
  return project ? { host: project.host, name } : null
}

export function defaultGitLabIssueHost() {
  const host = process.env.GITLAB_HOST || process.env.GITLAB_URI || process.env.GITLAB_URL || process.env.GL_HOST || 'gitlab.com'
  return gitLabProject(host.trim().replace(/^https?:\/\//iu, '').replace(/\/$/u, ''), 'sample/project')?.host
}

export function gitLabCli() {
  return Bun.which('glab', { PATH: process.env.PATH })
}

async function authenticatedGitLabHosts(signal: AbortSignal) {
  const glab = gitLabCli()
  if (!glab) return []
  try {
    const process = Bun.spawn([glab, 'auth', 'status'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', signal, timeout: 4_000 })
    const [output, diagnostics] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
    const hosts = new Set<string>()
    // glab groups authentication status beneath each configured host.
    for (const line of (output + '\n' + diagnostics).split('\n')) {
      const match = /Logged in to ([^\s]+) as\s+[^\s]+/iu.exec(line)
      const host = gitLabProject(match?.[1], 'sample/project')?.host
      if (host) hosts.add(host)
    }
    return [...hosts]
  }
  catch { return [] }
}

export async function trustedIssueProjects(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  const projects = await trustedProjectGitRemotes(workspaces, profile, signal)
  const hosts = new Set(['gitlab.com'])
  const defaultHost = defaultGitLabIssueHost()
  if (defaultHost) hosts.add(defaultHost)
  const knownRemotes = projects.map(({ workspace, remotes }) => ({
    workspace,
    remotes: remotes.map(({ path, url }) => ({ path, github: repositoryFromRemote(url), gitlab: gitLabRemote(url) })),
  }))
  if (knownRemotes.some(project => project.remotes.some(remote => !remote.github && remote.gitlab && !hosts.has(remote.gitlab.host))))
    for (const host of await authenticatedGitLabHosts(signal)) hosts.add(host)
  return knownRemotes.map(({ workspace, remotes }) => {
    const repositories = new Map<string, IssueRepository>()
    for (const { github, gitlab, path } of remotes) {
      if (github) {
        const key = github.toLowerCase()
        if (!repositories.has(key)) repositories.set(key, { tracker: 'github', key, name: github, path, workspace })
      }
      else if (gitlab && hosts.has(gitlab.host)) {
        const key = 'gitlab:' + gitlab.host + '/' + gitlab.name.toLowerCase()
        if (!repositories.has(key)) repositories.set(key, { tracker: 'gitlab', key, ...gitlab, path, workspace })
      }
    }
    return { workspace, repositories }
  })
}

export function mergeIssueRepositories(projects: Iterable<{ repositories: Map<string, IssueRepository> }>) {
  const repositories = new Map<string, IssueRepository>()
  for (const project of projects) {
    for (const [key, repository] of project.repositories) {
      if (!repositories.has(key)) repositories.set(key, repository)
    }
  }
  return repositories
}

export async function trustedIssueRepositories(workspaces: Iterable<WorkspaceState>, profile: number, signal: AbortSignal) {
  return mergeIssueRepositories(await trustedIssueProjects(workspaces, profile, signal))
}
