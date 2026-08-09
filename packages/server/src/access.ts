/**
 * Who is allowed to talk to the server.
 *
 * The server is the execution boundary: a socket that can dispatch commands can
 * start an agent, and an agent runs tools. Reaching this socket is therefore
 * equivalent to running code on the host, and everything here exists because of
 * that one sentence.
 *
 * ## Why loopback stops being trustworthy
 *
 * Until now the only protection was the bind address — 127.0.0.1, so only this
 * machine could connect, and anything already on this machine can run processes
 * as you anyway. That reasoning is sound right up to the moment someone puts a
 * tunnel in front of it.
 *
 * A tunnel connects *to localhost*. Every request it forwards arrives from
 * 127.0.0.1. So the check that used to mean "this came from my machine" starts
 * meaning "this came from my machine, or from anyone on the internet who found
 * the URL", and it cannot tell the two apart. Peer-address trust does not fail
 * loudly here; it keeps returning `true` and quietly stops being a check.
 *
 * So there are exactly two modes, and no gradient between them:
 *
 * - **local** (default) — bound to loopback, no authentication. What it always
 *   was, and honest about why: the boundary is the bind address.
 * - **remote** — every connection presents a token. *Including loopback*, which
 *   is the part that matters: exempting it would exempt the tunnel too.
 *
 * The local CLI and desktop app keep working in remote mode by reading a token
 * from a 0600 file, the way `docker`, Jupyter and friends do it.
 *
 * ## What the log stores
 *
 * A SHA-256 of each token, never the token. The event log is plaintext, append
 * only and designed never to forget; a bearer token written there would be
 * valid forever and readable by anything that can open the file. A hash can
 * check a token without being able to produce one.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** How long a pairing code is worth typing. */
const PAIRING_TTL_MS = 5 * 60_000
/**
 * Wrong guesses before a code is burned.
 *
 * A code is 40 bits, so guessing is hopeless on the numbers alone — but the
 * numbers assume nobody gets unlimited attempts, and an online guessing loop is
 * cheap to write. Burning the code turns a brute-force attempt into a denial of
 * pairing, which the host can see and retry, rather than a way in.
 */
const PAIRING_ATTEMPTS = 5

/**
 * Unambiguous by construction: no `0`/`O`, no `1`/`I`/`l`.
 *
 * Someone is reading this off a terminal and typing it into a phone. A code
 * that is technically strong and practically mistyped gets pasted into a chat
 * app to copy it, which is worse than a slightly shorter alphabet.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export interface PairedDevice {
  id: string
  name: string
  tokenHash: string
}

export interface AuthOutcome {
  ok: boolean
  deviceId?: string
  /** Why it failed, for the response body — never for a log line with the token in it. */
  reason?: 'no-credential' | 'unknown-token'
}

/** A random bearer token, URL-safe so it survives a query string or a header. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Compare two hashes without leaking where they diverge.
 *
 * Both are fixed-length hex, so length is not secret and an early length
 * mismatch tells an attacker nothing. The content comparison is the part that
 * has to be constant time.
 */
export function hashesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** A pairing code: short, single-use, and short-lived. */
export function mintPairingCode(): string {
  const bytes = randomBytes(8)
  let code = ''
  for (const byte of bytes) code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length)
  // Grouped for reading aloud, stripped again on the way in.
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function normaliseCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}

/**
 * The bearer token on a request, from either place a client can put one.
 *
 * A browser cannot set headers on a WebSocket upgrade, so the cookie is what
 * makes the page and its socket authenticate the same way. The header is for
 * the CLI, which has no cookie jar and should not grow one.
 */
export function credentialFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || null

  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'harness_token') return decodeURIComponent(rest.join('=')) || null
  }
  return null
}

/**
 * Whether a bind address only accepts connections from this machine.
 *
 * Used to refuse an unauthenticated bind to a public interface, not to
 * authorise a request — a *peer* being loopback proves nothing once a tunnel is
 * involved, which is the whole lesson of this file.
 */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === 'localhost'
    || hostname.startsWith('127.')
}

export interface AccessOptions {
  /** Require a token on every connection. Off is the loopback-only default. */
  remote: boolean
  /** Paired devices, read fresh on each check so a revoke takes effect at once. */
  devices: () => Iterable<PairedDevice>
  /** Called when a code is redeemed, to record the device in the log. */
  onPair: (device: { id: string, name: string, tokenHash: string }) => Promise<void>
}

