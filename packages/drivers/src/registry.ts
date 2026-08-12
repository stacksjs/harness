/**
 * The driver registry.
 *
 * Adding a provider is one import and one entry — no orchestration, contract or
 * client change. A `driverKind` with no driver resolves to `null` rather than
 * throwing, so a session recorded against a provider this build does not ship
 * surfaces as unavailable instead of crashing the server at hydrate time.
 *
 * Every kind in the contract is registered, including the four whose transports
 * are unimplemented. That is deliberate: a registered driver probes and reports
 * a reason ("codex is installed but the driver is not implemented yet"), while
 * an absent one produces "no driver for codex" — which tells the user nothing
 * they can act on.
 */

import type { DriverKind } from '@harness/contract'
import type { Driver } from './types'
import { CursorDriver } from './acp'
import { ClaudeDriver } from './claude'
import { GrokDriver, OpenCodeDriver } from './cli-driver'
import { CodexDriver } from './codex'

export const registry: Record<DriverKind, Driver> = {
  claude: ClaudeDriver,
  codex: CodexDriver,
  cursor: CursorDriver,
  grok: GrokDriver,
  opencode: OpenCodeDriver,
}

export function resolveDriver(kind: DriverKind): Driver | null {
  return registry[kind] ?? null
}

/** Every registered kind, for a startup probe sweep. */
export function driverKinds(): DriverKind[] {
  return Object.keys(registry) as DriverKind[]
}
