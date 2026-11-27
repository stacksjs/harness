import type { ThreadDrop } from '@harness/contract'
import type { threadSidebarLayout } from './thread-sidebar'

const sectionSelector = '[data-sidebar-section], [data-arrangement-section]'
const threadRowSelector = '[data-sidebar-row]:has(a[data-sidebar-item][href^="/s/"])'
const targetRowSelector = `${threadRowSelector}, [data-arrangement-row]`
const threadIcons = ['i-hugeicons-message-01', 'i-hugeicons-loading-03', 'i-hugeicons-help-circle']
type ThreadLayout = ReturnType<typeof threadSidebarLayout>

interface SidebarDrop {
  marker: HTMLElement
  intent: ThreadDrop
  action: string
}

interface SidebarDrag {
  pointerId: number
  grip: HTMLElement
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
  arrangement?: HTMLDialogElement | null
  onLayout?: (profileId: number, layout: ThreadLayout) => void
  save: (sessionId: number, intent: ThreadDrop, fromArrangement: boolean) => Promise<void>
  rename: (sessionId: number, title: string) => Promise<void>
}

/** Reconcile the host snapshot using the stx-rendered sidebar controls. */
export function createThreadSidebar({ root, arrangement, onLayout, save, rename }: ThreadSidebarOptions) {
  const document = root.ownerDocument
  const listeners = new AbortController()
  const options = { signal: listeners.signal }
  const rowTemplate = root.querySelector<HTMLTemplateElement>('template[data-live-sidebar-row]')?.content.querySelector('[data-sidebar-row]')
  const projectTemplate = root.querySelector<HTMLTemplateElement>('template[data-live-sidebar-project]')?.content.querySelector('[data-sidebar-section]')
  const renameTemplate = root.querySelector<HTMLTemplateElement>('template[data-live-sidebar-rename]')?.content.querySelector('input')
  let editing: { row: HTMLElement, link: HTMLAnchorElement, input: HTMLInputElement, originalTitle: string } | undefined
  let reconciling = false
  let drag: SidebarDrag | undefined
  let drop: SidebarDrop | undefined
  let suppressClick = false
  let saving = false
  let scrollFrame = 0
  let latestLayout: ThreadLayout | undefined
  const preview = arrangement?.querySelector<HTMLElement>('[data-arrangement-preview]')
  const previewTitle = preview?.querySelector('[data-arrangement-preview-title]')
  const previewAction = preview?.querySelector('[data-arrangement-preview-action]')

  function showPreview(): void {
    if (!preview || !drag || drag.panel !== arrangement || !drag.started) return
    const title = drag.row.querySelector('[data-arrangement-title]')?.textContent ?? ''
    const action = drop?.action || (drop ? 'Move' : '')
    if (previewTitle && previewTitle.textContent !== title) previewTitle.textContent = title
    if (previewAction && previewAction.textContent !== action) previewAction.textContent = action
    preview.style.setProperty('--arrangement-preview-y', `${drag.y}px`)
    preview.hidden = false
  }

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
    if (preview) preview.hidden = true
    if (!previous) return
    previous.row.removeAttribute('data-pin-dragging')
    previous.panel.removeAttribute('data-shelf-dragging')
    previous.panel.removeAttribute('data-projectless-drop')
    if (previous.grip.hasPointerCapture(previous.pointerId)) previous.grip.releasePointerCapture(previous.pointerId)
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
    showPreview()
    scrollFrame = requestAnimationFrame(scrollAtEdge)
  }

  function dropAt(current: SidebarDrag, x: number, y: number): SidebarDrop | undefined {
    const hit = document.elementFromPoint(x, y)
    const section = hit?.closest<HTMLElement>(sectionSelector)
    if (!section || section.closest('[data-space], [data-thread-arrangement]') !== current.panel) return
    const id = section.dataset.sectionId ?? ''
    const origin = current.section.dataset.sectionId ?? ''
    const destination = id.startsWith('pinned-') ? 'pinned' : id.startsWith('settled-') ? 'settled'
      : id === current.row.dataset.threadActiveSection ? 'active' : undefined
    if (!destination || (destination === 'settled' && current.section === section)) return
    if (current.row.hasAttribute('data-arrangement-row') && current.row.dataset[destination === 'settled' ? 'canSettle' : destination === 'pinned' ? 'canPin' : 'canActivate'] === 'false') return
    const hitRow = hit?.closest<HTMLElement>(targetRowSelector)
    if (hitRow === current.row) return
    const marker = destination !== 'settled' && hitRow ? hitRow
      : section.querySelector<HTMLElement>('[data-sidebar-section-header], [data-arrangement-header]:not([hidden])')
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

  function bindPointers(surface: HTMLElement, fromArrangement: boolean): void {
    surface.addEventListener('pointerdown', (event) => {
      if (drag) return
      suppressClick = false
      if (saving || event.button !== 0 || !event.isPrimary || (!fromArrangement && event.pointerType === 'touch')
        || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return
      const grip = event.target.closest<HTMLElement>(fromArrangement ? '[data-arrangement-grip]:not(:disabled)' : 'a[data-sidebar-item][href^="/s/"]')
      const row = grip?.closest<HTMLElement>(targetRowSelector)
      const section = row?.closest<HTMLElement>(sectionSelector)
      const panel = section?.closest<HTMLElement>('[data-thread-order-ready]')
      if (!grip || !row || !section || !panel || !row.dataset.threadActiveSection || section.dataset.sectionId?.startsWith('working-')) return
      grip.setPointerCapture(event.pointerId)
      drag = { pointerId: event.pointerId, grip, row, section, panel, viewport: panel.querySelector('.stx-sidebar-scroll, [data-arrangement-scroll]'), x: event.clientX, y: event.clientY, started: false }
    }, options)

    surface.addEventListener('pointermove', (event) => {
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
      showPreview()
      if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollAtEdge)
    }, options)

    surface.addEventListener('pointerup', (event) => {
      if (!drag || event.pointerId !== drag.pointerId) return
      const sessionId = Number(drag.row.dataset.itemId)
      const intent = drop?.intent
      cancel()
      if (!intent) return
      saving = true
      void save(sessionId, intent, fromArrangement).finally(() => { saving = false })
    }, options)

    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      surface.addEventListener(type, (event) => {
        if (drag?.pointerId === event.pointerId) cancel()
      }, options)
    }
    surface.addEventListener('dragstart', (event) => { if (drag) event.preventDefault() }, options)
    surface.addEventListener('click', (event) => {
      if (!suppressClick || event.detail === 0) return
      suppressClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }, { ...options, capture: true })
  }
  bindPointers(root, false)
  if (arrangement) bindPointers(arrangement, true)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !drag?.started) return
    cancel()
    event.preventDefault()
    event.stopImmediatePropagation()
  }, { ...options, capture: true })

  function finishRename(commit: boolean, restoreFocus = false): void {
    if (!editing) return
    const { row, link, input, originalTitle } = editing
    editing = undefined
    input.remove()
    link.hidden = false
    if (restoreFocus && link.isConnected && !link.closest('[inert]')) link.focus({ preventScroll: true })
    const title = input.value.trim()
    if (commit && row.isConnected && title && title !== originalTitle && title !== link.dataset.label)
      void rename(Number(row.dataset.itemId), title)
  }

  root.addEventListener('keydown', (event) => {
    if (event.key !== 'F2' || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
      || !(event.target instanceof HTMLAnchorElement) || !event.target.matches('a[data-sidebar-item][href^="/s/"]')) return
    const link = event.target
    const row = link.closest<HTMLElement>(threadRowSelector)
    if (!row || !renameTemplate || row.closest('[inert]')) return
    event.preventDefault()
    event.stopPropagation()
    finishRename(true)
    const input = renameTemplate.cloneNode(true) as HTMLInputElement
    input.value = link.dataset.label ?? ''
    editing = { row, link, input, originalTitle: input.value }
    input.addEventListener('keydown', (key) => {
      key.stopPropagation()
      if (key.isComposing || key.keyCode === 229 || (key.key !== 'Enter' && key.key !== 'Escape')) return
      key.preventDefault()
      finishRename(key.key === 'Enter', true)
    })
    input.addEventListener('blur', () => { if (!reconciling && editing?.input === input) finishRename(true) })
    row.append(input)
    link.hidden = true
    input.focus({ preventScroll: true })
    input.select()
  }, options)

  function createProjectSection(summary: ThreadLayout[number]): HTMLElement | undefined {
    if (!summary.workspaceId || !projectTemplate) return
    const section = projectTemplate.cloneNode(true) as HTMLElement
    section.dataset.sectionId = summary.id
    const compose = section.querySelector<HTMLElement>('[data-sidebar-row]')
    if (compose) compose.dataset.itemId = `compose-${summary.workspaceId}`
    compose?.querySelector('a[data-sidebar-item]')?.setAttribute('href', `/?workspace=${summary.workspaceId}`)
    return section
  }

  function updateThreadRow(existing: HTMLElement | undefined, item: ThreadLayout[number]['rows'][number]): HTMLElement | undefined {
    const row = existing ?? rowTemplate?.cloneNode(true) as HTMLElement | undefined
    if (!row) return
    const link = row.querySelector<HTMLAnchorElement>('a[data-sidebar-item]')
    if (!link) return
    if (!existing) {
      row.dataset.itemId = String(item.id)
      link.setAttribute('href', `/s/${item.id}`)
    }
    row.dataset.threadActiveSection = item.activeSection
    if (link.dataset.label !== item.title) {
      link.dataset.label = item.title
      // Harness thread rows have no badge after the label.
      const label = link.lastElementChild
      if (label) label.textContent = item.title
    }
    if (link.title !== item.title) link.title = item.title
    const icon = link.querySelector('[data-sidebar-icon]')
    if (icon && item.icon && !icon.classList.contains(item.icon)) {
      icon.classList.remove(...threadIcons)
      icon.classList.add(item.icon)
    }
    return row
  }

  function applyOrder(panel: HTMLElement, layout: ThreadLayout): void {
    const focus = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement) ? document.activeElement : null
    const focusSection = focus?.closest(sectionSelector)
    const viewport = panel.querySelector('.stx-sidebar-scroll')
    if (!viewport) return
    const scrollTop = viewport.scrollTop
    const sections = new Map(Array.from(panel.querySelectorAll<HTMLElement>(sectionSelector), section => [section.dataset.sectionId, section]))
    const rows = new Map(Array.from(panel.querySelectorAll<HTMLElement>(threadRowSelector), row => [Number(row.dataset.itemId), row]))

    let nextSection = viewport.querySelector('[data-sidebar-section]')
    for (const summary of layout) {
      const section = sections.get(summary.id) ?? createProjectSection(summary)
      const group = section?.querySelector<HTMLElement>(':scope > [role="group"]')
      if (!section || !group) continue
      sections.delete(summary.id)
      if (section !== nextSection) {
        if (drag) cancel()
        viewport.insertBefore(section, nextSection)
      }
      nextSection = section.nextElementSibling
      const collapsed = section.dataset.expanded === 'false'
      group.toggleAttribute('data-pin-order-ready', summary.id.startsWith('pinned-'))
      const label = section.querySelector('[data-sidebar-section-header] > span')
      if (label && label.textContent !== summary.label) label.textContent = summary.label
      if (group.getAttribute('aria-label') !== summary.label) group.setAttribute('aria-label', summary.label)
      let next = group.querySelector(threadRowSelector)
      for (const item of summary.rows) {
        const row = updateThreadRow(rows.get(item.id), item)
        if (!row) continue
        rows.delete(item.id)
        if (row !== next) {
          if (drag) cancel()
          group.insertBefore(row, next)
        }
        row.toggleAttribute('data-collapsed', collapsed)
        row.toggleAttribute('inert', collapsed)
        next = row.nextElementSibling
      }
    }
    for (const row of rows.values()) {
      if (drag?.row === row) cancel()
      if (editing?.row === row) finishRename(false)
      row.remove()
    }
    for (const section of sections.values()) {
      if (drag?.section === section) cancel()
      section.remove()
    }
    if (focus && (document.activeElement !== focus || focus.closest('[inert]'))) {
      if (focus.isConnected && !focus.closest('[inert]')) focus.focus({ preventScroll: true })
      else {
        if (editing?.input === focus) finishRename(false)
        const header = (focus.closest(sectionSelector) ?? focusSection)?.querySelector<HTMLElement>('[data-sidebar-section-header]')
        const target = header?.getClientRects().length ? header : root.querySelector<HTMLElement>('[data-nav-search]')
        target?.focus({ preventScroll: true })
      }
    }
    if (viewport.scrollTop !== scrollTop) viewport.scrollTop = scrollTop
    panel.setAttribute('data-thread-order-ready', '')
  }

  return {
    receive(frame: unknown): boolean {
      const order = frame as { t?: string, profileId?: number, sections?: ThreadLayout } | null
      if (order?.t !== 'sidebar-order') return false
      if (!Number.isSafeInteger(order.profileId) || !Array.isArray(order.sections)) return true
      const panel = root.querySelector<HTMLElement>(`[data-space-id="${order.profileId}"]:not([data-space-deferred])`)
      if (panel) {
        reconciling = true
        try { applyOrder(panel, order.sections) }
        finally { reconciling = false }
      }
      if (drag && drag.panel === arrangement && JSON.stringify(latestLayout) !== JSON.stringify(order.sections)) cancel()
      latestLayout = order.sections
      onLayout?.(order.profileId!, order.sections)
      return true
    },
    cancelArrangement() {
      if (drag && drag.panel === arrangement) cancel()
    },
    dispose() {
      cancel()
      finishRename(false)
      listeners.abort()
    },
  }
}
