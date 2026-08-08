/**
 * Drivers for the agent CLIs that are not yet implemented.
 *
 * Each one probes for its binary and reports honestly. That is not a stub for
 * its own sake — `unavailable` is a first-class state the whole stack already
 * handles: the registry keeps working, the reducer refuses the session with a
 * reason, and the UI can say which CLI to install. A driver that is *absent*
 * from the registry produces "no driver for codex", which tells the user
 * nothing actionable.
 *
 * `startTurn` throws rather than returning a plausible empty stream. A driver
 * that silently produces nothing looks to the runtime exactly like an agent
 * that had nothing to say, and that is the worse failure: the turn completes,
 * the transcript is empty, and nobody knows why.
 *
 * The transports themselves are M5's remaining work and each needs its CLI to
 * develop against:
 *   cursor    — ACP, plus a Cursor-specific extension
 *   grok      — ACP, plus an xAI extension
 *   opencode  — its own CLI/HTTP runtime
 * Two of the four speak ACP, so `packages/drivers/acp` is the piece that
 * unlocks the most, and should come first.
 */

import type { DriverKind } from '@harness/contract'
import type { Driver, DriverConfig, ProbeResult, ProviderEvent, ProviderInstance } from './types'
import { spawn } from 'node:child_process'

export class DriverNotImplemented extends Error {
  constructor(kind: DriverKind, binary: string) {
    super(
      `the ${kind} driver is not implemented yet — the ${binary} CLI was found, `
      + `but harness cannot drive it. Use claude for now.`,
    )
    this.name = 'DriverNotImplemented'
  }
}

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

function notImplemented(kind: DriverKind, binary: string): ProviderInstance {
  return {
    startTurn(): AsyncIterable<ProviderEvent> {
      throw new DriverNotImplemented(kind, binary)
    },
    async interrupt() {},
    async respondApproval() {},
    async stop() {},
  }
}

function pendingDriver(kind: DriverKind, binary: string): Driver {
  return {
    kind,

    async probe(config: DriverConfig): Promise<ProbeResult> {
      const result = await probeBinary(config.binaryPath ?? binary, config.home)
      if (result.status !== 'ready') return result
      // The binary is here but we cannot speak its protocol yet. `failed` with
      // a reason beats `ready`, which would let a session start and then die
      // on the first turn.
      return {
        status: 'failed',
        version: result.version,
        binaryPath: result.binaryPath,
        message: `${binary} is installed but the ${kind} driver is not implemented yet`,
      }
    },

    async create(): Promise<ProviderInstance> {
      return notImplemented(kind, binary)
    },
  }
}

export const CursorDriver: Driver = pendingDriver('cursor', 'cursor-agent')
export const GrokDriver: Driver = pendingDriver('grok', 'grok')
export const OpenCodeDriver: Driver = pendingDriver('opencode', 'opencode')

export { probeBinary }
