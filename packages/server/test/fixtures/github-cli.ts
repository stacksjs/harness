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
  const configureViewed = (viewedMode: 'normal' | 'denied' | 'lost-response' | 'unreadable' | 'revised', viewer = 'fixture-viewer') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, viewedMode, viewer }))
  }
  const configureConversations = (conversationMode: 'normal' | 'readonly' | 'unreadable' | 'lost-response' | 'head-changed') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, conversationMode }))
  }
  const configureReplies = (replyMode: 'normal' | 'denied' | 'lost-response' | 'unconfirmed') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, replyMode }))
  }
  const configureCommentPages = (commentMode: 'normal' | 'overlap' | 'unavailable' | 'stalled') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, commentMode }))
  }
  const configureInlineReviews = (reviewMode: 'normal' | 'denied' | 'invalid' | 'lost-response' | 'unconfirmed', reviewAuthor = true) => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, reviewMode, reviewAuthor }))
  }
  const configureLifecycle = (lifecycleMode: 'normal' | 'readonly' | 'archived' | 'denied' | 'refused' | 'lost-response' | 'unconfirmed') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, lifecycleMode }))
  }
  const configureMerge = (mergeMode: 'ready' | 'blocked' | 'queue' | 'readonly', mergeMethods = ['MERGE', 'SQUASH', 'REBASE']) => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, mergeMode, mergeMethods }))
  }
  const revealLifecycle = () => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    const { invisibleLifecycle, ...shown } = previous
    if (invisibleLifecycle) {
      shown.pulls = shown.pulls.map((pull: { number: number }) => pull.number === invisibleLifecycle.number ? invisibleLifecycle : pull)
      writeFileSync(state, JSON.stringify(shown))
    }
  }
  const revealInlineReview = () => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    const { invisibleReview, ...shown } = previous
    if (invisibleReview) writeFileSync(state, JSON.stringify({ ...shown, inlineReviews: [...(shown.inlineReviews ?? []), invisibleReview] }))
  }
  const revealReply = () => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    const { invisibleReply, ...shown } = previous
    if (invisibleReply) writeFileSync(state, JSON.stringify({ ...shown, replies: [...(shown.replies ?? []), invisibleReply] }))
  }
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const stateFile = join(import.meta.dir, 'state.json')
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === 'auth' && args[1] === 'token') {
  process.stdout.write('fixture-token')
  process.exit(0)
}
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

function commentsFor(pull) {
  return [
    { id: 'fixture-inline', author: { login: 'fixture-reviewer' }, createdAt: '2026-11-01T14:00:00Z',
      url: pull.html_url + '#discussion_r4', body: 'Verify the **inline report**. <img src=x onerror=alert(1)> <!-- hidden inline marker -->' },
    { id: 'fixture-minimized', body: 'Hidden by GitHub', isMinimized: true, url: 'https://other.example/unsafe' },
    ...Array.from({ length: state.commentMode ? 43 : 0 }, (_, index) => ({
      id: 'fixture-page-comment-' + (index + 1), author: { login: 'fixture-reviewer' },
      createdAt: '2026-11-01T14:30:00Z', url: pull.html_url + '#discussion_r' + (100 + index),
      body: 'History comment **' + (index + 1) + '**.' + (index === 18 ? ' <script>private-fake-html()</script>' : ''),
    })),
    ...(state.replies ?? []),
  ]
}

function commentPage(pull, variables) {
  const all = commentsFor(pull)
  const prefix = 'comments:+'
  const cursor = variables.after || variables.before
  const index = cursor && cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : undefined
  if (cursor && (!Number.isSafeInteger(index) || index < 0 || index >= all.length)) return null
  const last = variables.before ? index : all.length
  const start = variables.last ? Math.max(0, last - variables.last) : variables.after ? index + 1 : 0
  const end = variables.last ? last : Math.min(all.length, start + (variables.first ?? 20))
  return { nodes: all.slice(state.commentMode === 'overlap' && variables.after ? start - 1 : start, end), pageInfo: {
    startCursor: prefix + start, endCursor: state.commentMode === 'stalled' && variables.after ? variables.after : prefix + (end - 1),
    hasPreviousPage: !variables.after && start > 0, hasNextPage: !variables.before && end < all.length,
  } }
}

