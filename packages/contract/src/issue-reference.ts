export interface GitHubIssueReference {
  tracker: 'github'
  repository: string
  number: number
}

const repositoryPattern = /^[a-z\d][a-z\d-]{0,38}\/[a-z\d._-]{1,100}$/iu

export function githubIssueReference(value: unknown): GitHubIssueReference | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<GitHubIssueReference>
  const { tracker, repository, number } = candidate
  return tracker === 'github' && typeof repository === 'string' && repositoryPattern.test(repository)
    && !/\/\.+$/u.test(repository) && typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? { tracker, repository: repository.toLowerCase(), number } : null
}

export function parseGitHubIssueUrl(value: string): GitHubIssueReference | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/iu.exec(value)
  return match ? githubIssueReference({ tracker: 'github', repository: match[1], number: Number(match[2]) }) : null
}

export function githubIssueUrl(issue: GitHubIssueReference): string {
  return 'https://github.com/' + issue.repository + '/issues/' + issue.number
}

export function sameGitHubIssue(left: GitHubIssueReference, right: GitHubIssueReference): boolean {
  return left.tracker === right.tracker && left.repository === right.repository && left.number === right.number
}

export interface GitLabIssueReference {
  tracker: 'gitlab'
  host: string
  repository: string
  number: number
}
export interface ForgejoIssueReference {
  tracker: 'forgejo'
  host: string
  repository: string
  number: number
}

export type IssueReference = GitHubIssueReference | GitLabIssueReference | ForgejoIssueReference

export function gitLabProject(host: unknown, repository: unknown) {
  if (typeof host !== 'string' || typeof repository !== 'string' || host.length > 253 || repository.length > 512
    || !/^[a-z\d](?:[a-z\d.-]*[a-z\d])?(?::[1-9]\d{0,4})?$/iu.test(host)
    || !/^[a-z\d._-]+(?:\/[a-z\d._-]+)+$/iu.test(repository) || repository.split('/').some(part => /^\.+$/u.test(part))) return null
  return { host: host.toLowerCase(), repository: repository.toLowerCase() }
}

export function issueReference(value: unknown): IssueReference | null {
  const github = githubIssueReference(value)
  if (github || !value || typeof value !== 'object') return github
  const candidate = value as Partial<GitLabIssueReference | ForgejoIssueReference>
  const project = gitLabProject(candidate.host, candidate.repository)
  const { tracker, number } = candidate
  return project && (tracker === 'gitlab' || (tracker === 'forgejo' && project.host !== 'github.com'))
    && typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? { tracker, ...project, number } : null
}

export function parseIssueUrl(value: string): IssueReference | null {
  const github = parseGitHubIssueUrl(value)
  if (github) return github
  const match = /^https:\/\/([^/]+)\/(.+)\/-\/(?:issues|work_items)\/([1-9]\d*)$/iu.exec(value)
  return match ? issueReference({ tracker: 'gitlab', host: match[1], repository: match[2], number: Number(match[3]) }) : null
}

export function parseForgejoIssueUrl(value: string): ForgejoIssueReference | null {
  const match = /^https:\/\/([^/]+)\/(.+)\/issues\/([1-9]\d*)$/iu.exec(value)
  const issue = match && issueReference({ tracker: 'forgejo', host: match[1], repository: match[2], number: Number(match[3]) })
  return issue && issue.tracker === 'forgejo' ? issue : null
}

export function issueRepositoryKey(issue: IssueReference): string {
  return issue.tracker === 'github' ? issue.repository : issue.tracker + ':' + issue.host + '/' + issue.repository
}

export function issueUrl(issue: IssueReference): string {
  if (issue.tracker === 'github') return githubIssueUrl(issue)
  return 'https://' + issue.host + '/' + issue.repository + (issue.tracker === 'gitlab' ? '/-/issues/' : '/issues/') + issue.number
}

export function sameIssue(left: IssueReference, right: IssueReference): boolean {
  return issueRepositoryKey(left) === issueRepositoryKey(right) && left.number === right.number
}
