import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fixtureGitHubCli(directory: string, repositories: Record<string, { bare: string, parent?: string }>) {
  const bin = join(directory, 'fixture-github')
  const state = join(bin, 'state.json')
  mkdirSync(bin)
  const configure = (mode: 'normal' | 'denied' | 'lost-response' = 'normal', reset = false) => {
    const previous = !reset && existsSync(state) ? JSON.parse(readFileSync(state, 'utf8')) : {}
    writeFileSync(state, JSON.stringify({ repositories, pulls: [], posts: 0, ...previous, mode }))
  }
  configure('normal', true)
  const configureChecks = (pages: object[][], mode: 'normal' | 'unreadable' | 'head-changed' = 'normal') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, checkPages: pages, checkMode: mode }))
  }
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateFile = join(import.meta.dir, 'state.json')
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
const method = args[args.indexOf('--method') + 1]
const endpoint = args.at(-1)
const url = new URL(endpoint, 'https://api.github.com/')
const parts = url.pathname.split('/')
const name = parts.slice(2, 4).join('/')
const repo = state.repositories[name]

function reply(status, body) {
  process.stdout.write('HTTP/2.0 ' + status + ' Fixture\\r\\ncontent-type: application/json\\r\\n\\r\\n' + JSON.stringify(body))
  process.exit(status < 300 ? 0 : 1)
}

function head(repository, branch) {
  const command = Bun.spawnSync(['git', '--git-dir', repository.bare, 'rev-parse', '--verify', 'refs/heads/' + branch])
  return command.success ? command.stdout.toString().trim() : null
}

if (url.pathname === '/user') reply(200, { login: 'fixture-user' })
if (url.pathname === '/graphql' && method === 'POST') {
  const { variables } = JSON.parse(await Bun.stdin.text())
  const name = variables.owner + '/' + variables.name
  const pull = state.pulls.find(pull => pull.base.repo.full_name === name && pull.number === variables.number)
  if (!pull || state.checkMode === 'unreadable') reply(200, { errors: [{ message: 'Private forge diagnostics must not leak' }] })
  const index = Number(variables.cursor ?? 0)
  const nodes = state.checkPages?.[index] ?? []
  const hasNextPage = index + 1 < (state.checkPages?.length ?? 0)
  const sha = index > 0 && state.checkMode === 'head-changed' ? 'f'.repeat(40) : pull.head.sha
  const statusCheckRollup = nodes.length || hasNextPage ? { contexts: { nodes, pageInfo: { hasNextPage, endCursor: String(index + 1) } } } : null
  reply(200, { data: { repository: { pullRequest: {
    title: pull.title, state: 'OPEN', isDraft: pull.draft, headRefOid: sha, commits: { nodes: [{ commit: { oid: sha, statusCheckRollup } }] },
  } } } })
}

if (url.pathname === '/search/issues') {
  const keyword = url.searchParams.get('q') ?? ''
  const selected = /repo:([^ ]+)/.exec(keyword)?.[1]
  const title = keyword.split(String.fromCharCode(34))[1] ?? ''
  reply(200, { items: state.pulls.filter(pull => pull.base.repo.full_name === selected && pull.title.toLowerCase().includes(title.toLowerCase())) })
}
if (!repo) reply(404, {})
if (parts.length === 4) reply(200, { full_name: name, default_branch: 'main', parent: repo.parent && { full_name: repo.parent } })
if (parts[4] === 'branches') {
  const sha = head(repo, decodeURIComponent(parts[5]))
  reply(sha ? 200 : 404, sha ? { commit: { sha } } : {})
}
const pulls = state.pulls.filter(pull => pull.base.repo.full_name === name)
const detail = pulls.find(pull => pull.number === Number(parts[5]))
if (parts[4] === 'issues' && parts[6] === 'timeline' && detail) reply(200, [
  { id: 5, event: 'commented', user: { login: 'fixture-reviewer' }, created_at: '2026-11-01T13:00:00Z', body: 'Check the **export**. <script>globalThis.__pr_html = true</script>' },
  { id: 3, event: 'reviewed', user: { login: 'fixture-approver' }, state: 'approved', submitted_at: '2026-11-01T14:00:00Z' },
])
if (parts[4] !== 'pulls') reply(404, {})
if (method === 'GET' && parts[5]) {
  if (!detail) reply(404, {})
  if (parts[6] === 'files') reply(200, [{ filename: 'report.txt', status: 'added', additions: 1, deletions: 0,
    patch: '@@ -0,0 +1 @@' + String.fromCharCode(10) + '+Report fixture' }])
  reply(200, detail)
}
if (method === 'GET') reply(200, pulls.filter(pull => !url.searchParams.has('head')
  || (pull.base.ref === url.searchParams.get('base') && pull.head.label === url.searchParams.get('head'))))

const input = JSON.parse(await Bun.stdin.text())
state.posts++
if (state.mode === 'denied') {
  writeFileSync(stateFile, JSON.stringify(state))
  reply(403, { message: 'Private forge diagnostics must not leak' })
}
const owner = input.head.includes(':') ? input.head.split(':')[0] : name.split('/')[0]
const headRef = input.head.includes(':') ? input.head.split(':')[1] : input.head
const repositoryName = input.head_repo ? owner + '/' + input.head_repo : name
const headRepository = state.repositories[repositoryName]
const sha = headRepository && head(headRepository, headRef)
if (!sha) reply(422, {})
const number = state.pulls.length + 1
const pull = { ...input, number, state: 'open', user: { login: 'fixture-user' }, created_at: '2026-11-01T12:00:00Z', updated_at: '2026-11-01T12:00:00Z', html_url: 'https://github.com/' + name + '/pull/' + number,
  base: { ref: input.base, repo: { full_name: name } },
  head: { ref: headRef, sha, label: owner + ':' + headRef, repo: { full_name: repositoryName } } }
state.pulls.push(pull)
writeFileSync(stateFile, JSON.stringify(state))
if (state.mode === 'lost-response') process.exit(1)
reply(201, pull)
`, { mode: 0o700 })
  return { bin, state, configure, configureChecks }
}
