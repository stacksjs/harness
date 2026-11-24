import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { exchangeChatGptCode, parseChatGptCallback, prepareChatGptAuthorization } from '../src/chatgpt/authorization'
import { startChatGptAuthorization } from '../src/chatgpt/loopback'

const redirectUri = 'http://127.0.0.1:54213/auth/callback'
const hostId = 'urn:uuid:5fe264b9-baab-447c-9bf0-cd3d797c2e72'
const clientId = 'oaiapp_fixture'
const issuer = 'https://auth.openai.com'
const now = 1_800_000_000_000
const key = await generateKeyPair('RS256')
const keys = createLocalJWKSet({ keys: [await exportJWK(key.publicKey)] })

function returnUrl(state: string, issuedClient = clientId): string {
  return `${redirectUri}?state=${state}&code=one-time-fixture&client_id=${issuedClient}`
}

async function idToken(nonce: string, overrides: { subject?: string, audience?: string, issuer?: string, expiry?: number } = {}): Promise<string> {
  return new SignJWT({ nonce, email: 'fixture@example.test' })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? clientId)
    .setSubject(overrides.subject ?? 'subject-fixture')
    .setIssuedAt(now / 1000 - 120)
    .setExpirationTime(overrides.expiry ?? now / 1000 + 120)
    .sign(key.privateKey)
}

function tokens(idToken: string, scope = 'openid resource.invoke chatgpt.tokens.use.direct') {
  return { access_token: 'access-fixture', refresh_token: 'refresh-fixture', id_token: idToken, token_type: 'Bearer', expires_in: 120, scope }
}

function tokenEndpoint(body: Record<string, unknown>): typeof globalThis.fetch {
  return (async () => Response.json(body)) as typeof globalThis.fetch
}

describe('ChatGPT plan authorization', () => {
  it('registers a new account with Harness and a fresh OIDC and PKCE challenge', () => {
    const first = prepareChatGptAuthorization(redirectUri, hostId)
    const other = prepareChatGptAuthorization(redirectUri, hostId)
    const authorization = new URL(first.url)
    expect(first.state).not.toBe(other.state)
    expect(first.nonce).not.toBe(other.nonce)
    expect(first.verifier).not.toBe(other.verifier)
    expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorization.searchParams.get('agent_name_hint')).toBe('Harness')
    expect(authorization.searchParams.get('ext_agent_host_id')).toBe(hostId)
    expect(authorization.searchParams.get('nonce')).toBe(first.nonce)
    expect(authorization.searchParams.get('code_challenge')).toBe(createHash('sha256').update(first.verifier).digest('base64url'))
  })

  it('keeps account selection and rejects another redirect or registration', () => {
    const first = prepareChatGptAuthorization(redirectUri, hostId)
    const reconnect = prepareChatGptAuthorization(redirectUri, hostId, { clientId, subject: 'subject-fixture' })
    expect(new URL(reconnect.url).searchParams.get('client_id')).toBe(clientId)
    expect(new URL(reconnect.url).searchParams.has('agent_name_hint')).toBe(false)
    expect(() => parseChatGptCallback(first, returnUrl(reconnect.state))).toThrow('does not belong')
    expect(() => parseChatGptCallback(first, `${returnUrl(first.state)}&state=${first.state}`)).toThrow('does not belong')
    expect(() => parseChatGptCallback(first, returnUrl(first.state).replace('127.0.0.1', 'localhost'))).toThrow('does not belong')
    expect(() => parseChatGptCallback(reconnect, returnUrl(reconnect.state, 'oaiapp_wrong'))).toThrow('did not match')
    expect(() => parseChatGptCallback(first, `${redirectUri}?state=${first.state}&error=access_denied`)).toThrow('declined')
  })

  it('exchanges with the issued client ID and validates the signed identity and plan grant', async () => {
    const attempt = prepareChatGptAuthorization(redirectUri, hostId)
    const callback = parseChatGptCallback(attempt, returnUrl(attempt.state))
    const response = tokens(await idToken(attempt.nonce))
    const fetcher = (async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe(`${issuer}/api/accounts/oauth/token`)
      expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
        client_id: clientId,
        code: 'one-time-fixture',
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code_verifier: attempt.verifier,
        resource: 'https://api.openai.com/v1',
      })
      return Response.json(response)
    }) as typeof globalThis.fetch
    const session = await exchangeChatGptCode(attempt, callback, AbortSignal.timeout(1000), { fetch: fetcher, keys, now: () => now })
    expect(session).toMatchObject({ clientId, subject: 'subject-fixture', email: 'fixture@example.test', expiresAt: now + 120_000 })
  })

  it('rejects the wrong issuer, audience, nonce, expiry, account, or scope', async () => {
    const attempt = prepareChatGptAuthorization(redirectUri, hostId, { clientId, subject: 'subject-fixture' })
    const callback = parseChatGptCallback(attempt, returnUrl(attempt.state))
    const exchange = (response: Record<string, unknown>) => exchangeChatGptCode(attempt, callback, AbortSignal.timeout(1000), {
      fetch: tokenEndpoint(response), keys, now: () => now,
    })
    for (const invalid of [
      await idToken('other-nonce'),
      await idToken(attempt.nonce, { audience: 'oaiapp_wrong' }),
      await idToken(attempt.nonce, { issuer: 'https://issuer.example.test' }),
      await idToken(attempt.nonce, { expiry: now / 1000 - 1 }),
    ]) await expect(exchange(tokens(invalid))).rejects.toThrow('Could not verify')
    await expect(exchange(tokens(await idToken(attempt.nonce, { subject: 'different-account' })))).rejects.toThrow('same ChatGPT account')
    await expect(exchange(tokens(await idToken(attempt.nonce), 'openid'))).rejects.toThrow('was not granted')
  })
})

