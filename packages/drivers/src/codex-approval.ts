import type { ApprovalSelection, ToolApprovalChoice } from '@harness/contract'
import { offeredToolApproval } from '@harness/contract'

const standardChoices = [
  { id: 'accept', decision: 'allowed', scope: 'once', label: 'Allow' },
  { id: 'decline', decision: 'denied', scope: 'once', label: 'Deny' },
  { id: 'acceptForSession', decision: 'allowed', scope: 'session', label: 'Allow for this session' },
  { id: 'cancel', decision: 'cancelled', scope: 'once', label: 'Cancel' },
] satisfies ToolApprovalChoice[]

const legacyDecisions: Record<string, unknown> = {
  accept: 'approved',
  decline: { denied: { rejection: 'User declined the request.' } },
  acceptForSession: 'approved_for_session',
  cancel: 'abort',
}

export function codexApproval(method: string, params: Record<string, unknown> | null | undefined) {
  const permissionsRequest = method === 'item/permissions/requestApproval'
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
  const { availableDecisions, permissions } = params ?? {}
  const offered = Array.isArray(availableDecisions) ? availableDecisions : null
  const permissionPreview = permissionsRequest && permissions && typeof permissions === 'object' && !Array.isArray(permissions)
    ? JSON.stringify(permissions, null, 2)
    : undefined
  const detail = permissionPreview && permissionPreview.length <= 4096 ? permissionPreview : undefined
  const choices = standardChoices.filter((choice) => {
    if (offered && !offered.includes(choice.id)) return false
    if (!permissionsRequest) return true
    return choice.decision !== 'cancelled' && (choice.decision !== 'allowed' || detail !== undefined)
  })
  const rejectedPermissions = { permissions: {}, scope: 'turn' }

  function responseFor(id: string) {
    if (!permissionsRequest) return { decision: legacy ? legacyDecisions[id] : id }
    const accepted = id === 'accept' || id === 'acceptForSession'
    return accepted ? { permissions, scope: id === 'acceptForSession' ? 'session' : 'turn' } : rejectedPermissions
  }

  return {
    choices, detail,
    response(selection: ApprovalSelection) {
      const selected = offeredToolApproval(choices, selection)
      return responseFor(selected?.id ?? 'cancel')
    },
    automatic: responseFor(choices.some(choice => choice.id === 'accept') ? 'accept' : 'cancel'),
    cancel: responseFor('cancel'),
  }
}
