import { searchRepositoryLabels } from './pull-request-labels'
import { applyPullRequestDraftFilterChange, parsePullRequestQuery } from './pull-request-query'
import { RepositoryPullRequestError, repositoryGitHubCredential, repositoryGitHubRequest } from './repository-pull-request'

const reviewQualifiers = { approved: 'approved', 'changes-requested': 'changes_requested', 'review-required': 'required', none: 'none' } as const
const checksQualifiers = { passing: 'success', failing: 'failure' } as const
const filterKeys = ['involvement', 'draft', 'review', 'checks', 'author', 'label'] as const
const draftChoices = ['only', 'hide'] as const
const loginPattern = /^[a-z0-9][a-z0-9-]{0,99}(?:\[bot\])?$/iu
const labelPattern = /^[^"\\\p{Cc}]+$/u

function parseAuthor(value: string | null) {
  const login = value?.trim() ?? ''
  if (/^@?me$/iu.test(login)) return '@me'
  const username = login.replace(/^@/u, '')
  return loginPattern.test(username) ? username : ''
}

function enumValue<T extends string>(value: string | null, choices: readonly T[]): T | '' {
  return choices.find(choice => choice === value) ?? ''
}

export function readPullRequestFilters(query: URLSearchParams) {
  const labels = new Map<string, string>()
  for (const value of [...query.getAll('label').slice(0, 100), query.get('addLabel') ?? '']) {
    const label = value.trim()
    const key = label.toLowerCase()
    if (label.length <= 100 && labelPattern.test(label) && !labels.has(key)) labels.set(key, label)
    if (labels.size === 10) break
  }
  return {
    involvement: enumValue(query.get('involvement'), ['authored', 'reviewing'] as const),
    draft: enumValue(query.get('draft'), draftChoices),
    review: enumValue(query.get('review'), Object.keys(reviewQualifiers) as (keyof typeof reviewQualifiers)[]),
    checks: enumValue(query.get('checks'), Object.keys(checksQualifiers) as (keyof typeof checksQualifiers)[]),
    author: parseAuthor(query.get('chooseAuthor') || query.get('author')),
    label: [...labels.values()],
  }
}

type Filters = ReturnType<typeof readPullRequestFilters>
type EffectiveFilters = Omit<Filters, 'label'> & { labels: string[][], excludedLabels: string[] }

export function readPullRequestListSearch(query: URLSearchParams) {
  const menu = readPullRequestFilters(query)
  const bounded = (query.get('q') ?? '').slice(0, 200).replace(/[\uD800-\uDBFF]$/u, '')
  let search = bounded.replace(/\p{Cc}/gu, ' ').trim()
  let parsed = parsePullRequestQuery(search)
  // The form carries both the displayed draft setting and the saved menu setting.
  // A newly typed draft qualifier wins when both inputs changed on the same submit.
  if (query.has('chooseDraft')) {
    const choice = enumValue(query.get('chooseDraft'), draftChoices)
    const shown = enumValue(query.get('shownDraft'), draftChoices)
    if (choice !== shown && (!parsed.filters.draft || parsed.filters.draft === shown)) {
      const result = applyPullRequestDraftFilterChange(search, { draft: menu.draft || undefined }, { draft: choice || undefined })
      search = result.query
      menu.draft = result.filters.draft ?? ''
      parsed = parsePullRequestQuery(search)
    }
  }
  const typed = parsed.filters
  const typedLabels = typed.labels?.map(group => group.filter(label => labelPattern.test(label))).filter(group => group.length > 0)
  const filters: EffectiveFilters = {
    involvement: menu.involvement,
    author: parseAuthor(typed.author ?? null) || menu.author,
    draft: typed.draft ?? menu.draft,
    review: typed.review ?? menu.review,
    checks: typed.checks ?? menu.checks,
    labels: typedLabels?.length ? typedLabels : menu.label.map(label => [label]),
    excludedLabels: typed.excludedLabels?.filter(label => labelPattern.test(label)) ?? [],
  }
  const text = parsed.text.replace(/["\\\p{Cc}]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return { search, text, menu, filters }
}

export function writePullRequestFilters(params: URLSearchParams, filters: Filters) {
  for (const key of filterKeys) {
    const value = filters[key]
    if (typeof value === 'string') {
      if (value) params.set(key, value)
    }
    else for (const item of value) params.append(key, item)
  }
}

export async function readFilterViewer(path: string, signal: AbortSignal) {
  const response = await repositoryGitHubRequest(path, 'user', undefined, signal)
  const login = (response.body as { login?: unknown } | null)?.login
  if (response.status !== 200 || typeof login !== 'string' || !loginPattern.test(login))
    throw new RepositoryPullRequestError('GitHub could not identify the signed-in account. Run gh auth status on the host.')
  return login
}

export function pullRequestFilterQualifiers(filters: EffectiveFilters, viewer: string) {
  const author = filters.author === '@me' ? viewer : filters.author
  if (filters.involvement === 'authored' && author && author.toLowerCase() !== viewer.toLowerCase()) return null
  const requiredAuthor = filters.involvement === 'authored' ? viewer : author
  return [
    ...(requiredAuthor ? ['author:' + requiredAuthor] : []),
    ...(filters.involvement === 'reviewing' ? ['review-requested:' + viewer] : []),
    ...(filters.draft ? ['draft:' + (filters.draft === 'only')] : []),
    ...(filters.review ? ['review:' + reviewQualifiers[filters.review]] : []),
    ...(filters.checks ? ['status:' + checksQualifiers[filters.checks]] : []),
    ...filters.labels.map(labels => 'label:' + labels.map(label => '"' + label + '"').join(',')),
    ...filters.excludedLabels.map(label => '-label:"' + label + '"'),
  ]
}

export function readFilterLookup(query: URLSearchParams) {
  const kind = enumValue(query.get('find'), ['labels', 'authors'] as const)
  const search = (query.get('findQuery') ?? '').slice(0, 100).replace(/\p{Cc}/gu, '').trim()
  return kind && search ? { kind, search } : null
}

type LookupRepository = { path: string, name: string }
type FilterChoice = { value: string, description: string, color?: string }
type ChoicePage = { options: FilterChoice[], more: boolean }

async function searchRepositoryAuthors({ path, name }: LookupRepository, search: string, signal: AbortSignal, credential: string): Promise<ChoicePage> {
  const [owner, repository] = name.split('/')
  const result = await repositoryGitHubRequest(path, 'graphql', {
    query: `query HarnessSearchPullRequestAuthors($owner: String!, $name: String!, $search: String!) {
      repository(owner: $owner, name: $name) {
        nameWithOwner
        mentionableUsers(first: 50, query: $search) { nodes { login name } pageInfo { hasNextPage } }
      }
    }`, variables: { owner, name: repository, search },
  }, signal, credential)
  const response = result.body as { errors?: unknown[], data?: { repository?: { nameWithOwner?: string,
    mentionableUsers?: { nodes?: ({ login?: string, name?: string } | null)[], pageInfo?: { hasNextPage?: boolean } } } } } | null
  const repo = response?.data?.repository
  const users = repo?.mentionableUsers
  if (result.status !== 200 || response?.errors?.length || repo?.nameWithOwner?.toLowerCase() !== name.toLowerCase() || !Array.isArray(users?.nodes))
    throw new RepositoryPullRequestError('GitHub could not search this repository for authors.')
  return {
    options: users.nodes.flatMap(user => user?.login && loginPattern.test(user.login)
      ? [{ value: user.login, description: typeof user.name === 'string' ? user.name.slice(0, 160) : '' }] : []),
    more: users.pageInfo?.hasNextPage === true,
  }
}

export async function readPullRequestFilterChoices(repositories: LookupRepository[], lookup: NonNullable<ReturnType<typeof readFilterLookup>>, signal: AbortSignal) {
  const options = new Map<string, FilterChoice>()
  let more = false
  let failed = 0
  const { kind, search } = lookup
  const credential = repositories[0] && await repositoryGitHubCredential(repositories[0].path, signal).catch(() => null)
  if (!credential) return { ...lookup, options: [], more, failed: repositories.length }
  for (let index = 0; index < repositories.length; index += 4) {
    signal.throwIfAborted()
    const batch = repositories.slice(index, index + 4)
    const pages = await Promise.allSettled(batch.map(async (repo): Promise<ChoicePage> => {
      if (kind === 'authors') return searchRepositoryAuthors(repo, search, signal, credential)
      const result = await searchRepositoryLabels({ path: repo.path, repository: repo.name, credential, signal }, search)
      if (!result) throw new RepositoryPullRequestError('GitHub could not search this repository for labels.')
      return { options: result.labels.map(label => ({ value: label.name, color: label.color, description: label.description })), more: result.more }
    }))
    for (const page of pages) {
      if (page.status === 'rejected') {
        failed++
        continue
      }
      more = more || page.value.more
      for (const option of page.value.options) {
        const key = option.value.toLowerCase()
        if (!options.has(key)) options.set(key, option)
      }
    }
  }
  const ranked = [...options.values()].sort((a, b) => Number(b.value.toLowerCase() === search.toLowerCase())
    - Number(a.value.toLowerCase() === search.toLowerCase()) || a.value.localeCompare(b.value))
  return { ...lookup, options: ranked.slice(0, 50), more: more || ranked.length > 50, failed }
}
