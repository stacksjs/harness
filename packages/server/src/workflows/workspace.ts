import type { HarnessState } from '@harness/engine'
import type { WorkflowRunner } from './runner'
import { issueRepositoryKey, parseForgejoIssueUrl, parseIssueUrl } from '@harness/contract'
import { readRepositoryBody } from '../repository-commit'
import { workflowName } from './definitions'
import { workflowRunId } from './http'

const statuses = [
  { key: 'needs-you', label: 'Needs you', status: 'paused', empty: 'Nothing waits on you.' },
  { key: 'running', label: 'Running', status: 'running', empty: 'Nothing is running.' },
  { key: 'all', label: 'All', status: '', empty: 'No runs yet.' },
]
const words: Record<string, string> = { running: 'Running', paused: 'Paused', completed: 'Completed', cancelled: 'Cancelled', failed: 'Failed' }
const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const intervalUnits = [[86_400_000, 'day'], [3_600_000, 'hour'], [60_000, 'minute'], [1000, 'second']] as const

function workflowInterval(milliseconds: number) {
  const [duration, unit] = intervalUnits.find(([duration]) => milliseconds % duration === 0) ?? intervalUnits[3]
  return 'Every ' + new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'long' }).format(milliseconds / duration)
}

type StartDraft = { workflow: string, key: string, payload: string, message?: string }

function preview(result: unknown) {
  if (result === null || result === undefined) return ''
  const value = JSON.stringify(result, null, 2)
  return value.length <= 24_000 ? value : value.slice(0, 24_000) + '\n…'
}

function issueLink(profile: number, url: string) {
  const ref = parseIssueUrl(url) ?? parseForgejoIssueUrl(url)
  return ref ? '/issues?' + new URLSearchParams({
    profile: String(profile), selected: issueRepositoryKey(ref), issue: String(ref.number),
  }) : ''
}

function workflowHref(profile: number, values: Record<string, string> = {}) {
  return '/workflows?' + new URLSearchParams({ view: 'workspace', profile: String(profile), ...values })
}

function activeFilter(query: URLSearchParams) {
  const filter = query.get('filter') ?? ''
  return statuses.some(status => status.key === filter) ? filter : ''
}

function selectedWorkflow(query: URLSearchParams) {
  const workflow = query.get('workflow') ?? ''
  return workflowName.test(workflow) ? workflow : ''
}

function selection(query: URLSearchParams) {
  const supplied = query.get('run') ?? ''
  const filter = activeFilter(query)
  const workflow = selectedWorkflow(query)
  return { filter, workflow, run: workflowRunId.test(supplied) ? supplied : '', requested: Boolean(supplied) }
}

function queryFields(values: { filter: string, workflow: string }) {
  return { ...(values.filter && { filter: values.filter }), ...(values.workflow && { workflow: values.workflow }) }
}