describe('the loopback ChatGPT callback', () => {
  it('keeps listening after an unrelated callback and exchanges a valid code once', async () => {
    const reachedEndpoint = Promise.withResolvers<void>()
    const allowExchange = Promise.withResolvers<void>()
    let nonce = ''
    let requests = 0
    const fetcher = (async () => {
      requests++
      reachedEndpoint.resolve()
      await allowExchange.promise
      return Response.json(tokens(await idToken(nonce)))
    }) as typeof globalThis.fetch
    const pending = startChatGptAuthorization(hostId, undefined, {
      timeoutMs: 6000,
      transport: { fetch: fetcher, keys, now: () => now },
    })
    const completion = pending.result.catch(error => error)
    try {
      const authorize = new URL(pending.url)
      const callback = authorize.searchParams.get('redirect_uri')!
      nonce = authorize.searchParams.get('nonce')!
      const valid = `${callback}?state=${authorize.searchParams.get('state')}&code=fixture&client_id=${clientId}`
      expect(new URL(callback).hostname).toBe('127.0.0.1')
      expect((await fetch(`${callback}?state=unrelated&code=other`)).status).toBe(400)
      expect(requests).toBe(0)
      const exchange = fetch(valid)
      await reachedEndpoint.promise
      expect((await fetch(valid)).status).toBe(409)
      allowExchange.resolve()
      expect((await exchange).status).toBe(200)
      expect(await completion).toMatchObject({ clientId, subject: 'subject-fixture' })
      expect(requests).toBe(1)
    }
    finally {
      allowExchange.resolve()
      pending.cancel()
    }
  })

  it('settles when canceled or timed out', async () => {
    const canceled = startChatGptAuthorization(hostId)
    const failure = canceled.result.catch(error => error)
    canceled.cancel()
    expect(await failure).toMatchObject({ message: 'ChatGPT sign-in was canceled.' })

    const expired = startChatGptAuthorization(hostId, undefined, { timeoutMs: 10 })
    const timeout = await expired.result.catch(error => error)
    expect(timeout).toMatchObject({ message: 'ChatGPT sign-in timed out. Start a new sign-in.' })
  })
})
