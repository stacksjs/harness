import type { Driver, ProbeResult, ProviderEvent, ProviderInstance } from '../src/types'
import { describe, expect, it } from 'bun:test'
import { CursorDriver, GrokDriver, OpenCodeDriver } from '../src/acp'
import { CodexDriver } from '../src/codex'
import { formatConformance, runConformance } from '../src/conformance'

/**
 * A suite that only ever sees conforming drivers proves nothing — it would pass
 * just as happily if every check returned `true`. So each fake below breaks
 * exactly one invariant, and the test asserts that *that* case fails and the
 * others still pass. That is the difference between a spec and decoration.
 */

const WORKSPACE = '/tmp/harness-conformance'

function fakeDriver(options: {
  probe?: ProbeResult
  events?: ProviderEvent[]
  interrupt?: () => Promise<void>
  respondApproval?: () => Promise<void>
  stop?: () => Promise<void>
}): Driver {
  const events = options.events ?? goodTurn()
  return {
    kind: 'claude',
    async probe() {
      return options.probe ?? { status: 'ready', version: 'fake' }
    },
    async create(): Promise<ProviderInstance> {
      return {
        startTurn() {
          return (async function* () {
            for (const event of events) yield event
          })()
        },
        interrupt: options.interrupt ?? (async () => {}),
        respondApproval: options.respondApproval ?? (async () => {}),
        stop: options.stop ?? (async () => {}),
      }
    },
  }
}

function goodTurn(): ProviderEvent[] {
  return [
    { type: 'session-bound', providerSessionId: 'ps-1' },
    { type: 'assistant-delta', text: 'ok' },
    { type: 'tool-call-begin', callId: 'c1', toolName: 'Read', args: {} },
    { type: 'tool-call-end', callId: 'c1', ok: true },
    { type: 'turn-complete', tokensIn: 10, tokensOut: 2, costMicros: 1500 },
  ]
}

function failing(report: Awaited<ReturnType<typeof runConformance>>): string[] {
  return report.cases.filter(c => !c.ok).map(c => c.name)
}

