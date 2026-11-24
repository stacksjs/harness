import type { JWTVerifyGetKey } from 'jose'
import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { codexAuthorizationRequest, codexCallbackUrl } from './codex-auth-callback'

const ISSUER = 'https://auth.openai.com'
const RESOURCE = 'https://api.openai.com/v1'
const REGISTRATION_CLIENT = 'dynamic_agent_client'
const REQUIRED_SCOPES = ['openid', 'resource.invoke', 'chatgpt.tokens.use.direct']
const REQUESTED_SCOPES = [...REQUIRED_SCOPES, 'profile', 'email', 'offline_access']
const CLIENT_ID = /^oaiapp_[\w-]+$/u
const UNUSABLE_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

export class ChatGptRenewalRequiresSignIn extends Error {
  constructor() {
    super('ChatGPT can no longer renew this connection. Sign in again.')
  }
}

export interface ChatGptRegistration {
  clientId: string
  subject: string
  email?: string
  idToken?: string
}

export interface ChatGptAuthorization {
  url: string
  redirectUri: string
  state: string
  nonce: string
  verifier: string
  registration?: ChatGptRegistration
}

export interface ChatGptSession extends ChatGptRegistration {
  accessToken: string
  refreshToken: string
  idToken: string
  scopes: string[]
  expiresAt: number
  earliestRefreshAt?: number
}

export interface ChatGptTransport {
  fetch?: typeof globalThis.fetch
  keys?: JWTVerifyGetKey
  now?: () => number
}

function safeEndpoint(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('OpenAI sign-in discovery is incomplete.')
  const url = new URL(value)
  if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash)
    throw new Error('OpenAI sign-in discovery returned an invalid endpoint.')
  return url
}

async function readObject(response: Response, error: string): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  }
  catch { /* Provider responses can contain credentials. Keep parse errors private. */ }
  throw new Error(error)
}

async function openIdDiscovery(fetcher: typeof globalThis.fetch, signal: AbortSignal): Promise<Record<string, unknown>> {
  const error = 'Could not verify the OpenAI sign-in issuer.'
  const response = await fetcher(new URL('/.well-known/openid-configuration', ISSUER), { redirect: 'error', signal })
  if (!response.ok) throw new Error(error)
  const metadata = await readObject(response, error)
  if (metadata.issuer !== ISSUER) throw new Error(error)
  return metadata
}

async function requestTokens(
  fetcher: typeof globalThis.fetch,
  parameters: Record<string, string>,
  signal: AbortSignal,
  error: string,
): Promise<Record<string, unknown>> {
  const response = await fetcher(new URL('/api/accounts/oauth/token', ISSUER), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, resource: RESOURCE }),
    redirect: 'error',
    signal,
  })
  if (!response.ok) {
    if (parameters.grant_type === 'refresh_token' && response.status >= 400 && response.status < 500) {
      const body = await readObject(response, error).catch(() => null)
      const value = body?.error
      const code = typeof value === 'string' ? value : value && typeof value === 'object' && 'code' in value ? value.code : undefined
      if (typeof code === 'string' && UNUSABLE_REFRESH_CODES.has(code)) throw new ChatGptRenewalRequiresSignIn()
    }
    throw new Error(error)
  }
  return readObject(response, error)
}

function accessFields(
  token: Record<string, unknown>,
  now: number,
  fallbackScopes: string[] = [],
): Pick<ChatGptSession, 'accessToken' | 'refreshToken' | 'scopes' | 'expiresAt' | 'earliestRefreshAt'> {
  const scopes = typeof token.scope === 'string' ? token.scope.split(/\s+/).filter(Boolean) : fallbackScopes
  if (!REQUIRED_SCOPES.every(scope => scopes.includes(scope)))
    throw new Error('Permission to use the ChatGPT plan was not granted.')
  if (typeof token.access_token !== 'string' || !token.access_token
    || typeof token.refresh_token !== 'string' || !token.refresh_token
    || typeof token.expires_in !== 'number' || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 0
    || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer')
    throw new Error('OpenAI returned incomplete ChatGPT credentials. Start a new sign-in.')
  const refreshHint = token.earliest_refresh_at
  const earliestRefreshAt = typeof refreshHint === 'number' ? (refreshHint >= 1e12 ? refreshHint : refreshHint * 1000)
    : typeof refreshHint === 'string' ? Date.parse(refreshHint) : undefined
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    scopes,
    expiresAt: now + token.expires_in * 1000,
    ...(earliestRefreshAt !== undefined && Number.isFinite(earliestRefreshAt) ? { earliestRefreshAt } : {}),
  }
}

