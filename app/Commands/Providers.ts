import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { driverKinds, nativeProviderAuth } from '@harness/drivers'
import { addSavedProvider, removeSavedProvider, SavedProviderInstances } from '@harness/server'
import { boot, DB_PATH } from '../Support/engine'

function asId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Enter a positive numeric ID.')
  return id
}

export default function (cli: CLI) {
  cli
    .command('harness:provider-add <profile> <driver> <name>', 'Add a named provider account on this host')
    .option('--binary [path]', 'Provider executable or command on this host')
    .option('--home [path]', 'Provider account directory on this host')
    .action((profile: string, driver: string, name: string, options: { binary?: string, home?: string }) => {
      const kind = driverKinds().find(kind => kind === driver)
      if (!kind) throw new Error(`Choose a provider from ${driverKinds().join(', ')}.`)
      const id = addSavedProvider(DB_PATH, asId(profile), { kind, name, binaryPath: options.binary, home: options.home })
      console.log(`Saved ${name.trim()} (${kind}) as account ${id}.`)
    })

  cli
    .command('harness:provider-list <profile>', 'List named provider accounts for a profile')
    .action(async (profile: string) => {
      const id = asId(profile)
      const engine = await boot()
      if (!engine.current.profiles.has(id)) throw new Error('No Harness profile has that ID.')
      const accounts = new SavedProviderInstances(DB_PATH)
      try {
        const providers = accounts.list(id, process.cwd())
        if (providers.length === 0) console.log('No named provider accounts have been added.')
        for (const provider of providers) console.log(`${provider.id}  ${provider.kind}  ${provider.name}`)
      }
      finally {
        accounts.close()
      }
    })

  cli
    .command('harness:provider-remove <profile> <account>', 'Remove a named provider account from this profile')
    .action((profile: string, account: string) => {
      if (!removeSavedProvider(DB_PATH, asId(profile), asId(account)))
        throw new Error('No account with that ID belongs to this profile.')
      console.log(`Removed account ${account}.`)
    })

  cli
    .command('harness:provider-auth <workspace> <account>', 'Open a named account’s native login on this host')
    .option('--logout', 'Sign out the selected account', { default: false })
    .action(async (workspaceId: string, accountId: string, options: { logout?: boolean }) => {
      const engine = await boot()
      const workspace = engine.current.workspaces.get(asId(workspaceId))
      if (!workspace?.trusted) throw new Error('Choose a trusted Harness workspace.')
      const id = asId(accountId)
      const accounts = new SavedProviderInstances(DB_PATH)
      try {
        const account = accounts.list(workspace.profileId, workspace.path).find(account => account.id === id)
        if (!account) throw new Error('The named provider account is unavailable for this workspace.')
        if (account.kind !== 'claude' && account.kind !== 'codex')
          throw new Error('Use the provider’s own login command for this account.')
        const command = nativeProviderAuth(account.kind, { ...account.launch, workspacePath: workspace.path }, options.logout ? 'logout' : 'login')
        const child = Bun.spawn(command.argv, { cwd: workspace.path, env: command.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
        process.exitCode = await child.exited
      }
      finally {
        accounts.close()
      }
    })
}
