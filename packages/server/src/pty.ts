/**
 * A PTY without a native dependency.
 *
 * Bun has no PTY API and harness takes no native modules, but every machine
 * this server runs on ships `script(1)`, whose whole job is to run a command
 * under a pseudo-terminal and copy bytes both ways. That is the entire
 * transport: spawn `script`, write to its stdin, read its stdout, and the
 * emulator core (`@harness/ansi`) makes sense of what comes back.
 *
 * The BSD and util-linux spellings differ and are both pinned here — macOS
 * wants `script -q /dev/null <shell>`, Linux wants `script -qec <shell>
 * /dev/null` — which is exactly the kind of fact that must live in one place.
 *
 * The `cat |` in front is load-bearing. Both runtimes (node's child_process
 * and Bun.spawn alike) hand a child *socketpairs* for piped stdio on macOS,
 * and BSD `script` calls tcgetattr on its stdin, which fails fatally on a
 * socket — "tcgetattr/ioctl: Operation not supported on socket", exit 1,
 * zero bytes. On a real pipe the same call fails ENOTTY, which it tolerates.
 * `cat` reads the socket happily and hands `script` the pipe it needs; the
 * outgoing direction never mattered, because `script` only interrogates fd 0.
 *
 * Known punt, so nobody rediscovers it: `script` offers no way to change the
 * PTY's window size after spawn, so a terminal is the size it opened at.
 * COLUMNS/LINES are exported so full-screen programs at least start at the
 * right dimensions. Live resize needs a real ioctl, which means a native
 * shim or craft's `bridge_shell.zig` growing one — the seam is `resize()`.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import process from 'node:process'

export interface PtyOptions {
  /** Absolute path the shell starts in. */
  cwd: string
  cols: number
  rows: number
  /** Defaults to the user's shell, then to a sane per-platform fallback. */
  shell?: string
}

export class Pty {
  private readonly child: ChildProcessWithoutNullStreams
  private dataListener: ((_chunk: string) => void) | null = null
  private exitListener: ((_code: number | null) => void) | null = null
  /** Bytes that arrived before anyone listened — the shell's banner races the reply frame. */
  private buffered = ''

  constructor(options: PtyOptions) {
    const shell = options.shell ?? process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    // `"$0"` carries the shell path through untouched, so a path with spaces
    // never meets the shell's word splitter.
    const pipeline = process.platform === 'darwin'
      ? 'cat | exec script -q /dev/null "$0"'
      : 'cat | exec script -qec "$0" /dev/null'

    this.child = spawn('sh', ['-c', pipeline, shell], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own group, so kill() can take down the whole pipeline — killing
      // only `sh` would orphan `script` and the live shell under it.
      detached: true,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLUMNS: String(options.cols),
        LINES: String(options.rows),
      },
    }) as ChildProcessWithoutNullStreams

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => {
      if (this.dataListener) this.dataListener(chunk)
      else this.buffered += chunk
    })
    // scripts's own diagnostics; the PTY's bytes all arrive on stdout.
    this.child.stderr.resume()
    this.child.on('exit', code => this.exitListener?.(code))
    this.child.on('error', () => this.exitListener?.(null))
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListener = listener
    if (this.buffered) {
      const held = this.buffered
      this.buffered = ''
      listener(held)
    }
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListener = listener
  }

  write(data: string): void {
    this.child.stdin.write(data)
  }

  kill(): void {
    this.dataListener = null
    this.exitListener = null
    if (this.child.pid !== undefined) {
      try {
        // The negative pid addresses the process group (see `detached` above).
        process.kill(-this.child.pid, 'SIGKILL')
        return
      }
      catch {
        // The group is already gone — fall through for the direct child.
      }
    }
    this.child.kill()
  }
}
