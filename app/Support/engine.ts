import type { Engine as EngineType } from '@harness/engine'
import { Engine, reduce, SqliteStore } from '@harness/engine'

/**
 * The engine, for commands that run outside the server.
 *
 * A CLI command is a client like any other: it dispatches and reads the
 * resulting projection, it does not write rows. That is what keeps a profile
 * created from the terminal identical to one created from the desktop app —
 * same log, same ordering, same audit trail.
 *
 * Shared rather than repeated per command file, which is how the second copy
 * drifts from the first.
 */

const DB_PATH = 'database/stacks.sqlite'

export async function boot(): Promise<EngineType> {
  const engine = new Engine({ store: new SqliteStore(DB_PATH), reducer: reduce })
  await engine.hydrate()
  return engine
}

/**
 * Command ids are the idempotency key, so they must be unique per intent —
 * hence the random suffix. A caller that wants a retry to be recognised as a
 * retry passes its own id instead.
 */
export function commandId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
