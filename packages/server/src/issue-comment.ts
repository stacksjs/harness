import type { HarnessState } from '@harness/engine'
import type { GitHubIssueRepository, GitLabIssueRepository } from './issue-repositories'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { issueRepositoryKey } from '@harness/contract'
import { forgejoIssueCommentWriter } from './forgejo-issues'
import { findGitLabIssueComment, gitLabIssueCredential, postGitLabIssueComment, readGitLabIssueText } from './gitlab-issues'
import { issueReferenceForSelection, trustedIssueRepositories } from './issue-repositories'
import { issueWriteScope, readIssueMetadataAuthority } from './issue-metadata'
import { repositoryGitHubCredential, repositoryGitHubRequest, RepositoryPullRequestError } from './repository-pull-request'

const maxCommentBytes = 16_384
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const commentFields = 'fullDatabaseId body author { ... on Node { id } } issue { id }'
const messages = {
  posted: 'Comment posted to GitHub.',
  pending: 'GitHub has yet to confirm the comment. Check GitHub to recover it.',
  invalid: 'Enter a comment of up to 16 KB.',
  changed: 'The issue, project, account, or submitted comment changed. Review your draft before posting.',
  denied: 'This GitHub account cannot comment on this issue.',
  refused: 'GitHub rejected the comment. Review your draft and try again.',
  unavailable: 'Could not reach GitHub. Your draft is still here.',
}

type IssueCommentNode = {
  fullDatabaseId?: string | number, body?: string, author?: { id?: string }, issue?: { id?: string },
}

function matchingId(node: IssueCommentNode | null | undefined, viewer: string, issue: string, body: string) {
  if (node?.author?.id !== viewer || node.issue?.id !== issue || node.body !== body) return null
  const id = Number(node.fullDatabaseId)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

async function githubCommentAccess(repository: GitHubIssueRepository, number: number, signal: AbortSignal) {
  const credential = await repositoryGitHubCredential(repository.path, signal)
  const authority = await readIssueMetadataAuthority({ repository, number, credential, signal })
  if (!authority) return null
  const { issueId, viewer } = authority
  return {
    scope: issueWriteScope(repository, authority, 'issue-comment'), blocked: authority.commentBlocked,
    async post(body: string, intent: string) {
      const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
        query: `mutation HarnessPostIssueComment($input: AddCommentInput!) {
          addComment(input: $input) { commentEdge { node { ${commentFields} } } }
        }`, variables: { input: { subjectId: issueId, body, clientMutationId: intent } },
      }, signal, credential).catch((error: unknown) =>
        error instanceof RepositoryPullRequestError && error.status ? { status: error.status, body: null } : null)
      const payload = reply?.body as { data?: { addComment?: { commentEdge?: { node?: IssueCommentNode } } }, errors?: { type?: string }[] } | null
      const id = matchingId(payload?.data?.addComment?.commentEdge?.node, viewer, issueId, body)
      if (id) return id
      if (reply?.status === 401 || reply?.status === 403 || payload?.errors?.some(error => error.type === 'FORBIDDEN')) return 'denied' as const
      if (reply?.status === 422 || payload?.errors?.some(error => error.type === 'UNPROCESSABLE')) return 'refused' as const
      return null
    },
    async find(body: string, trusted: () => boolean) {
      let before: string | undefined
      for (let page = 0; page < 10 && trusted(); page++) {
        const reply = await repositoryGitHubRequest(repository.path, 'graphql', {
          query: `query HarnessFindIssueComment($id: ID!, $before: String) {
            viewer { id }
            node(id: $id) {
              ... on Issue {
                id
                comments(last: 50, before: $before) {
                  nodes { ${commentFields} }
                  pageInfo { hasPreviousPage startCursor }
                }
              }
            }
          }`, variables: { id: issueId, before },
        }, signal, credential)
        const payload = reply.body as { errors?: unknown[], data?: { viewer?: { id?: string }, node?: {
          id?: string, comments?: { nodes?: (IssueCommentNode | null)[], pageInfo?: { hasPreviousPage?: boolean, startCursor?: string } },
        } } } | null
        const comments = payload?.data?.node?.comments
        if (!trusted() || reply.status !== 200 || payload?.errors?.length || payload?.data?.viewer?.id !== viewer || payload.data.node?.id !== issueId
          || !Array.isArray(comments?.nodes)) break
        for (const comment of comments.nodes) {
          const id = matchingId(comment, viewer, issueId, body)
          if (id) return id
        }
        const cursor = comments.pageInfo?.startCursor
        if (!comments.pageInfo?.hasPreviousPage || !cursor || cursor === before) break
        before = cursor
      }
      return null
    },
  }
}

