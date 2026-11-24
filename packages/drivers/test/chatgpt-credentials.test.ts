import type { ChatGptSession } from '../src/chatgpt/authorization'
import { describe, expect, it } from 'bun:test'
import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { ChatGptCredentialStore } from '../src/chatgpt/credentials'

const now = 1_800_000_000_000
const session: ChatGptSession = {
  clientId: 'oaiapp_fixture', subject: 'fixture-account', email: 'fixture@example.test',
  accessToken: 'fixture-expired-access', refreshToken: 'fixture-original-renewal', idToken: 'fixture-id',
  scopes: ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct'], expiresAt: now - 100,
}

async function withStore(task: (directory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'harness-chatgpt-test-'))
  try { await task(join(root, 'chatgpt')) }
  finally { await rm(root, { recursive: true, force: true }) }
}

describe('protected ChatGPT credentials', () => {
  it('keeps a stable host identifier and rotates a stored token once across store instances', async () => {
    await withStore(async (directory) => {
      let renewals = 0
      const fetcher = (async (url: URL, options: RequestInit) => {
        renewals++
        expect(url.origin).toBe('https://auth.openai.com')
        const form = options.body as URLSearchParams
        expect(form.get('grant_type')).toBe('refresh_token')
        expect(form.get('client_id')).toBe(session.clientId)
        expect(form.get('refresh_token')).toBe(session.refreshToken)
        expect(form.has('scope')).toBe(false)
        return Response.json({
          access_token: 'fixture-renewed-access', refresh_token: 'fixture-next-renewal', token_type: 'Bearer', expires_in: 3600,
        })
      }) as typeof globalThis.fetch
      const first = new ChatGptCredentialStore(directory, { fetch: fetcher, now: () => now })
      const second = new ChatGptCredentialStore(directory, { fetch: fetcher, now: () => now })
      expect(await first.hostIdentifier()).toMatch(/^urn:uuid:/)
      expect(await first.hostIdentifier()).toBe(await second.hostIdentifier())
      await first.saveSession(session)
      await expect(second.saveSession({ ...session, subject: 'another-account' })).rejects.toThrow('belongs to another account')
      const results = await Promise.all([first.accessToken(session.clientId), second.accessToken(session.clientId)])
      expect(results).toEqual(['fixture-renewed-access', 'fixture-renewed-access'])
      expect(renewals).toBe(1)

      const files = await readdir(directory)
      expect(files).toHaveLength(2)
      if (process.platform !== 'win32') {
        expect((await lstat(directory)).mode & 0o777).toBe(0o700)
        for (const file of files) expect((await lstat(join(directory, file))).mode & 0o777).toBe(0o600)
      }
    })
  })

  it.each([true, false])('discards local tokens on sign-out and reports revocation %s', async (confirmed) => {
    await withStore(async (directory) => {
      const issuer = 'https://auth.openai.com'
      let revocations = 0
      const fetcher = (async (url: URL, options: RequestInit) => {
        if (url.pathname === '/.well-known/openid-configuration')
          return Response.json({ issuer, revocation_endpoint: `${issuer}/revoke` })
        revocations++
        expect(Object.fromEntries(options.body as URLSearchParams)).toEqual({
          client_id: session.clientId, token: session.refreshToken, token_type_hint: 'refresh_token',
        })
        return new Response(null, { status: confirmed ? 200 : 503 })
      }) as typeof globalThis.fetch
      const store = new ChatGptCredentialStore(directory, { fetch: fetcher })
      await store.saveSession(session)
      expect(await store.signOut(session.clientId)).toEqual({ revoked: confirmed })
      expect(revocations).toBe(confirmed ? 1 : 3)
      expect(await store.registration(session.clientId)).toEqual({ clientId: session.clientId, subject: session.subject, email: session.email })
      await expect(store.accessToken(session.clientId)).rejects.toThrow('Connect this ChatGPT account')
      const [file] = await readdir(directory)
      expect(await readFile(join(directory, file!), 'utf8')).not.toContain(session.refreshToken)
    })
  })

  it('keeps credentials on transient renewal errors and requires reauthorization for unusable tokens', async () => {
    await withStore(async (directory) => {
      let permanent = false
      const fetcher = Object.assign(async () => permanent
        ? Response.json({ error: 'invalid_grant', error_description: 'fixture-private-error' }, { status: 400 })
        : new Response(null, { status: 503 }), { preconnect() {} })
      const store = new ChatGptCredentialStore(directory, { fetch: fetcher, now: () => now })
      await store.saveSession(session, { requireNew: true })
      await expect(store.saveSession(session, { requireNew: true })).rejects.toThrow('already linked')
      expect(await store.connected(session.clientId)).toBe(true)
      await expect(store.accessToken(session.clientId)).rejects.toThrow('Could not renew')
      expect(await store.connected(session.clientId)).toBe(true)
      permanent = true
      await expect(store.accessToken(session.clientId)).rejects.toThrow('Sign in again')
      expect(await store.connected(session.clientId)).toBe(false)
      expect(await store.registration(session.clientId)).toEqual({ clientId: session.clientId, subject: session.subject, email: session.email })
    })
  })
})
