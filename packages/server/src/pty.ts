/**
 * A PTY without a native dependency to install.
 *
 * Two backends behind one interface, tried in order:
 *
 * **Native (preferred).** `pty-shim.c`, compiled at runtime by bun:ffi's
 * bundled TinyCC: posix_openpt for a real master/slave pair, posix_spawn with
 * SETSID + an addopen of the slave so the shell acquires it as a controlling
 * terminal (real job control, ^C reaching the foreground group), and — the
 * reason this backend exists — TIOCSWINSZ on a retained slave fd, which is
 * what makes `resize()` real. The master is read non-blocking on a short
 * poll; the same tick reaps the child with waitpid, so a dead shell is
 * noticed and never left a zombie. Why not plain dlopen: ioctl/fcntl/open are
 * variadic, and on Apple arm64 variadic args go on the stack while
 * fixed-signature FFI puts them in registers — C callers are the only ones
 * that compile correctly. And on macOS/BSD the winsize ioctls live on the
 * *slave* side; against the master they return ENOTTY.
 *
 * **script(1) (fallback).** Every machine this server targets ships `script`,
 * whose whole job is running a command under a pseudo-terminal. The BSD and
 * util-linux spellings differ and are both pinned here. The `cat |` in front
 * is load-bearing: both runtimes hand a child *socketpairs* for piped stdio
 * on macOS, and BSD `script` calls tcgetattr on its stdin, which fails
 * fatally on a socket while tolerating a real pipe. This backend cannot
 * resize after spawn — `resize()` is accepted and dropped — and COLUMNS/LINES
 * are exported so full-screen programs at least start at the right size.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'

export interface PtyOptions {
  /** Absolute path the shell starts in. */
  cwd: string
  cols: number
  rows: number
  /** Defaults to the user's shell, then to a sane per-platform fallback. */
  shell?: string
}

interface PtyBackend {
  onData: (listener: (chunk: string) => void) => void
  onExit: (listener: (code: number | null) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
}

/** The platform facts the C shim takes as arguments rather than #ifdef'ing. */
const PLATFORM = process.platform === 'darwin'
  ? { tiocswinsz: 0x80087467n, setsidFlag: 0x0400, oNonblock: 0x0004, libc: '/usr/lib/libSystem.B.dylib' }
  : { tiocswinsz: 0x5414n, setsidFlag: 0x0080, oNonblock: 0x0800, libc: 'libc.so.6' }

interface NativeShim {
  shim: {
    harness_open_pty_master: () => number
    harness_open_pty_slave: (master: number) => number
    harness_set_winsize: (fd: number, cols: number, rows: number, request: bigint) => number
    harness_set_nonblocking: (fd: number, flag: number) => number
    harness_spawn_on_pty: (master: number, shell: unknown, cwd: unknown, envp: unknown, setsidFlag: number) => number
    harness_poll_exit: (pid: number) => number
  }
  io: {
    read: (fd: number, buf: unknown, n: bigint) => bigint | number
    write: (fd: number, buf: unknown, n: bigint) => bigint | number
    close: (fd: number) => number
  }
  ptr: (view: ArrayBufferView) => number
}

/**
 * Compiled once, the first time a terminal opens; null forever after the
 * first failure, so a machine where TinyCC cannot link just uses script(1)
 * without retrying per terminal.
 */
let nativeShim: NativeShim | null | undefined

async function loadNativeShim(): Promise<NativeShim | null> {
  if (nativeShim !== undefined) return nativeShim
  try {
    const { cc, dlopen, FFIType, ptr } = await import('bun:ffi')
    const { symbols: shim } = cc({
      source: join(import.meta.dir, 'pty-shim.c'),
      symbols: {
        harness_open_pty_master: { args: [], returns: 'int' },
        harness_open_pty_slave: { args: ['int'], returns: 'int' },
        harness_set_winsize: { args: ['int', 'int', 'int', 'u64'], returns: 'int' },
        harness_set_nonblocking: { args: ['int', 'int'], returns: 'int' },
        harness_spawn_on_pty: { args: ['int', 'ptr', 'ptr', 'ptr', 'int'], returns: 'int' },
        harness_poll_exit: { args: ['int'], returns: 'int' },
      },
    })
    const io = dlopen(PLATFORM.libc, {
      read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    })
    nativeShim = { shim: shim as unknown as NativeShim['shim'], io: io.symbols as unknown as NativeShim['io'], ptr: ptr as unknown as NativeShim['ptr'] }
  }
  catch {
    nativeShim = null
  }
  return nativeShim
}

/** A NUL-terminated C string the FFI can point at. */
function cstr(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  const out = new Uint8Array(bytes.length + 1)
  out.set(bytes)
  return out
}

class NativePty implements PtyBackend {
  private dataListener: ((_chunk: string) => void) | null = null
  private exitListener: ((_code: number | null) => void) | null = null
  private buffered = ''
  private finished = false
  private readonly master: number
  private readonly slave: number
  private readonly pid: number
  private readonly poll: ReturnType<typeof setInterval>
  private readonly readBuf = new Uint8Array(65536)
  private readonly decoder = new TextDecoder('utf-8', { fatal: false })