export function workflowWorkspace(runner: WorkflowRunner, state: HarnessState, profile: number, query: URLSearchParams, draft?: StartDraft) {
  const { filter, workflow, run, requested } = selection(query)
  const fields = queryFields({ filter, workflow })
  const snapshot = runner.list(profile)
  const available = [...new Set([...snapshot.workflows.map(definition => definition.name), ...snapshot.runs.map(item => item.workflow)])].sort()
  const matching = workflow ? snapshot.runs.filter(item => item.workflow === workflow) : snapshot.runs
  const referenced = run ? runner.show(profile, run) : null
  const priority = matching.find(item => item.status === 'paused') ?? matching.find(item => item.status === 'running')
  const inferred = referenced?.run ?? priority
  const chosen = statuses.find(item => item.key === filter) ?? statuses.find(item => item.status === inferred?.status) ?? statuses[2]!
  const rows = chosen.status ? matching.filter(item => item.status === chosen.status) : matching
  const detail = requested ? referenced : rows[0] ? runner.show(profile, rows[0].runId) : null
  const listHref = workflowHref(profile, fields)
  const mode = query.get('page') === 'definitions' ? 'definitions' : query.get('page') === 'start' ? 'start' : 'runs'
  const notice = query.get('notice')
  const messages: Record<string, string> = {
    resumed: 'Run resumed.', cancelled: 'Run cancelled.', reused: 'This start key already has a run.',
    conflict: 'The run changed or its original definition is unavailable. Refresh and check its status.',
    missing: 'This run is unavailable in the selected profile.',
  }
  const references = detail?.references.flatMap(reference => {
    const href = issueLink(profile, reference.url)
    return href ? [{ ...reference, issueHref: href }] : []
  }) ?? []
  return {
    mode, profile, workflow, showDetail: requested, missingRun: requested && !detail,
    profiles: [...state.profiles.values()].map(item => ({ id: item.id, name: item.name })),
    definitions: snapshot.workflows.map(definition => ({
      ...definition,
      triggers: definition.triggers.map(trigger => ({
        ...trigger,
        cadence: trigger.everyMs !== undefined ? workflowInterval(trigger.everyMs)
          : (trigger.weekdays?.length ? trigger.weekdays.map(day => weekdays[day]).join(', ') : 'Daily')
          + ' at ' + trigger.timeOfDay + ' (' + trigger.timeZone + ')',
        next: trigger.nextAt ? date.format(new Date(trigger.nextAt)) : '',
      })),
    })),
    problems: snapshot.problems,
    workflowChoices: available,
    tabs: statuses.map(item => ({
      key: item.key, label: item.label, current: chosen.key === item.key,
      count: item.status ? matching.filter(run => run.status === item.status).length : matching.length,
      href: workflowHref(profile, { ...fields, filter: item.key }),
    })),
    emptyText: chosen.empty,
    rows: rows.map(row => ({
      key: row.runId, title: row.title, workflow: row.workflow,
      status: row.status, word: words[row.status], updatedAt: row.updatedAt, updated: date.format(new Date(row.updatedAt)),
      current: detail?.run.runId === row.runId, href: workflowHref(profile, { ...fields, filter: chosen.key, run: row.runId }),
    })),
    detail: detail && {
      ...detail.run, word: words[detail.run.status], started: date.format(new Date(detail.run.startedAt)),
      scheduled: detail.run.schedule ? date.format(new Date(detail.run.schedule.scheduledAt)) : '',
      result: preview(detail.run.result), references, canResume: detail.run.status === 'paused',
      canCancel: detail.run.status === 'paused' || detail.run.status === 'running',
      steps: detail.steps.map(step => ({ ...step, word: words[step.status], result: preview(step.result),
        references: references.filter(reference => reference.step === step.name),
      })),
    },
    workspaceHref: '/?profile=' + profile,
    listHref,
    definitionsHref: workflowHref(profile, { ...fields, page: 'definitions' }),
    startHref: workflowHref(profile, { ...fields, page: 'start' }),
    pollHref: '/workflows/view?' + new URLSearchParams({ profile: String(profile), ...fields, ...(requested && { run: run || '_' }) }),
    action: '/workflows/action?' + new URLSearchParams({ profile: String(profile), ...fields }),
    pending: snapshot.runs.some(item => item.status === 'running'),
    message: notice ? messages[notice] ?? '' : '',
    draft: draft ?? { workflow: workflow || snapshot.workflows[0]?.name || '', key: crypto.randomUUID(), payload: '{}' },
  }
}

export async function workflowForm(runner: WorkflowRunner, profile: number, request: Request, query: URLSearchParams) {
  const contentType = request.headers.get('content-type')?.split(';')[0]
  if (request.method !== 'POST') return { response: new Response(null, { status: 405, headers: { allow: 'POST' } }) }
  if (contentType !== 'application/x-www-form-urlencoded') return { response: new Response(null, { status: 415 }) }
  const raw = await readRepositoryBody(request, 460_000)
  if (raw === null) return { response: new Response(null, { status: 400 }) }
  const form = new URLSearchParams(raw)
  const fields = queryFields(selection(query))
  const redirect = (values: Record<string, string>) => ({
    response: new Response(null, {
      status: 303, headers: { 'location': workflowHref(profile, { ...fields, ...values }), 'cache-control': 'private, no-store' },
    }),
  })
  const action = form.get('action')
  if (action === 'start') {
    const draft = { workflow: form.get('workflow') ?? '', key: form.get('key') ?? '', payload: form.get('payload') ?? '' }
    let payload: unknown
    try { payload = JSON.parse(draft.payload || 'null') }
    catch { return { draft: { ...draft, message: 'Enter valid JSON for the input.' } } }
    const started = runner.start(profile, { ...draft, payload })
    if (!('error' in started)) return redirect({ run: started.run.runId, ...(started.replayed && { notice: 'reused' }) })
    return { draft: { ...draft, message: started.error === 'missing' ? 'Choose a registered workflow.' : 'Choose a valid workflow and enter a start key.' } }
  }
  const id = form.get('id') ?? ''
  if ((action !== 'resume' && action !== 'cancel') || !workflowRunId.test(id)) return { response: new Response(null, { status: 400 }) }
  const result = action === 'resume' ? runner.resume(profile, id) : runner.cancel(profile, id)
  return redirect({ run: id, notice: 'error' in result ? result.error ?? 'conflict' : action === 'resume' ? 'resumed' : 'cancelled' })
}
