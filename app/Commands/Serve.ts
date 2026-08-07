import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { serve } from '@harness/server'

/**
 * Boot the harness server.
 *
 * Everything that executes anything lives behind this process -- provider
 * processes, git, the filesystem. Clients (desktop, web, this CLI) dispatch
 * commands over the socket and render what comes back.
 */
export default function (cli: CLI) {
  cli
    .command('harness:serve', 'Run the harness server')
    .alias('hserve')
    .option('-p, --port [port]', 'Port to listen on', { default: 3789 })
    .option('--host [host]', 'Hostname to bind', { default: '127.0.0.1' })
    .action(async (options: { port?: number | string, host?: string }) => {
      const port = Number(options.port ?? 3789)
      const { engine } = await serve({ port, hostname: options.host })

      console.log(`harness listening on http://${options.host ?? '127.0.0.1'}:${port}`)
      console.log(`  ws        ws://${options.host ?? '127.0.0.1'}:${port}/ws`)
      console.log(`  health    http://${options.host ?? '127.0.0.1'}:${port}/health`)
      console.log(`  hydrated  ${engine.current.profiles.size} profile(s), ${engine.current.sessions.size} session(s)`)

      // Bun keeps the process alive for the listening socket; nothing to await.
      process.on('SIGINT', () => process.exit(0))
    })
}
