export interface ThreadSnoozeChoice {
  id: string
  label: string
  detail: string
  until: number
  minutes?: number
}

const MINUTE = 60_000

function localWake(now: Date, daysAhead: number, hour: number): Date {
  const wake = new Date(now)
  wake.setDate(now.getDate() + daysAhead)
  wake.setHours(hour, 0, 0, 0)
  return wake
}

/** Default wake choices in the current device's time zone, in wake order. */
export function threadSnoozeChoices(now: Date): ThreadSnoozeChoice[] {
  if (!Number.isFinite(now.getTime())) return []
  const nextMonday = (1 - now.getDay() + 7) % 7 || 7
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
  const candidates = [
    { id: 'hour', label: 'In 1 hour', wake: new Date(now.getTime() + 60 * MINUTE), minutes: 60, namesDay: false },
    { id: 'three-hours', label: 'In 3 hours', wake: new Date(now.getTime() + 180 * MINUTE), minutes: 180, namesDay: false },
    { id: 'evening', label: 'This evening', wake: localWake(now, 0, 18), namesDay: true },
    { id: 'tomorrow', label: 'Tomorrow', wake: localWake(now, 1, 9), namesDay: true },
    { id: 'next-week', label: nextMonday === 1 ? 'Tomorrow' : 'Next week', wake: localWake(now, nextMonday, 9), namesDay: nextMonday === 1 },
  ].sort((first, second) => Math.floor(first.wake.getTime() / MINUTE) - Math.floor(second.wake.getTime() / MINUTE))

  const seen = new Set<number>()
  const choices: ThreadSnoozeChoice[] = []
  for (const candidate of candidates) {
    const until = candidate.wake.getTime()
    const minute = Math.floor(until / MINUTE)
    if (until <= now.getTime() || seen.has(minute)) continue
    seen.add(minute)
    const showDay = !candidate.namesDay && candidate.wake.toDateString() !== now.toDateString()
    const detail = showDay ? `${weekday.format(candidate.wake)} ${time.format(candidate.wake)}` : time.format(candidate.wake)
    choices.push({ id: candidate.id, label: candidate.label, minutes: candidate.minutes, until, detail })
  }
  return choices
}

export function chosenSnoozeTime(choice: ThreadSnoozeChoice, now: number): number | undefined {
  if (choice.minutes) return now + choice.minutes * MINUTE
  return choice.until > now ? choice.until : undefined
}
