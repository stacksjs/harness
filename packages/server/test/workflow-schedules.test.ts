import { emptyState } from '@harness/engine'
import { expect, it, spyOn } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowRunner } from '../src/workflows/runner'
import { readSchedules, scheduleKey } from '../src/workflows/schedules'
import { WorkflowStore } from '../src/workflows/store'

it('rejects malformed schedules and normalizes equivalent weekdays and times', () => {
  expect(() => readSchedules({})).toThrow('list of named schedules')
  const schedule = { id: 'review', profile: 1, timeOfDay: '9:00', weekdays: [5, 1, 1] }
  expect(readSchedules([schedule])).toEqual([{ ...schedule, timeOfDay: '09:00', weekdays: [1, 5] }])
  expect(() => readSchedules([schedule, schedule])).toThrow('unique')
  expect(() => readSchedules([{ ...schedule, profile: 1.5 }])).toThrow('profile ID')
  expect(() => readSchedules([{ ...schedule, everyMs: 60_000 }])).toThrow('no daily options')
  expect(() => readSchedules([{ ...schedule, timeOfDay: '25:00' }])).toThrow('24-hour')
  expect(() => readSchedules([{ ...schedule, weekdays: [7] }])).toThrow('0 (Sunday)')
  expect(() => readSchedules([{ id: 'quick', profile: 1, everyMs: 59_999 }])).toThrow('at least one minute')
})

it('uses the host clock through gaps and repeated hours and observes weekdays', () => {
  const scenarios = [
    { from: '2026-03-08T09:00:00Z', timeOfDay: '02:30', expected: '2026-03-08T10:30:00.000Z' },
    { from: '2026-03-08T10:30:00Z', timeOfDay: '02:30', expected: '2026-03-09T09:30:00.000Z' },
    { from: '2026-11-01T07:00:00Z', timeOfDay: '01:30', expected: '2026-11-01T08:30:00.000Z' },
    { from: '2026-11-01T08:30:00Z', timeOfDay: '01:30', expected: '2026-11-02T09:30:00.000Z' },
    { from: '2026-07-03T17:00:00Z', timeOfDay: '09:00', weekdays: [1, 2, 3, 4, 5], expected: '2026-07-06T16:00:00.000Z' },
  ]
  const result = Bun.spawnSync([process.execPath, '--no-env-file', '--eval', `
    import { nextScheduleAt } from ${JSON.stringify(join(import.meta.dir, '../src/workflows/schedules.ts'))}
    const cases = ${JSON.stringify(scenarios)}
    console.log(JSON.stringify(cases.map(({ from, timeOfDay, weekdays }) => new Date(
      nextScheduleAt({ id: 'daily', profile: 1, timeOfDay, weekdays }, Date.parse(from))
    ).toISOString())))
  `], { env: { ...process.env, TZ: 'America/Los_Angeles' } })
  expect(result.stderr.toString()).toBe('')
  expect(result.success).toBe(true)
  expect(JSON.parse(result.stdout.toString())).toEqual(scenarios.map(scenario => scenario.expected))
})

