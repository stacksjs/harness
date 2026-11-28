import type { WorkflowRunner } from './runner'
import { hashToken } from '../access'
import { readRepositoryBody } from '../repository-commit'

export interface WorkflowWebhookRequest {
  method: string
  headers: Record<string, string>
  query: string
  body: string
}

export interface WorkflowWebhook {
  name: string
  profile: number
  key?: (request: WorkflowWebhookRequest) => string | undefined
}

export const workflowHookPrefix = '/api/hooks/'
const hookRoute = /^\/api\/hooks\/(wf-[\da-f]{64})\/([A-Z\da-z_-]{43})$/u
const hookName = /^[a-z\d][a-z\d._-]{0,79}$/iu
const limit = 1024 * 1024
const methods = ['GET', 'POST', 'PUT', 'PATCH']
const privateHeaders = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token'])
const deliveryHeaders = ['x-github-delivery', 'x-gitea-delivery', 'x-gitlab-event-uuid', 'linear-delivery', 'webhook-id', 'idempotency-key']
const headers = { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' }

export function readWebhooks(input: unknown): WorkflowWebhook[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new Error('Workflow webhooks need a list of named hooks.')
  const seen = new Set<string>()
  return input.map((item) => {
    const value = item as Partial<WorkflowWebhook> | null
    if (!value || typeof value.name !== 'string' || !hookName.test(value.name)
      || typeof value.profile !== 'number' || !Number.isSafeInteger(value.profile) || value.profile < 1
      || (value.key !== undefined && typeof value.key !== 'function'))
      throw new Error('Each webhook needs a valid name, profile ID, and optional key function.')
    const identity = JSON.stringify([value.profile, value.name])
    if (seen.has(identity)) throw new Error('Webhook names must be unique within a workflow and profile.')
    seen.add(identity)
    return { name: value.name, profile: value.profile, key: value.key }
  })
}

export function workflowHookId(workflow: string, hook: WorkflowWebhook) {
  return 'wf-' + hashToken(JSON.stringify([hook.profile, workflow, hook.name]))
}

export function webhookDeliveryKey(hook: WorkflowWebhook, request: WorkflowWebhookRequest) {
  const supplied = hook.key?.(request)
  if (supplied !== undefined) {
    if (typeof supplied !== 'string' || !supplied.trim()) throw new Error('Invalid webhook key')
    return hashToken('authored:' + supplied)
  }
  const sent = deliveryHeaders.find(name => request.headers[name])
  return hashToken(sent ? 'sender:' + sent + ':' + request.headers[sent] : 'request:' + crypto.randomUUID())
}

export async function respondWorkflowWebhook(runner: WorkflowRunner | null, request: Request, url: URL, allowed: boolean, permittedPeer: boolean) {
  const json = (value: object, status: number, extra?: Record<string, string>) =>
    Response.json(value, { status, headers: { ...headers, ...extra } })
  const match = hookRoute.exec(url.pathname)
  if (!match || !runner || !permittedPeer) return json({ error: 'hook_not_found' }, 404)
  const origin = request.headers.get('origin')
  const site = request.headers.get('sec-fetch-site')
  if ((origin !== null && origin !== url.origin) || site === 'cross-site' || site === 'same-site')
    return json({ error: 'hook_not_found' }, 404)
  const [, hookId, token] = match
  const deliver = runner.webhookDelivery(hookId!, token!)
  if (!deliver) return json({ error: 'hook_not_found' }, 404)
  if (!allowed) return json({ error: 'blocked_by_policy' }, 403)
  if (!methods.includes(request.method)) return json({ error: 'method_not_allowed' }, 405, { allow: methods.join(', ') })
  const length = Number(request.headers.get('content-length') ?? 0)
  if (!Number.isFinite(length) || length > limit) return json({ error: 'body_too_large' }, 413)
  const body = request.body ? await readRepositoryBody(request, limit) : ''
  if (body === null) return json({ error: 'body_too_large_or_unreadable' }, 413)

  const fields = Object.fromEntries([...request.headers].filter(([name]) => !privateHeaders.has(name)))
  const delivered = deliver({ method: request.method, headers: fields, query: url.search.slice(1), body })
  if ('runId' in delivered) return json(delivered, 202)
  if (delivered.error === 'rate_limited') return json(delivered, 429, { 'retry-after': '60' })
  return json(delivered, delivered.error === 'invalid_request' ? 400 : 404)
}
