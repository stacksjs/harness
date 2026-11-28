import type { WaitOutcome, WorkflowAnswer, WorkflowJson, WorkflowQuestionOptions, WorkflowWaitOptions } from './signals'
import type { HarnessState } from '@harness/engine'
import type { LoadedWorkflow, WorkflowContext, WorkflowIssueInput } from './definitions'
import type { WorkflowSchedule } from './schedules'
import type { WorkflowWebhook, WorkflowWebhookRequest } from './webhooks'
import type { TrackerStatus, WorkflowTrackerItem, WorkflowTrackerTrigger } from './tracker-triggers'
import { AsyncLocalStorage } from 'node:async_hooks'
import { hashesMatch, hashToken } from '../access'
import { createIssue, issueCreationScope } from '../issue-create'
import { trustedIssueProjects } from '../issue-repositories'
import { PullRequestReplyReceipts } from '../pull-request-reply-receipts'
import { loadWorkflowDefinitions, workflowName } from './definitions'
import { scheduleKey } from './schedules'
import { questionRequest, signalAddress, validWaitTimeout, waitName } from './signals'
import { presentRun, WorkflowStore } from './store'
import { openTrackerFeed, readTrackerBatch, trackerKey, trackerRepository, workflowProject } from './tracker-triggers'
import { webhookDeliveryKey, workflowHookId, workflowHookPrefix } from './webhooks'

const leaseMs = 30_000
const concurrency = 4
const trackerInterval = 60_000
const trackerConcurrency = 4
const contentsLimit = 450_000
const suspended = Symbol('workflow wait')
const stepExecution = new AsyncLocalStorage<string>()
const message = {
  changed: 'The issue project or account changed. Restore the original connection and resume.',
  denied: 'The issue tracker refused this write for the selected account.',
  unavailable: 'The issue tracker is unavailable. Restore the connection and resume.',
  'unknown-label': 'The issue tracker does not recognize a label.',
  'unknown-assignee': 'The issue tracker does not recognize an assignee.',
  refused: 'The issue tracker refused the requested fields.',
  pending: 'The issue tracker has yet to confirm the write. Resume to check the original request.',
}

type TrackerPoll = {
  key: string
  definition: LoadedWorkflow
  trigger: WorkflowTrackerTrigger
  nextAt: number
  status: TrackerStatus
}

type RegisteredHook = { definition: LoadedWorkflow, hook: WorkflowWebhook, token: string, tokenHash: string }

class WorkflowProblem extends Error {}

function json(value: unknown) {
  const encoded = JSON.stringify(value ?? null)
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > contentsLimit)
    throw new WorkflowProblem('Workflow data needs to be JSON under 450 KB.')
  return encoded
}

export class WorkflowRunner {
  private readonly owner = crypto.randomUUID()
  private readonly active = new Map<string, AbortController>()
  private readonly waitChecks = new Map<string, () => void>()
  private readonly store: WorkflowStore
  private readonly receipts: PullRequestReplyReceipts
  private readonly trackers: TrackerPoll[]
  private readonly trackerAbort = new AbortController()
  private activeTrackerPolls = 0
  private readonly webhooks = new Map<string, RegisteredHook>()
  private readonly schedules: { key: string, definition: LoadedWorkflow, schedule: WorkflowSchedule }[]
  private readonly zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  private readonly timer: ReturnType<typeof setInterval>
  private stopped = false

  private constructor(databasePath: string, private readonly state: () => HarnessState,
    private readonly loaded: Awaited<ReturnType<typeof loadWorkflowDefinitions>>,
  ) {
    this.store = new WorkflowStore(databasePath)
    const current = [...loaded.definitions.values()].map(versions => this.latest(versions))
    this.schedules = current.flatMap(definition => definition.schedules.filter(schedule => schedule.enabled !== false)
      .map(schedule => ({ key: scheduleKey(definition.name, schedule, this.zone), definition, schedule })))
    // A read error can hide an existing definition. Keep its cursor until a file loads or is removed.
    const loadedNames = loaded.problems.length ? [...loaded.definitions.keys()] : undefined
    this.store.keepSchedules(this.schedules.map(item => item.key), loadedNames)
    this.trackers = current.flatMap(definition => definition.trackerTriggers.map(trigger => ({
      key: trackerKey(definition.name, trigger), definition, trigger, nextAt: 0, status: 'waiting' as const,
    })))
    this.store.registerTrackers(this.trackers.map(({ key, definition }) => ({ key, name: definition.name })), loadedNames, Date.now())
    for (const definition of current) {
      for (const hook of definition.webhooks) {
        const id = workflowHookId(definition.name, hook)
        const token = this.store.webhookToken(id)
        this.webhooks.set(id, { definition, hook, token, tokenHash: hashToken(token) })
      }
    }
    this.receipts = new PullRequestReplyReceipts(databasePath)
    this.timer = setInterval(() => this.wake(), 2_000)
    this.timer.unref()
  }

