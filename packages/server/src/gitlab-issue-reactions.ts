import type { GitLabIssueReference } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import type { IssueCredential } from './gitlab-issues'
import type { IssueActivityItem } from './issue-activity'
import type { GitLabIssueRepository } from './issue-repositories'
import type { IssueReactionContent, IssueReactionForm, ReactionSubject } from './issue-reactions'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey } from '@harness/contract'
import { gitLabGraphQL, gitLabIssueCredential, readGitLabAwards, readGitLabIssueText } from './gitlab-issues'
import { trustedIssueRepositories } from './issue-repositories'
import { reactionBar } from './issue-reactions'
import { RepositoryPullRequestError } from './repository-pull-request'

const emoji = {
  THUMBS_UP: 'thumbsup', THUMBS_DOWN: 'thumbsdown', LAUGH: 'laughing', HOORAY: 'tada',
  CONFUSED: 'confused', HEART: 'heart', ROCKET: 'rocket', EYES: 'eyes',
} satisfies Record<IssueReactionContent, string>
const noteId = /^gid:\/\/gitlab\/Note\/([1-9]\d*)$/u
const issueId = /^gid:\/\/gitlab\/(?:Issue|WorkItem)\/[1-9]\d*$/u

type Context = { repository: GitLabIssueRepository, number: number, signal: AbortSignal, credential: IssueCredential }
type Authority = NonNullable<Awaited<ReturnType<typeof readGitLabIssueText>>>
type Award = { name?: string, user?: { id?: string | number } }
type Note = { id?: string, noteableId?: number, noteableType?: string, system?: boolean, internal?: boolean,
  userPermissions?: { awardEmoji?: boolean }, awardEmoji?: { nodes?: Award[], pageInfo?: { hasNextPage?: boolean } } }

function validNote(note: Note | null | undefined, subject: string, authority: Authority): note is Note {
  return note?.id === subject && String(note.noteableId) === authority.issueId.split('/').at(-1)
    && (note.noteableType === 'Issue' || note.noteableType === 'WorkItem') && note.system === false && note.internal === false
}

function awardUserId(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0 ? 'gid://gitlab/User/' + value
    : typeof value === 'string' && /^gid:\/\/gitlab\/User\/[1-9]\d*$/u.test(value) ? value : ''
}

function groups(awards: Award[], viewer: string): NonNullable<ReactionSubject['reactionGroups']> {
  return Object.entries(emoji).map(([content, name]) => {
    const actors = new Set(awards.flatMap(award => {
      if (award?.name !== name) return []
      const user = awardUserId(award.user?.id)
      return user ? [user] : []
    }))
    return { content, viewerHasReacted: actors.has(viewer), reactors: { totalCount: actors.size } }
  })
}

async function allAwards({ repository, number, signal, credential }: Context, comment: number) {
  const awards: Award[] = []
  for (let page = 1; page <= 10; page++) {
    const result = await readGitLabAwards(repository, number, comment, page, signal, credential)
    if (!Array.isArray(result.body)) return null
    awards.push(...result.body as Award[])
    if (result.more === false || result.body.length === 0) return awards
  }
  return null
}

async function notesForReactions({ repository, signal, credential }: Context, ids: string[], viewer: string) {
  const variables = Object.fromEntries(ids.map((id, index) => ['n' + index, id]))
  const names = Object.keys(variables)
  const declaration = names.map(name => '$' + name + ': NoteID!').join(', ')
  const notes = names.map(name => `${name}: note(id: $${name}) {
    id noteableId noteableType system internal userPermissions { awardEmoji }
    awardEmoji(first: 50) { nodes { name user { id } } pageInfo { hasNextPage } }
  }`).join('\n')
  const reply = await gitLabGraphQL(repository, `query HarnessGitLabReactionNotes(${declaration}) {
    currentUser { id }
    ${notes}
  }`, variables, signal, credential) as { errors?: unknown[], data?: { currentUser?: { id?: string } } & Record<string, Note | null> } | null
  if (reply?.errors?.length || reply?.data?.currentUser?.id !== viewer) return []
  return names.map(name => reply.data?.[name] ?? null)
}

export async function readGitLabIssueReactions(repository: GitLabIssueRepository, number: number, activity: IssueActivityItem[], signal: AbortSignal) {
  const credential = await gitLabIssueCredential(repository, signal)
  const context: Context = { repository, number, signal, credential }
  const authority = await readGitLabIssueText(repository, number, signal, credential)
  if (!authority) return null
  const listIssueAwards = allAwards(context, 0).catch(() => null)
  const comments = activity.filter(item => item.kind === 'comment').map(item => Number(item.id))
  const bars = new Map<number, ReturnType<typeof reactionBar>>()
  const batches = []
  for (let offset = 0; offset < comments.length; offset += 6) batches.push(comments.slice(offset, offset + 6))
  await Promise.all(batches.map(async (batch) => {
    const ids = batch.map(id => 'gid://gitlab/Note/' + id)
    const notes = await notesForReactions(context, ids, authority.viewer).catch(() => [])
    for (const [index, comment] of batch.entries()) {
      const subject = 'gid://gitlab/Note/' + comment
      const note = notes[index]
      if (!validNote(note, subject, authority)) continue
      const awards = note.awardEmoji?.pageInfo?.hasNextPage === true
        ? await allAwards(context, comment).catch(() => null)
        : note.awardEmoji?.pageInfo?.hasNextPage === false ? note.awardEmoji.nodes : null
      if (!Array.isArray(awards)) continue
      bars.set(comment, reactionBar({ id: subject, viewerCanReact: note.userPermissions?.awardEmoji,
        reactionGroups: groups(awards, authority.viewer) }, authority.reactionScope, authority.canReact, comment))
    }
  }))
  const awards = await listIssueAwards
  return {
    issue: awards ? reactionBar({ id: authority.issueId, viewerCanReact: true, reactionGroups: groups(awards, authority.viewer) },
      authority.reactionScope, authority.canReact) : null,
    comments: bars,
  }
}

