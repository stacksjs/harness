import { createHash } from 'node:crypto'
import { readRepositoryInput, repositoryGit } from './repository-commit'
import { parsePullRequest, repositoryFromRemote } from './prompt-links'
import { repositorySyncPreview, syncRepository } from './repository-sync'

type GitHubReply = { status: number, body: unknown }
type GitHubRepository = { full_name?: string, default_branch?: string, archived?: boolean, parent?: { full_name?: string }, source?: { full_name?: string } }
type GitHubPullRequest = { html_url?: string, number?: number, draft?: boolean, head?: { ref?: string, sha?: string, repo?: { full_name?: string } }, base?: { ref?: string } }

export class RepositoryPullRequestError extends Error {}

export async function readPullRequestSubmission(request: Request) {
  const value = await readRepositoryInput(request, 65_536)
  const { revision, baseRef, draft } = value ?? {}
  const title = typeof value?.title === 'string' ? value.title.trim() : ''
  const body = typeof value?.body === 'string' ? value.body : ''
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision)
    || typeof baseRef !== 'string' || !baseRef || Buffer.byteLength(baseRef) > 1024
    || typeof draft !== 'boolean' || [...title].length > 256 || Buffer.byteLength(body) > 16_384
    || /[\r\n\0]/u.test(title) || body.includes('\0')) return null
  return { revision, baseRef, title, body, draft }
}

export async function repositoryGitHubRequest(path: string, endpoint: string, payload?: object, signal?: AbortSignal): Promise<GitHubReply> {
  if (!Bun.which('gh')) throw new RepositoryPullRequestError('Install the GitHub CLI on this host, then run gh auth login.')
  const child = Bun.spawn([
    'gh', 'api', '--hostname', 'github.com', '--include', '--method', payload ? 'POST' : 'GET',
    '-H', 'Accept: application/vnd.github+json', ...(payload ? ['--input', '-'] : []), endpoint,
  ], {
    cwd: path,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '', NO_COLOR: '1' },
    stdin: payload ? new Blob([JSON.stringify(payload)]) : 'ignore',
    stdout: 'pipe', stderr: 'ignore', timeout: 15_000, signal,
  })
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const status = Number(/^HTTP\/\S+ (\d{3})\b/u.exec(output)?.[1])
  const json = /\r?\n\r?\n/u.exec(output)
  if (!status || !json)
    throw new RepositoryPullRequestError('Could not connect to GitHub. Check the host connection and gh auth status.')
  let body: unknown
  try { body = JSON.parse(output.slice(json.index + json[0].length)) }
  catch { throw new RepositoryPullRequestError('GitHub returned an unreadable response. Try again.') }
  if (status === 401) throw new RepositoryPullRequestError('GitHub authentication expired. Run gh auth login on this host.')
  if (status === 403) throw new RepositoryPullRequestError('GitHub refused this request. Check the account’s repository permissions or try again after its rate limit resets.')
  return { status, body }
}

async function configuredGitHubRepository(path: string, remote: string, forPush: boolean) {
  for (const key of forPush ? ['pushurl', 'url'] : ['url']) {
    const values = await repositoryGit(path, ['config', '--null', '--get-all', 'remote.' + remote + '.' + key])
      .then(result => result.stdout.split('\0').filter(Boolean), (error) => {
        if (error.code === 1) return []
        throw error
      })
    if (values.length) return values.length === 1 ? repositoryFromRemote(values[0]!) : null
  }
  return null
}

async function githubRepository(path: string, name: string) {
  const reply = await repositoryGitHubRequest(path, 'repos/' + name)
  const data = reply.body as GitHubRepository | null
  if (reply.status !== 200 || data?.full_name?.toLowerCase() !== name.toLowerCase() || typeof data.default_branch !== 'string')
    throw new RepositoryPullRequestError('GitHub could not read ' + name + '. Check which account is signed in on this host.')
  if (data.archived) throw new RepositoryPullRequestError('The GitHub repository is archived.')
  return data
}

async function githubBranch(path: string, repository: string, branch: string) {
  const reply = await repositoryGitHubRequest(path, 'repos/' + repository + '/branches/' + encodeURIComponent(branch))
  const data = reply.body as { commit?: { sha?: unknown } } | null
  if (reply.status === 404) return null
  if (reply.status !== 200 || typeof data?.commit?.sha !== 'string' || !/^[0-9a-f]{40}$/u.test(data.commit.sha))
    throw new RepositoryPullRequestError('GitHub could not confirm this branch. Check the repository and try again.')
  return data.commit.sha
}

function pullRequestResult(value: unknown, repository: string, headRepository: string, headRef: string, baseRef: string) {
  const pull = value as GitHubPullRequest | null
  const link = typeof pull?.html_url === 'string' ? parsePullRequest(pull.html_url) : null
  if (!link || link.repository.toLowerCase() !== repository.toLowerCase() || link.number !== pull?.number
    || pull.head?.repo?.full_name?.toLowerCase() !== headRepository.toLowerCase() || pull.head?.ref !== headRef || pull.base?.ref !== baseRef)
    return null
  return { ...link, headCommit: pull.head.sha, draft: pull.draft === true }
}

async function findOpenPullRequest(path: string, repository: string, headRepository: string, headRef: string, baseRef: string) {
  const owner = headRepository.split('/')[0]
  const query = new URLSearchParams({ state: 'open', head: owner + ':' + headRef, base: baseRef, per_page: '30' })
  const reply = await repositoryGitHubRequest(path, 'repos/' + repository + '/pulls?' + query)
  if (reply.status !== 200 || !Array.isArray(reply.body))
    throw new RepositoryPullRequestError('GitHub could not check for an existing pull request.')
  for (const item of reply.body) {
    const result = pullRequestResult(item, repository, headRepository, headRef, baseRef)
    if (result) return result
  }
  return null
}

