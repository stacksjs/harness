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
  const configureBranchUpdate = (branchBehind: number, branchMode: 'normal' | 'readonly' | 'conflict' | 'missing-ref' = 'normal') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    Object.assign(previous.pulls[0], { branchBehind, branchMode })
    writeFileSync(state, JSON.stringify(previous))
  }
  const configureRevert = (revertMode: 'normal' | 'denied' | 'unavailable' | 'unconfirmed' | 'wrong-author' | 'paged') => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, revertMode }))
  }
  const configureBranchDeletion = (settings: { mode?: 'normal' | 'readonly' | 'denied' | 'lost-response' | 'moved-on-write',
    repository?: string, target?: string | null, defaultBranch?: string, protected?: boolean, stacked?: boolean } = {}) => {
    const previous = JSON.parse(readFileSync(state, 'utf8'))
    writeFileSync(state, JSON.stringify({ ...previous, branchDeletion: { ...previous.branchDeletion, ...settings } }))
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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
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

function reply(status, body, headers = '') {
  process.stdout.write('HTTP/2.0 ' + status + ' Fixture\\r\\ncontent-type: application/json\\r\\n' + headers + '\\r\\n' + (body === undefined ? '' : JSON.stringify(body)))
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

if (url.pathname === '/user') reply(200, { login: state.actor ?? 'fixture-user' })
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
  if (query.includes('query HarnessPullRequestListDetails')) {
    const repository = variables.owner + '/' + variables.name
    if (!state.repositories[repository]) reply(404, {})
    const mode = state.listMetadataMode
    if (mode === 'unavailable') reply(503, { message: 'Private metadata diagnostics' })
    const selected = Object.fromEntries([...query.matchAll(/pr(\\d+): pullRequest\\(number: \\d+\\)/g)].map(([, number]) => {
      const pull = state.pulls.find(pull => pull.base.repo.full_name === repository && String(pull.number) === number)
      if (!pull || (mode === 'partial' && number === '3')) return ['pr' + number, null]
      const sha = mode === 'head-changed' && number === '1' ? 'e'.repeat(40) : pull.head.sha
      const decisions = { approved: 'APPROVED', changes_requested: 'CHANGES_REQUESTED', required: 'REVIEW_REQUIRED' }
      return ['pr' + number, {
        number: pull.number, headRefOid: sha, isDraft: Boolean(pull.draft),
        mergeable: pull.listConflict ? 'CONFLICTING' : 'MERGEABLE',
        reviewDecision: decisions[pull.filterReview] ?? null,
        additions: pull.additions, deletions: pull.deletions,
        reviewRequests: { nodes: (pull.requested_reviewers ?? []).map(user => ({ requestedReviewer: user })) },
        commits: { nodes: [{ commit: { oid: pull.listCheckHead ?? sha,
          statusCheckRollup: pull.filterChecks ? { state: pull.filterChecks.toUpperCase() } : null } }] },
      }]
    }))
    reply(200, { data: { viewer: { ...viewer, login: state.listViewer ?? viewer.login }, repository: {
      nameWithOwner: mode === 'wrong-repo' ? 'fixture/unrelated' : repository, isPrivate: state.privateRepository === repository, ...selected,
    } } })
  }
  const branchDeletion = state.branchDeletion
  const branchPull = state.pulls[0]
  const sourceRepository = branchDeletion && branchPull ? {
    id: 'fixture-repo:' + (branchDeletion.repository ?? branchPull.base.repo.full_name),
    nameWithOwner: branchDeletion.repository ?? branchPull.base.repo.full_name, isArchived: false,
    viewerPermission: branchDeletion.mode === 'readonly' ? 'READ' : 'WRITE',
    defaultBranchRef: { name: branchDeletion.defaultBranch ?? 'main' },
  } : null
  const branchRefName = sourceRepository ? 'refs/heads/' + branchPull.head.ref : null
  const sourceTarget = sourceRepository ? (branchDeletion.target === undefined ? branchPull.head.sha : branchDeletion.target) : null
  const sourceRef = sourceTarget ? { name: branchPull.head.ref, prefix: 'refs/heads/', target: { oid: sourceTarget },
    branchProtectionRule: branchDeletion?.protected ? { id: 'fixture-protection' } : null } : null
  if (query.includes('query HarnessReadPullRequestSourceBranch')) {
    if (!sourceRepository || !process.env.GH_TOKEN || sourceRepository.id !== variables.id || branchRefName !== variables.ref)
      reply(400, {})
    if (branchDeletion.mode === 'lost-response' && sourceTarget === null) process.exit(1)
    reply(200, { data: { viewer, node: { ...sourceRepository, ref: sourceRef } } })
  }
  if (query.includes('mutation HarnessDeletePullRequestBranch')) {
    const input = variables.input
    const updates = input?.refUpdates
    const update = updates?.[0]
    if (!sourceRepository || !process.env.GH_TOKEN || sourceRepository.id !== input?.repositoryId || updates?.length !== 1
      || update.name !== branchRefName || update.afterOid !== '0'.repeat(40)) reply(400, {})
    if (branchDeletion.mode === 'denied') reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Private branch deletion diagnostics' }] })
    state.deleteBranchWrites = [...(state.deleteBranchWrites ?? []), input]
    if (branchDeletion.mode === 'moved-on-write') branchDeletion.target = 'e'.repeat(40)
    if (update.beforeOid !== (branchDeletion.target === undefined ? sourceTarget : branchDeletion.target)) {
      writeFileSync(stateFile, JSON.stringify(state))
      reply(200, { errors: [{ message: 'Private stale ref diagnostics' }] })
    }
    branchDeletion.target = null
    writeFileSync(stateFile, JSON.stringify(state))
    if (branchDeletion.mode === 'lost-response') process.exit(1)
    reply(200, { data: { updateRefs: { clientMutationId: input.clientMutationId } } })
  }
  const revertCandidate = pull => ({
    id: 'fixture-pull-' + pull.number, number: pull.number, baseRefName: pull.base.ref, body: pull.body,
    author: { id: pull.authorId }, repository: { nameWithOwner: pull.base.repo.full_name },
  })
  if (query.includes('query HarnessFindPullRequestRevert')) {
    if (state.revertMode === 'unavailable') reply(200, { errors: [{ message: 'Private revert lookup diagnostics' }] })
    const source = state.pulls.find(pull => 'fixture-pull-' + pull.number === variables.id)
    const previousPage = state.revertMode === 'paged' && !variables.before
    const nodes = previousPage || state.revertMode === 'unconfirmed' ? [] : state.pulls.filter(pull => pull.reverts === source?.number)
      .map((pull) => ({ source: revertCandidate(state.revertMode === 'wrong-author' ? { ...pull, authorId: 'different-github-account' } : pull) }))
    reply(200, { data: { viewer, node: !source ? null : { id: variables.id, timelineItems: {
      nodes, pageInfo: { hasPreviousPage: previousPage, startCursor: previousPage ? 'previous-revert-page' : null },
    } } } })
  }
  if (query.includes('mutation HarnessRevertPullRequest')) {
    const input = variables.input
    const source = state.pulls.find(pull => 'fixture-pull-' + pull.number === input?.pullRequestId)
    if (!source?.merged_at || !process.env.GH_TOKEN || state.revertMode === 'denied')
      reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Private revert mutation diagnostics' }] })
    const number = state.pulls.length + 1
    const pull = { ...source, number, state: 'open', merged_at: null, title: 'Revert "' + source.title + '"',
      html_url: 'https://github.com/' + source.base.repo.full_name + '/pull/' + number, body: input.body,
      reverts: source.number, authorId: viewer.id, head: { ...source.head, ref: 'revert-' + source.number, sha: 'f'.repeat(40) } }
    state.revertWrites = [...(state.revertWrites ?? []), input]
    state.pulls.push(pull)
    writeFileSync(stateFile, JSON.stringify(state))
    if (state.revertMode === 'unconfirmed') process.exit(1)
    reply(200, { data: { revertPullRequest: {
      clientMutationId: input.clientMutationId, pullRequest: { id: input.pullRequestId }, revertPullRequest: revertCandidate(pull),
    } } })
  }
  if (query.includes('mutation HarnessSetPullRequestLifecycle')) {
    const id = variables.input?.pullRequestId ?? variables.input?.id ?? variables.id
    const pull = state.pulls.find(pull => 'fixture-pull-' + pull.number === id)
    const mutation = ['markPullRequestReadyForReview', 'convertPullRequestToDraft', 'closePullRequest', 'reopenPullRequest',
      'mergePullRequest', 'enablePullRequestAutoMerge', 'disablePullRequestAutoMerge', 'enqueuePullRequest', 'dequeuePullRequest', 'updatePullRequestBranch'].find(key => query.includes(' ' + key + '('))
    if (!pull || !mutation || !process.env.GH_TOKEN || state.lifecycleMode === 'denied')
      reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Private lifecycle diagnostics' }] })
    if (state.lifecycleMode === 'refused')
      reply(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Private lifecycle diagnostics' }] })
    if (mutation === 'updatePullRequestBranch') {
      const input = variables.input
      if (pull.branchMode !== 'normal' || pull.branchBehind <= 0 || input?.expectedHeadOid !== pull.head.sha
        || !['MERGE', 'REBASE'].includes(input?.updateMethod)) reply(200, { errors: [{ type: 'UNPROCESSABLE' }] })
      state.branchWrites = [...(state.branchWrites ?? []), input]
    }
    else if (variables.input) {
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
    if (mutation === 'updatePullRequestBranch') {
      updated.head = { ...pull.head, sha: 'f'.repeat(40) }
      updated.branchBehind = 0
    }
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
  const issueActor = actor => ({ id: actor.id ?? 'PERSON_' + actor.login, login: actor.login, name: actor.name ?? '' })
  const issueNodeId = (repo, issue) => 'ISSUE_' + repo.replace('/', '_') + '_' + issue.number
  const canChangeIssueState = !state.issueArchived && (state.issuePermission === 'TRIAGE' || state.issueAuthorCanChange === true)
  if (query.includes('query HarnessIssueMetadataAuthority')) {
    const repo = variables.owner + '/' + variables.name
    const issue = state.issues?.[repo]?.find(issue => issue.number === variables.number)
    if (state.issueUnsupportedPlanning && query.includes('planningStatuses(first'))
      reply(200, { errors: [{ extensions: { code: 'undefinedField', fieldName: 'planningStatuses' } }] })
    if (state.assigneeHiddenRead || state.issueStateHiddenRead) {
      delete state.assigneeHiddenRead
      delete state.issueStateHiddenRead
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    reply(200, { data: { viewer: { id: 'VIEWER_' + (state.actor ?? 'fixture-user') },
      repository: state.repositories[repo] && { id: 'REPO_' + repo.replace('/', '_'), nameWithOwner: repo,
        viewerPermission: state.issuePermission ?? 'READ', isArchived: Boolean(state.issueArchived),
        ...(state.planningStatuses && { planningStatuses: { nodes: state.planningStatuses, pageInfo: { hasNextPage: false } } }),
        issue: issue && !issue.pull_request ? { id: issueNodeId(repo, issue), number: issue.number,
          locked: Boolean(state.issueLocked), state: issue.state.toUpperCase(), stateReason: issue.state_reason?.toUpperCase() ?? null,
          viewerCanClose: canChangeIssueState, viewerCanReopen: canChangeIssueState,
          viewerCanSetStatus: canChangeIssueState && state.issuePermission === 'TRIAGE',
          status: state.planningStatuses?.find(item => item.id === issue.status_id) ?? null,
          assignees: { nodes: (issue.assignees ?? []).map(issueActor), pageInfo: { hasNextPage: false } } } : null } } })
  }
  if (query.includes('query HarnessIssueAssignablePeople')) {
    const repo = variables.owner + '/' + variables.name
    if (!state.repositories[repo] || !process.env.GH_TOKEN) reply(403, {})
    const needle = variables.search.toLowerCase()
    const users = (state.filterAssignees ?? []).filter(user => (user.login + ' ' + user.name).toLowerCase().includes(needle))
    reply(200, { data: { repository: { nameWithOwner: repo,
      assignableUsers: { nodes: users.slice(0, 50).map(issueActor), pageInfo: { hasNextPage: users.length > 50 } } } } })
  }
  if (query.includes('mutation HarnessPostIssueComment') || query.includes('query HarnessFindIssueComment')) {
    const posting = query.includes('mutation HarnessPostIssueComment')
    const input = variables.input
    const target = posting ? input?.subjectId : variables.id
    const located = Object.entries(state.issues ?? {}).flatMap(([repository, issues]) =>
      issues.filter(issue => issueNodeId(repository, issue) === target).map(issue => ({ repository, issue })))[0]
    if (!process.env.GH_TOKEN || !located) reply(404, {})
    const viewerId = 'VIEWER_' + (state.actor ?? 'fixture-user')
    const toNode = comment => ({ fullDatabaseId: String(comment.id), body: comment.body, author: { id: comment.user?.node_id }, issue: { id: target } })
    const comments = located.issue.comments ??= []
    if (!posting) {
      if (state.issueHideComment) reply(200, { data: { viewer: { id: viewerId }, node: { id: target, comments: { nodes: [], pageInfo: {} } } } })
      const end = variables.before ? Number(variables.before) : comments.length
      const start = Math.max(0, end - 50)
      reply(200, { data: { viewer: { id: viewerId }, node: { id: target, comments: {
        nodes: comments.slice(start, end).map(toNode), pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
      } } } })
    }
    if (state.issueArchived || (state.issueLocked && state.issuePermission === 'READ'))
      reply(200, { errors: [{ type: 'FORBIDDEN', message: 'Fixture commenting access denied' }] })
    if (state.issueRefuseComment) reply(200, { errors: [{ type: 'UNPROCESSABLE', message: 'Private fixture validation' }] })
    const id = (comments.at(-1)?.id ?? 0) + 1
    const comment = { id, body: input.body, user: { login: state.actor ?? 'fixture-user', node_id: viewerId },
      issue_url: 'https://api.github.com/repos/' + located.repository + '/issues/' + located.issue.number,
      created_at: '2026-11-27T18:00:00Z' }
    comments.push(comment)
    state.issueCommentWrites = [...(state.issueCommentWrites ?? []), [located.issue.number, id]]
    if (state.issueDropComment) {
      delete state.issueDropComment
      state.issueHideComment = true
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    writeFileSync(stateFile, JSON.stringify(state))
    reply(200, { data: { addComment: { commentEdge: { node: toNode(comment) } } } })
  }
  if (query.includes('mutation HarnessIssueStatus')) {
    if (!process.env.GH_TOKEN || state.issuePermission !== 'TRIAGE' || !canChangeIssueState) reply(403, {})
    const issue = Object.entries(state.issues ?? {}).flatMap(([repo, rows]) =>
      rows.filter(issue => issueNodeId(repo, issue) === variables.input.issueId))[0]
    const status = state.planningStatuses?.find(item => item.id === variables.input.statusId)
    if (!issue || issue.pull_request || !status) reply(200, { errors: [{ message: 'Unknown fixture status' }] })
    issue.status_id = status.id
    issue.state = status.category.state.toLowerCase()
    issue.state_reason = status.category.stateReason?.toLowerCase() ?? null
    state.issueStateWrites = [...(state.issueStateWrites ?? []), [issue.number, status.id]]
    writeFileSync(stateFile, JSON.stringify(state))
    reply(200, { data: { setIssueStatus: { clientMutationId: variables.input.clientMutationId } } })
  }
  if (query.includes('mutation HarnessIssueAssignee')) {
    if (!process.env.GH_TOKEN || state.issuePermission !== 'TRIAGE') reply(403, { message: 'Private issue diagnostics' })
    const add = query.includes('addAssigneesToAssignable')
    const key = variables.input.assigneeIds[0]
    const issue = Object.entries(state.issues ?? {}).flatMap(([repo, rows]) =>
      rows.filter(issue => issueNodeId(repo, issue) === variables.input.assignableId))[0]
    if (!issue || issue.pull_request) reply(404, {})
    const current = (issue.assignees ?? []).map(issueActor)
    const actor = (add ? (state.filterAssignees ?? []).map(issueActor) : current).find(person => person.id === key)
    if (!actor || variables.input.assigneeIds.length !== 1) reply(200, { errors: [{ message: 'Unknown fixture assignee' }] })
    issue.assignees = current.filter(person => person.id !== key)
    if (add) issue.assignees.push(actor)
    state.assigneeWrites = [...(state.assigneeWrites ?? []), [issue.number, add, key]]
    if (state.assigneeDropResponse === key) {
      delete state.assigneeDropResponse
      state.assigneeHiddenRead = true
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    writeFileSync(stateFile, JSON.stringify(state))
    reply(200, { data: { [add ? 'addAssigneesToAssignable' : 'removeAssigneesFromAssignable']: { clientMutationId: variables.input.clientMutationId } } })
  }
  const name = variables.owner + '/' + variables.name
  const pull = state.pulls.find(pull => pull.base.repo.full_name === name && pull.number === variables.number)
  if (query.includes('query HarnessSearchRepositoryLabels')) {
    if (!process.env.GH_TOKEN || !state.repositories[name]) reply(403, {})
    if (state.labelSearchFailure) reply(503, { message: 'Private label search diagnostics' })
    const needle = (variables.search ?? '').toLowerCase()
    const labels = (state.labelPages?.flat() ?? state.labelCatalog ?? []).filter(label => label.name.toLowerCase().includes(needle))
    const nodes = labels.slice(0, 100).map(label => ({ id: label.node_id ?? String(label.id), name: label.name, color: label.color, description: label.description }))
    reply(200, { data: { repository: { nameWithOwner: name, labels: { nodes, pageInfo: { hasNextPage: labels.length > 100 } } } } })
  }
  if (query.includes('query HarnessSearchPullRequestAuthors') || query.includes('query HarnessSearchIssueAssignees')) {
    const name = variables.owner + '/' + variables.name
    if (!state.repositories[name] || state.filterAuthorFailure === name) reply(503, { message: 'Private people search diagnostics' })
    const needle = variables.search.toLowerCase()
    const assignees = query.includes('query HarnessSearchIssueAssignees')
    const users = assignees ? state.filterAssignees : state.filterAuthors
    const field = assignees ? 'assignableUsers' : 'mentionableUsers'
    const nodes = (users ?? []).filter(user => (user.login + ' ' + user.name).toLowerCase().includes(needle))
    reply(200, { data: { repository: { nameWithOwner: name, [field]: { nodes: nodes.slice(0, 50),
      pageInfo: { hasNextPage: nodes.length > 50 } } } } })
  }
  if (query.includes('query HarnessReviewerIdentities')) {
    if (!process.env.GH_TOKEN) reply(403, {})
    reply(200, { data: { nodes: variables.ids.map(id => state.reviewerPeople?.find(person => person.id === id) ?? null) } })
  }
  if (query.includes('query HarnessReviewerCandidates')) {
    if (!process.env.GH_TOKEN || !pull) reply(403, {})
    if (state.reviewerHiddenRead) {
      delete state.reviewerHiddenRead
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    if (state.reviewerSearchFailure && variables.search) reply(503, {})
    const search = (variables.search ?? '').toLowerCase()
    const people = (state.reviewerPeople ?? []).filter(person => (person.login + ' ' + (person.name ?? '')).toLowerCase().includes(search))
    const size = state.reviewerPageSize ?? 100
    reply(200, { data: { repository: {
      assignableUsers: { nodes: people.slice(0, size), pageInfo: { hasNextPage: people.length > size } },
      pullRequest: { id: 'fixture-pull-' + pull.number, author: pull.user,
        reviewRequests: { nodes: (pull.reviewerNodes ?? []).map(requestedReviewer => ({ requestedReviewer })), pageInfo: { hasNextPage: false } } },
    } } })
  }
  if (query.includes('query HarnessPullRequestWorkflowHeads')) {
    const nodes = state.pulls.filter(pull => pull.base.repo.full_name === name && pull.head.ref === variables.branch)
      .map(pull => ({ id: 'fixture-pull-' + pull.number, number: pull.number, headRefOid: pull.head.sha,
        headRepository: { id: 'fixture-repo:' + (pull.head.repo?.full_name ?? name), nameWithOwner: pull.head.repo?.full_name ?? name } }))
    reply(200, { data: { viewer, repository: { nameWithOwner: name, pullRequests: { nodes, pageInfo: { hasNextPage: false } } } } })
  }
  if (query.includes('query HarnessPullRequestLifecycle')) {
    const enabled = Boolean(state.mergeMode)
    const missing = pull?.branchMode === 'missing-ref'
    reply(200, { ...(missing && { errors: [{ path: ['repository', 'pullRequest', 'baseRef', 'compare'], type: 'NOT_FOUND' }] }),
      data: { viewer, repository: { nameWithOwner: name, isArchived: state.lifecycleMode === 'archived',
      viewerPermission: state.labelPermission ?? (enabled && state.mergeMode !== 'readonly' ? 'WRITE' : 'READ'), autoMergeAllowed: enabled,
      mergeCommitAllowed: state.mergeMethods?.includes('MERGE'), squashMergeAllowed: state.mergeMethods?.includes('SQUASH'),
      rebaseMergeAllowed: state.mergeMethods?.includes('REBASE'), pullRequest: pull ? {
      id: 'fixture-pull-' + pull.number, number: pull.number, state: pull.merged_at ? 'MERGED' : pull.state.toUpperCase(),
      isDraft: pull.draft, headRefOid: pull.head.sha, baseRefOid: pull.base.sha, updatedAt: pull.updated_at,
      reviewDecision: pull.reviewDecision,
      latestReviews: pull.latestReviews && { nodes: pull.latestReviews },
      baseRefName: pull.base.ref, viewerCanUpdate: state.lifecycleMode !== 'readonly',
      mergeable: pull.branchMode === 'conflict' ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: state.mergeMode === 'blocked' ? 'BLOCKED' : 'CLEAN',
      baseRef: missing ? { compare: null } : { compare: { behindBy: pull.branchBehind } },
      viewerCanUpdateBranch: pull.branchMode === 'normal' && pull.branchBehind > 0,
      revertUrl: state.revertMode && pull.merged_at ? pull.html_url + '/revert' : null,
      mergeCommit: pull.merged_at ? { oid: 'd'.repeat(40) } : null,
      ...(pull === branchPull && branchDeletion && { viewerCanDeleteHeadRef: Boolean(sourceRef), headRefName: pull.head.ref,
        headRef: sourceRef, headRepository: sourceRepository, stack: branchDeletion.stacked ? { id: 'fixture-stack' } : null }),
      ...(pull.head.repo?.full_name && !branchDeletion && { headRefName: pull.head.ref,
        headRepository: { id: 'fixture-repo:' + pull.head.repo.full_name, nameWithOwner: pull.head.repo.full_name } }),
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
  if (keyword.startsWith('is:issue ')) {
    if (state.issueSearchLog) appendFileSync(state.issueSearchLog, JSON.stringify({ repository: selected, cwd: process.cwd() }) + '\\n')
    if (state.issueFailure === selected) reply(503, { message: 'Private fixture issue diagnostics' })
    const phrase = /in:title,body "([^"]+)"/.exec(keyword)?.[1]?.toLowerCase() ?? ''
    const terms = keyword.replace(/in:title,body "[^"]+"/, '')
    const filter = /(?:^| )is:(open|closed)(?: |$)/.exec(terms)?.[1]
    const author = /(?:^| )author:([^ ]+)/.exec(terms)?.[1]?.toLowerCase()
    const mention = /(?:^| )mentions:([^ ]+)/.exec(terms)?.[1]?.toLowerCase()
    const assignees = [...terms.matchAll(/(?:^| )assignee:([^ ]+)/g)].map(match => match[1].toLowerCase())
    const labels = [...terms.matchAll(/(?:^| )label:("(?:[^"\\\\]|\\\\.)+")/g)].map(match => JSON.parse(match[1]).toLowerCase())
    const field = url.searchParams.get('sort') === 'created' ? 'created_at' : 'updated_at'
    const matching = (state.issues?.[selected] ?? []).filter(issue =>
      (!filter || issue.state === filter) && (issue.title + ' ' + (issue.body ?? '')).toLowerCase().includes(phrase)
      && (!author || issue.user?.login.toLowerCase() === author)
      && (!mention || (issue.mentions ?? []).includes(mention))
      && (!assignees.length || assignees.some(name => issue.assignees?.some(user => user.login.toLowerCase() === name)))
      && labels.every(name => issue.labels?.some(label => label.name.toLowerCase() === name)))
      .sort((a, b) => (b[field] ?? '').localeCompare(a[field] ?? ''))
    const size = Number(url.searchParams.get('per_page') || 20)
    const page = Number(url.searchParams.get('page') || 1)
    const link = matching.length > page * size ? 'link: <' + endpoint + '>; rel="next"\\r\\n' : ''
    reply(200, { items: matching.slice((page - 1) * size, page * size), total_count: matching.length }, link)
  }
  const phrase = /in:title(?:,body,comments)? "([^"]+)"/.exec(keyword)?.[1]?.toLowerCase() ?? ''
  const withoutText = keyword.replace(/in:title(?:,body,comments)? "[^"]+"/, '')
  const labelsMatcher = /(?:^| )(-?)label:("[^"]+"(?:,"[^"]+")*)/g
  const labels = [...withoutText.matchAll(labelsMatcher)].map(match => ({ exclude: match[1] === '-',
    names: [...match[2].matchAll(/"([^"]+)"/g)].map(label => label[1].toLowerCase()) }))
  const terms = new Set(withoutText.replace(labelsMatcher, ' ').split(' '))
  const author = /(?:^| )author:([^ ]+)/.exec(withoutText)?.[1]?.toLowerCase()
  const reviewer = /(?:^| )review-requested:([^ ]+)/.exec(withoutText)?.[1]?.toLowerCase()
  const excludedAuthor = /(?:^| )-author:([^ ]+)/.exec(withoutText)?.[1]?.toLowerCase()
  const excludedReviewer = /(?:^| )-review-requested:([^ ]+)/.exec(withoutText)?.[1]?.toLowerCase()
  const review = /(?:^| )review:([^ ]+)/.exec(withoutText)?.[1]
  const checks = /(?:^| )status:([^ ]+)/.exec(withoutText)?.[1]
  if (state.filterListFailure === selected || (state.filterPriorityFailure === selected && excludedAuthor))
    reply(503, { message: 'Private list search diagnostics' })
  const matching = state.pulls.filter(pull => {
    const applied = new Set((pull.labels ?? []).map(label => label.name.toLowerCase()))
    const searchable = [pull.title, pull.body ?? '', ...(pull.searchComments ?? [])]
    const requested = [...(pull.requested_reviewers ?? []).map(user => user.login), ...(pull.teamReviewerLogins ?? [])]
      .map(login => login.toLowerCase())
    return pull.base.repo.full_name === selected && searchable.some(value => value.toLowerCase().includes(phrase))
      && (!terms.has('is:open') || pull.state === 'open') && (!terms.has('is:closed') || pull.state === 'closed')
      && (!terms.has('is:merged') || pull.merged_at) && (!terms.has('is:unmerged') || !pull.merged_at)
      && (!terms.has('draft:true') || pull.draft) && (!terms.has('draft:false') || !pull.draft)
      && (!author || pull.user?.login.toLowerCase() === author)
      && (!excludedAuthor || pull.user?.login.toLowerCase() !== excludedAuthor)
      && (!reviewer || requested.includes(reviewer))
      && (!excludedReviewer || !requested.includes(excludedReviewer))
      && (!review || review === (pull.filterReview ?? 'none')) && (!checks || checks === pull.filterChecks)
      && labels.every(group => group.exclude !== group.names.some(name => applied.has(name)))
  })
  const field = url.searchParams.get('sort') === 'created' ? 'created_at' : 'updated_at'
  const order = url.searchParams.get('order') === 'asc' ? 1 : -1
  matching.sort((a, b) => order * (a[field] ?? '').localeCompare(b[field] ?? ''))
  const size = Number(url.searchParams.get('per_page') || 20)
  const page = Number(url.searchParams.get('page') || 1)
  const more = matching.length > page * size ? 'link: <' + endpoint + '>; rel="next"\\r\\n' : ''
  reply(200, { items: matching.slice((page - 1) * size, page * size), total_count: state.filterListTotal ?? matching.length,
    incomplete_results: state.filterListIncomplete === selected }, more)
}
if (!repo) reply(404, {})
if (method === 'PATCH' && parts[4] === 'issues' && !parts[6]) {
  if (!process.env.GH_TOKEN || state.issueArchived || (state.issuePermission !== 'TRIAGE' && !state.issueAuthorCanChange))
    reply(403, {})
  const issue = state.issues?.[name]?.find(issue => issue.number === Number(parts[5]) && !issue.pull_request)
  if (!issue) reply(404, {})
  const next = JSON.parse(await Bun.stdin.text())
  if (!['open', 'closed'].includes(next.state) || next.state === issue.state
    || (next.state === 'closed' && !['completed', 'not_planned', 'duplicate'].includes(next.state_reason))) reply(422, {})
  issue.state = next.state
  issue.state_reason = next.state_reason ?? 'reopened'
  const status = state.planningStatuses?.find(item => item.category.stateReason?.toLowerCase() === next.state_reason)
  issue.status_id = status?.id ?? null
  state.issueStateWrites = [...(state.issueStateWrites ?? []), [issue.number, next.state, issue.state_reason]]
  if (state.issueStateDropResponse) {
    delete state.issueStateDropResponse
    state.issueStateHiddenRead = true
    writeFileSync(stateFile, JSON.stringify(state))
    process.exit(1)
  }
  writeFileSync(stateFile, JSON.stringify(state))
  reply(200, issue)
}
if (method === 'GET' && parts[4] === 'issues' && state.issues?.[name] && (!parts[6] || parts[6] === 'comments')) {
  const issue = state.issues[name].find(issue => issue.number === Number(parts[5]))
  if (!issue) reply(404, {})
  if (!parts[6]) reply(200, { ...issue, comments: issue.comments?.length ?? 0 })
  const comments = issue.comments ?? []
  const size = Number(url.searchParams.get('per_page') || 20)
  const page = Number(url.searchParams.get('page') || 1)
  const link = comments.length > page * size ? 'link: <' + endpoint + '>; rel="next"\\r\\n' : ''
  reply(200, comments.slice((page - 1) * size, page * size), link)
}
if (method === 'GET' && parts[4] === 'actions' && parts[5] === 'runs') {
  if (!parts[6]) reply(200, { workflow_runs: state.workflowRuns ?? [] })
  const run = state.workflowRuns?.find(run => run.id === Number(parts[6]))
  if (state.workflowHiddenRead === run?.id && run) {
    delete state.workflowHiddenRead
    writeFileSync(stateFile, JSON.stringify(state))
    process.exit(1)
  }
  if (run && state.workflowStaleRead === run.id)
    reply(200, { ...run, status: 'completed', conclusion: 'action_required' })
  reply(run ? 200 : 404, run && state.workflowAttemptChanged === run.id
    ? { ...run, run_attempt: run.run_attempt + 1 } : run ?? {})
}
if (method === 'POST' && parts[4] === 'actions' && parts[5] === 'runs' && parts[7] === 'approve') {
  const run = state.workflowRuns?.find(run => run.id === Number(parts[6]))
  if (!run) reply(404, {})
  state.workflowApprovalPosts = [...(state.workflowApprovalPosts ?? []), run.id]
  writeFileSync(stateFile, JSON.stringify(state))
  if (state.workflowDenied === run.id) reply(403, { message: 'Private workflow diagnostics must not leak' })
  if (run.status === 'action_required' || run.conclusion === 'action_required') {
    Object.assign(run, { status: 'queued', conclusion: null })
    if (state.workflowDropReply === run.id) {
      delete state.workflowDropReply
      state.workflowHiddenRead = run.id
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    writeFileSync(stateFile, JSON.stringify(state))
    reply(state.workflowApprovalStatus ?? 204)
  }
  reply(409, { message: 'This workflow run has already been approved.' })
}
if (parts.length === 4) reply(200, { full_name: name, default_branch: 'main', parent: repo.parent && { full_name: repo.parent } })
if (parts[4] === 'branches') {
  const sha = head(repo, decodeURIComponent(parts[5]))
  reply(sha ? 200 : 404, sha ? { commit: { sha } } : {})
}
const pulls = state.pulls.filter(pull => pull.base.repo.full_name === name)
const detail = pulls.find(pull => pull.number === Number(parts[5]))
if (parts[4] === 'pulls' && parts[6] === 'requested_reviewers' && detail) {
  if (!process.env.GH_TOKEN || state.reviewerDenied) reply(403, { message: 'Private reviewer diagnostics' })
  const request = method === 'POST'
  const body = JSON.parse(await Bun.stdin.text())
  const name = body.team_reviewers?.[0] ?? body.reviewers?.[0]
  const initial = detail.reviewerNodes ?? []
  const person = (request ? state.reviewerPeople : initial)?.find(candidate =>
    body.team_reviewers ? candidate.slug === name : candidate.login === name)
  if (!person || (body.team_reviewers ?? body.reviewers).length !== 1 || person.login === detail.user?.login) reply(422, {})
  state.reviewerWrites = [...(state.reviewerWrites ?? []), [detail.number, method, person.id]]
  detail.reviewerNodes = request ? [...initial.filter(row => row.id !== person.id), person] : initial.filter(row => row.id !== person.id)
  detail.requested_reviewers = detail.reviewerNodes.filter(row => row.__typename !== 'Team')
  detail.requested_teams = detail.reviewerNodes.filter(row => row.__typename === 'Team')
  if (state.reviewerDropResponse === person.id) {
    delete state.reviewerDropResponse
    state.reviewerHiddenRead = true
    writeFileSync(stateFile, JSON.stringify(state))
    process.exit(1)
  }
  writeFileSync(stateFile, JSON.stringify(state))
  reply(request ? 201 : 200, detail)
}
if (parts[4] === 'labels' && method === 'GET') {
  if (parts[5]) {
    const requested = decodeURIComponent(parts[5])
    const label = (state.labelPages?.flat() ?? state.labelCatalog ?? []).find(label => label.name === requested)
    reply(label ? 200 : 404, label ?? {})
  }
  const page = Number(url.searchParams.get('page')) || 1
  const pages = state.labelPages
  const next = pages && page < pages.length ? 'Link: <https://api.github.com' + url.pathname + '?page=' + (page+1) + '>; rel="next"\\r\\n' : ''
  reply(200, pages ? pages[page-1] ?? [] : state.labelCatalog ?? [], next)
}
const issueForMetadata = parts[4] === 'issues' ? state.issues?.[name]?.find(issue => issue.number === Number(parts[5]) && !issue.pull_request) : undefined
const labelled = issueForMetadata ?? detail
if (parts[4] === 'issues' && parts[6] === 'labels' && labelled) {
  const applied = labelled.labels ?? []
  if (method === 'GET') {
    if (state.labelHiddenRead) {
      state.labelHiddenRead = false
      writeFileSync(stateFile, JSON.stringify(state))
      process.exit(1)
    }
    reply(200, applied)
  }
  if (!process.env.GH_TOKEN || state.labelDenied || (issueForMetadata && state.issuePermission !== 'TRIAGE')) reply(403, { message: 'Private label diagnostics' })
  const names = method === 'POST' ? JSON.parse(await Bun.stdin.text()).labels : [decodeURIComponent(parts[7] ?? '')]
  const catalog = state.labelPages?.flat() ?? state.labelCatalog ?? []
  const label = (method === 'POST' ? catalog : applied).find(candidate => candidate.name === names[0])
  if (!label || names.length !== 1 || (method === 'POST' && label.archived_at)) reply(404, {})
  state.labelWrites = [...(state.labelWrites ?? []), [labelled.number, method, label.id, label.name]]
  labelled.labels = applied.filter(candidate => candidate.id !== label.id)
  if (method === 'POST') labelled.labels.push(label)
  if (state.labelDropResponse === label.id) {
    delete state.labelDropResponse
    state.labelHiddenRead = true
    writeFileSync(stateFile, JSON.stringify(state))
    process.exit(1)
  }
  writeFileSync(stateFile, JSON.stringify(state))
  if (method === 'DELETE') reply(204)
  reply(200, labelled.labels)
}
if (parts[4] === 'issues' && parts[6] === 'timeline' && detail) reply(200, [
  { id: 5, event: 'commented', user: { login: 'fixture-reviewer' }, created_at: '2026-11-01T13:00:00Z', body: 'Check the **export**. <script>globalThis.__pr_html = true</script>' },
  { id: 3, event: 'reviewed', user: { login: 'fixture-approver' }, state: 'approved', submitted_at: '2026-11-01T14:00:00Z' },
  ...(state.inlineReviews ?? []).filter(review => review.pull === detail.number).map(review => ({ ...review, event: 'reviewed' })),
  ...(state.reviewDismissed ?? []),
])
if (parts[4] !== 'pulls') reply(404, {})
if (parts[6] === 'reviews') {
  if (!detail) reply(404, {})
  if (method === 'GET') {
    const page = Number(url.searchParams.get('page')) || 1
    if (state.reviewOutcomeReadFailure === page) reply(503, { message: 'Private review history diagnostics' })
    const inline = (state.inlineReviews ?? []).filter(review => review.pull === detail.number)
    if (!state.reviewOutcomePages) reply(200, inline)
    const pages = state.reviewOutcomePages
    const next = page < pages.length ? 'Link: <https://api.github.com' + url.pathname + '?page=' + (page+1) + '>; rel="next"\\r\\n' : ''
    reply(200, [...(pages[page-1] ?? []), ...(next ? [] : inline)], next)
  }
  if (!process.env.GH_TOKEN) reply(404, {})
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
if (method === 'GET' && parts[4] === 'pulls' && url.searchParams.has('page')) {
  const status = url.searchParams.get('state')
  const field = url.searchParams.get('sort') === 'created' ? 'created_at' : 'updated_at'
  const direction = url.searchParams.get('direction') === 'asc' ? 1 : -1
  const matching = pulls.filter(pull => status === 'all' || pull.state === status)
    .sort((a, b) => direction * (a[field] ?? '').localeCompare(b[field] ?? ''))
  const size = Number(url.searchParams.get('per_page') || 20)
  const page = Number(url.searchParams.get('page') || 1)
  const more = matching.length > page * size ? 'link: <' + endpoint + '>; rel="next"\\r\\n' : ''
  reply(200, matching.slice((page - 1) * size, page * size), more)
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
    revealReply, configureInlineReviews, revealInlineReview, configureLifecycle, revealLifecycle, configureMerge, configureBranchUpdate,
    configureRevert, configureBranchDeletion }
}
