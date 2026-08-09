import { describe, expect, it } from 'bun:test'
import type { McpServer } from '../src/mcp'
import { interpolate, missingReferences, resolveForDriver } from '../src/mcp'

/**
 * The security property these mostly protect: a live credential must never
 * reach the event log. The log is plaintext SQLite that exists to be replayed
 * and inspected, so a token written into it is a token you cannot take back.
 */

const stdio = (over: Partial<McpServer> = {}): McpServer => ({
  name: 'files', transport: 'stdio', command: 'mcp-files', enabled: true, ...over,
})

describe('resolving references', () => {
  it('substitutes from the environment', () => {
    expect(interpolate('Bearer ${TOKEN}', { TOKEN: 'abc123' })).toBe('Bearer abc123')
  })

  it('resolves an unset variable to empty rather than leaving the reference', () => {
    // Leaving `${TOKEN}` would send that literal string as a bearer token, and
    // the server would complain about authentication instead of configuration.
    expect(interpolate('Bearer ${TOKEN}', {})).toBe('Bearer ')
  })

  it('leaves text that is not a reference alone', () => {
    expect(interpolate('$HOME and {braces} and $ {spaced}', {})).toBe('$HOME and {braces} and $ {spaced}')
  })

  it('handles several in one value', () => {
    expect(interpolate('${A}/${B}', { A: 'x', B: 'y' })).toBe('x/y')
  })
})

describe('reporting what is missing', () => {
  it('names every unset variable a server needs', () => {
    // The actionable message. Without it the failure surfaces from inside the
    // MCP server as an auth error, which sends you to the wrong place.
    const server = stdio({ env: { TOKEN: '${GITHUB_TOKEN}' }, args: ['--key', '${API_KEY}'] })

    expect(missingReferences(server, {}).sort()).toEqual(['API_KEY', 'GITHUB_TOKEN'])
  })

  it('says nothing when the environment has them', () => {
    const server = stdio({ env: { TOKEN: '${GITHUB_TOKEN}' } })

    expect(missingReferences(server, { GITHUB_TOKEN: 'x' })).toEqual([])
  })

  it('treats an empty string as present', () => {
    // Deliberately empty is a choice; unset is a mistake.
    expect(missingReferences(stdio({ env: { T: '${X}' } }), { X: '' })).toEqual([])
  })

  it('checks urls and headers too', () => {
    const server: McpServer = {
      name: 'api', transport: 'http', url: 'https://${HOST}/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' }, enabled: true,
    }

    expect(missingReferences(server, {}).sort()).toEqual(['HOST', 'TOKEN'])
  })
})

describe('preparing servers for a driver', () => {
  it('resolves a stdio server', () => {
    const resolved = resolveForDriver([stdio({ args: ['--root', '${HOME}'], env: { KEY: '${SECRET}' } })], {
      HOME: '/Users/x', SECRET: 's3cret',
    })

    expect(resolved).toEqual([{
      name: 'files', type: 'stdio', command: 'mcp-files',
      args: ['--root', '/Users/x'], env: { KEY: 's3cret' },
    }])
  })

  it('resolves an http server', () => {
    const resolved = resolveForDriver([{
      name: 'api', transport: 'http', url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer ${TOKEN}' }, enabled: true,
    }], { TOKEN: 'abc' })

    expect(resolved).toEqual([{
      name: 'api', type: 'http', url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer abc' },
    }])
  })

  it('drops a disabled server entirely', () => {
    // Not passed along disabled: the point of the switch is that the agent
    // never sees the tools, and a provider that ignored the flag would offer
    // them anyway.
    expect(resolveForDriver([stdio({ enabled: false })])).toEqual([])
  })

  it('drops a stdio server with no command', () => {
    // It cannot start, and handing it over turns a configuration mistake into a
    // provider error several layers from the cause.
    expect(resolveForDriver([stdio({ command: undefined })])).toEqual([])
  })

  it('drops an http server with no url', () => {
    expect(resolveForDriver([{ name: 'api', transport: 'http', enabled: true }])).toEqual([])
  })

  it('keeps the healthy ones when a neighbour is broken', () => {
    // One bad entry must not cost the agent every other tool it has.
    const resolved = resolveForDriver([stdio({ name: 'broken', command: undefined }), stdio({ name: 'good' })])

    expect(resolved.map(s => s.name)).toEqual(['good'])
  })

  it('never carries a reference through unresolved', () => {
    // The failure that would send `${TOKEN}` to a server as a literal.
    const resolved = resolveForDriver([stdio({ env: { KEY: '${NOPE}' } })], {})

    expect(JSON.stringify(resolved)).not.toContain('${')
  })
})

describe('what the guarantee covers', () => {
  it('keeps the reference out of the resolved config only at the edge', () => {
    // The property: harness stores `${VAR}` and resolves it at spawn, so the
    // log holds the reference and the process holds the value.
    const stored = stdio({ env: { TOKEN: '${SECRET}' } })
    const resolved = resolveForDriver([stored], { SECRET: 's3cret' })

    // What gets written down.
    expect(JSON.stringify(stored)).toContain('${SECRET}')
    expect(JSON.stringify(stored)).not.toContain('s3cret')
    // What the agent's process gets.
    expect(JSON.stringify(resolved)).toContain('s3cret')
  })
})
