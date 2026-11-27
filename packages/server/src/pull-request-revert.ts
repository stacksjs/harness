import type { LifecycleSnapshot } from './pull-request-lifecycle'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { requestPullRequestMutation } from './pull-request-lifecycle'
import { repositoryGitHubRequest } from './repository-pull-request'

const resultFields = 'id number baseRefName body author { ... on Node { id } } repository { nameWithOwner }'

type Candidate = {
  id?: string
  number?: number
  baseRefName?: string
  body?: string
  author?: { id?: string } | null
  repository?: { nameWithOwner?: string }
}
type Lookup = {
  errors?: unknown[]
  data?: { viewer?: { id?: string }, node?: {
    id?: string
    timelineItems?: {
      nodes?: ({ source?: Candidate | null } | null)[]
      pageInfo?: { hasPreviousPage?: boolean, startCursor?: string | null }
    }
  } | null }
}

export async function revertWorkspacePullRequest(path: string, repository: string, pull: LifecycleSnapshot, revisionIsCurrent: boolean,
  receipts: PullRequestReplyReceipts, signal: AbortSignal, credential: string) {
  const key = createHash('sha256').update(JSON.stringify(['revert-pull-request', pull.id, pull.mergeCommit?.oid])).digest('hex')
  const fingerprint = createHash('sha256').update(JSON.stringify([key, pull.viewer.id])).digest('hex')
  const marker = `<!-- harness-pr-revert:${key} -->`
  const candidateNumber = (candidate?: Candidate | null) => {
    const number = candidate?.number
    return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 && number !== pull.number
      && candidate?.id && candidate.id !== pull.id && candidate.baseRefName === pull.baseRefName
      && candidate.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase()
      && candidate.author?.id === pull.viewer.id && candidate.body?.split(/\r?\n/u).includes(marker) ? number : null
  }
  const find = async () => {
    let cursor: string | null = null
    const seenCursors = new Set<string>()
    while (!signal.aborted) {
      const reply = await repositoryGitHubRequest(path, 'graphql', {
        query: `query HarnessFindPullRequestRevert($id: ID!, $before: String) {
          viewer { id }
          node(id: $id) {
            ... on PullRequest {
              id
              timelineItems(last: 30, before: $before, itemTypes: [CROSS_REFERENCED_EVENT]) {
                pageInfo { hasPreviousPage startCursor }
                nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${resultFields} } } } }
              }
            }
          }
        }`,
        variables: { id: pull.id, before: cursor },
      }, signal, credential)
      const result = reply.body as Lookup | null
      const timeline = result?.data?.node?.timelineItems
      const pageInfo = timeline?.pageInfo
      if (reply.status !== 200 || result?.errors?.length || result?.data?.viewer?.id !== pull.viewer.id
        || result?.data?.node?.id !== pull.id || !Array.isArray(timeline?.nodes) || typeof pageInfo?.hasPreviousPage !== 'boolean') return undefined
      for (const item of timeline.nodes) {
        const number = candidateNumber(item?.source)
        if (number !== null) return number
      }
      if (!pageInfo.hasPreviousPage) return null
      if (!pageInfo.startCursor || seenCursors.has(pageInfo.startCursor)) return undefined
      cursor = pageInfo.startCursor
      seenCursors.add(cursor)
    }
    return undefined
  }
  const receipt = receipts.inspect(key, fingerprint)
  if (receipt === 'conflict') return 'changed'
  if (!receipt && !pull.merge.canWrite) return 'denied'
  const existing = await find().catch(() => undefined)
  if (typeof existing === 'number') {
    receipts.confirm(key, fingerprint)
    return existing
  }
  if (receipt === 'confirmed') return 'confirmed'
  if (receipt === 'pending') return 'pending'
  if (!revisionIsCurrent) return 'changed'
  if (existing === undefined) return 'unavailable'
  const claimed = receipts.claim(key, fingerprint, true)
  if (claimed === 'conflict') return 'changed'
  if (claimed === 'confirmed') return 'confirmed'
  if (claimed !== 'claimed') return 'pending'
  const write = await requestPullRequestMutation<{ revertPullRequest?: {
    clientMutationId?: string
    pullRequest?: { id?: string } | null
    revertPullRequest?: Candidate | null
  } }>(path, {
    query: `mutation HarnessRevertPullRequest($input: RevertPullRequestInput!) {
      revertPullRequest(input: $input) {
        clientMutationId pullRequest { id }
        revertPullRequest { ${resultFields} }
      }
    }`,
    variables: { input: { pullRequestId: pull.id, clientMutationId: key, body: `Reverts #${pull.number}\n\n${marker}` } },
  }, signal, credential)
  if (typeof write === 'string') {
    receipts.reject(key, fingerprint)
    return write
  }
  const payload = write.data?.revertPullRequest
  const created = payload?.clientMutationId === key && payload.pullRequest?.id === pull.id
    ? candidateNumber(payload.revertPullRequest)
    : null
  const number = created ?? await find().catch(() => undefined)
  if (typeof number !== 'number') return 'pending'
  receipts.confirm(key, fingerprint)
  return number
}
