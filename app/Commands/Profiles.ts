import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { Engine, reduce, derivedId, SqliteStore } from '@harness/engine'
import { ExitCode } from '@stacksjs/types'

/**
 * Profile management through the engine, not around it.
 *
 * The CLI is a client like any other: it dispatches a command and reads the
 * resulting projection. It does not write rows. That is what keeps a profile
 * created from the terminal identical to one created from the desktop app --
 * same log, same ordering, same audit trail.
 */

const DB_PATH = 'database/stacks.sqlite'

async function boot(): Promise<Engine> {
  const engine = new Engine({ store: new SqliteStore(DB_PATH), reducer: reduce })
  await engine.hydrate()
  return engine
}

/**
 * Command ids are the idempotency key, so they must be unique per intent --
 * hence the random suffix. A caller that wants a retry to be recognised as a
 * retry passes its own id instead.
 */
function commandId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export default function (cli: CLI) {
  cli
    .command('profiles:create <name>', 'Create a profile')
    .option('--id [id]', 'Command id, for a deliberate retry', { default: '' })
    .action(async (name: string, options: { id?: string }) => {
      const engine = await boot()
      const id = options.id || commandId('profile.create')

      const result = await engine.dispatch({
        id,
        at: Date.now(),
        command: { type: 'profile.create', name },
      })

      const profileId = derivedId(id)
      const profile = engine.current.profiles.get(profileId)

      if (result.replayed)
        console.log(`↻ already created (command ${id} had a receipt)`)

      console.log(`${profile?.name} · id ${profileId} · seq ${result.events[0]?.seq ?? '-'}`)
      process.exit(ExitCode.Success)
    })

  cli
    .command('profiles:list', 'List profiles, rebuilt from the event log')
    .action(async () => {
      const engine = await boot()
      const profiles = [...engine.current.profiles.values()]

      if (profiles.length === 0) {
        console.log('No profiles yet. Create one with `./buddy profiles:create <name>`.')
        process.exit(ExitCode.Success)
      }

      for (const profile of profiles)
        console.log(`${String(profile.id).padStart(10)}  ${profile.name}  (${profile.workspaceIds.length} workspace(s))`)

      process.exit(ExitCode.Success)
    })
}