  static async open(location: string, databasePath: string, state: () => HarnessState) {
    return new WorkflowRunner(databasePath, state, await loadWorkflowDefinitions(location))
  }

  private latest(versions: Map<number, LoadedWorkflow>) {
    return [...versions.values()].reduce((latest, definition) => definition.version > latest.version ? definition : latest)
  }

  list(profile: number) {
    return {
      workflows: [...this.loaded.definitions.values()].map(versions => {
        const current = this.latest(versions)
        const triggers = current.schedules.filter(schedule => schedule.profile === profile).map(schedule => {
          const { id, everyMs, timeOfDay, weekdays } = schedule
          const enabled = schedule.enabled !== false
          const due = enabled ? this.store.scheduleDue(scheduleKey(current.name, schedule, this.zone)) : undefined
          return {
            id, enabled, everyMs, timeOfDay, weekdays, timeZone: timeOfDay ? this.zone : undefined,
            nextAt: due === undefined ? null : new Date(due).toISOString(),
          }
        })
        const trackerTriggers = this.trackers
          .filter(item => item.definition === current && item.trigger.profile === profile)
          .map(({ trigger, status }) => ({ id: trigger.id, kind: trigger.kind, status }))
        return { name: current.name, version: current.version, triggers, trackerTriggers }
      }),
      runs: this.store.list(profile).map(presentRun),
      problems: this.loaded.problems,
    }
  }

  listWebhooks(profile: number) {
    return [...this.webhooks].flatMap(([id, { definition, hook, token }]) => hook.profile === profile
      ? [{ workflow: definition.name, name: hook.name, path: workflowHookPrefix + id + '/' + token }]
      : [])
  }

  webhookDelivery(id: string, token: string) {
    const registered = this.webhooks.get(id)
    if (this.stopped || !registered || !hashesMatch(registered.tokenHash, hashToken(token))
      || !this.state().profiles.has(registered.hook.profile)) return null
    const { definition, hook } = registered
    return (request: WorkflowWebhookRequest) => {
      if (this.stopped || !this.state().profiles.has(hook.profile)) return { error: 'hook_not_found' as const }
      const payload = JSON.stringify(request)
      let key: string
      try { key = webhookDeliveryKey(hook, request) }
      catch { return { error: 'invalid_request' as const } }
      const result = this.store.startWebhook(hook.profile, definition, { id, name: hook.name }, key, payload, Date.now())
      if ('runId' in result) queueMicrotask(() => this.wake())
      return result
    }
  }

  show(profile: number, id: string) {
    const row = this.store.run(profile, id)
    if (!row) return null
    const questions = this.store.waits.questions(profile, Date.now(), id)
    return { run: presentRun(row), steps: this.store.steps(id), references: this.store.references(id), questions }
  }

  questions(profile: number) {
    return this.store.waits.questions(profile, Date.now())
  }

  signal(profile: number, input: Record<string, unknown>, openQuestionOnly = false) {
    const invalid = { error: 'invalid' as const }
    const address = signalAddress(input)
    const key = input.key === undefined ? crypto.randomUUID() : input.key
    if (!address || (openQuestionOnly && !('runId' in address)) || !Object.hasOwn(input, 'value')
      || typeof key !== 'string' || !key.trim() || key.length > 200 || /\p{Cc}/u.test(key)) return invalid
    if ('workflow' in address && !this.loaded.definitions.has(address.workflow)) return { error: 'missing' as const }
    let serialized: string
    try { serialized = json(input.value) }
    catch { return invalid }
    const result = this.store.waits.signal(profile, address, key, serialized, Date.now(), openQuestionOnly)
    if (!('error' in result)) queueMicrotask(() => this.wake())
    return result
  }

  start(profile: number, value: unknown) {
    const input = value as { workflow?: unknown, key?: unknown, payload?: unknown } | null
    if (typeof input?.workflow !== 'string' || !workflowName.test(input.workflow) || typeof input.key !== 'string'
      || !input.key.trim() || input.key.length > 200 || /\p{Cc}/u.test(input.key)) return { error: 'invalid' as const }
    const existing = this.store.findStart(profile, input.workflow, input.key)
    if (existing) return { run: presentRun(existing), replayed: true }
    const versions = this.loaded.definitions.get(input.workflow)
    if (!versions) return { error: 'missing' as const }
    let payload: string
    try { payload = json(input.payload) }
    catch { return { error: 'invalid' as const } }
    const definition = this.latest(versions)
    const started = this.store.start(profile, definition, input.key, payload, Date.now())
    queueMicrotask(() => this.wake())
    return { run: presentRun(started.row), replayed: started.replayed }
  }

