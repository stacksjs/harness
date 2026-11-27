import { Terminal, toHtml } from '@harness/ansi'
import { terminalPreviewAddress } from './browser-preview'

export interface TerminalTab {
  key: string
  started: boolean
}

type CloseAction = 'end' | 'restart'

interface PaneStatus {
  activity: string
  busy: boolean
  error: string
  exited: boolean
  reconnecting: boolean
  shell: string
}

interface Pane {
  tab: TerminalTab
  id: number | null
  model: Terminal | null
  status: PaneStatus
  pendingInput: string
  closing?: CloseAction
  following: boolean
  renderQueued: boolean
  selectionDeferred?: boolean
  layoutChanged?: boolean
}

type TerminalFrame =
  | { t: 'term-opened', termId: number, shell: string, cols: number, rows: number, checkpoint?: Parameters<typeof Terminal.fromCheckpoint>[0], exit?: { code: number | null }, openPreview?: string }
  | { t: 'term-data', termId: number, data: string }
  | { t: 'term-sized', termId: number, cols: number, rows: number }
  | { t: 'term-exit', termId: number, code: number | null }
  | { t: 'term-closed', termId: number }
  | { t: 'term-error', message: string, termId?: number }

interface TerminalDockOptions {
  workspaceId: number
  sessionId: number
  surface: () => HTMLElement | undefined
  visible: () => boolean
  online: () => boolean
  send: (frame: Record<string, unknown>) => boolean
  started: (key: string) => void
  closed: (key: string, action: CloseAction) => void
  updateStatus: (key: string, status: PaneStatus | null) => void
  openPreview?: (url: string) => void
  workspaceLinks?: boolean
}

const terminalHistory = { scrollback: 5000, scrollbackBytes: 8 * 1024 * 1024 }
const keys: Record<string, string> = {
  Enter: '\r', Backspace: '\x7F', Tab: '\t', Escape: '\x1B',
  ArrowUp: '\x1B[A', ArrowDown: '\x1B[B', ArrowRight: '\x1B[C', ArrowLeft: '\x1B[D',
  Home: '\x1B[H', End: '\x1B[F', PageUp: '\x1B[5~', PageDown: '\x1B[6~',
}
const navigationCodes: Record<string, string> = { Home: '1H', End: '1F', PageUp: '5~', PageDown: '6~' }

