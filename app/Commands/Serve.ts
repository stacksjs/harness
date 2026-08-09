import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { localTokenPath, serve } from '@harness/server'
import { lanAddress } from '../Support/network'

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
    .option('--remote', 'Accept paired devices (phones, other machines)', { default: false })
    .option('--tunnel', 'Also reachable from outside this network, through a relay', { default: false })
    .option('--relay [url]', 'Relay to tunnel through', { default: '' })
    .action(async (options: { port?: number | string, host?: string, remote?: boolean, tunnel?: boolean, relay?: string }) => {
      const port = Number(options.port ?? 3789)
      const remote = options.remote === true
      // Binding loopback with --remote would authenticate connections that
      // cannot arrive, so opening the door means opening it.
      const hostname = options.host ?? (remote ? '0.0.0.0' : '127.0.0.1')

      const { engine, access, tunnelUrl } = await serve({
        port,
        hostname,
        remote,
        ...(options.tunnel ? { tunnel: options.relay ? { server: options.relay } : true } : {}),
      }).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error))
        return process.exit(1)
      })

      const shown = remote ? (lanAddress() ?? hostname) : hostname
      console.log(`harness listening on http://${shown}:${port}`)
      console.log(`  ws        ws://${shown}:${port}/ws`)
      console.log(`  health    http://${shown}:${port}/health`)
      console.log(`  hydrated  ${engine.current.profiles.size} profile(s), ${engine.current.sessions.size} session(s)`)

      if (access) {
        const { code } = access.openPairing()
        console.log('')
        console.log(`  Remote access is ON. Every connection needs a token — including this machine's.`)
        console.log(`  Local clients read one from ${localTokenPath()}`)
        console.log('')
        console.log(`  Pair a phone:  open http://${shown}:${port}/ and enter`)
        console.log('')
        console.log(`      ${code}`)
        console.log('')
        console.log(`  The code lasts 5 minutes and works once. For another: ./buddy harness:pair`)
        console.log(`  Paired devices: ./buddy harness:devices`)
        if (tunnelUrl) {
          console.log('')
          console.log(`  Reachable from anywhere at ${tunnelUrl}`)
          console.log(`  Anyone with that URL reaches the pairing page — and nothing else without a code.`)
        }
      }

      // Bun keeps the process alive for the listening socket; nothing to await.
      process.on('SIGINT', () => process.exit(0))
    })
}
