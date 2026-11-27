import { describe, expect, it } from 'bun:test'
import { canEmbedBrowserPreview, navigatePreviewTab, previewAddress, restoreBrowserPreview, terminalPreviewAddress } from '../src/browser-preview'

const local = 'http://localhost:3973'

describe('workspace browser addresses', () => {
  it('keeps preview documents out of Android hosts with a frame-wide native interface', () => {
    expect(canEmbedBrowserPreview(null)).toBeFalse()
    expect(canEmbedBrowserPreview({})).toBeTrue()
    expect(canEmbedBrowserPreview({ craft: { platform: 'ios' } })).toBeTrue()
    expect(canEmbedBrowserPreview({ CraftAndroid: {} })).toBeFalse()
  })

  it('uses HTTP for bare loopback addresses and HTTPS for web addresses', () => {
    expect(previewAddress('localhost:5173/tasks?view=list', local)).toEqual({ url: 'http://localhost:5173/tasks?view=list' })
    expect(previewAddress('[::1]:5173/tasks', local)).toEqual({ url: 'http://[::1]:5173/tasks' })
    expect(previewAddress('example.com:8443/tasks', local)).toEqual({ url: 'https://example.com:8443/tasks' })
    expect(previewAddress('127.example.test', local)).toEqual({ url: 'https://127.example.test/' })
  })

  it.each([
    'javascript:alert(1)', 'file:///path', 'data:text/html,hello', 'https://user:pass@example.com',
    'http://localhost:3973/s/1', 'http://127.0.0.1:3973', 'http://127.1:3973', 'http://[::1]:3973',
    '/s/1', '//example.com', 'two words', 'https://example.com\\@localhost',
  ])('rejects an unsafe or invalid address %s', (address) => {
    expect(previewAddress(address, local)).toHaveProperty('error')
  })

  it('keeps loopback and insecure HTTP out of remote HTTPS previews', () => {
    const remote = 'https://harness.example.test'
    expect(previewAddress('localhost:5173', remote)).toHaveProperty('error')
    expect(previewAddress('http://dev.example.test', remote)).toHaveProperty('error')
    expect(previewAddress('https://dev.example.test', remote)).toEqual({ url: 'https://dev.example.test/' })
  })

  it('offers an in-app terminal destination only for another reachable local origin', () => {
    expect(terminalPreviewAddress('http://127.0.0.1:5173/fixture', local)).toBe('http://127.0.0.1:5173/fixture')
    expect(terminalPreviewAddress('http://127.0.0.1:3973/', local)).toBeNull()
    expect(terminalPreviewAddress('http://127.0.0.1:5173/', 'https://harness.example.test')).toBeNull()
    expect(terminalPreviewAddress('https://example.test/', local)).toBeNull()
  })

  it('revalidates saved addresses and repairs an invalid selected tab', () => {
    expect(restoreBrowserPreview({ tabs: [null, { id: 2, index: 19, history: ['javascript:alert(1)', 'localhost:5173', 'http://127.0.0.1:3973'] }], active: 3 }, local))
      .toEqual({ tabs: [{ id: 2, index: 0, history: ['http://localhost:5173/'] }], active: 2 })
  })

  it('preserves the previous address and drops forward history after a new navigation', () => {
    const tab = { id: 1, index: 0, history: ['http://localhost:5173/', 'http://localhost:5173/second'] }
    expect(navigatePreviewTab(tab, 'http://localhost:5173/third')).toEqual({
      id: 1, index: 1, history: ['http://localhost:5173/', 'http://localhost:5173/third'],
    })
    expect(navigatePreviewTab(tab, tab.history[0]!)).toBe(tab)
  })
})
