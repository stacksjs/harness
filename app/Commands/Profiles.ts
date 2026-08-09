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
    .option('--tint [tint]', "The space's colour: a name, a hex value, or an oklch() string")
    .option('--icon [icon]', 'SF Symbol or iconify class for the switcher')
    .action(async (name: string, options: { id?: string, tint?: string, icon?: string }) => {
      const engine = await boot()
      const id = options.id || commandId('profile.create')

      const result = await engine.dispatch({
        id,
        at: Date.now(),
        command: {
          type: 'profile.create',
          name,
          ...(options.tint ? { tint: options.tint } : {}),
          ...(options.icon ? { icon: options.icon } : {}),
        },
      })

      const profileId = derivedId(id)
      const profile = engine.current.profiles.get(profileId)

      if (result.replayed)
        console.log(`↻ already created (command ${id} had a receipt)`)

      console.log(`${profile?.name} · id ${profileId} · seq ${result.events[0]?.seq ?? '-'}`)
      process.exit(ExitCode.Success)
    })

  cli
    .command('profiles:set <id>', "Change a profile's name, colour, or icon")
    .option('--name [name]', 'Rename it')
    .option('--tint [tint]', "The space's colour: a name, a hex value, or an oklch() string")
    .option('--icon [icon]', 'SF Symbol or iconify class for the switcher')
    .action(async (id: string, options: { name?: string, tint?: string, icon?: string }) => {
      const engine = await boot()
      const profileId = Number(id)

      // Only what was given. Omitted means unchanged, so recolouring a profile
      // cannot quietly rename it back to whatever the CLI last saw.
      const changes = {
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.tint !== undefined ? { tint: options.tint } : {}),
        ...(options.icon !== undefined ? { icon: options.icon } : {}),
      }

      if (Object.keys(changes).length === 0) {
        console.error('Nothing to change. Pass --name, --tint, or --icon.')
        process.exit(ExitCode.FatalError)
      }

      try {
        await engine.dispatch({
          id: commandId('profile.update'),
          at: Date.now(),
          command: { type: 'profile.update', profileId, ...changes },
        })
      }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(ExitCode.FatalError)
      }

      const profile = engine.current.profiles.get(profileId)
      console.log(`${profile?.name} · tint ${profile?.tint || '(default)'} · icon ${profile?.icon || '(default)'}`)
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
        console.log(`${String(profile.id).padStart(10)}  ${profile.name.padEnd(16)} ${(profile.tint || '—').padEnd(10)} (${profile.workspaceIds.length} workspace(s))`)

      process.exit(ExitCode.Success)
    })
}
