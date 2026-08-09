import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { derivedId } from '@harness/engine'
import { releaseWorktrees, worktreesOfProfile } from '@harness/server'
import { ExitCode } from '@stacksjs/types'
import { dispatch } from '../Support/dispatch'
import { boot, commandId } from '../Support/engine'

/**
 * Profile management through the engine, not around it.
 *
 * The CLI is a client like any other: it dispatches a command and reads the
 * resulting projection. It does not write rows. That is what keeps a profile
 * created from the terminal identical to one created from the desktop app --
 * same log, same ordering, same audit trail.
 */

export default function (cli: CLI) {
  cli
    .command('profiles:create <name>', 'Create a profile')
    .option('--id [id]', 'Command id, for a deliberate retry', { default: '' })
    .option('--tint [tint]', "The space's colour: a name, a hex value, or an oklch() string")
    .option('--icon [icon]', 'SF Symbol or iconify class for the switcher')
    .action(async (name: string, options: { id?: string, tint?: string, icon?: string }) => {
      const engine = await boot()
      const id = options.id || commandId('profile.create')

      const result = await dispatch({
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

      if (result.replayed)
        console.log(`↻ already created (command ${id} had a receipt)`)

      // The name comes from the argument rather than the projection: dispatched
      // through a running server, this process's read model is the one from
      // before the command and would print `undefined`.
      console.log(`${name} · id ${profileId} · seq ${result.seqs[0] ?? '-'}`)
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
        await dispatch({
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
    .command('profiles:delete <id>', 'Delete a profile, with its workspaces and sessions')
    .option('--yes', 'Skip the summary and delete', { default: false })
    .action(async (id: string, options: { yes?: boolean }) => {
      const engine = await boot()
      const profileId = Number(id)
      const profile = engine.current.profiles.get(profileId)

      if (!profile) {
        console.error(`No profile ${profileId}. List them with \`./buddy profiles:list\`.`)
        process.exit(ExitCode.FatalError)
      }

      // Counted before the delete, because afterwards there is nothing to count.
      const owned = new Set(profile.workspaceIds)
      const sessions = [...engine.current.sessions.values()].filter(s => owned.has(s.workspaceId))

      if (!options.yes) {
        // Says what goes rather than asking "are you sure": the sessions are
        // the part people forget a profile is holding.
        console.log(`${profile.name} · ${profile.workspaceIds.length} workspace(s) · ${sessions.length} session(s)`)
        console.log('Pass --yes to delete it and everything it owns.')
        process.exit(ExitCode.Success)
      }

      // Read before dispatching: the sessions holding these worktrees are gone
      // from the projection immediately afterwards, and their paths with them.
      const doomed = worktreesOfProfile(engine.current, profileId)

      let outcome
      try {
        outcome = await dispatch({
          id: commandId('profile.delete'),
          at: Date.now(),
          command: { type: 'profile.delete', profileId },
        })
      }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(ExitCode.FatalError)
      }

      // A workspace is a path harness knows about and does not own, so nothing
      // there is touched. A worktree is different: harness created it, and
      // leaving a full checkout per isolated session behind is how a large
      // repository quietly fills a disk.
      //
      // Only when there was no server to do it. The server releases them on the
      // same event, and doing it here as well would have this command report a
      // removal that the other process had already performed.
      if (outcome.via === 'log') {
        for (const released of await releaseWorktrees(doomed)) {
          if (released.committed)
            console.log(`  committed what session ${released.sessionId} left behind as ${released.committed.slice(0, 8)}`)
          console.log(`  released ${released.path} (its branch is kept)`)
        }
      }

      console.log(`deleted ${profile.name} · ${profile.workspaceIds.length} workspace(s) · ${sessions.length} session(s)`)
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
