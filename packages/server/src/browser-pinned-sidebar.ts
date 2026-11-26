const pinRowSelector = '[data-section-id^="pinned-"] [data-sidebar-row]'

interface PinDrop {
  target: HTMLElement
  placement: 'before' | 'after'
}

interface PinDrag {
  pointerId: number
  link: HTMLAnchorElement
  row: HTMLElement
  x: number
  y: number
  started: boolean
}

interface PinnedSidebarOptions {
  root: HTMLElement
  reorder: (sessionId: number, targetSessionId: number, placement: PinDrop['placement']) => Promise<void>
}

/** Move the existing sidebar rows so their links and keyboard state remain owned by stx. */
export function createPinnedSidebar({ root, reorder }: PinnedSidebarOptions) {
  const document = root.ownerDocument
  const listeners = new AbortController()
  const options = { signal: listeners.signal }
  let drag: PinDrag | undefined
  let drop: PinDrop | undefined
  let suppressClick = false
  let saving = false

  function showDrop(next?: PinDrop): void {
    if (next?.target === drop?.target && next?.placement === drop?.placement) return
    drop?.target.removeAttribute('data-pin-insertion')
    drop = next
    drop?.target.setAttribute('data-pin-insertion', drop.placement)
  }

  function cancel(): void {
    const previous = drag
    drag = undefined
    showDrop()
    if (!previous) return
    previous.row.removeAttribute('data-pin-dragging')
    if (previous.link.hasPointerCapture(previous.pointerId)) previous.link.releasePointerCapture(previous.pointerId)
  }

  root.addEventListener('pointerdown', (event) => {
    if (drag) return
    suppressClick = false
    if (saving || event.button !== 0 || !event.isPrimary || event.pointerType === 'touch'
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return
    const link = event.target.closest<HTMLAnchorElement>('a[data-sidebar-item]')
    const row = link?.closest<HTMLElement>(pinRowSelector)
    if (!link || !row || !row.parentElement?.hasAttribute('data-pin-order-ready')
      || row.parentElement.querySelectorAll(':scope > [data-sidebar-row]').length < 2) return
    link.setPointerCapture(event.pointerId)
    drag = { pointerId: event.pointerId, link, row, x: event.clientX, y: event.clientY, started: false }
  }, options)

  root.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return
      drag.started = true
      suppressClick = true
      drag.row.setAttribute('data-pin-dragging', '')
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(pinRowSelector)
    if (!target || target === drag.row || target.parentElement !== drag.row.parentElement) {
      showDrop()
      return
    }
    const rect = target.getBoundingClientRect()
    showDrop({ target, placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' })
  }, options)

  root.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const sessionId = Number(drag.row.dataset.itemId)
    const intent = drop
    cancel()
    if (!intent) return
    saving = true
    void reorder(sessionId, Number(intent.target.dataset.itemId), intent.placement).finally(() => { saving = false })
  }, options)

  for (const type of ['pointercancel', 'lostpointercapture'] as const) {
    root.addEventListener(type, (event) => {
      if (drag?.pointerId === event.pointerId) cancel()
    }, options)
  }
  root.addEventListener('dragstart', (event) => {
    if (drag) event.preventDefault()
  }, options)
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

  return {
    receive(frame: unknown): boolean {
      const order = frame as { t?: string, profileId?: number, sessionIds?: number[] } | null
      if (order?.t !== 'pin-order') return false
      if (!Number.isSafeInteger(order.profileId) || !Array.isArray(order.sessionIds)) return true
      const group = root.querySelector(`[data-section-id="pinned-${order.profileId}"] > [role="group"]`)
      const rows = group && Array.from(group.querySelectorAll<HTMLElement>(':scope > [data-sidebar-row]'))
      if (!group || !rows || rows.length !== order.sessionIds.length) return true
      const byId = new Map(rows.map(row => [Number(row.dataset.itemId), row]))
      const sorted = order.sessionIds.map(id => byId.get(id))
      if (sorted.some(row => row === undefined)) return true
      group.setAttribute('data-pin-order-ready', '')
      if (sorted.every((row, index) => row === rows[index])) return true
      cancel()
      const focus = document.activeElement instanceof HTMLElement && group.contains(document.activeElement) ? document.activeElement : null
      const viewport = group.closest('[data-sidebar-scroll]')
      const scrollTop = viewport?.scrollTop ?? 0
      for (const [index, row] of sorted.entries()) {
        if (row && row !== group.children[index]) group.insertBefore(row, group.children[index] ?? null)
      }
      if (focus && document.activeElement !== focus) focus.focus({ preventScroll: true })
      if (viewport && viewport.scrollTop !== scrollTop) viewport.scrollTop = scrollTop
      return true
    },
    dispose() {
      cancel()
      listeners.abort()
    },
  }
}
