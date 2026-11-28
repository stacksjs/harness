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