/** Creates one OAuth attempt for the selected host and optional saved registration. */
export function prepareChatGptAuthorization(redirectUri: string, hostId: string, registration?: ChatGptRegistration): ChatGptAuthorization {
  if (registration && !CLIENT_ID.test(registration.clientId)) throw new Error('The saved ChatGPT registration is invalid.')
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const authorization = new URL('/api/accounts/authorize', ISSUER)
  authorization.search = new URLSearchParams({
    client_id: registration?.clientId ?? REGISTRATION_CLIENT,
    ...(registration ? {} : { agent_name_hint: 'Harness' }),
    ...(registration?.idToken ? { id_token_hint: registration.idToken } : {}),
    ...(registration?.email ? { login_hint: registration.email } : {}),
    ext_agent_host_id: hostId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: REQUESTED_SCOPES.join(' '),
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString()
  codexAuthorizationRequest(authorization.toString())
  return { url: authorization.toString(), redirectUri, state, nonce, verifier, registration }
}

export function parseChatGptCallback(attempt: ChatGptAuthorization, input: string): { clientId: string, code: string } {
  const callback = codexCallbackUrl(input, attempt.redirectUri, attempt.state)
  if (callback.searchParams.has('error')) throw new Error('ChatGPT sign-in was declined or interrupted.')
  const returnedClient = callback.searchParams.get('client_id')
  const existingClient = attempt.registration?.clientId
  if (existingClient && returnedClient && existingClient !== returnedClient)
    throw new Error('The returned ChatGPT registration did not match the selected account.')
  const clientId = existingClient ?? returnedClient
  if (!clientId || !CLIENT_ID.test(clientId)) throw new Error('OpenAI did not return an issued ChatGPT client ID.')
  return { clientId, code: callback.searchParams.get('code')! }
}

export async function exchangeChatGptCode(
  attempt: ChatGptAuthorization,
  callback: { clientId: string, code: string },
  signal: AbortSignal,
  transport: ChatGptTransport = {},
): Promise<ChatGptSession> {
  const fetcher = transport.fetch ?? globalThis.fetch
  const token = await requestTokens(fetcher, {
    grant_type: 'authorization_code',
    client_id: callback.clientId,
    code: callback.code,
    redirect_uri: attempt.redirectUri,
    code_verifier: attempt.verifier,
  }, signal, 'OpenAI could not complete ChatGPT sign-in. Start a new sign-in.')
  if (typeof token.id_token !== 'string' || !token.id_token)
    throw new Error('OpenAI returned incomplete ChatGPT credentials. Start a new sign-in.')

  let keySet = transport.keys
  if (!keySet) {
    const metadata = await openIdDiscovery(fetcher, signal)
    keySet = createRemoteJWKSet(safeEndpoint(metadata.jwks_uri), { timeoutDuration: 5000 })
  }

  const now = transport.now?.() ?? Date.now()
  const access = accessFields(token, now)
  let identity
  try {
    const { payload } = await jwtVerify(token.id_token, keySet, {
      algorithms: ['RS256'],
      issuer: ISSUER,
      audience: callback.clientId,
      currentDate: new Date(now),
      requiredClaims: ['iat', 'exp', 'sub', 'nonce'],
    })
    if (payload.nonce !== attempt.nonce || !payload.sub
      || (payload.azp !== undefined && payload.azp !== callback.clientId)
      || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== callback.clientId))
      throw new Error('Invalid ID token claims.')
    identity = { subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) }
  }
  catch {
    throw new Error('Could not verify the returned ChatGPT account. Start a new sign-in.')
  }
  if (attempt.registration && attempt.registration.subject !== identity.subject)
    throw new Error('Sign in to the same ChatGPT account as the selected registration.')

  return {
    ...identity,
    ...access,
    clientId: callback.clientId,
    idToken: token.id_token,
  }
}

export async function renewChatGptSession(
  session: ChatGptSession,
  signal: AbortSignal,
  transport: ChatGptTransport = {},
): Promise<ChatGptSession> {
  const token = await requestTokens(transport.fetch ?? globalThis.fetch, {
    grant_type: 'refresh_token',
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  }, signal, 'Could not renew the ChatGPT connection. Retry or sign in again.')
  const replacement = { ...session }
  delete replacement.earliestRefreshAt
  return { ...replacement, ...accessFields(token, transport.now?.() ?? Date.now(), session.scopes) }
}

export async function revokeChatGptSession(
  session: ChatGptSession,
  signal: AbortSignal,
  transport: ChatGptTransport = {},
): Promise<boolean> {
  const fetcher = transport.fetch ?? globalThis.fetch
  const metadata = await openIdDiscovery(fetcher, signal)
  const endpoint = safeEndpoint(metadata.revocation_endpoint)
  for (let retry = 0; retry < 3; retry++) {
    if (signal.aborted) return false
    if (retry > 0) await Bun.sleep(200 * retry)
    try {
      const response = await fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: session.clientId, token: session.refreshToken, token_type_hint: 'refresh_token' }),
        redirect: 'error',
        signal,
      })
      if (response.status < 500) return response.status === 200
    }
    catch { /* Retry inside the deadline while the renewal token is still available. */ }
  }
  return false
}
