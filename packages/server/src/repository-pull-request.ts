import { createHash } from 'node:crypto'
import { readRepositoryInput, repositoryGit } from './repository-commit'
import { parsePullRequest, repositoryFromRemote } from './prompt-links'
import { repositorySyncPreview, syncRepository } from './repository-sync'

type GitHubReply = { status: number, body: unknown, hasNextPage: boolean }
type GitHubRepository = { full_name?: string, default_branch?: string, archived?: boolean, parent?: { full_name?: string }, source?: { full_name?: string } }
type GitHubPullRequest = { html_url?: string, number?: number, draft?: boolean, head?: { ref?: string, sha?: string, repo?: { full_name?: string } }, base?: { ref?: string } }

export class RepositoryPullRequestError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

export async function readPullRequestSubmission(request: Request) {
  return parsePullRequestSubmission(await readRepositoryInput(request, 65_536))
}

export function parsePullRequestSubmission(value: Record<string, unknown> | null) {
  const { revision, baseRef, draft } = value ?? {}
  const generate = value?.generate ?? null
  const title = typeof value?.title === 'string' ? value.title.trim() : ''
  const body = typeof value?.body === 'string' ? value.body : ''
  if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/u.test(revision)
    || typeof baseRef !== 'string' || !baseRef || Buffer.byteLength(baseRef) > 1024
    || (generate !== null && (typeof generate !== 'string' || !/^[0-9a-f]{64}$/u.test(generate) || Boolean(title)))
    || typeof draft !== 'boolean' || [...title].length > 256 || Buffer.byteLength(body) > 16_384
    || /[\r\n\0]/u.test(title) || body.includes('\0')) return null
  return { revision, baseRef, title, body, draft, generate }
}

export function generatedPullRequestText(value: unknown) {
  if (!value || typeof value !== 'object') throw new RepositoryPullRequestError('The provider returned invalid pull request text. Enter a title or try again.')
  const { title, body } = value as Record<string, unknown>
  if (typeof title !== 'string' || !title.trim() || [...title].length > 256 || /[\r\n\0]/u.test(title)
    || typeof body !== 'string' || Buffer.byteLength(body) > 16_384 || body.includes('\0'))
    throw new RepositoryPullRequestError('The provider returned invalid pull request text. Enter a title or try again.')
  return { title: title.trim(), body: body.trim() }
}

export async function readPullRequestPatch(path: string, base: string, head: string) {
  const { stdout } = await repositoryGit(path, [
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--stat', '--patch', base + '...' + head, '--',
  ]).catch((error) => {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof error.stdout === 'string') return { stdout: error.stdout }
    throw error
  })
  return stdout.length > 60_000 ? stdout.slice(0, 60_000) + '\n[Patch truncated]' : stdout
}

export async function repositoryGitHubCredential(path: string, signal: AbortSignal) {
  const configured = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (configured) return configured
  if (!Bun.which('gh')) throw new RepositoryPullRequestError('Install the GitHub CLI on this host, then run gh auth login.')
  const child = Bun.spawn(['gh', 'auth', 'token', '--hostname', 'github.com'], {
    cwd: path, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '', NO_COLOR: '1' },
    stdout: 'pipe', stderr: 'ignore', stdin: 'ignore', timeout: 15_000, signal,
  })
  const [value, status] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (status !== 0 || !value.trim()) throw new RepositoryPullRequestError('Sign in to GitHub on the host and try again.')
  return value.trim()
}

export async function repositoryGitHubRequest(path: string, endpoint: string, payload?: object, signal?: AbortSignal, credential?: string,
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH' = payload ? 'POST' : 'GET'): Promise<GitHubReply> {
  if (!Bun.which('gh')) throw new RepositoryPullRequestError('Install the GitHub CLI on this host, then run gh auth login.')
  const child = Bun.spawn([
    'gh', 'api', '--hostname', 'github.com', '--include', '--method', method,
    '-H', 'Accept: application/vnd.github+json', ...(payload ? ['--input', '-'] : []), endpoint,
  ], {
    cwd: path,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '', NO_COLOR: '1', ...(credential && { GH_TOKEN: credential }) },
    stdin: payload ? new Blob([JSON.stringify(payload)]) : 'ignore',
    stdout: 'pipe', stderr: 'ignore', timeout: 15_000, signal,
  })
  const [output] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const status = Number(/^HTTP\/\S+ (\d{3})\b/u.exec(output)?.[1])
  const json = /\r?\n\r?\n/u.exec(output)
  if (!status || !json)
    throw new RepositoryPullRequestError('Could not connect to GitHub. Check the host connection and gh auth status.')
  const responseBody = output.slice(json.index + json[0].length)
  let body: unknown
  try { body = (status === 201 || status === 204) && !responseBody.trim() ? null : JSON.parse(responseBody) }
  catch { throw new RepositoryPullRequestError('GitHub returned an unreadable response. Try again.') }
  if (status === 401) throw new RepositoryPullRequestError('GitHub authentication expired. Run gh auth login on this host.', status)
  if (status === 403) throw new RepositoryPullRequestError('GitHub refused this request. Check the account’s repository permissions or try again after its rate limit resets.', status)
  const links = /^link:[^\r\n]+/imu.exec(output.slice(0, json.index))?.[0] ?? ''
  return { status, body, hasNextPage: /;\s*rel="next"/u.test(links) }
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

