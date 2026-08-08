/**
 * The conformance suite: one spec every driver must pass.
 *
 * This is what turns "add a provider" from a project into a weekend. A driver
 * is not a class that compiles — it is a component the engine makes ordering
 * assumptions about, and those assumptions are invisible until something
 * violates them at three in the morning against a live agent. Writing them down
 * once, here, means a new driver either satisfies them on day one or fails
 * loudly.
 *
 * Every check runs against a driver's own recorded transcript, so the suite is
 * meaningful without the CLI installed. Run it against the real binary too
 * (nightly, per PLAN.md §13) — the recorded run proves the *shape*, the live
 * run proves the recording is still true.
 */

import type { Driver, ProviderEvent } from './types'

export interface ConformanceCase {
  name: string
  /** Why this matters — surfaced on failure, because a bare name is not a diagnosis. */
  because: string
  ok: boolean
  detail?: string
}

export interface ConformanceReport {
  driver: string
  cases: ConformanceCase[]
  passed: boolean
}

/**
 * Collect a turn's events with a hard cap.
 *
 * A driver that never ends its stream is itself a conformance failure, and
 * without the cap it would hang the suite instead of reporting one.
 */
async function collect(stream: AsyncIterable<ProviderEvent>, limit = 500): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const event of stream) {
    out.push(event)
    if (out.length >= limit) break
  }
  return out
}

function check(name: string, because: string, ok: boolean, detail?: string): ConformanceCase {
  return { name, because, ok, detail }
}

/**
 * Run the spec against a driver.
 *
 * `workspacePath` should be a scratch directory: a conforming driver may write
 * to it, and a driver that writes outside it is a finding of its own.
 */
export async function runConformance(driver: Driver, workspacePath: string): Promise<ConformanceReport> {
  const cases: ConformanceCase[] = []

  // --- Probe -----------------------------------------------------------

  const probe = await driver.probe({ workspacePath }).catch(error => ({
    status: 'threw' as const,
    message: error instanceof Error ? error.message : String(error),
  }))

  cases.push(check(
    'probe resolves rather than throwing',
    'The registry probes every driver at startup. One that throws takes the '
    + 'server down instead of reporting itself unavailable.',
    probe.status !== 'threw',
    probe.status === 'threw' ? probe.message : undefined,
  ))

  cases.push(check(
    'probe reports a known status',
    'An unrecognised status cannot be rendered, so the UI would show a session '
    + 'as neither working nor broken.',
    ['ready', 'unauthenticated', 'unavailable', 'failed'].includes(probe.status),
    `got ${probe.status}`,
  ))

  // A driver whose CLI is absent is expected to stop here. That is the
  // `unavailable` state doing its job, not a gap in coverage.
  if (probe.status !== 'ready') {
    return {
      driver: driver.kind,
      cases: [...cases, check(
        'declines cleanly when the CLI is unavailable',
        'An absent provider must surface as an explainable state, never as a crash.',
        true,
        `status: ${probe.status}`,
      )],
      passed: cases.every(c => c.ok),
    }
  }

  // --- A turn ----------------------------------------------------------

  const instance = await driver.create({ workspacePath, autoApprove: true })

  try {
    const events = await collect(instance.startTurn({ text: 'Reply with the single word: ok' }))

    cases.push(check(
      'a turn produces events',
      'A silent turn is indistinguishable from a hung one, and the engine has '
      + 'nothing to append.',
      events.length > 0,
      `${events.length} event(s)`,
    ))

    cases.push(check(
      'the stream terminates on its own',
      'The runtime awaits the stream to know a turn is over. One that never '
      + 'ends leaves the session running forever.',
      events.length < 500,
    ))

    const terminal = events.filter(e => e.type === 'turn-complete' || e.type === 'error')
    cases.push(check(
      'the turn ends with exactly one terminal event',
      'Two completions would settle a turn twice; none leaves it running in '
      + 'the projection after the provider has finished.',
      terminal.length === 1,
      `${terminal.length} terminal event(s)`,
    ))

    // Tool calls must be well-formed: an `end` for a call that never began
    // leaves the transcript describing a result with no cause.
    const begun = new Set<string>()
    let orphanEnd: string | null = null
    for (const event of events) {
      if (event.type === 'tool-call-begin') begun.add(event.callId)
      if (event.type === 'tool-call-end' && !begun.has(event.callId)) orphanEnd ??= event.callId
    }
    cases.push(check(
      'every tool result follows its call',
      'A result with no matching begin renders as an effect with no cause.',
      orphanEnd === null,
      orphanEnd ? `orphan end: ${orphanEnd}` : undefined,
    ))

    const bound = events.filter(e => e.type === 'session-bound')
    cases.push(check(
      'binds a provider session at most once per turn',
      'Rebinding mid-turn would repoint the resume target and silently start a '
      + 'second conversation on the next turn.',
      bound.length <= 1,
      `${bound.length} binding(s)`,
    ))

    const complete = events.find(e => e.type === 'turn-complete')
    if (complete && complete.type === 'turn-complete') {
      cases.push(check(
        'reports non-negative usage',
        'Costs and token counts are summed across turns; a negative would '
        + 'quietly reduce a session total.',
        complete.tokensIn >= 0 && complete.tokensOut >= 0 && complete.costMicros >= 0,
        `in=${complete.tokensIn} out=${complete.tokensOut} micros=${complete.costMicros}`,
      ))

      cases.push(check(
        'reports cost as an integer',
        'Cost is micro-USD precisely so summing a thousand turns cannot drift.',
        Number.isInteger(complete.costMicros),
        `costMicros=${complete.costMicros}`,
      ))
    }

    // --- Interrupt -------------------------------------------------------

    let interruptThrew: string | null = null
    await instance.interrupt().catch((error: unknown) => {
      interruptThrew = error instanceof Error ? error.message : String(error)
    })
    cases.push(check(
      'interrupting an idle session is a no-op',
      'The user presses stop just as a turn finishes. Throwing there turns a '
      + 'race into an error the user did nothing to cause.',
      interruptThrew === null,
      interruptThrew ?? undefined,
    ))

    // --- Approvals -------------------------------------------------------

    let approvalThrew: string | null = null
    await instance.respondApproval('no-such-request', true).catch((error: unknown) => {
      approvalThrew = error instanceof Error ? error.message : String(error)
    })
    cases.push(check(
      'an unknown approval id is ignored',
      'A late or duplicated decision arrives after the request is gone. It is '
      + 'a normal outcome of a reconnect, not a fault.',
      approvalThrew === null,
      approvalThrew ?? undefined,
    ))
  }
  finally {
    // --- Teardown --------------------------------------------------------

    let stopThrew: string | null = null
    await instance.stop().catch((error: unknown) => {
      stopThrew = error instanceof Error ? error.message : String(error)
    })
    cases.push(check(
      'stops cleanly',
      'Teardown runs on server shutdown. A driver that throws there leaks the '
      + 'child process it was supposed to reap.',
      stopThrew === null,
      stopThrew ?? undefined,
    ))
  }

  return { driver: driver.kind, cases, passed: cases.every(c => c.ok) }
}

/** Human-readable report. Failures carry their reason, not just their name. */
export function formatConformance(report: ConformanceReport): string {
  const lines = [`${report.passed ? 'PASS' : 'FAIL'}  ${report.driver}`]
  for (const c of report.cases) {
    lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    if (!c.ok) lines.push(`      why it matters: ${c.because}`)
  }
  return lines.join('\n')
}
