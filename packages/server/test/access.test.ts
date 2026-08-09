import { describe, expect, it } from 'bun:test'
import {
  AccessControl,
  credentialFrom,
  hashesMatch,
  hashToken,
  isLoopbackHost,
  mintPairingCode,
  mintToken,
  normaliseCode,
  sessionCookie,
} from '../src/access'

function control(devices: Array<{ id: string, name: string, tokenHash: string }> = []) {
  const paired = [...devices]
  const access = new AccessControl({
    remote: true,
    devices: () => paired,
    onPair: async (device) => { paired.push(device) },
  })
  return { access, paired }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3789/', { headers })
}

describe('tokens', () => {
  it('mints distinct tokens', () => {
    expect(mintToken()).not.toBe(mintToken())
  })

  it('stores a hash that does not contain the token', () => {
    const token = mintToken()
    const hash = hashToken(token)
    expect(hash).toHaveLength(64)
    expect(hash).not.toContain(token)
  })

  it('compares equal-length hashes and rejects different ones', () => {
    const a = hashToken('one')
    expect(hashesMatch(a, hashToken('one'))).toBe(true)
    expect(hashesMatch(a, hashToken('two'))).toBe(false)
    // A short string must not throw its way past the check.
    expect(hashesMatch(a, 'abc')).toBe(false)
  })
})

describe('credentials on a request', () => {
  it('reads a bearer header', () => {
    expect(credentialFrom(request({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('reads the cookie, which is all a browser websocket can send', () => {
    expect(credentialFrom(request({ cookie: 'other=1; harness_token=abc123; x=2' }))).toBe('abc123')
  })

  it('is null with nothing to read', () => {
    expect(credentialFrom(request())).toBeNull()
    expect(credentialFrom(request({ authorization: 'Basic abc' }))).toBeNull()
    expect(credentialFrom(request({ cookie: 'unrelated=1' }))).toBeNull()
  })
})

describe('pairing codes', () => {
  it('avoids characters that get misread off a screen', () => {
    for (let i = 0; i < 50; i++)
      expect(mintPairingCode()).not.toMatch(/[01OIL]/)
  })

  it('accepts the code however it was typed', () => {
    expect(normaliseCode('abcd-2345')).toBe('ABCD2345')
    expect(normaliseCode('ABCD 2345')).toBe('ABCD2345')
  })
})

describe('redeeming a code', () => {
  it('trades a correct code for a token and records the device', async () => {
    const { access, paired } = control()
    const { code } = access.openPairing()

    const result = await access.redeem(code, 'a phone')
    expect(result.ok).toBe(true)
    expect(paired).toHaveLength(1)
    // The device list holds a hash of what was issued, never the token.
    if (result.ok) {
      expect(paired[0]!.tokenHash).toBe(hashToken(result.token))
      expect(JSON.stringify(paired)).not.toContain(result.token)
    }
  })

  it('refuses a wrong code', async () => {
    const { access } = control()
    access.openPairing()
    expect((await access.redeem('AAAA-AAAA', 'x')).ok).toBe(false)
  })

  it('burns the code after too many wrong guesses', async () => {
    const { access } = control()
    const { code } = access.openPairing()
    for (let i = 0; i < 5; i++) await access.redeem('AAAA-AAAA', 'x')

    // Even the right code now fails: guessing has to cost something.
    expect((await access.redeem(code, 'x')).ok).toBe(false)
  })

  it('will not spend a code twice', async () => {
    const { access } = control()
    const { code } = access.openPairing()
    expect((await access.redeem(code, 'first')).ok).toBe(true)
    expect((await access.redeem(code, 'second')).ok).toBe(false)
  })

  it('refuses when no pairing is open', async () => {
    const { access } = control()
    expect((await access.redeem('AAAA-AAAA', 'x')).ok).toBe(false)
  })
})

describe('authenticating', () => {
  it('accepts this host own token', () => {
    const { access } = control()
    expect(access.authenticate(request({ authorization: `Bearer ${access.localToken}` })).ok).toBe(true)
  })

  it('accepts a paired device and names it', async () => {
    const { access } = control()
    const { code } = access.openPairing()
    const result = await access.redeem(code, 'a phone')
    if (!result.ok) throw new Error('pairing should have succeeded')

    const outcome = access.authenticate(request({ cookie: `harness_token=${result.token}` }))
    expect(outcome.ok).toBe(true)
    expect(outcome.deviceId).toMatch(/^dev_/)
  })

  it('rejects no credential and an unknown one', () => {
    const { access } = control()
    expect(access.authenticate(request()).ok).toBe(false)
    expect(access.authenticate(request({ authorization: 'Bearer nope' })).ok).toBe(false)
  })

  it('stops accepting a device the moment it is revoked', async () => {
    const { access, paired } = control()
    const { code } = access.openPairing()
    const result = await access.redeem(code, 'a phone')
    if (!result.ok) throw new Error('pairing should have succeeded')
    const authed = () => access.authenticate(request({ cookie: `harness_token=${result.token}` })).ok

    expect(authed()).toBe(true)
    paired.length = 0
    // No restart, no cache to expire: the list is read on every check.
    expect(authed()).toBe(false)
  })

  it('does not authenticate on where the request came from', async () => {
    // The whole point. A tunnel forwards from loopback, so a request that looks
    // local proves nothing — only the token does.
    const { access } = control()
    const local = new Request('http://127.0.0.1:3789/')
    expect(access.authenticate(local).ok).toBe(false)
  })

  it('lets everything through when remote access is off', () => {
    const access = new AccessControl({ remote: false, devices: () => [], onPair: async () => {} })
    expect(access.authenticate(request()).ok).toBe(true)
    expect(access.required).toBe(false)
  })
})

describe('bind addresses', () => {
  it('knows which ones only this machine can reach', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.20')).toBe(false)
  })
})

describe('the cookie', () => {
  it('is not readable from a script and not sent cross-site', () => {
    const cookie = sessionCookie('abc', false)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
  })

  it('is only marked Secure over https, or it would never be stored on a LAN address', () => {
    expect(sessionCookie('abc', false)).not.toContain('Secure')
    expect(sessionCookie('abc', true)).toContain('Secure')
  })
})