async function githubBranch(path: string, repository: string, branch: string, credential?: string) {
  const reply = await repositoryGitHubRequest(path, 'repos/' + repository + '/branches/' + encodeURIComponent(branch), undefined, undefined, credential)
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

async function findOpenPullRequest(path: string, repository: string, headRepository: string, headRef: string, baseRef: string, credential?: string) {
  const owner = headRepository.split('/')[0]
  const query = new URLSearchParams({ state: 'open', head: owner + ':' + headRef, base: baseRef, per_page: '30' })
  const reply = await repositoryGitHubRequest(path, 'repos/' + repository + '/pulls?' + query, undefined, undefined, credential)
  if (reply.status !== 200 || !Array.isArray(reply.body))
    throw new RepositoryPullRequestError('GitHub could not check for an existing pull request.')
  for (const item of reply.body) {
    const result = pullRequestResult(item, repository, headRepository, headRef, baseRef)
    if (result) return result
  }
  return null
}

export async function prepareRepositoryPullRequest(path: string, selectedBase?: string, beforeCommit = false) {
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
  const problem = beforeCommit && (push.defaultTarget || headRef === headMetadata.default_branch)
    ? 'Check out a feature branch before committing, pushing, and opening a pull request.'
    : !baseCommit ? 'GitHub could not find the selected base branch.'
    : repository.toLowerCase() === headRepository.toLowerCase() && baseRef === headRef
      ? 'Choose a base branch other than the branch you are publishing.'
      : !beforeCommit && !existing && push.head === baseCommit ? 'Add a commit before opening this pull request.'
        : !existing && publish ? push.problem : null

  const targetKey = createHash('sha256').update(JSON.stringify([
    push.destinationKey, actor, repository, headRepository, baseRef, baseCommit, headRef, headMetadata.default_branch,
  ])).digest('hex')
  const revision = createHash('sha256').update(JSON.stringify([
    push.revision, targetKey, headCommit, existing?.number ?? null,
  ])).digest('hex')
  const preview = { revision, actor, repository, headRepository, baseRef, headRef, remote: push.remote, branch: push.branch,
    title: [...suggested].slice(0, 256).join(''), publish, problem, existing }
  return { preview, push, baseCommit, targetKey }
}

export async function openRepositoryPullRequest(path: string, prepared: Awaited<ReturnType<typeof prepareRepositoryPullRequest>>,
  input: { title: string, body: string, draft: boolean }, authorize: () => boolean, publication = false) {
  const { preview, push } = prepared
  if (!authorize()) throw new RepositoryPullRequestError('The checkout changed. Review the pull request again.')
  if ((await repositorySyncPreview(path, 'push')).revision !== push.revision || !authorize())
    throw new RepositoryPullRequestError('The branch or publishing remote changed. Review the pull request again.')
  if (!publication && preview.existing) return { pullRequest: preview.existing, existing: true, headChanged: false }
  if (!publication && preview.publish) await syncRepository(path, 'push', push, authorize)

  const { repository, headRepository, headRef, baseRef } = preview
  const credential = publication ? await repositoryGitHubCredential(path, AbortSignal.timeout(15_000)) : undefined
  if (credential) {
    const identity = await repositoryGitHubRequest(path, 'user', undefined, undefined, credential)
    if (identity.status !== 200 || (identity.body as { login?: unknown } | null)?.login !== preview.actor)
      throw new RepositoryPullRequestError('The GitHub account changed. Refresh the review before continuing.')
  }
  const [publishedHead, currentBase] = await Promise.all([
    githubBranch(path, headRepository, headRef, credential), githubBranch(path, repository, baseRef, credential),
  ])
  if (publishedHead !== push.head || currentBase !== prepared.baseCommit || !authorize())
    throw new RepositoryPullRequestError('The published branch or base changed. Review the current refs before creating the pull request.')
  if (preview.existing) {
    if (preview.existing.headCommit !== push.head)
      throw new RepositoryPullRequestError('GitHub reports a different pull request head. Refresh the review and try again.')
    return { pullRequest: preview.existing, existing: true, headChanged: false }
  }
  const crossRepository = repository.toLowerCase() !== headRepository.toLowerCase()
  const payload = { title: input.title, body: input.body, draft: input.draft, base: baseRef,
    head: crossRepository ? headRepository.split('/')[0] + ':' + headRef : headRef,
    ...(crossRepository ? { head_repo: headRepository.split('/')[1] } : {}),
    maintainer_can_modify: true }
  // A lost response or concurrent creation can leave an open request on the
  // forge. Resolve it by exact base, head and repository before another write.
  let response: GitHubReply | undefined
  let failure: unknown
  try { response = await repositoryGitHubRequest(path, 'repos/' + repository + '/pulls', payload, undefined, credential) }
  catch (error) { failure = error }
  let pullRequest = response?.status === 201 ? pullRequestResult(response.body, repository, headRepository, headRef, baseRef) : null
  const created = Boolean(pullRequest)
  if (!pullRequest) pullRequest = await findOpenPullRequest(path, repository, headRepository, headRef, baseRef, credential).catch(() => null)
  if (!pullRequest) {
    if (failure) throw failure
    throw new RepositoryPullRequestError('GitHub did not confirm a pull request. Check the account’s write permissions, draft support, and branch differences before retrying.')
  }
  return { pullRequest, existing: !created, headChanged: pullRequest.headCommit !== push.head }
}