it('rolls back the cursor if a run insert fails and advances exactly once after recovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-schedule-'))
  const path = join(directory, 'state.sqlite')
  const first = new WorkflowStore(path)
  const second = new WorkflowStore(path)
  const fault = new Database(path)
  try {
    const definition = { name: 'report', version: 1, revision: 'original' }
    const schedule = { id: 'minute', profile: 1, everyMs: 60_000 }
    const key = scheduleKey(definition.name, schedule, 'UTC')
    const start = Date.parse('2026-11-28T12:00:00Z')
    first.scanSchedule(key, definition, schedule, start)
    fault.exec(`CREATE TRIGGER fail_scheduled_insert BEFORE INSERT ON harness_workflow_runs
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    expect(() => first.scanSchedule(key, definition, schedule, start + 60_000)).toThrow('simulated write failure')
    expect(second.scheduleDue(key)).toBe(start + 60_000)
    expect(second.list(1)).toHaveLength(0)
    fault.exec('DROP TRIGGER fail_scheduled_insert')
    second.scanSchedule(key, definition, schedule, start + 300_000)
    first.scanSchedule(key, definition, schedule, start + 300_000)
    expect(first.scheduleDue(key)).toBe(start + 360_000)
    expect(first.list(1)).toMatchObject([{ name: 'report', payload: '{"scheduledAt":"2026-11-28T12:01:00.000Z"}' }])
  }
  finally {
    fault.close()
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('preserves overdue schedules across restart, scopes runs and resets disabled schedules', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-schedule-'))
  const path = join(directory, 'state.sqlite')
  const state = emptyState()
  for (const id of [1, 2]) state.profiles.set(id, { id, name: 'Profile ' + id, icon: '', tint: '', position: id, workspaceIds: [], mcpServers: [] })
  const today = new Date(2026, 10, 28, 11, 59).getTime()
  let now = today
  const clock = spyOn(Date, 'now').mockImplementation(() => now)
  const iso = (value: number) => new Date(value).toISOString()
  const makeFile = (revision: number, enabled: boolean) => {
    const source = join(directory, 'report-' + revision + '.ts')
    writeFileSync(source, `export default {
      name: 'report', version: ${revision}, run: input => input,
      schedules: [
        { id: 'minute', profile: 1, everyMs: 60000, enabled: ${enabled} },
        { id: 'noon', profile: 1, timeOfDay: '12:00', enabled: ${enabled} },
        { id: 'next-minute', profile: 1, timeOfDay: '12:01', enabled: ${enabled} },
        { id: 'absent', profile: 3, everyMs: 60000, enabled: ${enabled} },
      ],
    }`)
    return source
  }
  let runner: WorkflowRunner | undefined
  let peer: WorkflowRunner | undefined
  try {
    const original = makeFile(1, true)
    const current = makeFile(2, true)
    const disabled = makeFile(3, false)
    const reenabled = makeFile(4, true)
    runner = await WorkflowRunner.open(original, path, () => state)
    runner.wake()
    expect(runner.list(1).runs).toHaveLength(0)
    expect(runner.list(1).workflows[0]?.triggers).toMatchObject([
      { id: 'minute', nextAt: iso(today + 60_000) },
      { id: 'noon', nextAt: iso(today + 60_000) },
      { id: 'next-minute', nextAt: iso(today + 120_000) },
    ])
    expect(runner.list(2).workflows[0]?.triggers).toHaveLength(0)
    runner.stop()

    now += 12 * 60_000
    runner = await WorkflowRunner.open(join(directory, 'unavailable.ts'), path, () => state)
    expect(runner.list(1).problems).toHaveLength(1)
    runner.wake()
    runner.stop()
    runner = await WorkflowRunner.open(current, path, () => state)
    peer = await WorkflowRunner.open(current, path, () => state)
    runner.wake()
    peer.wake()
    // Both version 2 runs retain their original due time, including exactly ten minutes late.
    await Bun.sleep(0)
    const first = runner.list(1).runs
    expect(first).toHaveLength(2)
    for (const [id, due] of [['minute', today + 60_000], ['next-minute', today + 120_000]] as const) {
      expect(first.find(run => run.schedule?.id === id)).toMatchObject({
        version: 2, status: 'completed', startedAt: iso(now),
        schedule: { id, scheduledAt: iso(due) }, result: { scheduledAt: iso(due) },
      })
    }
    expect(runner.list(2).runs).toHaveLength(0)
    expect(runner.list(3).runs).toHaveLength(0)
    expect(runner.start(1, { workflow: 'report', key: '\nscheduled:minute:example' })).toEqual({ error: 'invalid' })
    const manual = runner.start(1, { workflow: 'report', key: 'scheduled:minute:example' })
    expect(manual).toMatchObject({ replayed: false })
    expect(manual).not.toHaveProperty('run.schedule')
    peer.stop()
    runner.stop()

    runner = await WorkflowRunner.open(disabled, path, () => state)
    now += 60_000
    runner.wake()
    expect(runner.list(1).runs).toHaveLength(3)
    expect(runner.list(1).workflows[0]?.triggers).toMatchObject([{ enabled: false, nextAt: null }, { enabled: false }, { enabled: false }])
    runner.stop()
    runner = await WorkflowRunner.open(reenabled, path, () => state)
    runner.wake()
    expect(runner.list(1).runs).toHaveLength(3)
    expect(runner.list(1).workflows[0]?.triggers[0]?.nextAt).toBe(iso(now + 60_000))
    now += 60_000
    runner.wake()
    expect(runner.list(1).runs).toHaveLength(4)
  }
  finally {
    runner?.stop()
    peer?.stop()
    clock.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})