  constructor(private readonly native: NativeShim, options: PtyOptions) {
    const { shim } = native
    this.master = shim.harness_open_pty_master()
    if (this.master < 0) throw new Error('posix_openpt failed')
    // Retained for exactly one job: TIOCSWINSZ aims at the slave (macOS/BSD).
    this.slave = shim.harness_open_pty_slave(this.master)
    if (this.slave < 0) {
      native.io.close(this.master)
      throw new Error('pty slave open failed')
    }
    shim.harness_set_winsize(this.slave, options.cols, options.rows, PLATFORM.tiocswinsz)
    shim.harness_set_nonblocking(this.master, PLATFORM.oNonblock)

    const shell = options.shell ?? process.env.SHELL ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    // The child gets the server's whole environment with TERM pinned; the
    // buffers must stay referenced across the call, which the locals do.
    const envStrings = Object.entries({ ...process.env, TERM: 'xterm-256color' })
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => cstr(`${key}=${String(value)}`))
    const envArr = new BigUint64Array([...envStrings.map(b => BigInt(native.ptr(b))), 0n])
    const shellBuf = cstr(shell)
    const cwdBuf = cstr(options.cwd)

    this.pid = shim.harness_spawn_on_pty(this.master, native.ptr(shellBuf), native.ptr(cwdBuf), native.ptr(envArr), PLATFORM.setsidFlag)
    if (this.pid < 0) {
      native.io.close(this.slave)
      native.io.close(this.master)
      throw new Error('posix_spawn on pty failed')
    }

    // One short tick does both jobs: drain the master, reap the child. The
    // drain runs again after an exit is seen, so the shell's last bytes are
    // delivered before the exit is.
    this.poll = setInterval(() => {
      this.drain()
      const code = shim.harness_poll_exit(this.pid)
      if (code >= 0) {
        this.drain()
        this.finish(code)
      }
    }, 15)
  }

  private drain(): void {
    for (;;) {
      const n = Number(this.native.io.read(this.master, this.native.ptr(this.readBuf), 65536n))
      if (n <= 0) return
      const chunk = this.decoder.decode(this.readBuf.subarray(0, n), { stream: true })
      if (this.dataListener) this.dataListener(chunk)
      else this.buffered += chunk
    }
  }

  private finish(code: number | null): void {
    if (this.finished) return
    this.finished = true
    clearInterval(this.poll)
    this.native.io.close(this.slave)
    this.native.io.close(this.master)
    this.exitListener?.(code)
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
    if (this.finished) return
    const buf = new TextEncoder().encode(data)
    this.native.io.write(this.master, this.native.ptr(buf), BigInt(buf.length))
  }

  resize(cols: number, rows: number): void {
    if (this.finished) return
    // The kernel raises SIGWINCH at the foreground group itself.
    this.native.shim.harness_set_winsize(this.slave, cols, rows, PLATFORM.tiocswinsz)
  }

  kill(): void {
    this.dataListener = null
    this.exitListener = null
    if (this.finished) return
    try {
      // The child is its own session leader, so its group id is its pid.
      process.kill(-this.pid, 'SIGKILL')
    }
    catch {
      try { process.kill(this.pid, 'SIGKILL') } catch {}
    }
    // The poll keeps running until waitpid reaps — killing must not leave a
    // zombie — and finish() closes the fds then.
  }
}

class ScriptPty implements PtyBackend {
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
    // script's own diagnostics; the PTY's bytes all arrive on stdout.
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

  resize(): void {
    // script(1) has no way to change the PTY's size after spawn.
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

/**
 * The facade the server holds. Construction is synchronous and always
 * succeeds; the backend resolves on the first tick, and anything written or
 * asked before then is queued the way pre-listener output already was.
 */
export class Pty implements PtyBackend {
  private backend: PtyBackend | null = null
  private pendingWrites: string[] = []
  private pendingResize: { cols: number, rows: number } | null = null
  private pendingData: ((_chunk: string) => void) | null = null
  private pendingExit: ((_code: number | null) => void) | null = null
  private killed = false

  /** Which backend actually opened, for doctors and tests: 'native' | 'script'. */
  backendKind: 'native' | 'script' | 'pending' = 'pending'

  constructor(options: PtyOptions) {
    void this.open(options)
  }

  private async open(options: PtyOptions): Promise<void> {
    let backend: PtyBackend | null = null
    const native = await loadNativeShim()
    if (native) {
      try {
        backend = new NativePty(native, options)
        this.backendKind = 'native'
      }
      catch {
        backend = null
      }
    }
    if (!backend) {
      backend = new ScriptPty(options)
      this.backendKind = 'script'
    }
    if (this.killed) {
      backend.kill()
      return
    }
    this.backend = backend
    if (this.pendingData) backend.onData(this.pendingData)
    if (this.pendingExit) backend.onExit(this.pendingExit)
    if (this.pendingResize) backend.resize(this.pendingResize.cols, this.pendingResize.rows)
    for (const data of this.pendingWrites) backend.write(data)
    this.pendingWrites = []
  }

  onData(listener: (chunk: string) => void): void {
    this.pendingData = listener
    this.backend?.onData(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.pendingExit = listener
    this.backend?.onExit(listener)
  }

  write(data: string): void {
    if (this.backend) this.backend.write(data)
    else this.pendingWrites.push(data)
  }

  resize(cols: number, rows: number): void {
    if (this.backend) this.backend.resize(cols, rows)
    else this.pendingResize = { cols, rows }
  }

  kill(): void {
    this.killed = true
    this.pendingData = null
    this.pendingExit = null
    this.backend?.kill()
  }
}
