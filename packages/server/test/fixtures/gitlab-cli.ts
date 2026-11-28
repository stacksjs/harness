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
  const currentUser = { id: 'gid://gitlab/User/' + viewer }
  const connect = nodes => ({ nodes, pageInfo: { hasNextPage: false } })
  const allLabels = [...(gitlab.labels ?? []), { name: 'offline' }, { name: 'Unrelated label' }].flatMap((label, i) =>
    typeof label.name === 'string' ? [{ id: 'gid://gitlab/' + (i === 0 ? 'GroupLabel/' : 'ProjectLabel/') + (700 + i),
      title: label.name, description: label.description ?? '', archived: label.archived === true }] : [])
  const allMembers = (gitlab.members ?? []).flatMap((member, i) => /^[a-z0-9._-]+$/i.test(member.username ?? '')
    ? [{ id: 'gid://gitlab/User/' + (800 + i), username: member.username, name: member.name, state: member.state ?? 'active' }] : [])
  const projectInfo = { id: 'gid://gitlab/Project/74', fullPath: gitlab.repository, archived: gitlab.archived === true,
    multipleAssignees: { available: gitlab.multipleAssignees !== false } }
  const issue = () => ({ id: 'gid://gitlab/Issue/2000', iid: String(gitlab.issue.iid), webUrl: gitlab.issue.web_url,
    title: gitlab.issue.title, description: gitlab.issue.description ?? null, state: gitlab.issue.state, discussionLocked: gitlab.locked === true,
    labels: connect(allLabels.filter(label => gitlab.issue.labels.includes(label.title))),
    assignees: connect(allMembers.filter(member => gitlab.issue.assignees?.some(assignee => assignee.username === member.username))),
    userPermissions: { updateIssue: gitlab.canEditText === true, createNote: gitlab.canComment === true && !gitlab.locked,
      adminIssue: gitlab.canTriage === true, reopenIssue: gitlab.canEditText === true && !gitlab.denyReopen } })
  const note = item => ({ id: 'gid://gitlab/Note/' + item.id, body: item.body, noteableId: 2000, noteableType: 'Issue',
    system: item.system === true, internal: item.internal === true, author: { id: 'gid://gitlab/User/' + item.author.id } })
  if (query.includes('query HarnessGitLabIssueText')) {
    if (gitlab.noLicensedField && query.includes('licensedFeatureAvailability'))
      respond(200, { errors: [{ extensions: { code: 'undefinedField', typeName: 'Project', fieldName: 'licensedFeatureAvailability' } }] })
    if (gitlab.failTextRead) {
      delete gitlab.failTextRead
      writeFileSync(statePath, JSON.stringify(state))
      respond(503, {})
    }
    if (variables.path !== gitlab.repository || variables.iid !== String(gitlab.issue.iid)) respond(200, { data: { project: null } })
    if (gitlab.failTriageRead && (query.includes('labels(first:') || query.includes('assignees(first:'))) {
      delete gitlab.failTriageRead
      writeFileSync(statePath, JSON.stringify(state))
      respond(503, {})
    }
    const project = { ...projectInfo, issue: issue() }
    if (gitlab.noLicensedField) delete project.multipleAssignees
    respond(200, { data: { currentUser, project } })
  }
  if (query.includes('query HarnessGitLabTriageChoices')) {
    if (!pinned || variables.path !== gitlab.repository || typeof variables.search !== 'string') respond(400, {})
    if (gitlab.catalogUnavailable) respond(403, {})
    const search = variables.search.toLowerCase()
    if (query.includes('labels(first:')) {
      if (!query.includes('includeAncestorGroups: true')) respond(400, {})
      if (gitlab.noArchivedField && query.includes('description archived'))
        respond(200, { errors: [{ extensions: { code: 'undefinedField', typeName: 'Label', fieldName: 'archived' } }] })
      respond(200, { data: { currentUser, project: { ...projectInfo, labels: connect(allLabels.filter(label => label.title.toLowerCase().includes(search))) } } })
    }
    const nodes = allMembers.filter(member => member.username.toLowerCase().includes(search) || member.name.toLowerCase().includes(search)).map(user => ({ user }))
    respond(200, { data: { currentUser, project: { ...projectInfo, projectMembers: connect(nodes) } } })
  }
  if (query.includes('mutation HarnessGitLabTriage')) {
    if (!pinned || !gitlab.canTriage || gitlab.archived) respond(403, {})
    const input = variables.input
    if (input.projectPath !== gitlab.repository || input.iid !== String(gitlab.issue.iid)) respond(400, {})
    const assignees = query.includes('issueSetAssignees')
    const name = assignees ? 'issueSetAssignees' : 'updateIssue'
    if (gitlab.refuseTriage) respond(200, { data: { [name]: { issue: issue(), errors: ['Fixture rejected this change'] } } })
    if (assignees) {
      if (input.operationMode !== 'REPLACE' || !Array.isArray(input.assigneeUsernames)) respond(400, {})
      const users = input.assigneeUsernames.map(username => allMembers.find(member => member.username === username))
      if (users.some(user => !user)) respond(400, {})
      gitlab.issue.assignees = users.map(({ id, username }) => ({ id: Number(id.split('/').at(-1)), username }))
    }
    else {
      const labels = ids => Array.isArray(ids) ? ids.map(id => allLabels.find(label => label.id.endsWith('/' + id))?.title) : [null]
      const added = labels(input.addLabelIds), removed = labels(input.removeLabelIds)
      if (added.some(label => !label) || removed.some(label => !label)) respond(400, {})
      gitlab.issue.labels = [...new Set([...gitlab.issue.labels.filter(label => !removed.includes(label)), ...added])]
    }
    gitlab.triageWrites ??= []
    gitlab.triageWrites.push({ viewer, kind: assignees ? 'assignees' : 'labels', input })
    if (gitlab.dropTriageReply) {
      delete gitlab.dropTriageReply
      gitlab.failTriageRead = true
      writeFileSync(statePath, JSON.stringify(state))
      respond(502, {})
    }
    writeFileSync(statePath, JSON.stringify(state))
    respond(200, { data: { [name]: { issue: issue(), errors: [] } } })
  }
  if (query.includes('mutation HarnessPostGitLabIssueComment')) {
    if (!pinned || !gitlab.canComment || gitlab.locked || gitlab.archived) respond(403, {})
    const input = variables.input
    if (input.noteableId !== issue().id || typeof input.body !== 'string') respond(400, {})
    if (gitlab.refuseComment) respond(200, { data: { createNote: { note: null, errors: ['Fixture rejected the comment'] } } })
    const body = input.body.replaceAll('\\n/subscribe\\n', '\\n')
    const item = { id: (gitlab.notes.at(-1)?.id ?? 0) + 1, body, created_at: '2026-11-27T19:00:00Z',
      author: { id: viewer, username: 'fixture-reviewer' } }
    gitlab.notes.push(item)
    gitlab.issue.user_notes_count = gitlab.notes.length
    gitlab.commentWrites = (gitlab.commentWrites ?? 0) + 1
    if (gitlab.dropCommentReply) {
      delete gitlab.dropCommentReply
      gitlab.failCommentRead = true
      writeFileSync(statePath, JSON.stringify(state))
      respond(502, {})
    }
    writeFileSync(statePath, JSON.stringify(state))
    respond(200, { data: { createNote: { note: note(item), errors: [] } } })
  }
  if (query.includes('query HarnessFindGitLabIssueComment')) {
    if (!pinned || variables.path !== gitlab.repository || variables.iid !== String(gitlab.issue.iid)) respond(400, {})
    if (gitlab.failCommentRead) {
      delete gitlab.failCommentRead
      writeFileSync(statePath, JSON.stringify(state))
      respond(503, {})
    }
    const authored = gitlab.notes.filter(item => item.author.id).map(note)
    const decoy = authored.at(-1)
    const nodes = decoy && !variables.before ? [
      { ...decoy, id: 'gid://gitlab/Note/9101', author: { id: 'gid://gitlab/User/99' } },
      { ...decoy, id: 'gid://gitlab/Note/9102', noteableId: 9999 },
      { ...decoy, id: 'gid://gitlab/Note/9103', internal: true },
      { ...decoy, id: 'gid://gitlab/Note/9104', system: true },
    ] : authored
    const pageInfo = { hasPreviousPage: Boolean(decoy && !variables.before), startCursor: 'fixture-page-2' }
    respond(200, { data: { currentUser, project: { issue: { id: issue().id, notes: { nodes, pageInfo } } } } })
  }
  if (query.includes('mutation HarnessGitLabIssueStatus')) {
    if (!pinned || !gitlab.canEditText || gitlab.archived) respond(403, {})
    const input = variables.input
    if (input.projectPath !== gitlab.repository || input.iid !== String(gitlab.issue.iid) || !['CLOSE', 'REOPEN'].includes(input.stateEvent))
      respond(400, {})
    if (input.stateEvent === 'REOPEN' && gitlab.denyReopen) respond(403, {})
    if (gitlab.refuseStatus) respond(200, { data: { updateIssue: { issue: null, errors: ['Fixture rejected this status change'] } } })
    gitlab.issue.state = input.stateEvent === 'CLOSE' ? 'closed' : 'opened'
    gitlab.statusWrites ??= []
    gitlab.statusWrites.push([gitlab.issue.state, viewer])
    if (gitlab.dropStatusReply) {
      delete gitlab.dropStatusReply
      gitlab.failTextRead = true
      writeFileSync(statePath, JSON.stringify(state))
      respond(502, {})
    }
    writeFileSync(statePath, JSON.stringify(state))
    respond(200, { data: { updateIssue: { issue: issue(), errors: [] } } })
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