export async function prepareRepositoryPullRequest(path: string, selectedBase?: string) {
  const push = await repositorySyncPreview(path, 'push')
  if (!push.branch || !push.head || !push.remote || !push.ref)
    throw new RepositoryPullRequestError(push.problem ?? 'Check out a branch before creating a pull request.')
  const headRepository = await configuredGitHubRepository(path, push.remote, true)
  if (!headRepository) throw new RepositoryPullRequestError('Choose a GitHub publishing remote for this checkout.')

  const headMetadata = await githubRepository(path, headRepository)
  const pull = await repositorySyncPreview(path, 'pull')
  const possibleBaseRemotes = [...new Set([pull.remote, 'upstream', 'origin'])].filter(remote => remote && remote !== push.remote)
  let repository: string = headRepository
  for (const remote of possibleBaseRemotes) {
    const candidate = await configuredGitHubRepository(path, remote, false)
    if (candidate && [headMetadata.parent?.full_name, headMetadata.source?.full_name]
      .some(relative => relative?.toLowerCase() === candidate.toLowerCase())) {
      repository = candidate
      break
    }
  }
  const metadata = repository === headRepository ? headMetadata : await githubRepository(path, repository)
  const baseRef = selectedBase ?? metadata.default_branch!
  if (selectedBase && !await repositoryGit(path, ['check-ref-format', 'refs/heads/' + selectedBase]).then(() => true, () => false))
    throw new RepositoryPullRequestError('Enter a valid base branch name.')
  const headRef = push.ref.slice('refs/heads/'.length)
  const identity = await repositoryGitHubRequest(path, 'user')
  const actor = (identity.body as { login?: unknown } | null)?.login
  if (identity.status !== 200 || typeof actor !== 'string')
    throw new RepositoryPullRequestError('Run gh auth login on this host before creating a pull request.')

  const [baseCommit, headCommit, suggested, existing] = await Promise.all([
    githubBranch(path, repository, baseRef),
    githubBranch(path, headRepository, headRef),
    repositoryGit(path, ['log', '-1', '--format=%s', push.head]).then(result => result.stdout.trim()),
    findOpenPullRequest(path, repository, headRepository, headRef, baseRef),
  ])
  const publish = headCommit !== push.head
  const problem = !baseCommit ? 'GitHub could not find the selected base branch.'
    : repository.toLowerCase() === headRepository.toLowerCase() && baseRef === headRef
      ? 'Choose a base branch other than the branch you are publishing.'
      : !existing && push.head === baseCommit ? 'Add a commit before opening this pull request.'
        : !existing && publish ? push.problem : null

  const revision = createHash('sha256').update(JSON.stringify([
    push.revision, actor, repository, headRepository, baseRef, baseCommit, headCommit, existing?.number ?? null,
  ])).digest('hex')
  const preview = { revision, actor, repository, headRepository, baseRef, headRef, remote: push.remote, branch: push.branch,
    title: [...suggested].slice(0, 256).join(''), publish, problem, existing }
  return { preview, push, baseCommit }
}

export async function openRepositoryPullRequest(path: string, prepared: Awaited<ReturnType<typeof prepareRepositoryPullRequest>>,
  input: { title: string, body: string, draft: boolean }, authorize: () => boolean) {
  const { preview, push } = prepared
  if (!authorize()) throw new RepositoryPullRequestError('The checkout changed. Review the pull request again.')
  if ((await repositorySyncPreview(path, 'push')).revision !== push.revision || !authorize())
    throw new RepositoryPullRequestError('The branch or publishing remote changed. Review the pull request again.')
  if (preview.existing) return { pullRequest: preview.existing, existing: true, headChanged: false }
  if (preview.publish) await syncRepository(path, 'push', push, authorize)

  const { repository, headRepository, headRef, baseRef } = preview
  const [publishedHead, currentBase] = await Promise.all([
    githubBranch(path, headRepository, headRef), githubBranch(path, repository, baseRef),
  ])
  if (publishedHead !== push.head || currentBase !== prepared.baseCommit || !authorize())
    throw new RepositoryPullRequestError('The published branch or base changed. Review the current refs before creating the pull request.')
  const crossRepository = repository.toLowerCase() !== headRepository.toLowerCase()
  const payload = { title: input.title, body: input.body, draft: input.draft, base: baseRef,
    head: crossRepository ? headRepository.split('/')[0] + ':' + headRef : headRef,
    ...(crossRepository ? { head_repo: headRepository.split('/')[1] } : {}),
    maintainer_can_modify: true }
  // A lost response or concurrent creation can leave an open request on the
  // forge. Resolve it by exact base, head and repository before another write.
  let response: GitHubReply | undefined
  let failure: unknown
  try { response = await repositoryGitHubRequest(path, 'repos/' + repository + '/pulls', payload) }
  catch (error) { failure = error }
  let pullRequest = response?.status === 201 ? pullRequestResult(response.body, repository, headRepository, headRef, baseRef) : null
  const created = Boolean(pullRequest)
  if (!pullRequest) pullRequest = await findOpenPullRequest(path, repository, headRepository, headRef, baseRef).catch(() => null)
  if (!pullRequest) {
    if (failure) throw failure
    throw new RepositoryPullRequestError('GitHub did not confirm a pull request. Check the account’s write permissions, draft support, and branch differences before retrying.')
  }
  return { pullRequest, existing: !created, headChanged: pullRequest.headCommit !== push.head }
}
