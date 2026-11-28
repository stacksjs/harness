import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fixtureGitLabCli(bin: string) {
  const path = join(bin, 'glab')
  writeFileSync(path, `#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
const [command, endpoint, ...flags] = process.argv.slice(2)
const { gitlab } = JSON.parse(readFileSync(${JSON.stringify(join(bin, 'state.json'))}, 'utf8'))
if (command === 'auth' && endpoint === 'status') {
  console.error('✓ Logged in to ' + gitlab.host + ' as fixture-reviewer')
  process.exit(0)
}
function respond(status, value, next = '') {
  process.stdout.write('HTTP/2.0 ' + status + '\\r\\nX-Next-Page: ' + next + '\\r\\n\\r\\n' + JSON.stringify(value))
  process.exit(status === 200 ? 0 : 1)
}
if (command !== 'api' || flags[0] !== '--hostname' || flags[1] !== gitlab.host || !flags.includes('--include'))
  respond(404, {})
if (process.env.GITLAB_TOKEN || process.env.GITLAB_ACCESS_TOKEN || process.env.OAUTH_TOKEN)
  respond(412, {})
const address = new URL(endpoint, 'https://fixture.invalid/')
const path = decodeURIComponent(address.pathname)
const root = '/projects/' + gitlab.repository + '/issues'
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
