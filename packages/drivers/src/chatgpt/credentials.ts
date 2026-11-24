import type { ChatGptRegistration, ChatGptSession, ChatGptTransport } from './authorization'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { lock } from 'proper-lockfile'
import { ChatGptRenewalRequiresSignIn, renewChatGptSession, revokeChatGptSession } from './authorization'

interface StoredChatGptAccount {
  registration: Omit<ChatGptRegistration, 'idToken'>
  session?: ChatGptSession
}

function missingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function readPrivateFile(path: string): Promise<string | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077)))
      throw new Error('The ChatGPT credential file is not private.')
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if (missingFile(error)) return null
    throw new Error('Could not read the private ChatGPT credential file.')
  }
}

async function replacePrivateFile(path: string, value: string, signal: AbortSignal): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    await rename(temporary, path)
  }
  finally {
    await unlink(temporary).catch(() => {})
  }
}

/** Host filesystem storage. Raw credentials never enter a Harness model or event. */
export class ChatGptCredentialStore {
  constructor(private readonly directory: string, private readonly transport: ChatGptTransport = {}) {}

  private accountPath(clientId: string): string {
    if (!/^oaiapp_[\w-]+$/u.test(clientId)) throw new Error('The ChatGPT registration is invalid.')
    return join(this.directory, `${createHash('sha256').update(clientId).digest('hex')}.json`)
  }

  private async privateDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077)))
      throw new Error('The ChatGPT credential directory is not private.')
  }

  private async withLease<T>(path: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.privateDirectory()
    const abort = new AbortController()
    const failure = () => new Error('Could not lock the ChatGPT connection for an update. Try again.')
    let release
    try {
      // Lease timing follows CodexChatGptSessionLock.ts at the pinned T3 Code
      // revision. The refresh token rotates across all Harness host processes.
      release = await lock(path, {
        realpath: false,
        stale: 120_000,
        update: 10_000,
        retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
        onCompromised: () => abort.abort(failure()),
      })
    }
    catch {
      throw failure()
    }
    try {
      const outcome = await task(abort.signal)
      abort.signal.throwIfAborted()
      return outcome
    }
    finally {
      await release().catch(() => {})
    }
  }

  private async account(path: string, clientId: string): Promise<StoredChatGptAccount | null> {
    const content = await readPrivateFile(path)
    if (content === null) return null
    try {
      const account = JSON.parse(content) as StoredChatGptAccount
      if (account.registration.clientId !== clientId || !account.registration.subject
        || (account.session && (account.session.clientId !== clientId
          || account.session.subject !== account.registration.subject
          || !Number.isFinite(account.session.expiresAt)
          || !account.session.accessToken || !account.session.refreshToken || !account.session.idToken
          || !Array.isArray(account.session.scopes))))
        throw new Error('Invalid saved connection.')
      return account
    }
    catch {
      throw new Error('The saved ChatGPT connection could not be read. Sign in again.')
    }
  }

  async hostIdentifier(): Promise<string> {
    const path = join(this.directory, 'host-id')
    return this.withLease(path, async (signal) => {
      const existing = await readPrivateFile(path)
      if (existing) return existing.trim()
      const hostId = `urn:uuid:${randomUUID()}`
      await replacePrivateFile(path, `${hostId}\n`, signal)
      return hostId
    })
  }

  async registration(clientId: string): Promise<ChatGptRegistration | null> {
    const account = await this.account(this.accountPath(clientId), clientId)
    if (!account) return null
    return { ...account.registration, ...(account.session ? { idToken: account.session.idToken } : {}) }
  }

  async connected(clientId: string): Promise<boolean> {
    return Boolean((await this.account(this.accountPath(clientId), clientId))?.session)
  }

  async runtimeHome(clientId: string): Promise<string> {
    const path = this.accountPath(clientId).replace(/\.json$/u, '.codex')
    await this.privateDirectory()
    await mkdir(path, { recursive: true, mode: 0o700 })
    const directory = await lstat(path)
    if (!directory.isDirectory() || (process.platform !== 'win32' && (directory.mode & 0o077)))
      throw new Error('The managed Codex directory is not private.')
    return path
  }

  async saveSession(session: ChatGptSession, options: { requireNew?: boolean } = {}): Promise<void> {
    const path = this.accountPath(session.clientId)
    await this.withLease(path, async (signal) => {
      const existing = await this.account(path, session.clientId)
      if (existing && options.requireNew)
        throw new Error('This ChatGPT registration is already linked on this host. Reconnect the existing Harness account.')
      if (existing && existing.registration.subject !== session.subject)
        throw new Error('The ChatGPT registration belongs to another account.')
      const { clientId, subject, email } = session
      await replacePrivateFile(path, JSON.stringify({ registration: { clientId, subject, email }, session }), signal)
    })
  }

  async accessToken(clientId: string): Promise<string> {
    const path = this.accountPath(clientId)
    return this.withLease(path, async (signal) => {
      const account = await this.account(path, clientId)
      if (!account?.session) throw new Error('Connect this ChatGPT account before starting a turn.')
      const { session } = account
      const now = this.transport.now?.() ?? Date.now()
      if (session.expiresAt - now > 60_000) return session.accessToken
      if (session.earliestRefreshAt !== undefined && session.earliestRefreshAt > now) {
        if (session.expiresAt > now) return session.accessToken
        throw new Error('This ChatGPT connection cannot be renewed yet. Try again or sign in.')
      }
      let replacement: ChatGptSession
      try {
        replacement = await renewChatGptSession(session, AbortSignal.any([signal, AbortSignal.timeout(10000)]), this.transport)
      }
      catch (error) {
        if (error instanceof ChatGptRenewalRequiresSignIn)
          await replacePrivateFile(path, JSON.stringify({ registration: account.registration }), signal)
        throw error
      }
      await replacePrivateFile(path, JSON.stringify({ ...account, session: replacement }), signal)
      return replacement.accessToken
    })
  }

  async signOut(clientId: string, options: { forget?: boolean } = {}): Promise<{ revoked: boolean }> {
    const path = this.accountPath(clientId)
    return this.withLease(path, async (signal) => {
      const account = await this.account(path, clientId)
      if (!account) return { revoked: true }
      let revoked = true
      if (account.session) {
        revoked = await revokeChatGptSession(account.session, AbortSignal.any([signal, AbortSignal.timeout(5000)]), this.transport)
          .catch(() => false)
      }
      signal.throwIfAborted()
      if (options.forget) await unlink(path)
      else if (account.session) await replacePrivateFile(path, JSON.stringify({ registration: account.registration }), signal)
      return { revoked }
    })
  }
}
