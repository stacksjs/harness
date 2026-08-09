import { describe, expect, it } from 'bun:test'
import { open } from '../src/tunnel'

/**
 * Only the refusals are tested here, deliberately: they are the part that has
 * to hold, and they are the part that needs no relay to exercise. The happy
 * path was verified against a relay running on this machine -- see PLAN.md.
 */
describe('refusing to publish a shell', () => {
  it('will not tunnel a server that has no authentication', async () => {
    await expect(open({ port: 3901, authenticated: false })).rejects.toThrow(/without authentication/)
  })

  it('names the fix rather than just the problem', async () => {
    await expect(open({ port: 3901, authenticated: false })).rejects.toThrow(/--remote/)
  })

  it('will not relay through a third party in the clear', async () => {
    await expect(open({ port: 3901, authenticated: true, server: 'http://relay.example' }))
      .rejects.toThrow(/plain http/)
    await expect(open({ port: 3901, authenticated: true, server: 'ws://relay.example' }))
      .rejects.toThrow(/plain http/)
  })

  it('allows a relay on this machine, which is not a third party', async () => {
    // Nothing is listening, so this fails on the connection rather than on the
    // policy -- which is the distinction being asserted.
    await expect(open({ port: 3901, authenticated: true, server: 'ws://127.0.0.1:1' }))
      .rejects.not.toThrow(/plain http/)
  })
})
