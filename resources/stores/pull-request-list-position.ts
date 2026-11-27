type ScrollPosition = { top: number, anchor?: string, offset?: number }
type ListPosition = ScrollPosition & { scope: string, range: string }
type NavigationPosition = { address: string, expires: number, position: ListPosition, focus: boolean }

const POSITION_KEY = 'harness.pr-list-position.v1'
const VISITS_KEY = 'harness.pr-list-visits.v1'

export function pullRequestListPosition(browser: Window, pane: HTMLElement, scope: () => string) {
  let last: ScrollPosition = { top: 0 }
  let timer: ReturnType<typeof setTimeout> | undefined
  const range = () => {
    const params = new URLSearchParams(browser.location.search)
    return (params.get('page') ?? '1') + ':' + (params.get('through') ?? '')
  }
  const rows = () => Array.from(pane.querySelectorAll<HTMLElement>('[data-pr-entry]'))
  const address = () => browser.location.pathname + browser.location.search
  const visits = (): [string, ListPosition][] => JSON.parse(browser.sessionStorage.getItem(VISITS_KEY) ?? '[]')
  const position = (): ListPosition => {
    if (pane.getClientRects().length) {
      const top = pane.getBoundingClientRect().top
      const anchor = rows().find(row => row.getBoundingClientRect().bottom > top)
      last = { top: pane.scrollTop, anchor: anchor?.getAttribute('data-pr-entry') ?? undefined,
        offset: anchor ? anchor.getBoundingClientRect().top - top : undefined }
    }
    return { ...last, scope: scope(), range: range() }
  }

  function save() {
    clearTimeout(timer)
    const current = position()
    try {
      browser.history.replaceState({ ...browser.history.state, [POSITION_KEY]: current }, '')
    }
    catch { /* Temporary browser storage can be unavailable. */ }
    // Some WebKit navigations restore the rewritten URL without its state.
    try {
      const key = address()
      const recent = visits().filter(([visited]) => visited !== key).slice(0, 7)
      browser.sessionStorage.setItem(VISITS_KEY, JSON.stringify([[key, current], ...recent]))
    }
    catch { /* The current history entry may still be available. */ }
  }

  return {
    save,
    scrolled() {
      clearTimeout(timer)
      timer = setTimeout(save, 180)
    },
    remember(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!link || link.target && link.target !== '_self'
        || !link.matches('[data-pr-entry], [data-pr-restore], [data-pr-workspace-detail] a[href^="/pull-requests?"]')) return
      const target = new URL(link.href, browser.location.href)
      if (target.origin !== browser.location.origin || target.pathname !== '/pull-requests') return
      save()
      try {
        const handoff: NavigationPosition = { address: target.pathname + target.search, expires: Date.now() + 120_000,
          position: position(), focus: event.detail === 0 }
        browser.sessionStorage.setItem(POSITION_KEY, JSON.stringify(handoff))
      }
      catch { /* Navigation still works when browser storage is unavailable. */ }
    },
    restore() {
      let saved: ListPosition | undefined = browser.history.state?.[POSITION_KEY]
      let focus = false
      try {
        const raw = browser.sessionStorage.getItem(POSITION_KEY)
        browser.sessionStorage.removeItem(POSITION_KEY)
        const handoff: NavigationPosition | null = raw ? JSON.parse(raw) : null
        if (!saved && handoff && handoff.expires > Date.now() && handoff.address === address()) {
          saved = handoff.position
          focus = handoff.focus
        }
        saved ??= visits().find(([visited]) => visited === address())?.[1]
      }
      catch { /* State can still be restored from browser history. */ }
      if (saved?.scope !== scope() || saved.range !== range() || !Number.isFinite(saved.top) || saved.top < 0) return
      last = saved
      if (pane.getClientRects().length) {
        const bounds = pane.getBoundingClientRect()
        const anchor = saved.anchor && rows().find(row => row.getAttribute('data-pr-entry') === saved.anchor)
        pane.scrollTop = anchor && typeof saved.offset === 'number' && Number.isFinite(saved.offset)
          ? pane.scrollTop + anchor.getBoundingClientRect().top - bounds.top - saved.offset
          : saved.top
        if (focus) {
          const visible = rows().filter((row) => {
            const rect = row.getBoundingClientRect()
            return rect.top >= bounds.top && rect.bottom <= bounds.bottom
          })
          const row = visible.find(item => item.hasAttribute('aria-current')) ?? visible[0]
          row?.focus({ preventScroll: true })
        }
      }
      else if (focus) pane.ownerDocument.querySelector<HTMLElement>('#pr-detail-title')?.focus({ preventScroll: true })
      save()
    },
    reset() {
      last = { top: 0 }
      pane.scrollTop = 0
      save()
    },
  }
}
