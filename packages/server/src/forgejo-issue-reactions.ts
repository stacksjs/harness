import type { ForgejoIssueReference } from '@harness/contract'
import type { HarnessState } from '@harness/engine'
import type { IssueActivityItem } from './issue-activity'
import type { ForgejoIssueRepository } from './issue-repositories'
import type { IssueReactionContent, IssueReactionForm } from './issue-reactions'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey } from '@harness/contract'
import { forgejoIssueHasComment, forgejoReactionEndpoint, readForgejoIssueAuthority } from './forgejo-issues'
import { forgejoTeaRequest } from './forgejo-tea'
import { trustedIssueRepositories } from './issue-repositories'
import { reactionBar } from './issue-reactions'
import { RepositoryPullRequestError } from './repository-pull-request'

const emoji = {
  THUMBS_UP: '+1', THUMBS_DOWN: '-1', LAUGH: 'laugh', HOORAY: 'hooray',
  CONFUSED: 'confused', HEART: 'heart', ROCKET: 'rocket', EYES: 'eyes',
} satisfies Record<IssueReactionContent, string>

type Authority = NonNullable<Awaited<ReturnType<typeof readForgejoIssueAuthority>>>
type Reaction = { content?: unknown, user?: { id?: unknown, login?: unknown } | null }

function byViewer(reaction: Reaction, authority: Authority) {
  const user = reaction.user
  if (Number.isSafeInteger(user?.id)) return user?.id === authority.viewer
  return Boolean(authority.viewerLogin && typeof user?.login === 'string'
    && user.login.toLowerCase() === authority.viewerLogin.toLowerCase())
}

async function readReactions(repository: ForgejoIssueRepository, number: number, comment: number, signal: AbortSignal) {
  const endpoint = forgejoReactionEndpoint(repository, number, comment)
  const limit = 50
  const reactions: Reaction[] = []
  for (let page = 1; page <= 10; page++) {
    // Forgejo paginates issue reactions. The comment endpoint returns a single array.
    const { body, more } = await forgejoTeaRequest(repository, comment ? endpoint : endpoint + '?limit=' + limit + '&page=' + page, signal)
    if (body !== null && !Array.isArray(body)) return null
    const rows = (body ?? []) as Reaction[]
    reactions.push(...rows.filter(row => row && typeof row.content === 'string'))
    if (comment || !(more ?? rows.length === limit)) return reactions
  }
  return null
}

export async function readForgejoIssueReactions(repository: ForgejoIssueRepository, number: number, activity: IssueActivityItem[],
  authority: Authority, signal: AbortSignal) {
  const readBar = async (comment: number) => {
    const rows = await readReactions(repository, number, comment, signal).catch(() => null)
    if (!rows) return null
    const groups = Object.entries(emoji).map(([content, name]) => {
      const matching = rows.filter(row => row.content === name)
      return { content, viewerHasReacted: matching.some(row => byViewer(row, authority)), reactors: { totalCount: matching.length } }
    })
    const id = comment ? 'comment:' + comment : 'issue:' + authority.issueId
    return reactionBar({ id, viewerCanReact: authority.canReact, reactionGroups: groups }, authority.reactionScope, authority.canReact, comment)
  }
  const issue = readBar(0)
  const comments = activity.flatMap(item => item.kind === 'comment' && typeof item.id === 'number' ? [item.id] : [])
  const bars = new Map<number, Awaited<ReturnType<typeof readBar>>>()
  for (let offset = 0; offset < comments.length && !signal.aborted; offset += 4) {
    await Promise.all(comments.slice(offset, offset + 4).map(async id => { bars.set(id, await readBar(id)) }))
  }
  return { issue: await issue, comments: bars }
}

const messages = {
  updated: 'Reaction updated on Forgejo.',
  changed: 'The issue, comment, or Forgejo account changed.',
  denied: 'This Forgejo account cannot react here.',
  unavailable: 'Could not check this reaction on Forgejo.',
  refused: 'Forgejo refused the reaction. Reopen the issue to check the current state.',
  pending: 'Forgejo has yet to confirm the reaction.',
}

function hash(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function submitForgejoIssueReaction(state: HarnessState, profile: number, reference: ForgejoIssueReference, form: IssueReactionForm,
  signal: AbortSignal, receipts: PullRequestReplyReceipts,
) {
  const subject = /^(issue|comment):([1-9]\d*)$/u.exec(form.subject)
  const id = Number(subject?.[2])
  if (!subject || !Number.isSafeInteger(id)) return null
  const comment = subject[1] === 'comment' ? id : 0
  let attempted = false
  const finish = (result: keyof typeof messages) => ({ result, message: messages[result], comment, draft: result === 'pending' ? form : null })
  try {
    const repository = (await trustedIssueRepositories(state.workspaces.values(), profile, signal)).get(issueRepositoryKey(reference))
    if (repository?.tracker !== 'forgejo') return finish('changed')
    const trusted = () => {
      const workspace = state.workspaces.get(repository.workspace.id)
      return Boolean(workspace?.trusted && !workspace.scratch && workspace.profileId === profile && workspace.path === repository.workspace.path)
    }
    const currentTarget = async () => {
      const current = await readForgejoIssueAuthority(repository, reference.number, signal)
      if (!current || current.reactionScope !== form.scope || !trusted()) return null
      const valid = comment ? await forgejoIssueHasComment(repository, reference.number, comment, signal) : current.issueId === id
      return valid && trusted() ? current : null
    }
    const authority = await currentTarget()
    if (!authority) return finish('changed')
    const key = hash(['forgejo-issue-reaction', form.intent, form.subject, form.content])
    const fingerprint = hash([form.scope, form.subject, form.content, form.desired])
    const previous = receipts.inspect(key, fingerprint)
    if (previous === 'conflict') return finish('changed')
    if (previous === 'confirmed') return finish('updated')
    if (!previous && !authority.canReact) return finish('denied')
    const content = emoji[form.content]
    const active = (rows: Reaction[], viewer: Authority) => rows.some(row => row.content === content && byViewer(row, viewer))
    const before = await readReactions(repository, reference.number, comment, signal).catch(() => null)
    if (!before) return finish(previous ? 'pending' : 'unavailable')
    const fresh = await currentTarget()
    if (!fresh) return finish(previous ? 'pending' : 'changed')
    if (previous === 'pending') {
      if (active(before, fresh) !== form.desired) return finish('pending')
      receipts.confirm(key, fingerprint)
      return finish('updated')
    }
    if (!fresh.canReact) return finish('denied')
    const claim = receipts.claim(key, fingerprint, trusted())
    if (claim !== 'claimed') return finish(claim === 'confirmed' ? 'updated' : claim === 'pending' ? 'pending' : 'changed')
    attempted = true
    if (active(before, fresh) !== form.desired) {
      const status = await forgejoTeaRequest(repository, forgejoReactionEndpoint(repository, reference.number, comment), signal, {
        method: form.desired ? 'POST' : 'DELETE', body: { content }, success: form.desired ? [200, 201] : [200, 204],
      }).then(() => 200, error => error instanceof RepositoryPullRequestError ? error.status : undefined)
      if (status === 401 || status === 403) {
        receipts.reject(key, fingerprint)
        return finish('denied')
      }
      const [after, current] = await Promise.all([
        readReactions(repository, reference.number, comment, signal).catch(() => null),
        currentTarget().catch(() => null),
      ])
      if (!current || !after || active(after, current) !== form.desired) {
        if (current && after && (status === 400 || status === 404 || status === 422)) {
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
