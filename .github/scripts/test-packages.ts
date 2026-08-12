/**
 * Run each workspace package's test suite from inside the package.
 *
 * The root `bun test` deliberately confines discovery to `tests/` —
 * bunfig.toml's `[test] root` explains the pantry symlink explosion that
 * forced it — so the suites under `packages/<name>/test` are invisible to it and
 * must be run with the package as the working directory, which is also what
 * gives each one its package-local resolution. Without this, CI green means
 * "the app tests pass" while the engine, server, contract, client and driver
 * suites never ran at all.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

let failed = false

for (const name of readdirSync('packages').sort()) {
  const dir = join('packages', name)
  if (!existsSync(join(dir, 'test'))) continue

  console.log(`\n── ${dir}`)
  const result = spawnSync('bun', ['test'], { cwd: dir, stdio: 'inherit' })
  if (result.status !== 0) failed = true
}

process.exit(failed ? 1 : 0)
