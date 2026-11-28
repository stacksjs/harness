export type WorkflowJson = null | boolean | number | string | WorkflowJson[] | { [key: string]: WorkflowJson }
export type WorkflowWaitOptions = { channel?: string, timeoutMs?: number }
export type WorkflowQuestionOptions = { title: string, choices: readonly string[], data?: WorkflowJson, timeoutMs?: number }
export type WorkflowAnswer<Choice extends string = string> = { choice: Choice, reason?: string }
export type SignalAddress = { runId: string, wait: string } | { workflow: string, channel: string }
export type WaitOutcome = { expired: true } | { expired: false, value: WorkflowJson }
export type QuestionRequest = Omit<WorkflowQuestionOptions, 'timeoutMs'>

export const workflowRunId = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u
const workflowName = /^[a-z\d][a-z\d._-]{0,79}$/iu
export const workflowSignalTtl = 7 * 24 * 60 * 60 * 1000

export function waitName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && /^[^\p{Cc}]{1,120}$/u.test(value)
}

export function validWaitTimeout(value: number | undefined) {
  return value === undefined || Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(Date.now() + value).getTime())
}

export function questionRequest(options: WorkflowQuestionOptions): QuestionRequest | null {
  if (!options || typeof options.title !== 'string' || !options.title.trim() || options.title.length > 1000
    || !Array.isArray(options.choices) || options.choices.length < 1 || options.choices.length > 32
    || [...options.choices].some(choice => !waitName(choice)) || new Set(options.choices).size !== options.choices.length)
    return null
  const { title, choices, data } = options
  return { title: title.trim(), choices: [...choices], ...(data !== undefined && { data }) }
}

export function validAnswer(question: QuestionRequest, value: unknown): value is WorkflowAnswer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const answer = value as Partial<WorkflowAnswer>
  return typeof answer.choice === 'string' && question.choices.includes(answer.choice)
    && (answer.reason === undefined || typeof answer.reason === 'string' && answer.reason.length <= 2000)
    && Object.keys(answer).every(key => key === 'choice' || key === 'reason')
}

export function signalAddress(input: Record<string, unknown>): SignalAddress | null {
  if (typeof input.runId === 'string' && workflowRunId.test(input.runId) && waitName(input.wait)
    && input.workflow === undefined && input.channel === undefined)
    return { runId: input.runId, wait: input.wait }
  if (typeof input.workflow === 'string' && workflowName.test(input.workflow) && waitName(input.channel)
    && input.runId === undefined && input.wait === undefined)
    return { workflow: input.workflow, channel: input.channel }
  return null
}
