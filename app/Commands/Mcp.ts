import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { ExitCode } from '@stacksjs/types'
import { dispatch } from '../Support/dispatch'
import { boot, commandId } from '../Support/engine'

/**
 * MCP servers, per profile.
 *
 * A project's tools belong to the project: a work profile wants its issue
 * tracker and its database, a personal one does not, and neither should inherit
 * the other's credentials.
 *
 * Secrets are referenced, never stored. `${GITHUB_TOKEN}` in a value is
 * resolved from the environment when an agent starts, so the event log — which
 * is plaintext and exists to be replayed — holds the reference rather than the
 * token.
 */
export default function (cli: CLI) {
  cli
    .command('mcp:add <profile> <name>', 'Attach an MCP server to a profile')
    .option('--command [command]', 'Executable, for a stdio server')
    .option('--args [args]', 'Comma-separated arguments')
    .option('--url [url]', 'Endpoint, for an sse or http server')
    .option('--transport [transport]', 'stdio, sse or http', { default: 'stdio' })
    .option('--env [pairs]', 'Comma-separated KEY=value; use ${VAR} to reference the environment')
    .option('--header [pairs]', 'Comma-separated Name=value; use ${VAR} to reference the environment')
    .action(async (profile: string, name: string, options: {
      command?: string
      args?: string
      url?: string
      transport?: string
      env?: string
      header?: string
    }) => {
      const engine = await boot()
      const profileId = Number(profile)
      if (!engine.current.profiles.get(profileId)) {
        console.error(`No profile ${profileId}. List them with \`./buddy profiles:list\`.`)
        process.exit(ExitCode.FatalError)
      }

      const transport = (options.transport ?? 'stdio') as 'stdio' | 'sse' | 'http'

      try {
        await dispatch({
          id: commandId('mcp.add'),
          at: Date.now(),
          command: {
            type: 'mcp.add',
            profileId,
            name,
            transport,
            ...(options.command ? { command: options.command } : {}),
            ...(options.args ? { args: options.args.split(',').map(a => a.trim()).filter(Boolean) } : {}),
            ...(options.url ? { url: options.url } : {}),
            ...(options.env ? { env: pairs(options.env) } : {}),
            ...(options.header ? { headers: pairs(options.header) } : {}),
          },
        })
      }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(ExitCode.FatalError)
      }

      console.log(`attached ${name} (${transport})`)
      process.exit(ExitCode.Success)
    })

  cli
    .command('mcp:list [profile]', 'List MCP servers, rebuilt from the event log')
    .action(async (profile?: string) => {
      const engine = await boot()
      const wanted = profile ? Number(profile) : null

      for (const p of engine.current.profiles.values()) {
        if (wanted !== null && p.id !== wanted) continue
        console.log(`${p.name} (${p.id})`)
        if (p.mcpServers.length === 0) {
          console.log('   no MCP servers')
          continue
        }
        for (const server of p.mcpServers) {
          const target = server.transport === 'stdio'
            ? [server.command, ...(server.args ?? [])].join(' ')
            : server.url
          // The mark is the thing to scan for: a disabled server is invisible
          // to the agent, which is the most common cause of "why can it not
          // see my tool".
          console.log(`   ${server.enabled ? '●' : '○'} ${server.name.padEnd(16)} ${server.transport.padEnd(6)} ${target}`)
        }
      }
      process.exit(ExitCode.Success)
    })

  cli
    .command('mcp:remove <profile> <name>', 'Detach an MCP server')
    .action(async (profile: string, name: string) => {
      await mutate({ type: 'mcp.remove', profileId: Number(profile), name }, `detached ${name}`)
    })

  cli
    .command('mcp:enable <profile> <name>', 'Let this profile\'s agents use a server')
    .action(async (profile: string, name: string) => {
      await mutate({ type: 'mcp.setEnabled', profileId: Number(profile), name, enabled: true }, `enabled ${name}`)
    })

  cli
    .command('mcp:disable <profile> <name>', 'Hide a server from this profile\'s agents')
    .action(async (profile: string, name: string) => {
      await mutate({ type: 'mcp.setEnabled', profileId: Number(profile), name, enabled: false }, `disabled ${name}`)
    })
}

/** `KEY=value,OTHER=value` — the shape both `--env` and `--header` take. */
function pairs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of raw.split(',')) {
    // Split on the first `=` only: a value may contain one, and a URL usually
    // does.
    const at = entry.indexOf('=')
    if (at <= 0) continue
    out[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
  }
  return out
}

// Typed from the Support dispatcher, not the engine's: the engine also accepts
// server-internal commands (assistant deltas, receipts), and a CLI that could
// pass one would be a client writing the server's private events.
async function mutate(command: Parameters<typeof dispatch>[0]['command'], done: string): Promise<void> {
  const engine = await boot()
  try {
    await dispatch({ id: commandId('mcp'), at: Date.now(), command })
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(ExitCode.FatalError)
  }
  console.log(done)
  process.exit(ExitCode.Success)
}