if (url.pathname === '/user') reply(200, { login: 'fixture-user' })
if (url.pathname === '/graphql' && method === 'POST') {
  const { query, variables } = JSON.parse(await Bun.stdin.text())
  if (query.includes('mutation SetPullRequestFileViewed')) {
    if (!process.env.GH_TOKEN || variables.id !== 'fixture-pull' || variables.path !== 'report.txt') reply(400, {})
    if (state.viewedMode === 'denied') reply(403, { message: 'Private forge diagnostics must not leak' })
    const marked = query.includes(' markFileAsViewed(')
    state.fileViewed = marked
    state.viewedWrites = (state.viewedWrites || 0) + 1
    writeFileSync(stateFile, JSON.stringify(state))
    if (state.viewedMode === 'lost-response') process.exit(1)
    reply(200, { data: { [marked ? 'markFileAsViewed' : 'unmarkFileAsViewed']: { clientMutationId: null } } })
  }
  const viewer = { id: state.viewer || 'fixture-viewer', login: 'fixture-user' }
  if (query.includes('mutation HarnessSetPullRequestLifecycle')) {
    const id = variables.input?.pullRequestId ?? variables.input?.id ?? variables.id
    const pull = state.pulls.find(pull => 'fixture-pull-' + pull.number === id)
    const mutation = ['markPullRequestReadyForReview', 'convertPullRequestToDraft', 'closePullRequest', 'reopenPullRequest',
      'mergePullRequest', 'enablePullRequestAutoMerge', 'disablePullRequestAutoMerge', 'enqueuePullRequest', 'dequeuePullRequest'].find(key => query.includes(' ' + key + '('))
    if (!pull || !mutation || !process.env.GH_TOKEN || state.lifecycleMode === 'denied')
      reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Private lifecycle diagnostics' }] })
    if (state.lifecycleMode === 'refused')
      reply(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Private lifecycle diagnostics' }] })
    if (variables.input) {
      const { expectedHeadOid, mergeMethod } = variables.input
      const guarded = ['mergePullRequest', 'enablePullRequestAutoMerge', 'enqueuePullRequest'].includes(mutation)
      const needsMethod = ['mergePullRequest', 'enablePullRequestAutoMerge'].includes(mutation)
      if ((guarded && expectedHeadOid !== pull.head.sha) || (needsMethod && !state.mergeMethods?.includes(mergeMethod))
        || (!needsMethod && mergeMethod) || (mutation === 'mergePullRequest' && state.mergeMode !== 'ready'))
        reply(200, { errors: [{ type: 'UNPROCESSABLE' }] })
      state.mergeWrites = [...(state.mergeWrites ?? []), { mutation, input: variables.input }]
    }
    state.lifecycleWrites = (state.lifecycleWrites || 0) + 1
    const updated = { ...pull, updated_at: new Date(Date.UTC(2026, 10, 1, 16, 0, state.lifecycleWrites)).toISOString() }
    if (mutation === 'markPullRequestReadyForReview') updated.draft = false
    if (mutation === 'convertPullRequestToDraft') updated.draft = true
    if (mutation === 'closePullRequest') updated.state = 'closed'
    if (mutation === 'reopenPullRequest') updated.state = 'open'
    if (mutation === 'mergePullRequest') {
      updated.state = 'closed'
      updated.merged_at = updated.updated_at
      updated.base = { ...pull.base, sha: 'c'.repeat(40) }
    }
    if (mutation === 'enablePullRequestAutoMerge') updated.autoMergeMethod = variables.input.mergeMethod
    if (mutation === 'disablePullRequestAutoMerge') updated.autoMergeMethod = null
    if (mutation === 'enqueuePullRequest') updated.queueEntry = 'fixture-queue-' + pull.number
    if (mutation === 'dequeuePullRequest') updated.queueEntry = null
    if (state.lifecycleMode === 'unconfirmed') state.invisibleLifecycle = updated
    else Object.assign(pull, updated)
    writeFileSync(stateFile, JSON.stringify(state))
    if (state.lifecycleMode === 'unconfirmed' || state.lifecycleMode === 'lost-response') process.exit(1)
    reply(200, { data: { [mutation]: { pullRequest: { id: variables.id } } } })
  }
  const isResolved = Boolean(state.conversationResolved)
  const allowed = state.conversationMode !== 'readonly'
  const thread = { id: 'fixture-conversation', isResolved, viewerCanResolve: allowed && !isResolved,
    viewerCanUnresolve: allowed && isResolved, viewerCanReply: state.replyMode !== 'denied' && allowed }
  if (query.includes('mutation AddPullRequestConversationReply')) {
    const pull = state.pulls[0]
    if (!process.env.GH_TOKEN || !pull || !thread.viewerCanReply || variables.id !== thread.id) reply(403, {})
    state.replyRequests = (state.replyRequests || 0) + 1
    const comment = { id: 'fixture-reply-' + state.replyRequests, author: viewer, body: variables.body,
      createdAt: '2026-11-01T15:00:00Z', url: pull.html_url + '#discussion_r' + (20 + state.replyRequests) }
    if (state.replyMode === 'unconfirmed') state.invisibleReply = comment
    else state.replies = [...(state.replies ?? []), comment]
    writeFileSync(stateFile, JSON.stringify(state))
    if (state.replyMode === 'unconfirmed' || state.replyMode === 'lost-response') process.exit(1)
    reply(200, { data: { addPullRequestReviewThreadReply: { comment } } })
  }
  if (query.includes('mutation SetPullRequestConversationResolved')) {
    if (!process.env.GH_TOKEN || !allowed || variables.id !== thread.id) reply(403, {})
    const resolved = query.includes(' resolveReviewThread(')
    state.conversationResolved = resolved
    state.conversationWrites = (state.conversationWrites || 0) + 1
    writeFileSync(stateFile, JSON.stringify(state))
    if (state.conversationMode === 'lost-response') process.exit(1)
    reply(200, { data: { [resolved ? 'resolveReviewThread' : 'unresolveReviewThread']: { thread: { id: thread.id, isResolved: resolved } } } })
  }
  if (query.includes('query PullRequestReviewConversation(')) {
    const pull = state.pulls[0]
    const comments = pull && variables.replies ? commentPage(pull, variables) : undefined
    if (variables.replies && (!comments || (state.commentMode === 'unavailable' && variables.after)))
      reply(200, { errors: [{ message: 'Private comment page diagnostics' }] })
    const node = !pull || ![thread.id, 'other-conversation'].includes(variables.id) ? null : {
      ...thread, id: variables.id, pullRequest: { number: pull.number, headRefOid: pull.head.sha,
        repository: { nameWithOwner: variables.id === thread.id ? pull.base.repo.full_name : 'fixture/another-project' } },
      ...(variables.replies && { comments }),
    }
    reply(200, { data: { viewer, node } })
  }
  const name = variables.owner + '/' + variables.name
  const pull = state.pulls.find(pull => pull.base.repo.full_name === name && pull.number === variables.number)
  if (query.includes('query HarnessPullRequestLifecycle')) {
    const enabled = Boolean(state.mergeMode)
    reply(200, { data: { viewer, repository: { nameWithOwner: name, isArchived: state.lifecycleMode === 'archived',
      viewerPermission: enabled && state.mergeMode !== 'readonly' ? 'WRITE' : 'READ', autoMergeAllowed: enabled,
      mergeCommitAllowed: state.mergeMethods?.includes('MERGE'), squashMergeAllowed: state.mergeMethods?.includes('SQUASH'),
      rebaseMergeAllowed: state.mergeMethods?.includes('REBASE'), pullRequest: pull ? {
      id: 'fixture-pull-' + pull.number, number: pull.number, state: pull.merged_at ? 'MERGED' : pull.state.toUpperCase(),
      isDraft: pull.draft, headRefOid: pull.head.sha, baseRefOid: pull.base.sha, updatedAt: pull.updated_at,
      baseRefName: pull.base.ref, viewerCanUpdate: state.lifecycleMode !== 'readonly',
      mergeable: 'MERGEABLE', mergeStateStatus: state.mergeMode === 'blocked' ? 'BLOCKED' : 'CLEAN',
      isMergeQueueEnabled: state.mergeMode === 'queue', mergeQueueEntry: pull.queueEntry ? { id: pull.queueEntry } : null,
      autoMergeRequest: pull.autoMergeMethod ? { mergeMethod: pull.autoMergeMethod } : null,
      viewerCanEnableAutoMerge: state.mergeMode === 'blocked', viewerCanDisableAutoMerge: Boolean(pull.autoMergeMethod),
    } : null } } })
  }
  if (query.includes('query HarnessPullRequestReviewAccount')) {
    if (!process.env.GH_TOKEN || !pull) reply(404, {})
    reply(200, { data: { viewer, repository: { pullRequest: { viewerDidAuthor: state.reviewAuthor !== false } } } })
  }
  if (query.includes('query PullRequestReviewConversations')) {
    if (!pull || state.conversationMode === 'unreadable') reply(200, { errors: [{ message: 'Private conversation diagnostics' }] })
    const inline = {
      ...thread, path: 'report.txt', line: 1, startLine: 1, diffSide: 'RIGHT', isOutdated: false,
      comments: commentPage(pull, { first: 20 }),
    }
    const outdated = { ...thread, id: 'fixture-outdated', isResolved: true, viewerCanResolve: false, viewerCanUnresolve: false,
      path: 'report.txt', originalLine: 12, line: null, diffSide: 'LEFT', isOutdated: true,
      comments: { nodes: [{ id: 'fixture-outdated-comment', body: 'Previous review location' }] },
    }
    const detached = { ...outdated, id: 'fixture-detached', path: 'removed-earlier.txt', comments: { nodes: [{ id: 'fixture-detached-comment', body: 'Earlier file discussion' }] } }
    const posted = (state.inlineReviews ?? []).filter(review => review.pull === pull.number).flatMap(review => review.comments.map((comment, index) => ({
      ...thread, id: 'fixture-review-' + review.id + '-' + index, path: comment.path, line: comment.line, startLine: comment.start_line,
      diffSide: comment.side, startDiffSide: comment.start_side, isOutdated: false,
      comments: { nodes: [{ id: 'fixture-review-comment-' + review.id + '-' + index, author: viewer, body: comment.body,
        createdAt: '2026-11-01T16:00:00Z', url: pull.html_url + '#discussion_r' + (500 + review.id * 50 + index) }] },
    })))
    const second = variables.cursor === 'more-conversations'
    reply(200, { data: { viewer, repository: { pullRequest: { id: 'fixture-pull',
      headRefOid: second && state.conversationMode === 'head-changed' ? 'd'.repeat(40) : pull.head.sha,
      reviewThreads: { nodes: second ? [outdated, detached] : [...(state.conversationMode ? [inline] : []), ...posted],
        pageInfo: { hasNextPage: Boolean(state.conversationMode) && !second, endCursor: 'more-conversations' } },
    } } } })
  }
  if (query.includes('query PullRequestViewedFiles')) {
    if (!pull || state.viewedMode === 'unreadable') reply(200, { errors: [{ message: 'Private viewed diagnostics must not leak' }] })
    reply(200, { data: { viewer: { id: state.viewer || 'fixture-viewer', login: 'fixture-user' }, repository: { pullRequest: {
      id: 'fixture-pull', headRefOid: pull.head.sha, files: variables.cursor === '2'
        ? { nodes: [{ path: 'report.txt', viewerViewedState: state.viewedMode === 'revised' ? 'DISMISSED' : state.fileViewed ? 'VIEWED' : 'UNVIEWED' }], pageInfo: { hasNextPage: false } }
        : { nodes: [{ path: 'other.txt', viewerViewedState: 'VIEWED' }], pageInfo: { hasNextPage: true, endCursor: '2' } },
    } } } })
  }
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
  ...(state.inlineReviews ?? []).filter(review => review.pull === detail.number).map(review => ({ ...review, event: 'reviewed' })),
])
if (parts[4] !== 'pulls') reply(404, {})
if (parts[6] === 'reviews') {
  if (!detail || !process.env.GH_TOKEN) reply(404, {})
  if (method === 'GET') reply(200, (state.inlineReviews ?? []).filter(review => review.pull === detail.number))
  const input = JSON.parse(await Bun.stdin.text())
  state.reviewRequests = (state.reviewRequests || 0) + 1
  const statuses = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }
  if (state.reviewMode === 'denied' || state.reviewMode === 'invalid') {
    writeFileSync(stateFile, JSON.stringify(state))
    reply(state.reviewMode === 'denied' ? 403 : 422, { message: 'Private review diagnostics' })
  }
  if (input.commit_id !== detail.head.sha || !statuses[input.event] || !Array.isArray(input.comments)) reply(422, {})
  const review = { ...input, id: state.reviewRequests, pull: detail.number, state: statuses[input.event],
    user: { login: 'fixture-user' }, submitted_at: '2026-11-01T16:00:00Z' }
  if (state.reviewMode === 'unconfirmed') state.invisibleReview = review
  else state.inlineReviews = [...(state.inlineReviews ?? []), review]
  writeFileSync(stateFile, JSON.stringify(state))
  if (state.reviewMode === 'unconfirmed' || state.reviewMode === 'lost-response') process.exit(1)
  reply(200, review)
}
if (method === 'GET' && parts[5]) {
  if (!detail) reply(404, {})
  if (parts[6] === 'files') reply(200, [{ filename: 'report.txt', status: 'modified', additions: 3, deletions: 2,
    patch: ['@@ -1,2 +1,3 @@', '-Old report', '+Report fixture', '+Report details', ' Shared context',
      '@@ -20 +21 @@', '-Old ending', '+New ending'].join(String.fromCharCode(10)) }])
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
  base: { ref: input.base, sha: repo && head(repo, input.base), repo: { full_name: name } },
  head: { ref: headRef, sha, label: owner + ':' + headRef, repo: { full_name: repositoryName } } }
state.pulls.push(pull)
writeFileSync(stateFile, JSON.stringify(state))
if (state.mode === 'lost-response') process.exit(1)
reply(201, pull)
`, { mode: 0o700 })
  return { bin, state, configure, configureChecks, configureViewed, configureConversations, configureReplies, configureCommentPages,
    revealReply, configureInlineReviews, revealInlineReview, configureLifecycle, revealLifecycle, configureMerge }
}
