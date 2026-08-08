import type { DriverKind } from '@harness/contract'
import type { CLI } from '@stacksjs/types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { driverKinds, formatConformance, resolveDriver, runConformance } from '@harness/drivers'
import { ExitCode } from '@stacksjs/types'

/**
 * Probe every driver, and optionally run the conformance suite against them.
 *
 * Two questions, one command: "which agents can I actually use on this
 * machine?" and "does this driver still honour the contract the engine assumes?"
 * The second is the one that decays silently — a provider CLI ships a new
 * message shape and the driver keeps compiling.
 */
export default function (cli: CLI) {
  cli
    .command('harness:doctor', 'Probe agent drivers and check them against the conformance spec')
    .option('--conformance', 'Run the full conformance suite (spends tokens on ready drivers)', { default: false })
    .option('--driver [kind]', 'Check a single driver instead of all of them')
    .action(async (options: { conformance: boolean, driver?: string }) => {
      const kinds = options.driver ? [options.driver as DriverKind] : driverKinds()
      let failed = false

      // A scratch workspace: a conforming driver may write into its workspace,
      // and the repo is not the place to find out which ones do.
      const scratch = await mkdtemp(join(tmpdir(), 'harness-doctor-'))

      try {
        for (const kind of kinds) {
          const driver = resolveDriver(kind)
          if (!driver) {
            console.error(`unknown driver: ${kind}`)
            failed = true
            continue
          }

          const probe = await driver.probe({ workspacePath: scratch })
          const mark = probe.status === 'ready' ? '●' : '○'
          const detail = [probe.version, probe.message].filter(Boolean).join(' — ')
          console.log(`${mark} ${kind.padEnd(9)} ${probe.status}${detail ? `  ${detail}` : ''}`)

          if (!options.conformance) continue

          const report = await runConformance(driver, scratch)
          console.log(formatConformance(report).split('\n').map(l => `  ${l}`).join('\n'))
          if (!report.passed) failed = true
        }
      }
      finally {
        await rm(scratch, { recursive: true, force: true })
      }

      if (failed) process.exit(ExitCode.FatalError)
    })
}
