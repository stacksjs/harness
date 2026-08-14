import type { CLI } from '@stacksjs/types'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { serve } from '@harness/server'
import { lanAddress } from '../Support/network'
import { ExitCode } from '@stacksjs/types'

/**
 * The desktop surface: a Craft window over the same server the web app uses.
 *
 * One process, one execution boundary. The window is a client like any other —
 * it renders the same SSR views and speaks the same socket, so a session
 * started here is visible in a browser and on a phone.
 *
 * `--web-sidebar-material` is the mode stx's sidebar was written for: AppKit
 * draws the real macOS sidebar material and the web UI sits on top of it, so
 * the profile rail gets native translucency without reimplementing the sidebar
 * natively.
 */
function resolveCraft(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.CRAFT_BIN,
    join(process.cwd(), 'node_modules/.bin/craft'),
    // The local Zig checkout, which is where the upstream fixes harness
    // depends on (§10) actually live until they ship in a release.
    join(homedir(), 'Documents/Projects/craft/packages/zig/zig-out/bin/craft'),
    join(homedir(), 'Code/Tools/craft/packages/zig/zig-out/bin/craft'),
  ].filter((c): c is string => Boolean(c))
  return candidates.find(c => existsSync(c)) ?? null
}

export default function (cli: CLI) {
  cli
    .command('harness:desktop', 'Open the harness desktop window')
    .option('-p, --port [port]', 'Port for the embedded server', { default: 3789 })
    .option('--craft [path]', 'Path to the craft binary', { default: '' })
    .option('--width [width]', 'Window width', { default: 1280 })
    .option('--height [height]', 'Window height', { default: 820 })
    .option('--tray', 'Show a system tray icon', { default: false })
    .option('--remote', 'Also accept paired devices, so a phone can drive this window', { default: false })
    .action(async (options: { port?: number | string, craft?: string, width?: number, height?: number, tray?: boolean, remote?: boolean }) => {
      const port = Number(options.port ?? 3789)
      const remote = options.remote === true
      const craftBin = resolveCraft(options.craft || undefined)

      if (!craftBin) {
        console.error('Could not find the craft binary.')
        console.error('Build it with `cd ~/Code/Tools/craft/packages/zig && zig build`, or set CRAFT_BIN.')
        process.exit(ExitCode.FatalError)
      }

      const { engine, access, markWindowSpawned } = await serve({
        port,
        remote,
        // Bound to every interface only when there is something to let in.
        ...(remote ? { hostname: '0.0.0.0' } : {}),
      })
      console.log(`harness server on http://127.0.0.1:${port} — ${engine.current.profiles.size} profile(s)`)

      if (access) {
        const { code } = access.openPairing()
        console.log('')
        console.log(`  Pair a phone: open http://${lanAddress() ?? '127.0.0.1'}:${port}/ and enter  ${code}`)
        console.log(`  Five minutes, once. Another: ./buddy harness:pair`)
      }

      // Marked immediately before the spawn, so the reported cold start covers
      // the window and its page — not this command's own startup, which the
      // user pays once and which tells us nothing about page weight.
      markWindowSpawned()
      const child = spawn(craftBin, [
        // The window authenticates through a one-time token in the URL; the
        // server swaps it for a cookie and redirects, so it does not linger.
        '--url', access ? `http://127.0.0.1:${port}/?token=${access.localToken}` : `http://127.0.0.1:${port}/`,
        '--title', 'harness',
        '--width', String(options.width ?? 1280),
        '--height', String(options.height ?? 820),
        // The web UI draws the sidebar; AppKit draws the material behind it.
        '--web-sidebar-material',
        // Matches the aside's width in the view, so the material lines up with
        // the rendered sidebar rather than showing a seam.
        '--web-sidebar-width', '280',
        // The full bridge — and with it tray polling — is gated on this flag
        // host-side, so asking for a tray also turns on the surface that
        // drives it.
        ...(options.tray ? ['--system-tray'] : []),
      ], {
        stdio: 'inherit',
        // Detached from this process group. Launching the GUI in-group has
        // repeatedly taken the parent's toolchain down with it on this host.
        detached: true,
      })

      child.on('exit', code => process.exit(code ?? 0))
      process.on('SIGINT', () => { child.kill(); process.exit(0) })
    })
}
