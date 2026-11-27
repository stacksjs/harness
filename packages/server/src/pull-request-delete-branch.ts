import type { LifecycleSnapshot, SourceRef, SourceRepository } from './pull-request-lifecycle'
import type { PullRequestReplyReceipts } from './pull-request-reply-receipts'
import { createHash } from 'node:crypto'
import { allowsRefDeletion, canDeleteSourceBranch, deletableSourceBranch, requestPullRequestMutation, sourceRepositoryFields } from './pull-request-lifecycle'
import { repositoryGitHubRequest } from './repository-pull-request'

type SourceBranch = { name: string, repositoryId: string }
type RepositoryBranch = SourceRepository & { ref?: (SourceRef & { name?: string, prefix?: string }) | null }
type ReadReply = { errors?: unknown[], data?: { viewer?: { id?: string }, node?: RepositoryBranch | null } }

export async function deleteWorkspacePullRequestBranch(path: string, pull: LifecycleSnapshot, branch: SourceBranch,
  revisionIsCurrent: boolean, trusted: () => boolean, receipts: PullRequestReplyReceipts, signal: AbortSignal, credential: string) {
  const repository = pull.headRepository
  if (repository?.id !== branch.repositoryId || pull.headRefName !== branch.name || !repository.nameWithOwner) return 'changed'
  const refName = `refs/heads/${branch.name}`
  const key = createHash('sha256').update(JSON.stringify(['delete-pull-request-branch', pull.id, repository.id, refName, pull.headRefOid])).digest('hex')
  const fingerprint = createHash('sha256').update(JSON.stringify([key, pull.viewer.id])).digest('hex')
  const read = async () => {
    const reply = await repositoryGitHubRequest(path, 'graphql', {
      query: `query HarnessReadPullRequestSourceBranch($id: ID!, $ref: String!) {
        viewer { id }
        node(id: $id) {
          ... on Repository {
            ${sourceRepositoryFields}
            ref(qualifiedName: $ref) { name prefix target { oid } branchProtectionRule { id allowsDeletions lockBranch } }
          }
        }
      }`,
      variables: { id: branch.repositoryId, ref: refName },
    }, signal, credential)
    const result = reply.body as ReadReply | null
    const node = result?.data?.node
    if (reply.status !== 200 || result?.errors?.length || result?.data?.viewer?.id !== pull.viewer.id
      || !node || node.id !== repository.id || node.nameWithOwner !== repository.nameWithOwner) return null
    if (node.ref !== null && (node.ref?.name !== branch.name || node.ref.prefix !== 'refs/heads/'
      || !/^[0-9a-f]{40}$/u.test(node.ref.target?.oid ?? ''))) return null
    return node
  }
  const confirm = () => {
    receipts.confirm(key, fingerprint)
    return 'updated' as const
  }
  const recover = (node: RepositoryBranch | null) => {
    if (!trusted()) return 'changed'
    if (node?.ref === null) return confirm()
    return node && node.ref?.target?.oid !== pull.headRefOid ? 'branch-changed' : 'pending'
  }
  const receipt = receipts.inspect(key, fingerprint)
  if (receipt === 'conflict') return 'changed'
  if (receipt === 'confirmed') return 'confirmed'
  // A lost response may have deleted a branch that was later recreated at the same commit.
  if (receipt === 'pending') return recover(await read().catch(() => null))
  if (!canDeleteSourceBranch(repository, branch.name) || pull.viewerCanDeleteHeadRef !== true) return 'denied'
  if (pull.headRef && pull.headRef.target?.oid !== pull.headRefOid) return 'branch-changed'
  if (!revisionIsCurrent || !deletableSourceBranch(pull)) return 'changed'
  const current = await read().catch(() => null)
  if (!trusted()) return 'changed'
  if (!current) return 'unavailable'
  if (!current.ref || current.ref.target?.oid !== pull.headRefOid) return 'branch-changed'
  if (!canDeleteSourceBranch(current, branch.name) || !allowsRefDeletion(current.ref)) return 'denied'
  const claimed = receipts.claim(key, fingerprint, true)
  if (claimed === 'conflict') return 'changed'
  if (claimed === 'confirmed') return 'confirmed'
  if (claimed !== 'claimed') return 'pending'

  const write = await requestPullRequestMutation<{ updateRefs?: { clientMutationId?: string } | null }>(path, {
    query: `mutation HarnessDeletePullRequestBranch($input: UpdateRefsInput!) {
      updateRefs(input: $input) { clientMutationId }
    }`,
    variables: { input: { repositoryId: branch.repositoryId, clientMutationId: key,
      refUpdates: [{ name: refName, beforeOid: pull.headRefOid, afterOid: '0'.repeat(40) }] } },
  }, signal, credential)
  if (typeof write !== 'string' && write.data?.updateRefs?.clientMutationId === key) return confirm()
  const latest = await read().catch(() => null)
  if (typeof write !== 'string' || latest?.ref === null) return recover(latest)
  receipts.reject(key, fingerprint)
  if (latest && latest.ref?.target?.oid !== pull.headRefOid) return 'branch-changed'
  return write
}