  resume(profile: number, id: string) {
    const row = this.store.run(profile, id)
    if (!row) return { error: 'missing' as const }
    if (row.status !== 'paused' || this.loaded.definitions.get(row.name)?.get(row.version)?.revision !== row.revision) return { error: 'conflict' as const }
    const resumed = this.store.resume(profile, id, Date.now())!
    queueMicrotask(() => this.wake())
    return { run: presentRun(resumed) }
  }

  cancel(profile: number, id: string) {
    const row = this.store.cancel(profile, id, Date.now())
    if (!row) return { error: 'missing' as const }
    if (row.status !== 'cancelled') return { error: 'conflict' as const }
    this.active.get(id)?.abort()
    return { run: presentRun(row) }
  }

  wake() {
    if (this.stopped) return
    try {
      const now = Date.now()
      this.store.waits.sweep(now)
      for (const [id, controller] of this.active)
        if (!this.store.renew(id, this.owner, now, now + leaseMs)) controller.abort()
      for (const check of this.waitChecks.values()) check()
      if (this.schedules.length) {
        const { profiles } = this.state()
        for (const { key, definition, schedule } of this.schedules) {
          if (profiles.has(schedule.profile)) this.store.scanSchedule(key, definition, schedule, now)
        }
      }
      this.scanTrackers(now)
      const remaining = concurrency - this.active.size
      if (remaining < 1) return
      for (const row of this.store.eligible(now, remaining)) {
        if (this.active.has(row.id) || !this.store.claim(row.id, this.owner, now, now + leaseMs)) continue
        const controller = new AbortController()
        this.active.set(row.id, controller)
        const registered = this.loaded.definitions.get(row.name)?.get(row.version)
        const definition = registered?.revision === row.revision ? registered : undefined
        void this.execute(row.id, row.profile, row.payload, definition, controller, row.start_key.startsWith('\ntracker:')).catch(() => {
          // A storage failure leaves the lease to expire. Another attempt reads the saved steps.
          console.warn('[workflows] Could not update a run. Its lease will expire.')
        })
      }
    }
    catch { console.warn('[workflows] Could not scan for runnable workflows. Retrying.') }
  }

  private scanTrackers(now: number) {
    const slots = trackerConcurrency - this.activeTrackerPolls
    if (slots <= 0 || !this.trackers.length) return
    const ready = this.trackers.filter(item => item.status !== 'polling' && item.nextAt <= now
      && this.state().profiles.has(item.trigger.profile)).sort((a, b) => a.nextAt - b.nextAt)
    for (const item of ready.slice(0, slots)) {
      item.nextAt = now + trackerInterval
      item.status = 'polling'
      this.activeTrackerPolls++
      void this.pollTracker(item).then((status) => {
        item.status = status
      }, () => {
        item.status = 'unavailable'
      }).finally(() => {
        this.activeTrackerPolls--
        if (!this.stopped) queueMicrotask(() => this.wake())
      })
    }
  }

  private async pollTracker(item: TrackerPoll): Promise<TrackerStatus> {
    const signal = AbortSignal.any([this.trackerAbort.signal, AbortSignal.timeout(45_000)])
    const { key, definition, trigger } = item
    const repository = await trackerRepository(this.state(), trigger, signal)
    if (!repository) return 'unavailable'
    const feed = await openTrackerFeed(repository, trigger, signal)
    signal.throwIfAborted()
    const cursor = this.store.bindTracker(key, feed.scope)
    if (!cursor || cursor.scope !== feed.scope) return 'account-changed'
    const batch = await readTrackerBatch(feed, repository, trigger, cursor.floor)
    if (await feed.verify() !== feed.scope) return 'account-changed'
    signal.throwIfAborted()
    const current = workflowProject(this.state(), trigger.profile, trigger.project)
    if (!current || current.id !== repository.workspace.id || current.path !== repository.workspace.path) return 'unavailable'
    this.store.acceptTrackerBatch(key, feed.scope, definition, trigger, batch, Date.now())
    return batch.complete ? 'ready' : 'backlog'
  }

