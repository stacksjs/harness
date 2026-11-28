import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function fixtureForgejoCli(bin: string) {
  writeFileSync(join(bin, 'tea'), `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const statePath = join(import.meta.dir, 'state.json')
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const { forgejo } = state
const args = process.argv.slice(2)
if (args.join(' ') === 'login list --output json') {
  console.log(JSON.stringify(forgejo?.logins ?? []))
  process.exit(0)
}
function reply(code, body, more = false) {
  console.error('HTTP/1.1 ' + code)
  if (more) console.error('Link: <https://fixture.invalid/ignored>; rel="next"')
  console.log(JSON.stringify(body))
  process.exit(0)
}
if (args[0] !== 'api' || !args.includes('--include') || !forgejo) reply(400, {})
const flag = key => args[args.indexOf(key) + 1]
const url = new URL(args.at(-1))
const endpoint = forgejo.base + '/api/v1/repos/' + forgejo.repository
const method = flag('--method')
if (!['GET', 'POST'].includes(method) || flag('--login') !== forgejo.selected || flag('--repo') !== forgejo.repository) reply(401, {})
if (forgejo.unavailable) reply(503, {})
const viewer = { id: forgejo.viewerId ?? 17, login: forgejo.viewer }
if (method === 'GET' && url.origin + url.pathname === forgejo.base + '/api/v1/user') reply(200, viewer)
if (method === 'GET' && url.origin + url.pathname === endpoint)
  reply(200, { id: 50, full_name: forgejo.repository, archived: forgejo.archived === true, permissions: { push: forgejo.push === true } })
if (!url.href.startsWith(endpoint + '/')) reply(404, {})
const path = (url.origin + url.pathname).slice(endpoint.length)
const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
const find = url.searchParams
if (method === 'POST') {
  const match = /^\\/issues\\/(\\d+)\\/comments$/.exec(path)
  const issue = match && forgejo.issues.find(row => row.number === Number(match[1]))
  if (!issue || !args.includes('@-')) reply(404, {})
  if (forgejo.archived || (issue.is_locked && !forgejo.push) || forgejo.denyComment) reply(403, {})
  if (forgejo.refuseComment) reply(422, {})
  const input = await new Response(Bun.stdin.stream()).json()
  if (typeof input.body !== 'string' || !input.body.trim()) reply(422, {})
  const comment = { id: 703 + (forgejo.commentWrites?.length ?? 0), user: viewer, body: input.body,
    issue_url: endpoint + '/issues/' + issue.number, created_at: '2026-11-27T17:00:00Z' }
  forgejo.commentWrites ??= []
  forgejo.commentWrites.push([issue.number, viewer.id, comment.id])
  forgejo.comments.push(comment)
  issue.comments++
  if (forgejo.dropCommentReply) {
    delete forgejo.dropCommentReply
    forgejo.failCommentRead = true
    writeFileSync(statePath, JSON.stringify(state))
    reply(502, {})
  }
  writeFileSync(statePath, JSON.stringify(state))
  reply(201, comment)
}
if (path === '/issues') {
  const rows = forgejo.issues.filter(row => {
    if (find.get('state') !== 'all' && row.state !== find.get('state')) return false
    const text = find.get('q')
    if (text && ![row.title, row.body].some(value => value?.toLowerCase().includes(text.toLowerCase()))) return false
    const label = find.get('labels')
    if (label && !label.split(',').some(name => row.labels?.some(item => item.name === name))) return false
    if (find.has('assigned_by') && !row.assignees?.some(user => user.login === find.get('assigned_by'))) return false
    if (find.has('created_by') && row.user?.login !== find.get('created_by')) return false
    if (find.has('mentioned_by') && !row.body?.includes('@' + find.get('mentioned_by'))) return false
    return true
  }).sort((a, b) => {
    const sort = find.get('sort') === 'latest' ? 'created_at' : 'updated_at'
    return Date.parse(b[sort]) - Date.parse(a[sort])
  })
  const size = 10
  reply(200, rows.slice((page - 1) * size, page * size), rows.length > page * size)
}
if (path === '/labels' || path === '/assignees') reply(200, page === 1 ? forgejo[path.slice(1)] : [])
const individual = /^\\/issues\\/(\\d+)(\\/comments)?$/.exec(path)
const issue = individual && forgejo.issues.find(row => row.number === Number(individual[1]))
if (!issue) reply(404, {})
if (!individual[2]) reply(200, issue)
if (forgejo.failCommentRead) {
  delete forgejo.failCommentRead
  writeFileSync(statePath, JSON.stringify(state))
  reply(503, {})
}
reply(200, forgejo.comments)
`, { mode: 0o755 })
}