const messages = {
  updated: 'Reaction updated on GitLab.',
  changed: 'The issue, note, or GitLab account changed.',
  denied: 'This GitLab account cannot react here.',
  unavailable: 'Could not check this reaction on GitLab.',
  refused: 'GitLab refused the reaction. Reopen the issue to check the current state.',
  pending: 'GitLab has yet to confirm the reaction.',
}

export async function submitGitLabIssueReaction(state: HarnessState, profile: number, reference: GitLabIssueReference, form: IssueReactionForm,
  signal: AbortSignal, receipts: PullRequestReplyReceipts,
) {
  const encodedNote = noteId.exec(form.subject)?.[1]
  const comment = encodedNote ? Number(encodedNote) : 0
  if (!Number.isSafeInteger(comment) || (!comment && !issueId.test(form.subject))) return null
  let attempted = false
  const finish = (result: keyof typeof messages) => ({ result, message: messages[result], comment, draft: result === 'pending' ? form : null })
  try {
    const repository = (await trustedIssueRepositories(state.workspaces.values(), profile, signal)).get(issueRepositoryKey(reference))
    if (repository?.tracker !== 'gitlab') return finish('changed')
    const trusted = () => {
      const workspace = state.workspaces.get(repository.workspace.id)
      return Boolean(workspace?.trusted && !workspace.scratch && workspace.profileId === profile && workspace.path === repository.workspace.path)
    }
    const credential = await gitLabIssueCredential(repository, signal)
    const context = { repository, number: reference.number, signal, credential }
    const read = () => readGitLabIssueText(repository, reference.number, signal, credential)
    const authority = await read()
    if (!authority || !trusted() || authority.reactionScope !== form.scope) return finish('changed')
    const note = comment ? (await notesForReactions(context, [form.subject], authority.viewer))[0] : null
    if (comment ? !validNote(note, form.subject, authority) : form.subject !== authority.issueId) return finish('changed')
    const active = (rows: Award[]) => rows.some(row => row?.name === emoji[form.content] && awardUserId(row.user?.id) === authority.viewer)
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const key = hash(['gitlab-issue-reaction', form.intent, form.subject, form.content])
    const fingerprint = hash([form.scope, form.subject, form.content, form.desired])
    const previous = receipts.inspect(key, fingerprint)
    if (previous === 'conflict') return finish('changed')
    if (previous === 'confirmed') return finish('updated')
    if (!previous && !(authority.canReact && (!comment || note?.userPermissions?.awardEmoji === true))) return finish('denied')
    const before = await allAwards(context, comment).catch(() => null)
    if (!before) return finish(previous ? 'pending' : 'unavailable')
    if (!trusted()) return finish('changed')
    if (previous === 'pending') {
      if (active(before) !== form.desired) return finish('pending')
      receipts.confirm(key, fingerprint)
      return finish('updated')
    }
    const claim = receipts.claim(key, fingerprint, trusted())
    if (claim !== 'claimed') return finish(claim === 'confirmed' ? 'updated' : claim === 'pending' ? 'pending' : 'changed')
    attempted = true
    if (active(before) !== form.desired) {
      const mutation = form.desired ? 'awardEmojiAdd' : 'awardEmojiRemove'
      const type = form.desired ? 'AwardEmojiAddInput' : 'AwardEmojiRemoveInput'
      const result = await gitLabGraphQL(repository, `mutation HarnessGitLabIssueReaction($input: ${type}!) {
        ${mutation}(input: $input) { awardEmoji { name user { id } } errors }
      }`, { input: { awardableId: form.subject, name: emoji[form.content] } }, signal, credential).catch((error: unknown) =>
        error instanceof RepositoryPullRequestError && error.status ? { status: error.status } : null) as {
          status?: number, errors?: { extensions?: { code?: string } }[], data?: Record<string, { errors?: unknown[] }>,
        } | null
      if (result?.status === 401 || result?.status === 403 || result?.errors?.some(error => error.extensions?.code === 'RESOURCE_NOT_AVAILABLE')) {
        receipts.reject(key, fingerprint)
        return finish('denied')
      }
      const [after, current] = await Promise.all([allAwards(context, comment).catch(() => null), read().catch(() => null)])
      const sameIssue = trusted() && current?.reactionScope === form.scope
      if (!sameIssue || !after || active(after) !== form.desired) {
        if (sameIssue && after && (result?.status === 400 || result?.status === 422 || result?.data?.[mutation]?.errors?.length)) {
          receipts.reject(key, fingerprint)
          return finish('refused')
        }
        return finish('pending')
      }
    }
    receipts.confirm(key, fingerprint)
    return finish('updated')
  }
  catch { return finish(attempted ? 'pending' : 'unavailable') }
}