  private async execute(id: string, profile: number, payload: string, definition: LoadedWorkflow | undefined,
    controller: AbortController, triggeredByTracker: boolean,
  ) {
    const { signal } = controller
    let projectId: number | undefined
    const alive = () => {
      signal.throwIfAborted()
      const state = this.state()
      if (!state.profiles.has(profile)) throw new WorkflowProblem('The workflow profile is unavailable.')
      if (projectId !== undefined) {
        const project = state.workspaces.get(projectId)
        if (project?.profileId !== profile || !project.trusted || project.scratch)
          throw new WorkflowProblem('Restore trust in the source project to resume this run.')
      }
      if (!this.store.owns(id, this.owner, Date.now())) throw new WorkflowProblem('This run lost its lease.')
    }
    const used = new Set<string>()
    const pending = new Set<Promise<unknown>>()
    const wakes = new Map<string, PromiseWithResolvers<WorkflowJson | undefined>>()
    const barrier = Promise.withResolvers<typeof suspended>()
    let activeSteps = 0
    const observe = <T>(operation: Promise<T>) => {
      pending.add(operation)
      void operation.catch(() => {})
      return operation
    }
    const valueOf = (outcome: WaitOutcome) => outcome.expired ? undefined : outcome.value
    const check = () => {
      if (signal.aborted || !wakes.size) return
      try {
        let delivered = false
        for (const [name, outcome] of wakes) {
          const result = this.store.waits.outcome(id, name)
          if (!result) continue
          wakes.delete(name)
          outcome.resolve(valueOf(result))
          delivered = true
        }
        // Let the resumed body enqueue its next activity before considering a park.
        if (delivered || activeSteps > 0 || !wakes.size) return
        const status = this.store.waits.park(id, this.owner, [...wakes.keys()], Date.now())
        if (status === 'parked') barrier.resolve(suspended)
        else if (status === 'ready') queueMicrotask(check)
        else controller.abort()
      }
      catch (error) { barrier.reject(error) }
    }
    signal.addEventListener('abort', () => {
      for (const outcome of wakes.values()) outcome.reject(signal.reason)
      wakes.clear()
    }, { once: true })
    this.waitChecks.set(id, check)
    const wait = async (name: string, options: WorkflowWaitOptions & { request?: string }) => {
      alive()
      if (stepExecution.getStore() === id) throw new WorkflowProblem('Call ask or wait from the workflow body, outside code steps.')
      if (!waitName(name) || used.has(name) || !validWaitTimeout(options.timeoutMs)
        || (options.channel !== undefined && !waitName(options.channel)))
        throw new WorkflowProblem('Each wait needs a unique name, a valid channel, and a positive timeout if supplied.')
      used.add(name)
      const schema = options.returns === undefined ? undefined : json(options.returns)
      const opened = this.store.waits.open(profile, definition!.name, id, this.owner, name, { ...options, schema }, Date.now())
      if (!opened) throw new WorkflowProblem('This run lost its lease.')
      if ('error' in opened) throw new WorkflowProblem('The wait needs a valid, synchronous JSON Schema (Draft 2020-12).')
      if (opened.outcome) return valueOf(opened.outcome)
      const outcome = Promise.withResolvers<WorkflowJson | undefined>()
      wakes.set(name, outcome)
      queueMicrotask(check)
      return outcome.promise
    }
    const ask = async (name: string, options: WorkflowQuestionOptions) => {
      const question = questionRequest(options)
      if (!question) throw new WorkflowProblem('Each question needs a title and unique choices.')
      const request = json(question)
      if (Buffer.byteLength(request) > 32_000) throw new WorkflowProblem('Question data needs to be under 32 KB.')
      return await wait(name, { request, timeoutMs: options.timeoutMs }) as WorkflowAnswer | undefined
    }
    const context: WorkflowContext = {
      signal,
      title: (title) => {
        alive()
        if (typeof title !== 'string' || !title.trim() || title.length > 256 || /\p{Cc}/u.test(title))
          throw new WorkflowProblem('Workflow titles need one line and at most 256 characters.')
        this.store.title(id, this.owner, Date.now(), title.trim())
      },
      ask: <const Choices extends readonly string[]>(name: string, options: WorkflowQuestionOptions & { choices: Choices }) =>
        observe(ask(name, options)) as Promise<WorkflowAnswer<Choices[number]> | undefined>,
      wait: (name, options = {}) => observe(wait(name, options)),
      step: <T>(name: string, work: Parameters<WorkflowContext['step']>[1]) => {
        activeSteps++
        const operation = stepExecution.run(id, () => this.step(id, profile, name, work, alive, signal, used)).finally(() => {
          activeSteps--
          queueMicrotask(check)
        })
        return observe(operation) as Promise<T>
      },
    }
    try {
      const input = JSON.parse(payload) as unknown
      if (triggeredByTracker) projectId = (input as WorkflowTrackerItem).projectId
      alive()
      if (!definition) throw new WorkflowProblem('The workflow version is unavailable. Restore its definition and resume.')
      const run = async () => {
        const result = await definition.run(input, context)
        await Promise.all(pending)
        return result
      }
      const result = await Promise.race([run(), barrier.promise])
      if (result === suspended) return
      alive()
      this.store.finish(id, this.owner, 'completed', Date.now(), null, json(result))
    }
    catch (error) {
      if (!signal.aborted) {
        const reason = error instanceof WorkflowProblem ? error.message : 'A workflow step failed. Review the definition and resume.'
        this.store.finish(id, this.owner, 'paused', Date.now(), reason, null)
      }
    }
    finally {
      controller.abort()
      this.active.delete(id)
      this.waitChecks.delete(id)
      queueMicrotask(() => this.wake())
    }
  }

