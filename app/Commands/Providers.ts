import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { ChatGptCredentialStore, driverKinds, nativeProviderAuth, startChatGptAuthorization } from '@harness/drivers'
import { addSavedProvider, chatGptCredentialDirectory, removeSavedProvider, SavedProviderInstances } from '@harness/server'
import { boot, DB_PATH } from '../Support/engine'

function asId(value: string): number {
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Enter a positive numeric ID.')
  return id
}

async function openSignIn(url: string): Promise<void> {
  const args = [process.platform === 'darwin' ? 'open' : 'xdg-open', url]
  try {
    const subprocess = Bun.spawn(args, { stdout: 'ignore', stderr: 'ignore' })
    if (await subprocess.exited === 0) return
  }
  catch { /* The URL can contain a private sign-in hint. Keep it out of command errors. */ }
  throw new Error('Could not open a browser on this host for ChatGPT sign-in.')
}

function profileAccounts(profileId: number) {
  const accounts = new SavedProviderInstances(DB_PATH)
  try {
    return accounts.list(profileId, process.cwd())
  }
  finally {
    accounts.close()
  }
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
      const providers = profileAccounts(id)
      if (providers.length === 0) console.log('No named provider accounts have been added.')
      for (const provider of providers)
        console.log(`${provider.id}  ${provider.launch.chatGptClientId ? 'chatgpt-plan' : provider.kind}  ${provider.name}`)
    })

  cli
    .command('harness:provider-remove <profile> <account>', 'Remove a named provider account from this profile')
    .action(async (profile: string, account: string) => {
      const profileId = asId(profile)
      const accountId = asId(account)
      const clientId = profileAccounts(profileId).find(provider => provider.id === accountId)?.launch.chatGptClientId
      if (clientId) {
        const store = new ChatGptCredentialStore(chatGptCredentialDirectory())
        if (!(await store.signOut(clientId, { forget: true })).revoked)
          console.log('The host credential was removed. OpenAI revocation could not be confirmed.')
      }
      if (!removeSavedProvider(DB_PATH, profileId, accountId))
        throw new Error('No account with that ID belongs to this profile.')
      console.log(`Removed account ${account}.`)
    })

  cli
    .command('harness:provider-chatgpt-connect <profile> <name>', 'Connect a ChatGPT plan to Codex on this host')
    .action(async (profile: string, requestedName: string) => {
      if (process.platform === 'win32') throw new Error('The managed ChatGPT preview requires a macOS or Linux host.')
      const profileId = asId(profile)
      const name = requestedName.trim()
      if (!name || name.length > 80) throw new Error('Enter an account name from 1 to 80 characters.')
      if (!(await boot()).current.profiles.has(profileId)) throw new Error('No Harness profile has that ID.')
      const matching = profileAccounts(profileId).find(account => account.kind === 'codex' && account.name.toLowerCase() === name.toLowerCase())
      if (matching && !matching.launch.chatGptClientId)
        throw new Error('A Codex CLI account already uses that name. Choose another name.')

      const store = new ChatGptCredentialStore(chatGptCredentialDirectory())
      const registration = matching?.launch.chatGptClientId
        ? await store.registration(matching.launch.chatGptClientId)
        : null
      if (matching && !registration) throw new Error('The host registration is missing. Remove this account and connect it again.')

      const attempt = startChatGptAuthorization(await store.hostIdentifier(), registration ?? undefined)
      const completed = attempt.result.then(session => ({ session }), (error: unknown) => ({ error }))
      process.once('SIGINT', attempt.cancel)
      try {
        await openSignIn(attempt.url)
        console.log('Finish ChatGPT sign-in in the browser. Press Ctrl+C to cancel.')
        const result = await completed
        if ('error' in result) throw result.error
        const { session } = result
        await store.saveSession(session, { requireNew: !registration })
        try {
          const id = addSavedProvider(DB_PATH, profileId, { kind: 'codex', name, chatGptClientId: session.clientId })
          console.log(`Connected ${name} as Harness account ${id}.`)
        }
        catch (error) {
          if (!registration) await store.signOut(session.clientId, { forget: true })
          throw error
        }
      }
      finally {
        process.off('SIGINT', attempt.cancel)
        attempt.cancel()
      }
    })

  cli
    .command('harness:provider-chatgpt-disconnect <profile> <account>', 'Disconnect a ChatGPT plan from this host')
    .action(async (profile: string, account: string) => {
      const accountId = asId(account)
      const clientId = profileAccounts(asId(profile)).find(provider => provider.id === accountId)?.launch.chatGptClientId
      if (!clientId) throw new Error('Choose a ChatGPT plan account in this profile.')
      const store = new ChatGptCredentialStore(chatGptCredentialDirectory())
      const { revoked } = await store.signOut(clientId)
      console.log(revoked
        ? `Disconnected ChatGPT plan account ${accountId}.`
        : 'The host credential was removed. OpenAI revocation could not be confirmed.')
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
        if (account.launch.chatGptClientId)
          throw new Error('Use harness:provider-chatgpt-connect or harness:provider-chatgpt-disconnect for this account.')
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
