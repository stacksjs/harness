import { describe, expect, it } from 'bun:test'
import { chosenSnoozeTime, threadSnoozeChoices } from '../src/browser-thread-snooze'

describe('thread snooze choices', () => {
  it('sorts by wake minute and uses the next Monday after today', () => {
    const monday = new Date(2026, 10, 23, 17, 0)
    const choices = threadSnoozeChoices(monday)
    expect(choices.map(choice => choice.id)).toEqual(['hour', 'three-hours', 'tomorrow', 'next-week'])
    const next = choices.find(choice => choice.id === 'next-week')!
    expect(next.until).toBe(new Date(2026, 10, 30, 9, 0).getTime())
  })

  it('drops passed times and merges tomorrow with the following Monday on Sunday', () => {
    const sunday = new Date(2026, 10, 22, 21, 30)
    const choices = threadSnoozeChoices(sunday)
    expect(choices.map(choice => choice.id)).toEqual(['hour', 'three-hours', 'tomorrow'])
    expect(choices[2]?.until).toBe(new Date(2026, 10, 23, 9, 0).getTime())
  })

  it('keeps a displayed calendar wake and computes durations from selection', () => {
    const shownAt = new Date(2026, 2, 7, 22, 0)
    const choices = threadSnoozeChoices(shownAt)
    const duration = choices.find(choice => choice.id === 'hour')!
    const tomorrow = choices.find(choice => choice.id === 'tomorrow')!
    const selectedAt = new Date(2026, 2, 8, 1, 15).getTime()
    expect(chosenSnoozeTime(duration, selectedAt)).toBe(selectedAt + 60 * 60_000)
    expect(chosenSnoozeTime(tomorrow, selectedAt)).toBe(new Date(2026, 2, 8, 9).getTime())
    expect(chosenSnoozeTime(tomorrow, tomorrow.until)).toBeUndefined()
  })
})
