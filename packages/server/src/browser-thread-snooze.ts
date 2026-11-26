import type { SnoozeDay, SnoozePreset } from '@harness/contract'
import { defaultSnoozePresets, maxSnoozeMinutes, maxSnoozePresets, sameSnoozePresets, snoozeDays, snoozePresetKey } from '@harness/contract'

export interface ThreadSnoozeChoice {
  id: string
  label: string
  detail: string
  until: number
  minutes?: number
}

const MINUTE = 60_000
const snoozeUnits = { minutes: 1, hours: 60, days: 1440 } as const
type SnoozeUnit = keyof typeof snoozeUnits

function snoozeDuration(minutes: number): { amount: number, unit: SnoozeUnit } {
  const unit = minutes % snoozeUnits.days === 0 ? 'days' : minutes % snoozeUnits.hours === 0 ? 'hours' : 'minutes'
  return { amount: minutes / snoozeUnits[unit], unit }
}

function resolveSnoozePreset(preset: SnoozePreset, now: Date): ThreadSnoozeChoice | undefined {
  if (!Number.isFinite(now.getTime())) return
  const wake = new Date(now)
  let label: string
  let namesDay = false
  if (preset.kind === 'after') {
    const { amount, unit } = snoozeDuration(preset.minutes)
    label = `In ${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`
    wake.setTime(now.getTime() + preset.minutes * MINUTE)
  }
  else {
    const { day, time } = preset
    const [hour, minute] = time.split(':').map(Number) as [number, number]
    const weekday = snoozeDays.indexOf(day) - 2
    const daysAhead = day === 'today' ? 0 : day === 'tomorrow' ? 1 : (weekday - now.getDay() + 7) % 7 || 7
    wake.setDate(now.getDate() + daysAhead)
    wake.setHours(hour, minute, 0, 0)
    namesDay = true
    if (daysAhead === 0) label = hour < 12 ? 'This morning' : hour < 17 ? 'This afternoon' : 'This evening'
    else if (daysAhead === 1) label = 'Tomorrow'
    else if (day === 'monday') {
      label = 'Next week'
      namesDay = false
    }
    else label = (daysAhead === 7 ? 'Next ' : '') + day[0]!.toUpperCase() + day.slice(1)
  }
  const until = wake.getTime()
  if (!Number.isFinite(until) || until <= now.getTime()) return
  const time = wake.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const detail = namesDay || wake.toDateString() === now.toDateString()
    ? time
    : `${wake.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return {
    id: snoozePresetKey(preset),
    label,
    detail,
    until,
    ...(preset.kind === 'after' && { minutes: preset.minutes }),
  }
}

/** Device-local wake times, soonest first, with one choice per minute. */
export function threadSnoozeChoices(now: Date, presets: readonly SnoozePreset[] = defaultSnoozePresets): ThreadSnoozeChoice[] {
  const minute = (choice: ThreadSnoozeChoice) => Math.floor(choice.until / MINUTE)
  const choices = presets.flatMap(preset => resolveSnoozePreset(preset, now) ?? [])
    .sort((first, second) => minute(first) - minute(second))
  return choices.filter((choice, index) => index === 0 || minute(choice) !== minute(choices[index - 1]!))
}

export function chosenSnoozeTime(choice: ThreadSnoozeChoice, now: number): number | undefined {
  if (choice.minutes) return now + choice.minutes * MINUTE
  return choice.until > now ? choice.until : undefined
}

interface SnoozeRow {
  id: number
  when: 'after' | SnoozeDay
  amount: number
  unit: SnoozeUnit
  time: string
}

function presetFromRow(row: SnoozeRow): SnoozePreset {
  return row.when === 'after'
    ? { kind: 'after', minutes: row.amount * snoozeUnits[row.unit] }
    : { kind: 'at', day: row.when, time: row.time }
}

const addCandidates: readonly SnoozePreset[] = [
  ...defaultSnoozePresets,
  { kind: 'after', minutes: 30 },
  { kind: 'at', day: 'saturday', time: '09:00' },
  { kind: 'after', minutes: 1440 },
]

function arrangeRows(rows: SnoozeRow[], now: Date): SnoozeRow[] {
  return rows.map(row => ({ row, wake: resolveSnoozePreset(presetFromRow(row), now)?.until ?? Number.MAX_VALUE }))
    .sort((first, second) => first.wake - second.wake)
    .map(entry => entry.row)
}

interface SnoozeEditorOptions {
  initial: readonly SnoozePreset[]
  render: (rows: readonly SnoozeRow[]) => void
  error: (message: string) => void
  save: (presets: readonly SnoozePreset[]) => Promise<unknown>
}

export function createSnoozeEditor(options: SnoozeEditorOptions) {
  let nextId = 0
  let saved = options.initial
  let saving = false
  let pending = saved

  function newRow(preset: SnoozePreset): SnoozeRow {
    const row: SnoozeRow = { id: ++nextId, when: 'after', amount: 1, unit: 'hours', time: '09:00' }
    return preset.kind === 'after'
      ? { ...row, ...snoozeDuration(preset.minutes) }
      : { ...row, when: preset.day, time: preset.time }
  }

  let rows = arrangeRows(saved.map(newRow), new Date())
  options.render(rows)

  function restoreSavedRows(): void {
    if (sameSnoozePresets(rows.map(presetFromRow), saved)) return
    rows = arrangeRows(saved.map(newRow), new Date())
    options.render(rows)
  }

  async function commit(next: SnoozeRow[]): Promise<void> {
    rows = next
    pending = next.map(presetFromRow)
    options.render(rows)
    options.error('')
    if (saving) return
    saving = true
    try {
      let target = pending
      while (!sameSnoozePresets(saved, target)) {
        try {
          await options.save(target)
        }
        catch (error) {
          // Another client can win the race to write the same values.
          if (!sameSnoozePresets(saved, target)) throw error
        }
        saved = target
        target = pending
      }
    }
    catch (error) {
      restoreSavedRows()
      options.error(error instanceof Error ? error.message : 'Could not save snooze options.')
    }
    finally {
      saving = false
    }
  }

  return {
    receive(presets: readonly SnoozePreset[]) {
      if (sameSnoozePresets(saved, presets)) return
      saved = presets
      if (!saving) restoreSavedRows()
    },
    arrange() {
      const ordered = arrangeRows(rows, new Date())
      if (ordered.every((row, index) => row === rows[index])) return
      rows = ordered
      options.render(rows)
    },
    add() {
      if (rows.length >= maxSnoozePresets) return
      const used = new Set(rows.map(row => snoozePresetKey(presetFromRow(row))))
      const candidate = addCandidates.find(preset => !used.has(snoozePresetKey(preset))) ?? defaultSnoozePresets[0]!
      void commit([...rows, newRow(candidate)])
    },
    remove(id: number) {
      void commit(rows.filter(row => row.id !== id))
    },
    reset() {
      void commit(arrangeRows(defaultSnoozePresets.map(newRow), new Date()))
    },
    change(id: number, field: 'when' | 'amount' | 'unit' | 'time', input: HTMLInputElement | HTMLSelectElement) {
      const row = rows.find(row => row.id === id)
      if (!row) return
      const value = input.value
      const valid = input.validity.valid && value !== ''
      if (!valid) {
        input.value = String(row[field])
        options.error(field === 'amount' ? `Enter a whole number from 1 to ${maxSnoozeMinutes / snoozeUnits[row.unit]}.` : 'Enter a time for this option.')
        return
      }
      const next = { ...row, [field]: field === 'amount' ? Number(value) : value }
      if (field === 'unit') next.amount = Math.min(next.amount, maxSnoozeMinutes / snoozeUnits[next.unit])
      void commit(rows.map(entry => entry.id === id ? next : entry))
    },
    previews(rows: readonly SnoozeRow[], now: Date) {
      const ids = new Set<string>()
      const minutes = new Set<number>()
      return Object.fromEntries(rows.map((row) => {
        const choice = resolveSnoozePreset(presetFromRow(row), now)
        if (!choice) return [row.id, 'This time has passed today.']
        if (ids.has(choice.id)) return [row.id, 'Duplicate of an option above']
        const minute = Math.floor(choice.until / MINUTE)
        if (minutes.has(minute)) return [row.id, 'Same time as an option above']
        ids.add(choice.id)
        minutes.add(minute)
        return [row.id, `${choice.label} · ${choice.detail}`]
      }))
    },
    menuPreview(rows: readonly SnoozeRow[], now: Date) {
      const choices = threadSnoozeChoices(now, rows.map(presetFromRow))
      return choices.map(choice => choices.filter(candidate => candidate.label === choice.label).length > 1
        ? `${choice.label} ${choice.detail}` : choice.label).join(', ')
    },
    isDefault(rows: readonly SnoozeRow[]) {
      const keys = rows.map(row => snoozePresetKey(presetFromRow(row))).sort()
      const defaults = defaultSnoozePresets.map(snoozePresetKey).sort()
      return defaults.length === keys.length && defaults.every((key, index) => key === keys[index])
    },
    maxAmount(row: SnoozeRow) {
      return maxSnoozeMinutes / snoozeUnits[row.unit]
    },
  }
}