export class AccessControl {
  /** The code currently on screen, if any. */
  private code: string | null = null
  private codeExpires = 0
  private attemptsLeft = 0
  /**
   * The token this host's own CLI and desktop app use.
   *
   * Minted rather than derived so it changes every boot: a token written to
   * disk that survived restarts would outlive the session it was meant for, and
   * nothing would ever rotate it.
   */
  readonly localToken: string

  constructor(private options: AccessOptions) {
    this.localToken = mintToken()
  }

  get required(): boolean {
    return this.options.remote
  }

  /** Begin pairing, returning the code to display. */
  openPairing(): { code: string, expiresAt: number } {
    this.code = mintPairingCode()
    this.codeExpires = Date.now() + PAIRING_TTL_MS
    this.attemptsLeft = PAIRING_ATTEMPTS
    return { code: this.code, expiresAt: this.codeExpires }
  }

  get pairingOpen(): boolean {
    return this.code !== null && Date.now() < this.codeExpires
  }

  /**
   * Trade a pairing code for a token.
   *
   * Single-use on success: a code that stayed valid for its whole five minutes
   * would let anyone who glanced at the screen pair a second device later.
   */
  async redeem(input: string, deviceName: string): Promise<{ ok: true, token: string } | { ok: false, reason: string }> {
    if (!this.options.remote) return { ok: false, reason: 'this server is not accepting remote devices' }
    if (!this.code || Date.now() >= this.codeExpires) {
      this.code = null
      return { ok: false, reason: 'the pairing code has expired' }
    }

    const supplied = normaliseCode(input)
    const expected = normaliseCode(this.code)
    // Same-length hex is not what these are, so compare through hashes to keep
    // the timing flat regardless of how much of the code was right.
    if (!hashesMatch(hashToken(supplied), hashToken(expected))) {
      this.attemptsLeft -= 1
      if (this.attemptsLeft <= 0) {
        this.code = null
        return { ok: false, reason: 'too many wrong codes; pair again from the host' }
      }
      return { ok: false, reason: `that code is not right (${this.attemptsLeft} attempts left)` }
    }

    this.code = null
    const token = mintToken()
    await this.options.onPair({
      id: `dev_${randomBytes(6).toString('hex')}`,
      name: deviceName.trim().slice(0, 60) || 'a device',
      tokenHash: hashToken(token),
    })
    return { ok: true, token }
  }

  /**
   * Authenticate a request.
   *
   * Note what is *not* consulted: the peer address. In remote mode a tunnel
   * makes every peer loopback, so the only thing worth asking is whether the
   * caller holds a token.
   */
  authenticate(request: Request): AuthOutcome {
    if (!this.options.remote) return { ok: true }

    const token = credentialFrom(request)
    if (!token) return { ok: false, reason: 'no-credential' }

    const hash = hashToken(token)
    if (hashesMatch(hash, hashToken(this.localToken)))
      return { ok: true, deviceId: 'local' }

    for (const device of this.options.devices()) {
      if (hashesMatch(hash, device.tokenHash)) return { ok: true, deviceId: device.id }
    }
    return { ok: false, reason: 'unknown-token' }
  }
}

/**
 * The `Set-Cookie` for a freshly paired browser.
 *
 * `HttpOnly` so a script on the page cannot read the token back out, and
 * `SameSite=Strict` so another site cannot make an authenticated request to a
 * harness the browser has paired with. `Secure` only over https, because
 * setting it on a plain-http LAN address means the cookie is never stored and
 * pairing appears to succeed and then silently fail.
 */
export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `harness_token=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${60 * 60 * 24 * 30}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * Where this host's own clients look for their token.
 *
 * A file rather than an environment variable so the desktop app and a CLI in
 * any shell find the same one without the user exporting anything, and because
 * an env var is visible in `ps` output on some systems.
 */
export function localTokenPath(): string {
  return join(process.cwd(), 'storage', 'private', 'harness.token')
}

/**
 * Write the token for local clients, readable only by this user.
 *
 * `0o600` is set at creation through `mode` *and* re-applied with `chmod`: the
 * mode passed to `writeFile` is masked by the process umask and ignored
 * outright if the file already exists, so on a second boot a previously
 * world-readable file would keep its permissions.
 */
export async function writeLocalToken(token: string, path = localTokenPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

/** Read this host's token, or null when the server is not running with auth. */
export async function readLocalToken(path = localTokenPath()): Promise<string | null> {
  try {
    const token = (await readFile(path, 'utf8')).trim()
    return token || null
  }
  catch {
    return null
  }
}
