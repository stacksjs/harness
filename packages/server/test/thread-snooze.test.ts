import type { SnoozePreset } from '@harness/contract'
import { describe, expect, it } from 'bun:test'
import { chosenSnoozeTime, createSnoozeEditor, threadSnoozeChoices } from '../src/browser-thread-snooze'

describe('thread snooze choices', () => {
  it('sorts by wake minute and uses the next Monday after today', () => {
    const monday = new Date(2026, 10, 23, 17, 0)
    const choices = threadSnoozeChoices(monday)
    expect(choices.map(choice => choice.id)).toEqual(['after:60', 'after:180', 'at:tomorrow:09:00', 'at:monday:09:00'])
    const next = choices.find(choice => choice.id === 'at:monday:09:00')!
    expect(next.until).toBe(new Date(2026, 10, 30, 9, 0).getTime())
  })

  it('drops passed times and merges tomorrow with the following Monday on Sunday', () => {
    const sunday = new Date(2026, 10, 22, 21, 30)
    const choices = threadSnoozeChoices(sunday)
    expect(choices.map(choice => choice.id)).toEqual(['after:60', 'after:180', 'at:tomorrow:09:00'])
    expect(choices[2]?.until).toBe(new Date(2026, 10, 23, 9, 0).getTime())
  })

  it('keeps a displayed calendar wake and computes durations from selection', () => {
    const shownAt = new Date(2026, 2, 7, 22, 0)
    const choices = threadSnoozeChoices(shownAt)
    const duration = choices.find(choice => choice.id === 'after:60')!
    const tomorrow = choices.find(choice => choice.id === 'at:tomorrow:09:00')!
    const selectedAt = new Date(2026, 2, 8, 1, 15).getTime()
    expect(chosenSnoozeTime(duration, selectedAt)).toBe(selectedAt + 60 * 60_000)
    expect(chosenSnoozeTime(tomorrow, selectedAt)).toBe(new Date(2026, 2, 8, 9).getTime())
    expect(chosenSnoozeTime(tomorrow, tomorrow.until)).toBeUndefined()
  })

  it('orders mixed presets and deduplicates by minute using settings order', () => {
    const friday = new Date(2026, 10, 27, 10, 10, 20)
    const presets = [
      { kind: 'at', day: 'friday', time: '16:15' },
      { kind: 'at', day: 'today', time: '10:20' },
      { kind: 'after', minutes: 10 },
      { kind: 'after', minutes: 1440 },
      { kind: 'at', day: 'today', time: '10:00' },
    ] as const
    const choices = threadSnoozeChoices(friday, presets)
    expect(choices.map(choice => choice.label)).toEqual(['This morning', 'In 1 day', 'Next Friday'])
    expect(choices.map(choice => choice.until)).toEqual([
      new Date(2026, 10, 27, 10, 20).getTime(),
      friday.getTime() + 86_400_000,
      new Date(2026, 11, 4, 16, 15).getTime(),
    ])
    expect(threadSnoozeChoices(friday, [])).toEqual([])
  })
})

describe('snooze editor', () => {
  it('keeps later edits and row identity while a prior save is in flight', async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const writes: Array<readonly SnoozePreset[]> = []
    let rowIds: number[] = []
    const editor = createSnoozeEditor({
      initial: [],
      render: rows => { rowIds = rows.map(row => row.id) },
      error: message => { expect(message).toBe('') },
      save: (presets) => {
        writes.push(presets)
        return writes.length === 1 ? first.promise : second.promise
      },
    })
    editor.add()
    const firstId = rowIds[0]
    editor.add()
    expect(writes).toEqual([[{ kind: 'after', minutes: 60 }]])
    editor.receive(writes[0]!)
    expect(rowIds).toHaveLength(2)
    first.resolve()
    await Promise.resolve()
    expect(writes[1]).toEqual([{ kind: 'after', minutes: 60 }, { kind: 'after', minutes: 180 }])
    second.resolve()
    await Promise.resolve()
    editor.receive(writes[1]!)
    expect(rowIds[0]).toBe(firstId)
  })

  it('restores host rows and surfaces a rejected save', async () => {
    let count = 0
    let error = ''
    const editor = createSnoozeEditor({
      initial: [],
      render: rows => { count = rows.length },
      error: (message) => { error = message },
      save: () => Promise.reject(new Error('Host disconnected')),
    })
    editor.add()
    expect(count).toBe(1)
    await Promise.resolve()
    expect(count).toBe(0)
    expect(error).toBe('Host disconnected')
  })
})
