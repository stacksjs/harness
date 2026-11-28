import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fixtureGitLabCli(bin: string) {
  const path = join(bin, 'glab')
  writeFileSync(path, `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
const [command, endpoint, ...flags] = process.argv.slice(2)
const statePath = ${JSON.stringify(join(bin, 'state.json'))}
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const { gitlab } = state
const viewer = gitlab.viewer || 17
const credential = 'gitlab-fixture-credential-' + viewer
if (command === 'auth' && endpoint === 'status') {
  console.error('✓ Logged in to ' + gitlab.host + ' as fixture-reviewer')
  process.exit(0)
}
function respond(status, value, next = '') {
  process.stdout.write('HTTP/2.0 ' + status + '\\r\\nX-Next-Page: ' + next + '\\r\\n\\r\\n' + JSON.stringify(value))
  process.exit(status === 200 ? 0 : 1)
}
if (command === 'auth' && endpoint === 'credential-helper') {
  if (process.env.GITLAB_TOKEN || flags[0] !== '--repo' || flags[1] !== 'https://' + gitlab.host + '/' + gitlab.repository) process.exit(1)
  console.log(JSON.stringify({ type: 'success', instance_url: 'https://' + gitlab.host, token: { type: 'pat', token: credential } }))
  process.exit(0)
}
if (command !== 'api' || flags[0] !== '--hostname' || flags[1] !== gitlab.host || !flags.includes('--include'))
  respond(404, {})
const pinned = process.env.GITLAB_TOKEN === credential && process.env.GITLAB_HOST === gitlab.host
if ((process.env.GITLAB_TOKEN && (!pinned || endpoint !== 'graphql')) || process.env.GITLAB_ACCESS_TOKEN || process.env.OAUTH_TOKEN)
  respond(412, {})
const address = new URL(endpoint, 'https://fixture.invalid/')
const path = decodeURIComponent(address.pathname)
const project = '/projects/' + gitlab.repository
const root = project + '/issues'
if (path === '/graphql') {
  if (!flags.includes('--method') || !flags.includes('POST')) respond(400, {})
  const { query, variables } = await new Response(Bun.stdin.stream()).json()
  const issue = () => ({ id: 'gid://gitlab/Issue/2000', iid: String(gitlab.issue.iid), webUrl: gitlab.issue.web_url,
    title: gitlab.issue.title, description: gitlab.issue.description ?? null, userPermissions: { updateIssue: gitlab.canEditText === true } })
  if (query.includes('query HarnessGitLabIssueText')) {
    if (gitlab.failTextRead) {
      delete gitlab.failTextRead
      writeFileSync(statePath, JSON.stringify(state))
      respond(503, {})
    }
    if (variables.path !== gitlab.repository || variables.iid !== String(gitlab.issue.iid)) respond(200, { data: { project: null } })
    respond(200, { data: { currentUser: { id: 'gid://gitlab/User/' + viewer },
      project: { id: 'gid://gitlab/Project/74', fullPath: gitlab.repository, archived: gitlab.archived === true, issue: issue() } } })
  }
  if (query.includes('mutation HarnessGitLabEditIssue')) {
    if (!pinned || !gitlab.canEditText || gitlab.archived) respond(403, {})
    const input = variables.input
    if (input.projectPath !== gitlab.repository || input.iid !== String(gitlab.issue.iid)) respond(404, {})
    const field = 'title' in input ? 'title' : 'description'
    if (gitlab.refuseText) respond(200, { data: { updateIssue: { issue: null, errors: ['Fixture rejected the edit'] } } })
    gitlab.issue[field] = input[field]
    gitlab.textWrites ??= []
    gitlab.textWrites.push([field, input[field], viewer])
    if (gitlab.dropTextReply) {
      delete gitlab.dropTextReply
      gitlab.failTextRead = true
      writeFileSync(statePath, JSON.stringify(state))
      respond(502, {})
    }
    writeFileSync(statePath, JSON.stringify(state))
    respond(200, { data: { updateIssue: { issue: issue(), errors: [] } } })
  }
  respond(404, {})
}
if (path === project + '/labels' || path === project + '/members/all') {
  if (gitlab.catalogUnavailable) respond(403, {})
  const labels = path.endsWith('/labels')
  const query = address.searchParams
  if (labels && query.get('include_ancestor_groups') !== 'true') respond(400, {})
  const search = query.get(labels ? 'search' : 'query').toLowerCase()
  const entries = labels ? gitlab.labels : gitlab.members
  const matches = entries.filter(entry => [entry.name, entry.username].some(value => value?.toLowerCase().includes(search)))
  const size = Number(query.get('per_page'))
  respond(200, matches.slice(0, size), matches.length > size ? '2' : '')
}
if (path === '/user') respond(200, { username: 'fixture-reviewer' })
if (path === root) {
  if (gitlab.listUnavailable) respond(401, {})
  const query = address.searchParams
  const rows = [gitlab.issue, ...gitlab.otherIssues].filter(issue => (
    (!query.has('state') || issue.state === query.get('state')) &&
    (!query.has('author_username') || issue.author.username === query.get('author_username')) &&
    (!query.has('assignee_username') || issue.assignees.some(user => user.username === query.get('assignee_username'))) &&
    (!query.has('labels') || query.get('labels').split(',').every(label => issue.labels.includes(label))) &&
    (!query.has('search') || issue.title.toLowerCase().includes(query.get('search').toLowerCase()))
  )).sort((left, right) => right[query.get('order_by')].localeCompare(left[query.get('order_by')]))
  const size = Number(query.get('per_page'))
  const page = Number(query.get('page'))
  respond(200, rows.slice((page - 1) * size, page * size), rows.length > page * size ? page + 1 : '')
}
if (path === root + '/' + gitlab.issue.iid) respond(200, gitlab.issue)
if (path === root + '/' + gitlab.issue.iid + '/notes') {
  const size = Number(address.searchParams.get('per_page'))
  const page = Number(address.searchParams.get('page'))
  const notes = gitlab.notes.slice().reverse()
  respond(200, notes.slice((page - 1) * size, page * size), notes.length > page * size ? page + 1 : '')
}
if (path === root + '/' + gitlab.issue.iid + '/related_merge_requests') respond(200, gitlab.relatedRequests)
respond(404, {})
`)
  chmodSync(path, 0o755)
}