  private async step(id: string, profile: number, name: string, work: Parameters<WorkflowContext['step']>[1],
    alive: () => void, signal: AbortSignal, used: Set<string>,
  ) {
    alive()
    if (!waitName(name) || used.has(name))
      throw new WorkflowProblem('Each step needs a unique name in this run.')
    used.add(name)
    const row = this.store.beginStep(id, this.owner, name, Date.now())
    if (!row) throw new WorkflowProblem('This run lost its lease.')
    if (row.saved !== null) return JSON.parse(row.saved) as unknown
    let position = 0
    let interpreting = true
    const writes: Promise<unknown>[] = []
    try {
      const result = await work({ signal, issues: { create: (input) => {
        alive()
        if (!interpreting) return Promise.reject(new WorkflowProblem('Issue creation needs an active step.'))
        const operation = this.fileIssue(id, profile, name, position++, input, alive, signal)
        writes.push(operation)
        void operation.catch(() => {})
        return operation
      } } })
      await Promise.all(writes)
      alive()
      const serialized = json(result)
      if (!this.store.completeStep(id, this.owner, name, Date.now(), serialized))
        throw new WorkflowProblem('This run lost its lease.')
      return JSON.parse(serialized) as unknown
    }
    finally { interpreting = false }
  }

  private async fileIssue(id: string, profile: number, step: string, position: number, input: WorkflowIssueInput,
    alive: () => void, signal: AbortSignal,
  ) {
    if (!input || (typeof input.project !== 'number' && typeof input.project !== 'string') || typeof input.title !== 'string')
      throw new WorkflowProblem('Issue creation needs a project and title.')
    const workspace = workflowProject(this.state(), profile, input.project)
    if (!workspace) throw new WorkflowProblem('Choose one trusted project in the workflow’s profile.')
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
    const [project] = await trustedIssueProjects([workspace], profile, requestSignal)
    const repository = input.repository ? project?.repositories.get(input.repository) : project?.repositories.values().next().value
    if (!repository) throw new WorkflowProblem('The workflow’s project has no selected issue repository.')
    const query = new URLSearchParams({ profile: String(profile), workspace: String(workspace.id), repository: repository.key })
    const target = query.toString()
    alive()
    let intent = this.store.issueIntent(id, step, position)
    if (!intent) {
      const scope = await issueCreationScope(this.state(), query, requestSignal)
      alive()
      if (!scope) throw new WorkflowProblem('Could not confirm the issue tracker account.')
      intent = this.store.saveIssueIntent(id, this.owner, step, position, Date.now(), target, scope)
    }
    if (!intent || intent.target !== target) throw new WorkflowProblem('The workflow’s issue repository changed.')
    alive()
    const result = await createIssue(this.state(), query, { scope: intent.scope, intent: intent.intent, title: input.title,
      body: input.body ?? '', labels: input.labels ?? [], assignees: input.assignees ?? [],
    }, requestSignal, this.receipts)
    alive()
    if (!result) throw new WorkflowProblem('The workflow supplied invalid issue fields.')
    if (result.status !== 'created') throw new WorkflowProblem(message[result.status])
    if (!this.store.recordIssue(id, this.owner, step, position, Date.now(), result.issue))
      throw new WorkflowProblem('This run lost its lease.')
    return result.issue
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    this.trackerAbort.abort()
    for (const controller of this.active.values()) controller.abort()
    this.store.release(this.owner)
    this.store.close()
  }
}