async function gitLabCommentAccess(repository: GitLabIssueRepository, number: number, signal: AbortSignal) {
  const credential = await gitLabIssueCredential(repository, signal)
  const authority = await readGitLabIssueText(repository, number, signal, credential)
  if (!authority) return null
  const { issueId, viewer } = authority
  return {
    scope: authority.commentScope, blocked: authority.commentBlocked,
    post: (body: string) => postGitLabIssueComment(repository, issueId, viewer, body, signal, credential),
    find: (body: string, trusted: () => boolean) => findGitLabIssueComment(repository, number, issueId, viewer, body, signal, credential, trusted),
  }
}

export async function submitIssueComment(state: HarnessState, query: URLSearchParams, values: URLSearchParams,
  signal: AbortSignal, receipts: PullRequestReplyReceipts) {
  const profile = Number(query.get('profile'))
  const reference = issueReferenceForSelection(query.get('selected'), Number(query.get('issue')))
  const intent = values.get('intent') ?? ''
  const scope = values.get('scope') ?? ''
  const draft = (values.get('body') ?? '').replace(/\r\n?/gu, '\n')
  if (!reference || !state.profiles.has(profile) || !tokenPattern.test(intent) || !/^[a-f0-9]{64}$/u.test(scope)) return null
  const forge = { github: 'GitHub', gitlab: 'GitLab', forgejo: 'Forgejo' }[reference.tracker]
  const finish = (result: keyof typeof messages, id: number | null = null) =>
    ({ result, id, text: draft.slice(0, maxCommentBytes), intent, scope, message: messages[result].replaceAll('GitHub', forge) })
  if (!draft.trim() || Buffer.byteLength(draft) > maxCommentBytes || draft.includes('\0')) return finish('invalid')
  let attempted = false
  let confirmed = false
  try {
    const repository = (await trustedIssueRepositories(state.workspaces.values(), profile, signal)).get(issueRepositoryKey(reference))
    if (!repository || repository.tracker !== reference.tracker) return finish('changed')
    const trusted = () => {
      const current = state.workspaces.get(repository.workspace.id)
      return Boolean(current?.trusted && !current.scratch && current.profileId === profile && current.path === repository.workspace.path)
    }
    const access = repository.tracker === 'gitlab' ? await gitLabCommentAccess(repository, reference.number, signal)
      : repository.tracker === 'forgejo' ? await forgejoIssueCommentWriter(repository, reference.number, signal)
        : await githubCommentAccess(repository, reference.number, signal)
    if (!access) return finish('unavailable')
    if (!trusted() || access.scope !== scope) return finish('changed')
    const fingerprintOf = (text: string) => createHash('sha256').update(JSON.stringify([scope, text])).digest('hex')
    let text = draft
    let fingerprint = fingerprintOf(text)
    let receipt = receipts.claim(intent, fingerprint, !access.blocked)
    // An already claimed comment from the older writer used trimmed text.
    if (receipt === 'conflict' && repository.tracker === 'github' && draft !== draft.trim()) {
      const previousText = draft.trim()
      const previousFingerprint = fingerprintOf(previousText)
      const previous = receipts.inspect(intent, previousFingerprint)
      if (previous === 'pending' || previous === 'confirmed') {
        text = previousText
        fingerprint = previousFingerprint
        receipt = previous
      }
    }
    if (receipt === 'denied' || receipt === 'conflict') return finish(receipt === 'denied' ? 'denied' : 'changed')
    attempted = true
    confirmed = receipt === 'confirmed'
    // The marker identifies the write in the issue if the forge response is lost.
    const body = '<!-- harness:issue-comment:' + intent + ' -->\n\n' + text
    if (receipt === 'claimed') {
      const sent = await access.post(body, intent)
      if (typeof sent === 'number' && trusted()) {
        receipts.confirm(intent, fingerprint)
        return finish('posted', sent)
      }
      if (sent === 'denied' || sent === 'refused') {
        receipts.reject(intent, fingerprint)
        return finish(sent)
      }
    }
    const id = await access.find(body, trusted)
    if (id) {
      receipts.confirm(intent, fingerprint)
      return finish('posted', id)
    }
    return finish(confirmed ? 'posted' : 'pending')
  }
  catch { return finish(confirmed ? 'posted' : attempted ? 'pending' : 'unavailable') }
}
export type IssueCommentSubmission = NonNullable<Awaited<ReturnType<typeof submitIssueComment>>>
