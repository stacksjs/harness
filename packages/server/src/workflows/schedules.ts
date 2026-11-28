export type WorkflowSchedule = {
  id: string
  profile: number
  enabled?: boolean
} & (
  | { everyMs: number, timeOfDay?: never, weekdays?: never }
  | { timeOfDay: string, weekdays?: number[], everyMs?: never }
)

const minute = 60_000
const timeOfDay = /^([01]?\d|2[0-3]):([0-5]\d)$/u
const scheduleId = /^[a-z\d][a-z\d._-]{0,79}$/iu

export function readSchedules(input: unknown): WorkflowSchedule[] {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw new Error('Workflow schedules need a list of named schedules.')
  const seen = new Set<string>()
  return input.map((item) => {
    const value = item as Partial<WorkflowSchedule> | null
    if (!value || typeof value.id !== 'string' || !scheduleId.test(value.id)
      || typeof value.profile !== 'number' || !Number.isSafeInteger(value.profile) || value.profile < 1
      || (value.enabled !== undefined && typeof value.enabled !== 'boolean'))
      throw new Error('Each schedule needs a valid ID, profile ID, and optional enabled flag.')
    const { id, profile, enabled } = value
    const key = JSON.stringify([profile, id])
    if (seen.has(key)) throw new Error('Schedule IDs must be unique within a workflow and profile.')
    seen.add(key)
    if (value.everyMs !== undefined) {
      if (!Number.isSafeInteger(value.everyMs) || value.everyMs < minute || !Number.isFinite(new Date(Date.now() + value.everyMs).getTime())
        || value.timeOfDay !== undefined || value.weekdays !== undefined)
        throw new Error('An interval schedule needs a valid everyMs of at least one minute and no daily options.')
      return { id, profile, enabled, everyMs: value.everyMs }
    }
    const time = typeof value.timeOfDay === 'string' && timeOfDay.exec(value.timeOfDay.trim())
    if (!time) throw new Error('A daily schedule needs a 24-hour time such as 09:00.')
    if (value.weekdays !== undefined && (!Array.isArray(value.weekdays)
      || [...value.weekdays].some(day => !Number.isInteger(day) || day < 0 || day > 6)))
      throw new Error('Schedule weekdays must be 0 (Sunday) through 6 (Saturday).')
    const days = [...new Set(value.weekdays)].sort((a, b) => a - b)
    return { id, profile, enabled, timeOfDay: time[1]!.padStart(2, '0') + ':' + time[2], weekdays: days.length === 7 ? [] : days }
  })
}

export function scheduleKey(workflow: string, schedule: WorkflowSchedule, zone: string) {
  return JSON.stringify([schedule.profile, workflow, schedule.id, schedule.everyMs ?? [schedule.timeOfDay, schedule.weekdays, zone]])
}

export function nextScheduleAt(schedule: WorkflowSchedule, now: number) {
  if (schedule.everyMs !== undefined) return now + schedule.everyMs
  const [hour, minute] = schedule.timeOfDay.split(':').map(Number)
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(now)
    candidate.setDate(candidate.getDate() + offset)
    // Local Date moves through a skipped hour and chooses the first instant in a repeated hour.
    candidate.setHours(hour!, minute!, 0, 0)
    if (candidate.getTime() > now && (!schedule.weekdays?.length || schedule.weekdays.includes(candidate.getDay())))
      return candidate.getTime()
  }
  throw new Error('Could not calculate the next daily workflow run.')
}

export function shouldFireSchedule(schedule: WorkflowSchedule, dueAt: number, now: number) {
  return dueAt <= now && (schedule.everyMs !== undefined || now - dueAt <= 10 * minute)
}
