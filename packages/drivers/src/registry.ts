/**
 * The driver registry.
 *
 * Adding a provider is one import and one entry — no orchestration, contract or
 * client change. A `driverKind` with no driver resolves to `null` rather than
 * throwing, so a session recorded against a provider this build does not ship
 * surfaces as unavailable instead of crashing the server at hydrate time.
 */

import type { DriverKind } from '@harness/contract'
import type { Driver } from './types'
import { ClaudeDriver } from './claude'

export const registry: Partial<Record<DriverKind, Driver>> = {
  claude: ClaudeDriver,
}

export function resolveDriver(kind: DriverKind): Driver | null {
  return registry[kind] ?? null
}
