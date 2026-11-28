import type { WorkflowRunner } from './runner'
import { readRepositoryBody } from '../repository-commit'
import { workflowRunId } from './signals'

export const workflowRoutes = new Set(['/workflows', '/workflows/hooks', '/workflows/run', '/workflows/questions', '/workflows/signal', '/workflows/start', '/workflows/resume', '/workflows/cancel', '/workflows/view', '/workflows/action'])

const headers = { 'cache-control': 'private, no-store', 'x-frame-options': 'DENY', 'vary': 'Accept' }

export async function respondWorkflows(runner: WorkflowRunner | null, profile: number | null, request: Request, url: URL, allowWebhooks = true) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers })
  if (!runner) return json({ error: 'workflows-disabled' }, 404)
  if (profile === null) return json({ error: 'missing-profile' }, 404)
  const read = ['/workflows', '/workflows/run', '/workflows/hooks', '/workflows/questions'].includes(url.pathname)
  const method = read ? 'GET' : 'POST'
  if (request.method !== method)
    return new Response(null, { status: 405, headers: { ...headers, allow: method } })
  if (url.pathname === '/workflows/hooks') return allowWebhooks
    ? json({ hooks: runner.listWebhooks(profile) })
    : json({ error: 'blocked_by_policy' }, 403)
  if (url.pathname === '/workflows') return json(runner.list(profile))
  if (url.pathname === '/workflows/questions') return json({ questions: runner.questions(profile) })
  if (url.pathname === '/workflows/run') {
    const id = url.searchParams.get('id')
    const detail = id && workflowRunId.test(id) ? runner.show(profile, id) : null
    return detail ? json(detail) : json({ error: 'missing' }, 404)
  }
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'invalid-content-type' }, 415)
  const raw = await readRepositoryBody(request, 451_000)
  let input: Record<string, unknown> | null
  try {
    input = raw === null ? null : JSON.parse(raw)
    if (!input || typeof input !== 'object' || Array.isArray(input)) return json({ error: 'invalid' }, 400)
  }
  catch { return json({ error: 'invalid' }, 400) }
  if (url.pathname === '/workflows/start') {
    const result = runner.start(profile, input)
    return json(result, 'error' in result ? result.error === 'missing' ? 404 : 400 : result.replayed ? 200 : 202)
  }
  if (url.pathname === '/workflows/signal') {
    const result = runner.signal(profile, input)
    const status = 'error' in result ? result.error === 'missing' ? 404 : result.error === 'conflict' ? 409 : 400
      : result.status === 'buffered' ? 202 : 200
    return json(result, status)
  }
  if (typeof input.id !== 'string' || !workflowRunId.test(input.id)) return json({ error: 'invalid' }, 400)
  const result = url.pathname === '/workflows/resume' ? runner.resume(profile, input.id) : runner.cancel(profile, input.id)
  return json(result, 'error' in result ? result.error === 'missing' ? 404 : 409 : 200)
}