export function createTerminalDock(options: TerminalDockOptions) {
  const panes = new Map<string, Pane>()
  const detachedClosingPanes = new Map<number, Pane>()
  const scriptStarts = new Map<string, string>()
  // Old hosts reply to term-open without a correlation key. Submit one open
  // at a time. Once attached, every pane streams independently by PTY id.
  let opening: Pane | undefined
  let disposed = false
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
    for (const pane of panes.values()) resize(pane)
  })

  function paneFor(tab: TerminalTab): Pane {
    const current = panes.get(tab.key)
    if (current) return current
    const pane: Pane = {
      tab, id: null, model: null, pendingInput: '', following: true, renderQueued: false,
      status: { busy: false, activity: '', error: '', exited: false, reconnecting: false, shell: 'Terminal' },
    }
    panes.set(tab.key, pane)
    return pane
  }

  function host(key: string): HTMLElement | undefined {
    return Array.from(options.surface()?.querySelectorAll<HTMLElement>('[data-terminal-host]') ?? [])
      .find(element => element.dataset.terminalHost === key)
  }

  function output(key: string): HTMLElement | null | undefined {
    return host(key)?.querySelector<HTMLElement>('[data-terminal-screen]')
  }

  function selection(screen: HTMLElement): Selection | null {
    const current = screen.ownerDocument.getSelection()
    return current && !current.isCollapsed && screen.contains(current.anchorNode) && screen.contains(current.focusNode)
      ? current : null
  }

  function selectedText(key: string): string {
    const screen = output(key)
    return screen ? selection(screen)?.toString() ?? '' : ''
  }

  function selectAll(key: string): void {
    const screen = output(key)
    const current = screen?.ownerDocument.getSelection()
    if (!screen || !current || !screen.textContent) return
    const range = screen.ownerDocument.createRange()
    range.selectNodeContents(screen)
    current.removeAllRanges()
    current.addRange(range)
  }

  function scroll(key: string, move: 'start' | 'latest' | 'page-up' | 'page-down'): void {
    const viewport = host(key)
    const pane = panes.get(key)
    if (!viewport || !pane?.model) return
    if (move === 'latest') {
      const screen = output(key)
      if (screen) selection(screen)?.removeAllRanges()
      viewport.scrollTop = viewport.scrollHeight
    }
    else if (move === 'start') viewport.scrollTop = 0
    else viewport.scrollTop += (move === 'page-up' ? -1 : 1) * viewport.clientHeight
    pane.following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 25
  }

  function status(pane: Pane, changes: Partial<PaneStatus>): void {
    if (Object.entries(changes).every(([key, value]) => pane.status[key as keyof PaneStatus] === value)) return
    pane.status = { ...pane.status, ...changes }
    if (panes.get(pane.tab.key) === pane) options.updateStatus(pane.tab.key, pane.status)
  }

  function paint(pane: Pane): void {
    if (pane.renderQueued || !pane.model) return
    pane.renderQueued = true
    requestAnimationFrame(() => {
      pane.renderQueued = false
      if (panes.get(pane.tab.key) !== pane || !pane.model) return
      const viewport = host(pane.tab.key)
      const screen = viewport?.querySelector<HTMLElement>('[data-terminal-screen]')
      if (!viewport || !screen) return
      const focused = screen.ownerDocument.activeElement
      const link = focused?.matches('[data-terminal-link]') && screen.contains(focused) ? focused : null
      // Keep text selection during output. On resize, repaint a focused link
      // and move focus to the matching destination in its new layout.
      pane.selectionDeferred = Boolean(selection(screen) || (link && !pane.layoutChanged))
      if (pane.selectionDeferred) return
      const targetAttribute = link?.hasAttribute('data-terminal-file') ? 'data-terminal-file' : 'href'
      const target = link?.getAttribute(targetAttribute)
      const matchingLinks = () => [...screen.querySelectorAll<HTMLElement>('[data-terminal-link]')]
        .filter(candidate => candidate.getAttribute(targetAttribute) === target)
      const occurrence = link ? matchingLinks().findIndex(candidate => candidate === link) : -1
      pane.layoutChanged = false
      screen.innerHTML = toHtml(pane.model.snapshot(true), true, options.workspaceLinks === true)
      if (pane.following || pane.model.onAltScreen) viewport.scrollTop = viewport.scrollHeight
      if (link) (matchingLinks()[occurrence] ?? viewport).focus()
    })
  }

  function dimensions(pane: Pane): { cols: number, rows: number } | undefined {
    const viewport = host(pane.tab.key)
    const cell = viewport?.querySelector('[data-term-metric]')?.getBoundingClientRect()
    const box = viewport?.getBoundingClientRect()
    if (!cell?.width || !cell.height || !box?.width || !box.height) return
    return {
      cols: Math.min(500, Math.max(20, Math.floor((box.width - 20) / (cell.width / 10)))),
      rows: Math.min(200, Math.max(5, Math.floor((box.height - 16) / cell.height))),
    }
  }

  function resize(pane: Pane): void {
    if (pane.id === null || !pane.model || pane.status.exited || !options.visible()) return
    const size = dimensions(pane)
    if (size && (size.cols !== pane.model.cols || size.rows !== pane.model.rows))
      options.send({ t: 'term-resize', termId: pane.id, ...size })
  }

  function openNext(): void {
    if (disposed || opening || !options.online() || !options.visible()) return
    for (const pane of panes.values()) {
      if (pane.id !== null || pane.status.error || [...detachedClosingPanes.values()].some(closing => closing.tab.key === pane.tab.key)) continue
      const size = dimensions(pane) ?? { cols: 100, rows: 24 }
      const projectScriptId = scriptStarts.get(pane.tab.key)
      if (options.send({ t: 'term-open', workspaceId: options.workspaceId, sessionId: options.sessionId,
        resumeKey: pane.tab.key, ...size, ...(projectScriptId ? { projectScriptId } : pane.tab.started ? { resumeOnly: true } : {}) })) {
        scriptStarts.delete(pane.tab.key)
        opening = pane
        status(pane, { busy: true })
        return
      }
      status(pane, { reconnecting: false, error: 'The terminal could not connect to this host.' })
    }
  }

  function show(tabs: TerminalTab[]): void {
    const visible = new Set(tabs.map(tab => tab.key))
    observer?.disconnect()
    for (const [key, pane] of panes) {
      if (visible.has(key)) continue
      if (pane.id !== null) {
        if (pane.closing) detachedClosingPanes.set(pane.id, pane)
        else options.send({ t: 'term-detach', termId: pane.id })
      }
      panes.delete(key)
      scriptStarts.delete(key)
      options.updateStatus(key, null)
    }
    for (const tab of tabs) {
      const pane = paneFor(tab)
      pane.tab = tab
      const viewport = host(tab.key)
      if (viewport) observer?.observe(viewport)
      resize(pane)
      paint(pane)
    }
    openNext()
  }

  function sendInput(pane: Pane, data: string): void {
    if (!data || !options.online() || pane.status.reconnecting || pane.status.exited || pane.status.error || pane.closing) return
    const screen = output(pane.tab.key)
    if (screen) selection(screen)?.removeAllRanges()
    if (pane.id === null) pane.pendingInput += data
    else options.send({ t: 'term-input', termId: pane.id, data })
  }

  function exit(pane: Pane, code: number | null): void {
    pane.model?.write(`\r\n[exited${code === null ? '' : ` (${code})`}]`)
    pane.pendingInput = ''
    status(pane, { exited: true, activity: '' })
    paint(pane)
  }

  function activity(pane: Pane): void {
    const shell = pane.model?.shellActivity
    if (shell?.phase === 'running') status(pane, { activity: 'Running' })
    else if (shell?.phase === 'ready') status(pane, { activity: shell.lastExitStatus ? `Exit ${shell.lastExitStatus}` : 'Ready' })
  }

  function receive(frame: TerminalFrame): boolean {
    if (frame.t === 'term-error' && frame.termId !== undefined) {
      const pane = [...panes.values()].find(pane => pane.id === frame.termId)
      if (pane) {
        pane.closing = undefined
        status(pane, { busy: false, error: frame.message })
      }
      else if (detachedClosingPanes.delete(frame.termId)) {
        options.send({ t: 'term-detach', termId: frame.termId })
        openNext()
      }
      return true
    }
    if (frame.t === 'term-opened' || frame.t === 'term-error') {
      const pane = opening
      opening = undefined
      if (!pane) return true
      if (frame.t === 'term-opened') {
        options.started(pane.tab.key)
        const current = panes.get(pane.tab.key)
        if (current) current.tab = { ...current.tab, started: true }
      }
      if (panes.get(pane.tab.key) !== pane) {
        if (frame.t === 'term-opened') options.send({ t: 'term-detach', termId: frame.termId })
      }
      else if (frame.t === 'term-error') {
        pane.pendingInput = ''
        status(pane, { busy: false, reconnecting: false, error: frame.message })
      }
      else {
        pane.id = frame.termId
        if (typeof frame.openPreview === 'string') options.openPreview?.(frame.openPreview)
        if (pane.model) pane.layoutChanged = true
        pane.model = frame.checkpoint ? Terminal.fromCheckpoint(frame.checkpoint, terminalHistory)
          : new Terminal({ cols: frame.cols, rows: frame.rows, ...terminalHistory })
        status(pane, { busy: false, reconnecting: false, exited: false, activity: '', shell: frame.shell === 'den' ? 'Den terminal' : 'Terminal' })
        if (frame.exit) exit(pane, frame.exit.code)
        else {
          activity(pane)
          resize(pane)
          sendInput(pane, pane.pendingInput)
          pane.pendingInput = ''
          paint(pane)
        }
      }
      openNext()
      return true
    }
    if (frame.t !== 'term-data' && frame.t !== 'term-sized' && frame.t !== 'term-exit' && frame.t !== 'term-closed') return false
    const pane = [...panes.values()].find(pane => pane.id === frame.termId)
      ?? (frame.t === 'term-closed' ? detachedClosingPanes.get(frame.termId) : undefined)
    if (!pane) return true
    if (frame.t === 'term-closed') {
      detachedClosingPanes.delete(frame.termId)
      panes.delete(pane.tab.key)
      options.updateStatus(pane.tab.key, null)
      options.closed(pane.tab.key, pane.closing ?? 'end')
    }
    else if (frame.t === 'term-exit') exit(pane, frame.code)
    else {
      if (frame.t === 'term-sized') {
        pane.model?.resize(frame.cols, frame.rows)
        pane.layoutChanged = true
      }
      else {
        pane.model?.write(frame.data)
        activity(pane)
      }
      paint(pane)
    }
    return true
  }

  function onOffline(): void {
    const pending = opening
    opening = undefined
    detachedClosingPanes.clear()
    for (const pane of panes.values()) {
      const reattaching = pane === pending || pane.id !== null
      pane.id = null
      pane.closing = undefined
      pane.pendingInput = ''
      status(pane, { busy: false, reconnecting: reattaching })
    }
  }

  function close(key: string, action: CloseAction): void {
    const pane = panes.get(key)
    if (!pane || pane.id === null) {
      panes.delete(key)
      options.updateStatus(key, null)
      options.closed(key, action)
    }
    else if (options.send({ t: 'term-close', termId: pane.id })) {
      pane.closing = action
      status(pane, { busy: true })
    }
  }

  function keydown(tab: TerminalTab, event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return
    const pane = paneFor(tab)
    const key = event.key.toLowerCase()
    if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && !event.altKey && key === 'a') {
      event.preventDefault()
      selectAll(tab.key)
      return
    }
    if ((event.metaKey || (event.ctrlKey && event.shiftKey)) && (key === 'c' || key === 'v')) return
    const navigation = navigationCodes[event.key]
    if (pane.model && !pane.model.onAltScreen && event.shiftKey && !event.altKey) {
      const edge = (event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')
      const page = !event.ctrlKey && !event.metaKey && (event.key === 'PageUp' || event.key === 'PageDown')
      if (edge || page) {
        event.preventDefault()
        scroll(tab.key, edge ? (event.key === 'Home' ? 'start' : 'latest') : (event.key === 'PageUp' ? 'page-up' : 'page-down'))
        return
      }
    }
    if (pane.status.exited || pane.status.error || (event.metaKey && !(pane.model?.onAltScreen && navigation))) return
    let data = keys[event.key]
    const modifiers = 1 + Number(event.shiftKey) + 2 * Number(event.altKey) + 4 * Number(event.ctrlKey) + 8 * Number(event.metaKey)
    if (navigation && modifiers > 1) data = `\x1B[${navigation[0]};${modifiers}${navigation[1]}`
    else if (event.ctrlKey && event.key.length === 1) {
      const code = key.charCodeAt(0)
      data = code >= 97 && code <= 122 ? String.fromCharCode(code - 96) : ''
    }
    else if (event.key.length === 1) data = event.key
    if (!data) return
    event.preventDefault()
    sendInput(pane, data)
  }

  return {
    show, receive, onOffline, close, keydown,
    previewAddress: terminalPreviewAddress,
    selectedText, selectAll,
    visibleText(key: string) {
      const viewport = host(key)
      const screen = output(key)
      const height = viewport?.querySelector('[data-term-metric]')?.getBoundingClientRect().height
      if (!viewport || !height || !screen?.textContent) return ''
      const from = viewport.getBoundingClientRect().top + viewport.clientTop - screen.getBoundingClientRect().top
      const first = Math.max(0, Math.floor(from / height))
      const last = Math.ceil((from + viewport.clientHeight) / height)
      return screen.textContent.split('\n').slice(first, last).join('\n')
    },
    hasOutput: (key: string) => Boolean(output(key)?.textContent),
    jumpToLatest: (key: string) => scroll(key, 'latest'),
    selectionChanged() {
      for (const pane of panes.values()) {
        if (pane.selectionDeferred) paint(pane)
      }
    },
    queueProjectScript: (key: string, scriptId: string) => scriptStarts.set(key, scriptId),
    canEnd: (key: string) => panes.get(key)?.id != null && !panes.get(key)?.status.exited,
    focus: (key: string) => host(key)?.focus({ preventScroll: true }),
    input: (tab: TerminalTab, data: string) => sendInput(paneFor(tab), data),
    pasteText(key: string, text: string) {
      const pane = panes.get(key)
      if (text && pane?.model) sendInput(pane, pane.model.formatPaste(text))
    },
    canPaste(key: string) {
      const pane = panes.get(key)
      return Boolean(pane?.model && options.online() && !pane.status.reconnecting && !pane.status.exited && !pane.status.error && !pane.closing)
    },
    track(key: string, event: Event) {
      const pane = panes.get(key)
      const { scrollHeight, clientHeight, scrollTop } = event.currentTarget as HTMLElement
      if (pane) pane.following = scrollHeight - clientHeight - scrollTop < 25
    },
    dispose() {
      disposed = true
      observer?.disconnect()
      panes.clear()
      detachedClosingPanes.clear()
      scriptStarts.clear()
    },
  }
}
