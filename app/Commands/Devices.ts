import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import type { HarnessClient } from '@harness/client'
import { readLocalToken } from '@harness/server'
import { connect } from '../Support/client'
import { boot, commandId } from '../Support/engine'

/**
 * Pair a device, and take that pairing back.
 *
 * Pairing goes through the running server rather than the store directly: the
 * code lives in that process's memory and is meant to be short-lived, so a
 * second process minting its own would issue codes nothing will ever accept.
 *
 * Revoking goes straight to the log, so it still works when the server is down
 * — which is exactly the situation a lost phone creates.
 */

async function mintCode(url: string): Promise<void> {
  const token = await readLocalToken()
  if (!token) {
    console.error('No local token found. Is the server running with `--remote`?')
    process.exit(1)
  }

  const response = await fetch(`${url}/pair/new`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null)

  if (!response?.ok) {
    console.error(`Could not reach the harness server at ${url}.`)
    console.error('Start it with `./buddy harness:serve --remote`.')
    process.exit(1)
  }

  const { code, expiresAt } = await response.json() as { code: string, expiresAt: number }
  const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000))
  console.log('')
  console.log(`    ${code}`)
  console.log('')
  console.log(`  Open ${url}/ on the device and enter it. Valid for ${minutes} minutes, once.`)
}

export default function (cli: CLI) {
  cli
    .command('harness:pair', 'Show a pairing code for a phone or another machine')
    .option('--url [url]', 'Server URL', { default: 'http://127.0.0.1:3789' })
    .action(async (options: { url: string }) => {
      await mintCode(options.url.replace(/\/$/, ''))
    })

  cli
    .command('harness:devices', 'List the devices paired with this harness')
    .action(async () => {
      const engine = await boot()
      const devices = [...engine.current.devices.values()]

      if (devices.length === 0) {
        console.log('No devices are paired.')
        console.log('Run `./buddy harness:serve --remote` and pair one from a phone.')
        return
      }

      for (const device of devices) {
        const when = new Date(device.pairedAt).toISOString().slice(0, 16).replace('T', ' ')
        console.log(`  ${device.id}  ${device.name.padEnd(28)}  paired ${when}`)
      }
    })

  cli
    .command('harness:revoke <deviceId>', "Withdraw a device's access")
    .option('--url [url]', 'Server websocket URL', { default: 'ws://127.0.0.1:3789/ws' })
    .action(async (deviceId: string, options: { url: string }) => {
      const engine = await boot()
      const device = engine.current.devices.get(deviceId)
      if (!device) {
        console.error(`No device with id ${deviceId}. Run \`./buddy harness:devices\` to list them.`)
        process.exit(1)
      }

      const envelope = {
        id: commandId('revoke'),
        at: Date.now(),
        command: { type: 'device.revoke' as const, deviceId },
      }

      // Through the running server when there is one. Writing straight to the
      // log instead would leave that process holding a projection where the
      // device is still paired — so it would keep honouring the token, which
      // is the one thing a revoke must not do.
      let client: HarnessClient | null = null
      try {
        client = await connect(options.url)
        await client.dispatch(envelope.id, envelope.command)
        client.close()
        console.log(`revoked ${device.name} (${deviceId})`)
        // The server drops the socket that device already holds as the revoked
        // event broadcasts, so an open connection does not outlive its access.
        return
      }
      catch {
        client?.close()
      }

      // No server to tell. Recording it now means the revoke is already in the
      // log when one next starts, rather than depending on someone to redo it.
      await engine.dispatch(envelope)
      console.log(`revoked ${device.name} (${deviceId})`)
      console.log('  (no server was running; this applies when one next starts)')
    })
}
