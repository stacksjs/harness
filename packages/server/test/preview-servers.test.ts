import { describe, expect, it } from 'bun:test'
import { parsePreviewListeners, terminalDescendants } from '../src/preview-servers'

describe('terminal listener ownership', () => {
  it('follows terminal descendants without adopting siblings or orphaned processes', () => {
    const table = '15 14\n 14 10\n 10 1\n 11 1\n 12 11\n 99 42\n'
    expect(terminalDescendants(table, [10, 42])).toEqual(new Set([10, 14, 15]))
    expect(terminalDescendants(table, [11])).toEqual(new Set([11, 12]))
  })

  it('preserves process identity for loopback and wildcard lsof listeners', () => {
    const table = [
      'p10', 'cserver', '\nf8', 'tIPv4', 'n*:5173', '\nf9', 'tIPv6', 'n*:5174', '\nf10', 'tIPv4', 'n192.168.0.1:8000',
      '\np11', 'cpid\np10', '\nf8', 'tIPv4', 'n127.0.0.1:4000', '',
    ].join('\0')
    expect(parsePreviewListeners(table, 'lsof')).toEqual([
      { url: 'http://127.0.0.1:5173/', label: 'server', pid: 10 },
      { url: 'http://[::1]:5174/', label: 'server', pid: 10 },
      { url: 'http://127.0.0.1:4000/', label: 'pid\np10', pid: 11 },
    ])
  })

  it('preserves multiple owners on ss entries and filters non-loopback binds', () => {
    const table = [
      'LISTEN 0 4096 *:5173 *:* users:(("other",pid=11,fd=9),("bun",pid=10,fd=8))',
      'LISTEN 0 4096 [::1]:5174 [::]:* users:(("bun",pid=10,fd=8))',
      'LISTEN 0 4096 [::1]:5175 [::]:* users:(("other",pid=11,fd=9))',
      'LISTEN 0 4096 [fe80::32]:3000 [::]:* users:(("bun",pid=10,fd=8))',
    ].join('\n')
    expect(parsePreviewListeners(table, 'ss', true)).toEqual([
      { url: 'http://[::1]:5173/', label: 'other', pid: 11 },
      { url: 'http://[::1]:5173/', label: 'bun', pid: 10 },
      { url: 'http://[::1]:5174/', label: 'bun', pid: 10 },
      { url: 'http://[::1]:5175/', label: 'other', pid: 11 },
    ])
  })
})
