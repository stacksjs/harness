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
if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || flag('--login') !== forgejo.selected || flag('--repo') !== forgejo.repository) reply(401, {})
if (forgejo.unavailable) reply(503, {})
const viewer = { id: forgejo.viewerId ?? 17, login: forgejo.viewer }
if (method === 'GET' && url.origin + url.pathname === forgejo.base + '/api/v1/user') reply(200, viewer)
if (method === 'GET' && url.origin + url.pathname === endpoint)
  reply(200, { id: 50, full_name: forgejo.repository, archived: forgejo.archived === true, has_issues: forgejo.issuesEnabled !== false, permissions: { push: forgejo.push === true } })
const pullPath = url.origin + url.pathname
if (method === 'GET' && pullPath.startsWith(forgejo.base + '/api/v1/repos/') && /\\/pulls\\/\\d+$/.test(pullPath)) {
  const request = forgejo.pulls?.[pullPath.slice((forgejo.base + '/api/v1/repos/').length)]
  if (!request) reply(404, {})
  reply(200, request)
}
if (!url.href.startsWith(endpoint + '/')) reply(404, {})
const path = (url.origin + url.pathname).slice(endpoint.length)
const page = Math.max(1, Number(url.searchParams.get('page')) || 1)
const find = url.searchParams
const reactionTarget = /^\\/issues\\/(comments\\/)?(\\d+)\\/reactions$/.exec(path)
if (reactionTarget) {
  const [, comment, id] = reactionTarget
  const subject = (comment ? 'comment:' : 'issue:') + id
  const subjectExists = comment ? forgejo.comments.some(row => row.id === Number(id)) : forgejo.issues.some(row => row.number === Number(id))
  if (!subjectExists) reply(404, {})
  const rows = forgejo.reactions?.[subject] ?? []
  if (method === 'GET') {
    if (forgejo.failReactionRead === subject) {
      delete forgejo.failReactionRead
      writeFileSync(statePath, JSON.stringify(state))
      reply(503, {})
    }
    if (comment) reply(200, rows)
    reply(200, rows.slice(page - 1, page), page < rows.length)
  }
  if (!['POST', 'DELETE'].includes(method) || !args.includes('@-')) reply(405, {})
  if (forgejo.archived || forgejo.denyReaction) reply(403, {})
  const input = await new Response(Bun.stdin.stream()).json()
  if (forgejo.refuseReaction || !['+1', '-1', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'].includes(input.content)
    || Object.keys(input).length !== 1) reply(422, {})
  const already = rows.find(row => row.content === input.content && row.user?.id === viewer.id)
  const reaction = { content: input.content, user: viewer }
  forgejo.reactions ??= {}
  forgejo.reactions[subject] = method === 'POST' ? already ? rows : [...rows, reaction] : rows.filter(row => row !== already)
  forgejo.reactionWrites ??= []
  forgejo.reactionWrites.push([subject, viewer.id, method, input.content])
  if (forgejo.dropReactionReply) {
    delete forgejo.dropReactionReply
    forgejo.failReactionRead = subject
    writeFileSync(statePath, JSON.stringify(state))
    reply(502, {})
  }
  writeFileSync(statePath, JSON.stringify(state))
  if (method === 'POST') reply(already ? 200 : 201, reaction)
  console.error('HTTP/1.1 200')
  process.exit(0)
}
function finishTriage(issue, kind, values) {
  forgejo.triageWrites ??= []
  forgejo.triageWrites.push([issue.number, viewer.id, kind, values])
  if (forgejo.dropTriageReply) {
    delete forgejo.dropTriageReply
    forgejo.failIssueRead = true
    writeFileSync(statePath, JSON.stringify(state))
    reply(502, {})
  }
  writeFileSync(statePath, JSON.stringify(state))
  reply(200, issue[kind])
}
if (method === 'PUT') {
  const match = /^\\/issues\\/(\\d+)\\/labels$/.exec(path)
  const issue = match && forgejo.issues.find(row => row.number === Number(match[1]))
  if (!issue || !args.includes('@-')) reply(404, {})
  if (forgejo.archived || !forgejo.push) reply(403, {})
  const input = await new Response(Bun.stdin.stream()).json()
  if (forgejo.refuseTriage || Object.keys(input).length !== 1 || !Array.isArray(input.labels)) reply(422, {})
  const labels = input.labels.map(id => forgejo.labels.find(label => label.id === id))
  if (labels.some(label => !label)) reply(422, {})
  issue.labels = labels
  finishTriage(issue, 'labels', input.labels)
}
if (method === 'PATCH') {
  const match = /^\\/issues\\/(\\d+)$/.exec(path)
  const issue = match && forgejo.issues.find(row => row.number === Number(match[1]))
  if (!issue || !args.includes('@-')) reply(404, {})
  if (forgejo.archived || (issue.user?.id !== viewer.id && !forgejo.push)) reply(403, {})
  const input = await new Response(Bun.stdin.stream()).json()
  const keys = Object.keys(input)
  if (keys.length !== 1) reply(422, {})
  const field = keys[0]
  if (field === 'assignees') {
    if (!forgejo.push) reply(403, {})
    if (forgejo.refuseTriage || !Array.isArray(input.assignees)) reply(422, {})
    const people = input.assignees.map(login => forgejo.assignees.find(user => user.login === login))
    if (people.some(user => !user)) reply(422, {})
    issue.assignees = people
    finishTriage(issue, 'assignees', input.assignees)
  }
  if (field === 'title' || field === 'body') {
    if (forgejo.refuseText || typeof input[field] !== 'string' || (field === 'title' && !input.title.trim())) reply(422, {})
    issue[field] = input[field]
    forgejo.textWrites ??= []
    forgejo.textWrites.push([issue.number, viewer.id, field, input[field]])
    if (forgejo.dropTextReply) {
      delete forgejo.dropTextReply
      forgejo.failIssueRead = true
      writeFileSync(statePath, JSON.stringify(state))
      reply(502, {})
    }
    writeFileSync(statePath, JSON.stringify(state))
    reply(200, issue)
  }
  if (forgejo.refuseStatus || !['open', 'closed'].includes(input.state)) reply(422, {})
  issue.state = input.state
  forgejo.statusWrites ??= []
  forgejo.statusWrites.push([issue.number, viewer.id, input.state])
  if (forgejo.dropStatusReply) {
    delete forgejo.dropStatusReply
    forgejo.failIssueRead = true
    writeFileSync(statePath, JSON.stringify(state))
    reply(502, {})
  }
  writeFileSync(statePath, JSON.stringify(state))
  reply(200, issue)
}
if (path === '/issue_templates' && method === 'GET') reply(200, forgejo.templates ?? [])
if (path === '/issue_config' && method === 'GET') {
  if (forgejo.issueConfigMissing) reply(404, {})
  reply(200, { blank_issues_enabled: forgejo.blankIssuesEnabled !== false })
}
if (path === '/issues' && method === 'POST') {
  if (forgejo.archived || forgejo.issuesEnabled === false || !args.includes('@-')) reply(403, {})
  const input = await new Response(Bun.stdin.stream()).json()
  if (forgejo.refuseCreate || Object.keys(input).sort().join(',') !== 'assignees,body,labels,title'
    || typeof input.title !== 'string' || typeof input.body !== 'string'
    || !Array.isArray(input.labels) || !Array.isArray(input.assignees)) reply(422, {})
  if (!forgejo.push && (input.labels.length || input.assignees.length)) reply(403, {})
  const labels = input.labels.map(id => forgejo.labels.find(label => label.id === id))
  const assignees = input.assignees.map(login => forgejo.assignees.find(person => person.login === login))
  if (labels.some(label => !label) || assignees.some(person => !person)) reply(422, {})
  const number = Math.max(100, ...forgejo.issues.map(row => row.number)) + 1
  const issue = { number, id: 1000 + number, title: input.title, body: input.body, user: viewer, state: 'open',
    html_url: forgejo.base + '/' + forgejo.repository + '/issues/' + number, labels, assignees,
    created_at: '2026-11-27T17:00:00Z', updated_at: '2026-11-27T17:00:00Z', comments: 0 }
  forgejo.issues.push(issue)
  forgejo.createWrites ??= []
  forgejo.createWrites.push({ number, actor: viewer.id, ...input })
  if (forgejo.dropCreateReply) {
    delete forgejo.dropCreateReply
    forgejo.failCreateScan = true
    writeFileSync(statePath, JSON.stringify(state))
    reply(502, {})
  }
  writeFileSync(statePath, JSON.stringify(state))
  reply(201, issue)
}
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
  if (forgejo.failCreateScan) {
    delete forgejo.failCreateScan
    writeFileSync(statePath, JSON.stringify(state))
    reply(503, {})
  }
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
  const size = forgejo.issuePageSize ?? 10
  reply(200, rows.slice((page - 1) * size, page * size), rows.length > page * size)
}
if (path === '/labels' || path === '/assignees') reply(200, page === 1 ? forgejo[path.slice(1)] : [])
const individual = /^\\/issues\\/(\\d+)(\\/(?:comments|timeline))?$/.exec(path)
const issue = individual && forgejo.issues.find(row => row.number === Number(individual[1]))
if (!issue) reply(404, {})
if (individual[2] === '/timeline') {
  if (forgejo.failTimelinePage === page) reply(503, {})
  const rows = issue.number === 73 ? forgejo.timeline ?? [] : []
  const size = 4
  reply(200, rows.slice((page - 1) * size, page * size), rows.length > page * size)
}
if (!individual[2]) {
  if (forgejo.failIssueRead) {
    delete forgejo.failIssueRead
    writeFileSync(statePath, JSON.stringify(state))
    reply(503, {})
  }
  reply(200, issue)
}
if (forgejo.failCommentRead) {
  delete forgejo.failCommentRead
  writeFileSync(statePath, JSON.stringify(state))
  reply(503, {})
}
reply(200, forgejo.comments)
`, { mode: 0o755 })
}