describe('conformance suite', () => {
  it('passes a driver that respects every invariant', async () => {
    const report = await runConformance(fakeDriver({}), WORKSPACE)
    expect(failing(report)).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('catches a stream that never ends', async () => {
    // 600 events, past the 500 cap: the collector bails and the suite reports
    // it rather than hanging, which is the whole point of the cap.
    const flood: ProviderEvent[] = Array.from({ length: 600 }, () => ({
      type: 'assistant-delta' as const,
      text: '.',
    }))
    const report = await runConformance(fakeDriver({ events: flood }), WORKSPACE)
    expect(failing(report)).toContain('the stream terminates on its own')
  })

  it('catches a turn with no terminal event', async () => {
    const report = await runConformance(
      fakeDriver({ events: [{ type: 'assistant-delta', text: 'hi' }] }),
      WORKSPACE,
    )
    expect(failing(report)).toContain('the turn ends with exactly one terminal event')
  })

  it('catches two terminal events', async () => {
    const report = await runConformance(fakeDriver({
      events: [
        { type: 'turn-complete', tokensIn: 1, tokensOut: 1, costMicros: 1 },
        { type: 'error', message: 'and also this' },
      ],
    }), WORKSPACE)
    expect(failing(report)).toContain('the turn ends with exactly one terminal event')
  })

  it('catches a tool result with no matching call', async () => {
    const report = await runConformance(fakeDriver({
      events: [
        { type: 'tool-call-end', callId: 'ghost', ok: true },
        { type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 },
      ],
    }), WORKSPACE)
    const orphan = report.cases.find(c => c.name === 'every tool result follows its call')
    expect(orphan?.ok).toBe(false)
    expect(orphan?.detail).toContain('ghost')
  })

  it('catches rebinding the provider session mid-turn', async () => {
    const report = await runConformance(fakeDriver({
      events: [
        { type: 'session-bound', providerSessionId: 'ps-1' },
        { type: 'session-bound', providerSessionId: 'ps-2' },
        { type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0 },
      ],
    }), WORKSPACE)
    expect(failing(report)).toContain('binds a provider session at most once per turn')
  })

  it('catches negative usage', async () => {
    const report = await runConformance(fakeDriver({
      events: [{ type: 'turn-complete', tokensIn: -1, tokensOut: 0, costMicros: 0 }],
    }), WORKSPACE)
    expect(failing(report)).toContain('reports non-negative usage')
  })

  it('catches fractional cost', async () => {
    // Cost is micro-USD so a thousand turns sum exactly. A float here is the
    // start of a drift nobody notices until the numbers are wrong.
    const report = await runConformance(fakeDriver({
      events: [{ type: 'turn-complete', tokensIn: 0, tokensOut: 0, costMicros: 0.5 }],
    }), WORKSPACE)
    expect(failing(report)).toContain('reports cost as an integer')
  })

  it('catches an interrupt that throws when idle', async () => {
    const report = await runConformance(fakeDriver({
      interrupt: async () => { throw new Error('nothing to interrupt') },
    }), WORKSPACE)
    expect(failing(report)).toContain('interrupting an idle session is a no-op')
  })

  it('catches an unknown approval id that throws', async () => {
    const report = await runConformance(fakeDriver({
      respondApproval: async () => { throw new Error('no such request') },
    }), WORKSPACE)
    expect(failing(report)).toContain('an unknown approval id is ignored')
  })

  it('catches teardown that throws', async () => {
    const report = await runConformance(fakeDriver({
      stop: async () => { throw new Error('leaked') },
    }), WORKSPACE)
    expect(failing(report)).toContain('stops cleanly')
  })

  it('still runs teardown after an earlier check fails', async () => {
    // The stop check lives in a `finally`. If it did not, one bad turn would
    // skip teardown and the suite would leak the child it was testing.
    let stopped = false
    const report = await runConformance(fakeDriver({
      events: [],
      stop: async () => { stopped = true },
    }), WORKSPACE)
    expect(stopped).toBe(true)
    expect(report.cases.some(c => c.name === 'stops cleanly' && c.ok)).toBe(true)
  })

  it('accepts a driver whose CLI is absent, and stops there', async () => {
    const report = await runConformance(
      fakeDriver({ probe: { status: 'unavailable', message: 'not installed' } }),
      WORKSPACE,
    )
    expect(report.passed).toBe(true)
    expect(report.cases.some(c => c.name === 'declines cleanly when the CLI is unavailable')).toBe(true)
    // No turn was attempted — there is nothing to attempt it against.
    expect(report.cases.some(c => c.name === 'a turn produces events')).toBe(false)
  })

  it('fails a probe that throws instead of reporting', async () => {
    const thrower: Driver = {
      kind: 'claude',
      async probe(): Promise<ProbeResult> { throw new Error('boom') },
      async create() { throw new Error('unreachable') },
    }
    const report = await runConformance(thrower, WORKSPACE)
    expect(report.passed).toBe(false)
    expect(failing(report)).toContain('probe resolves rather than throwing')
  })

  it('explains why a failing case matters', async () => {
    // A report that only names the broken invariant makes the next person guess
    // whether it is worth fixing.
    const report = await runConformance(fakeDriver({
      stop: async () => { throw new Error('leaked') },
    }), WORKSPACE)
    const text = formatConformance(report)
    expect(text).toStartWith('FAIL  claude')
    expect(text).toContain('why it matters:')
    expect(text).toContain('leaks the child process')
  })
})

describe('an absent CLI is a state, not a crash', () => {
  // Every driver has a real transport now, but the first rule of the old
  // stubs still binds them all: a machine without the CLI must produce an
  // `unavailable` probe the UI can explain, never a throw that takes the
  // startup sweep down with it.
  const drivers = [
    ['cursor', CursorDriver],
    ['grok', GrokDriver],
    ['opencode', OpenCodeDriver],
    ['codex', CodexDriver],
  ] as const

  for (const [kind, driver] of drivers) {
    it(`${kind} reports a missing binary as unavailable`, async () => {
      const probe = await driver.probe({
        workspacePath: WORKSPACE,
        binaryPath: '/nonexistent/definitely-not-a-cli',
      })
      expect(driver.kind).toBe(kind)
      expect(probe.status).toBe('unavailable')
    })
  }
})
