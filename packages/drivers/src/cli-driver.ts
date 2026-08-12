/**
 * Probing helpers shared by the drivers.
 *
 * This file used to hold the "registered, not absent" stubs for the CLIs
 * harness could not drive yet. All five providers have real transports now
 * (M5), so what remains is the probing machinery they share: a driver's first
 * question is always "is the binary here, and is it signed in?", and both
 * checks must resolve rather than throw — the registry probes every driver at
 * startup, and one that throws takes the server down instead of reporting
 * itself unavailable.
 */

import type { ProbeResult } from './types'
import { spawn } from 'node:child_process'

/** Run `<binary> --version` to decide installed-or-not, with a timeout. */
async function probeBinary(binary: string, home?: string): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve) => {
    let settled = false
    const finish = (result: ProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: home ? { ...process.env, HOME: home } : process.env,
      })
    }
    catch {
      return finish({ status: 'unavailable', message: `${binary} is not installed` })
    }

    // A CLI that hangs on `--version` is not usable, and the probe runs at
    // startup for every driver — so it must not be able to stall boot.
    const timer = setTimeout(() => {
      child.kill()
      finish({ status: 'failed', message: `${binary} --version did not return within 5s` })
    }, 5000)

    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.on('error', () => {
      clearTimeout(timer)
      finish({ status: 'unavailable', message: `${binary} is not installed` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0)
        return finish({ status: 'failed', message: `${binary} --version exited ${code}` })
      finish({ status: 'ready', version: out.trim().split('\n')[0], binaryPath: binary })
    })
  })
}

/**
 * Run a CLI subcommand for its output, never for its side effects.
 *
 * Shared by the probes that have to ask a CLI about its own auth state
 * (`codex login status`, `cursor-agent status`, `grok models`) — a hung or
 * missing binary resolves `ok: false` rather than throwing, because probes
 * must not crash.
 */
export function runQuiet(binary: string, args: string[], home?: string): Promise<{ ok: boolean, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: home ? { ...process.env, HOME: home } : process.env,
    })
    let output = ''
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, output }) }, 5000)
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, output }) })
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, output }) })
  })
}

export { probeBinary }
