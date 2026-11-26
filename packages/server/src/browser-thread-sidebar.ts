import type { ThreadDrop } from '@harness/contract'
import type { threadSidebarLayout } from './thread-sidebar'

const sectionSelector = '[data-sidebar-section]'
const threadRowSelector = '[data-sidebar-row]:has(a[data-sidebar-item][href^="/s/"])'

interface SidebarDrop {
  marker: HTMLElement
  intent: ThreadDrop
  action: string
}

interface SidebarDrag {
  pointerId: number
  link: HTMLAnchorElement
  row: HTMLElement
  section: HTMLElement
  panel: HTMLElement
  viewport: HTMLElement | null
  x: number
  y: number
  started: boolean
}

interface ThreadSidebarOptions {
  root: HTMLElement
  save: (sessionId: number, intent: ThreadDrop) => Promise<void>
}

/** Move existing sidebar rows so their links and keyboard state remain owned by stx. */
export function createThreadSidebar({ root, save }: ThreadSidebarOptions) {
  const document = root.ownerDocument
  const listeners = new AbortController()
  const options = { signal: listeners.signal }
  const removedRows = new Map<HTMLElement, Map<number, HTMLElement>>()
  let drag: SidebarDrag | undefined
  let drop: SidebarDrop | undefined
  let suppressClick = false
  let saving = false
  let scrollFrame = 0

  function showDrop(next?: SidebarDrop): void {
    if (next?.marker === drop?.marker && next?.intent.anchor?.placement === drop?.intent.anchor?.placement) return
    drop?.marker.removeAttribute('data-pin-insertion')
    drop?.marker.removeAttribute('data-shelf-action')
    drop = next
    drop?.marker.setAttribute('data-pin-insertion', drop.intent.anchor?.placement ?? 'after')
    if (drop?.action) drop.marker.setAttribute('data-shelf-action', drop.action)
  }

  function cancel(): void {
    cancelAnimationFrame(scrollFrame)
    scrollFrame = 0
    const previous = drag
    drag = undefined
    showDrop()
    if (!previous) return
    previous.row.removeAttribute('data-pin-dragging')
    previous.panel.removeAttribute('data-shelf-dragging')
    previous.panel.removeAttribute('data-projectless-drop')
    if (previous.link.hasPointerCapture(previous.pointerId)) previous.link.releasePointerCapture(previous.pointerId)
  }

  function scrollAtEdge(): void {
    scrollFrame = 0
    const viewport = drag?.viewport
    if (!drag || !viewport) return
    const { x, y } = drag
    const bounds = viewport.getBoundingClientRect()
    if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return
    const top = Math.max(0, bounds.top + 30 - y)
    const bottom = Math.max(0, y - bounds.bottom + 30)
    const previous = viewport.scrollTop
    viewport.scrollTop += (bottom - top) * 0.25
    if (viewport.scrollTop === previous) return
    showDrop(dropAt(drag, x, y))
    scrollFrame = requestAnimationFrame(scrollAtEdge)
  }

  function dropAt(current: SidebarDrag, x: number, y: number): SidebarDrop | undefined {
    const hit = document.elementFromPoint(x, y)
    const section = hit?.closest<HTMLElement>(sectionSelector)
    if (!section || section.closest('[data-space]') !== current.panel) return
    const id = section.dataset.sectionId ?? ''
    const origin = current.section.dataset.sectionId ?? ''
    const destination = id.startsWith('pinned-') ? 'pinned' : id.startsWith('settled-') ? 'settled'
      : id === current.row.dataset.threadActiveSection ? 'active' : undefined
    if (!destination || (destination === 'settled' && current.section === section)) return
    const hitRow = hit?.closest<HTMLElement>(threadRowSelector)
    if (hitRow === current.row) return
    const marker = destination !== 'settled' && hitRow ? hitRow
      : section.querySelector<HTMLElement>('[data-sidebar-section-header]')
    if (!marker) return
    const action = current.section === section ? '' : destination === 'pinned' ? 'Pin' : destination === 'settled' ? 'Settle'
      : origin.startsWith('pinned-') ? 'Unpin' : origin.startsWith('snoozed-') ? 'Wake' : 'Un-settle'
    const intent: ThreadDrop = { destination }
    if (marker === hitRow) {
      const rect = marker.getBoundingClientRect()
      intent.anchor = { sessionId: Number(marker.dataset.itemId), placement: y < rect.top + rect.height / 2 ? 'before' : 'after' }
    }
    return { marker, intent, action }
  }

  root.addEventListener('pointerdown', (event) => {
    if (drag) return
    suppressClick = false
    if (saving || event.button !== 0 || !event.isPrimary || event.pointerType === 'touch'
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return
    const link = event.target.closest<HTMLAnchorElement>('a[data-sidebar-item][href^="/s/"]')
    const row = link?.closest<HTMLElement>('[data-sidebar-row]')
    const section = row?.closest<HTMLElement>(sectionSelector)
    const panel = section?.closest<HTMLElement>('[data-thread-order-ready]')
    if (!link || !row || !section || !panel || !row.dataset.threadActiveSection || section.dataset.sectionId?.startsWith('working-')) return
    link.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, link, row, section, panel, viewport: panel.querySelector('.stx-sidebar-scroll'), x: event.clientX, y: event.clientY, started: false }
  }, options)

  root.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
      drag.started = true
      suppressClick = true
      drag.row.setAttribute('data-pin-dragging', '')
      drag.panel.setAttribute('data-shelf-dragging', '')
      drag.panel.toggleAttribute('data-projectless-drop', drag.row.dataset.threadActiveSection?.startsWith('projectless-'))
    }
    drag.x = event.clientX
    drag.y = event.clientY
    showDrop(dropAt(drag, drag.x, drag.y))
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollAtEdge)
  }, options)

  root.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const sessionId = Number(drag.row.dataset.itemId)
    const intent = drop?.intent
    cancel()
    if (!intent) return
    saving = true
    void save(sessionId, intent).finally(() => { saving = false })
  }, options)

  for (const type of ['pointercancel', 'lostpointercapture'] as const) {
    root.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) cancel()
    }, options)
  }
  root.addEventListener('dragstart', (event) => { if (drag) event.preventDefault() }, options)
  root.addEventListener('click', (event) => {
    if (!suppressClick || event.detail === 0) return
    suppressClick = false
    event.preventDefault()
    event.stopImmediatePropagation()
  }, { ...options, capture: true })
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !drag?.started) return
    cancel()
    event.preventDefault()
    event.stopImmediatePropagation()
  }, { ...options, capture: true })

  function applyOrder(panel: HTMLElement, layout: ReturnType<typeof threadSidebarLayout>): void {
    const focus = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : null
    const viewport = panel.querySelector('.stx-sidebar-scroll')
    const scrollTop = viewport?.scrollTop ?? 0
    const sections = new Map(Array.from(panel.querySelectorAll<HTMLElement>(sectionSelector), section => [section.dataset.sectionId, section]))
    const kept = removedRows.get(panel) ?? new Map<number, HTMLElement>()
    removedRows.set(panel, kept)
    const rows = new Map(kept)
    for (const row of panel.querySelectorAll<HTMLElement>(threadRowSelector)) rows.set(Number(row.dataset.itemId), row)

    for (const summary of layout) {
      const section = sections.get(summary.id)
      const group = section?.querySelector<HTMLElement>(':scope > [role="group"]')
      if (!section || !group) continue
      const collapsed = section.dataset.expanded === 'false'
      group.toggleAttribute('data-pin-order-ready', summary.id.startsWith('pinned-'))
      if (summary.id.startsWith('settled-')) {
        const label = section.querySelector('[data-sidebar-section-header] > span')
        if (label && label.textContent !== summary.label) label.textContent = summary.label
        if (group.getAttribute('aria-label') !== summary.label) group.setAttribute('aria-label', summary.label)
      }
      let next = group.querySelector(threadRowSelector)
      for (const item of summary.rows) {
        const row = rows.get(item.id)
        if (!row) continue
        rows.delete(item.id)
        kept.delete(item.id)
        row.dataset.threadActiveSection = item.activeSection
        if (row !== next) {
          if (drag) cancel()
          group.insertBefore(row, next)
        }
        row.toggleAttribute('data-collapsed', collapsed)
        row.toggleAttribute('inert', collapsed)
        next = row.nextElementSibling
      }
    }
    // A section for a newly registered project may not have been rendered yet.
    const stillVisible = new Set(layout.flatMap(section => section.rows.map(item => item.id)))
    for (const [id, row] of rows) {
      if (stillVisible.has(id) || !row.isConnected) continue
      if (drag?.row === row) cancel()
      kept.set(id, row)
      row.remove()
    }
    if (focus && document.activeElement !== focus) {
      if (focus.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true })
      else if (focus.isConnected) focus.closest(sectionSelector)?.querySelector<HTMLElement>('[data-sidebar-section-header]')?.focus({ preventScroll: true })
    }
    if (viewport && viewport.scrollTop !== scrollTop) viewport.scrollTop = scrollTop
    panel.setAttribute('data-thread-order-ready', '')
  }

  return {
    receive(frame: unknown): boolean {
      const order = frame as { t?: string, profileId?: number, sections?: ReturnType<typeof threadSidebarLayout> } | null
      if (order?.t !== 'sidebar-order') return false
      if (!Number.isSafeInteger(order.profileId) || !Array.isArray(order.sections)) return true
      const panel = root.querySelector<HTMLElement>(`[data-space-id="${order.profileId}"]:not([data-space-deferred])`)
      if (panel) applyOrder(panel, order.sections)
      return true
    },
    dispose() {
      cancel()
      listeners.abort()
    },
  }
}
