export interface PreviewTab {
  id: number
  history: string[]
  index: number
}

export interface BrowserPreview {
  tabs: PreviewTab[]
  active: number
}

export interface PreviewServer {
  url: string
  label: string
}

export interface PreviewServerSnapshot {
  status: 'ready' | 'unavailable'
  servers: PreviewServer[]
}

export const MAX_PREVIEW_TABS = 12
const MAX_HISTORY = 30

function loopback(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d+){3}$/u.test(host) || host === '[::1]'
}

export function previewAddress(input: string, owner: string): { url: string } | { error: string } {
  const address = input.trim()
  if (!address || address.length > 4096 || /[\u0000-\u0020\u007F\\]/u.test(address)) return { error: 'Enter a website address.' }
  const local = /^(?:(?:[a-z\d-]+\.)*localhost|127(?:\.\d+){3}|\[::1\])(?=[:/#?]|$)/iu.test(address)
  const hasPort = /^(?:[a-z\d.-]+|\[[\da-f:]+\]):\d+(?=[/#?]|$)/iu.test(address)
  const hasScheme = /^[a-z][a-z\d+.-]*:/iu.test(address) && !local && !hasPort
  try {
    const url = new URL(hasScheme ? address : `${local ? 'http' : 'https'}://${address}`)
    const harness = new URL(owner)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || address.startsWith('/'))
      return { error: 'Use an HTTP or HTTPS address without credentials.' }
    if (url.origin === harness.origin || (loopback(harness.hostname) && loopback(url.hostname)
      && (url.port || (url.protocol === 'https:' ? '443' : '80')) === (harness.port || (harness.protocol === 'https:' ? '443' : '80'))))
      return { error: 'Open Harness in its main window.' }
    if (loopback(url.hostname) && !loopback(harness.hostname))
      return { error: 'This address points to the current device. Use a server address this device can reach.' }
    if (harness.protocol === 'https:' && url.protocol === 'http:' && !loopback(url.hostname))
      return { error: 'Use HTTPS to open this site inside Harness.' }
    return { url: url.href }
  }
  catch { return { error: 'Enter a valid website address.' } }
}

export function restoreBrowserPreview(value: unknown, owner: string): BrowserPreview {
  if (typeof value === 'object' && value !== null && 'tabs' in value && Array.isArray(value.tabs)) {
    const tabs: PreviewTab[] = []
    for (const tab of value.tabs.slice(0, MAX_PREVIEW_TABS)) {
      if (!tab || !Number.isSafeInteger(tab.id) || tab.id < 1 || tabs.some(entry => entry.id === tab.id) || !Array.isArray(tab.history)) continue
      const history = tab.history.slice(-MAX_HISTORY).flatMap((address: unknown) => {
        if (typeof address !== 'string') return []
        const result = previewAddress(address, owner)
        return 'url' in result ? [result.url] : []
      })
      const index = Number.isInteger(tab.index) ? Math.max(0, Math.min(tab.index, history.length - 1)) : 0
      tabs.push({ id: tab.id, history, index })
    }
    if (tabs.length) return { tabs, active: 'active' in value && tabs.some(tab => tab.id === value.active) ? Number(value.active) : tabs[0]!.id }
  }
  return { tabs: [{ id: 1, history: [], index: 0 }], active: 1 }
}

export function navigatePreviewTab(tab: PreviewTab, url: string): PreviewTab {
  if (tab.history[tab.index] === url) return tab
  const history = [...tab.history.slice(0, tab.index + 1), url].slice(-MAX_HISTORY)
  return { ...tab, history, index: history.length - 1 }
}

export function reloadPreviewFrame(pane: HTMLElement | null, id: number): void {
  const frame = pane?.querySelector<HTMLIFrameElement>(`iframe[data-preview-frame="${id}"]`)
  if (frame) frame.src = frame.src
}

export function watchPreviewServers(sessionId: number, changed: (snapshot: PreviewServerSnapshot) => void): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let previous = ''
  async function refresh() {
    let snapshot: PreviewServerSnapshot = { status: 'unavailable', servers: [] }
    try {
      const response = await fetch(`/s/${sessionId}/preview-servers`, { cache: 'no-store', signal: controller.signal })
      if (response.ok) snapshot = await response.json() as PreviewServerSnapshot
    }
    catch { /* A closed pane aborts its request. Network failures can recover on the next refresh. */ }
    if (controller.signal.aborted) return
    const key = JSON.stringify(snapshot)
    if (previous !== key) { previous = key; changed(snapshot) }
    timer = setTimeout(() => void refresh(), 3000)
  }
  void refresh()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}
