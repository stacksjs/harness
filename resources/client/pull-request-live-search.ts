import { pullRequestListPosition } from './pull-request-list-position'

type SearchResult = {
  html: string
  scope: string
  search: string
  draft: string
  filterCount: number
  partial: boolean
}

const SEARCH_DELAY_MS = 250
const MAX_LOADED_ROWS = 500
const GROUP_ORDER = ['authored', 'reviewing', 'other', 'filtered']
const REVIEW_KEYS = ['selectedUrl', 'selectionProfile', 'tab', 'detailPage', 'reviewHead', 'reviewBase', 'reviewLine', 'reviewStart',
  'conversation', 'commentScope', 'commentsAfter', 'commentsBefore', 'commentsLatest'] as const
const SEARCH_FIELDS = new Set(['q', 'shownDraft', 'chooseDraft', ...REVIEW_KEYS])

function listFormScope(form: HTMLFormElement) {
  const data = new FormData(form)
  const scope = Array.from(data).filter(([key]) => !SEARCH_FIELDS.has(key))
  if (data.get('chooseDraft') !== data.get('shownDraft')) scope.push(['chooseDraft', data.get('chooseDraft') ?? ''])
  return JSON.stringify(scope)
}

export function withCurrentPullRequestQuery(address: string, current: Location) {
  const target = new URL(address, current.href)
  if (target.origin !== current.origin || !/^\/pull-requests(?:\/|$)/u.test(target.pathname)) return address
  const list = new URLSearchParams(current.search)
  for (const key of ['q', 'page', 'through']) {
    const value = list.get(key)
    if (value) target.searchParams.set(key, value)
    else target.searchParams.delete(key)
  }
  return target.pathname + target.search + target.hash
}

function appendPullRequestPage(current: Element, incoming: Element, link: HTMLAnchorElement, keyboard: boolean, partial: boolean) {
  const loaded = new Set(Array.from(current.querySelectorAll('[data-pr-entry]'), row => row.getAttribute('data-pr-entry')))
  const newRows = Array.from(incoming.querySelectorAll('[data-pr-entry]')).filter(row => !loaded.has(row.getAttribute('data-pr-entry')))
  if (loaded.size + newRows.length > MAX_LOADED_ROWS) return false

  const pagination = link.closest('[data-pr-result-pages]')
  for (const list of incoming.querySelectorAll('[data-pr-group]')) {
    const group = list.getAttribute('data-pr-group') ?? ''
    const rows = Array.from(list.children).filter((item) => {
      const row = item.querySelector('[data-pr-entry]')
      const key = row?.getAttribute('data-pr-entry')
      if (!key || loaded.has(key)) return false
      loaded.add(key)
      return true
    })
    if (!rows.length) continue
    const currentGroups = Array.from(current.querySelectorAll('[data-pr-group]'))
    const existing = currentGroups.find(node => node.getAttribute('data-pr-group') === group)
    if (existing) {
      existing.append(...rows)
      const count = existing.previousElementSibling?.querySelector('[data-pr-group-count]')
      if (count) count.textContent = String(existing.children.length)
    }
    else {
      const nextGroup = currentGroups.find(node => GROUP_ORDER.indexOf(node.getAttribute('data-pr-group') ?? '') > GROUP_ORDER.indexOf(group))
      const nextHeading = nextGroup?.previousElementSibling
      const before = nextHeading?.matches('[data-pr-group-heading]') ? nextHeading : nextGroup ?? pagination
      const heading = list.previousElementSibling
      list.replaceChildren(...rows)
      if (heading?.matches('[data-pr-group-heading]')) {
        const count = heading.querySelector('[data-pr-group-count]')
        if (count) count.textContent = String(rows.length)
        current.insertBefore(heading, before ?? null)
      }
      current.insertBefore(list, before ?? null)
    }
  }
  const count = pagination?.querySelector('span')
  if (count) count.textContent = loaded.size + ' shown'
  const next = partial ? link.getAttribute('href') : incoming.querySelector('[data-pr-next]')?.getAttribute('href')
  if (next) link.setAttribute('href', next)
  else link.remove()
  const first = newRows[0] ?? (!next ? Array.from(current.querySelectorAll('[data-pr-entry]')).at(-1) : null)
  if (first instanceof HTMLElement && (keyboard || !next)) first.focus({ preventScroll: !keyboard })
  return true
}

export function pullRequestLiveSearch(input: HTMLInputElement, results: HTMLElement, scope: () => string,
  applied: (result: SearchResult) => void, pending: (value: 'search' | 'page' | '') => void, status: (message: string) => void,
  range: { page: number, through: number }) {
  const view = input.ownerDocument.defaultView
  const form = input.form
  if (!view || !form) return
  const browser = view
  const pane = results.closest<HTMLElement>('[data-pr-workspace-list]')
  const position = pane ? pullRequestListPosition(browser, pane, scope) : null
  const initialFormScope = listFormScope(form)
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let composing = false
  const address = new URL(browser.location.href)
  if (address.searchParams.has('through')) {
    if (range.through > range.page) address.searchParams.set('through', String(range.through))
    else address.searchParams.delete('through')
    if (address.href !== browser.location.href) browser.history.replaceState(browser.history.state, '', address)
  }
  position?.restore()

  function updateWorkspaceLinks() {
    const workspace = results.closest('[data-pr-workspace-columns]')
    const links = workspace?.querySelectorAll(
      '[data-pr-entry], [data-pr-workspace-detail] a[href^="/pull-requests?"], [data-pr-workspace-detail] form[action^="/pull-requests/"]',
    )
    for (const link of links ?? []) {
      const attribute = link.localName === 'form' ? 'action' : 'href'
      const address = link.getAttribute(attribute)
      if (address) link.setAttribute(attribute, withCurrentPullRequestQuery(address, browser.location))
    }
  }

  function cancel() {
    clearTimeout(timer)
    timer = undefined
    request?.abort()
    request = undefined
    pending('')
  }

  async function load(search: string, link?: HTMLAnchorElement, keyboard = false) {
    if (!results.isConnected) return
    const controller = new AbortController()
    request = controller
    const expectedScope = scope()
    const params = new URLSearchParams(expectedScope)
    const target = link ? new URL(link.href) : null
    const pageStatus = link?.closest('[data-pr-result-pages]')?.querySelector('[data-pr-page-status]')
    const linkLabel = link?.textContent ?? ''
    if (link) {
      link.textContent = 'Loading more pull requests…'
      link.setAttribute('aria-disabled', 'true')
      if (pageStatus) pageStatus.textContent = ''
    }
    const address = new URLSearchParams(browser.location.search)
    for (const key of REVIEW_KEYS) {
      const value = address.get(key)
      if (value !== null) params.set(key, value)
    }
    params.set('q', search)
    if (target) {
      params.set('page', target.searchParams.get('page') ?? '')
      params.set('continuation', '1')
    }

    try {
      const response = await fetch('/pull-requests/results?' + params, {
        headers: { accept: 'application/json' }, signal: controller.signal,
      })
      if (!response.ok) throw new Error('Could not load pull requests')
      const result: SearchResult = await response.json()
      if (controller.signal.aborted || !results.isConnected) return
      const markup = new DOMParser().parseFromString(result.html, 'text/html')
      const fragment = markup.querySelector('[data-pr-results-fragment]')
      if (!fragment) throw new Error('Missing pull request results')
      if (link && target) {
        const current = results.querySelector('[data-pr-results-fragment]')
        if (!current || result.scope !== expectedScope) throw new Error('Could not finish loading this page')
        const receivedRows = Boolean(fragment.querySelector('[data-pr-entry]'))
        if (!appendPullRequestPage(current, fragment, link, keyboard, result.partial)) browser.location.assign(target.href)
        else {
          if (!result.partial || receivedRows) {
            const url = new URL(browser.location.href)
            const end = Number(target.searchParams.get('page'))
            if (end > Number(url.searchParams.get('through') ?? 0)) {
              url.searchParams.set('through', String(end))
              browser.history.replaceState(browser.history.state, '', url)
              updateWorkspaceLinks()
              position?.save()
            }
          }
          const count = current.querySelectorAll('[data-pr-row]').length
          status(count + ' pull requests shown.')
          if (result.partial && pageStatus) pageStatus.textContent = 'Some repositories could not finish loading. Retry this page.'
        }
        return
      }
      const url = new URL(browser.location.href)
      if (result.search) url.searchParams.set('q', result.search)
      else url.searchParams.delete('q')
      url.searchParams.delete('page')
      url.searchParams.delete('through')
      browser.history.replaceState(browser.history.state, '', url)
      results.replaceChildren(fragment)
      updateWorkspaceLinks()
      const clear = results.closest('[data-pr-workspace-list]')?.querySelector('[data-pr-clear-filters]')
      const clearAddress = clear?.getAttribute('href')
      if (clearAddress) {
        clear?.setAttribute('href', withCurrentPullRequestQuery(clearAddress, browser.location))
      }
      applied(result)
      position?.reset()
      const count = fragment.querySelectorAll('[data-pr-row]').length
      status(count === 1 ? '1 pull request shown.' : count + ' pull requests shown.')
    }
    catch {
      if (!controller.signal.aborted) {
        if (pageStatus) pageStatus.textContent = 'Could not load more pull requests. Try again.'
        else status('Could not update pull requests. Edit your search or press Enter to retry.')
      }
    }
    finally {
      if (link) {
        link.textContent = linkLabel
        link.removeAttribute('aria-disabled')
      }
      if (request === controller) {
        request = undefined
        pending('')
      }
    }
  }

  function schedule(immediate = false, force = false) {
    cancel()
    status('')
    const search = input.value.trim()
    if (!force && search === (new URLSearchParams(scope()).get('q') ?? '')) return
    pending('search')
    if (immediate) void load(search)
    else timer = setTimeout(() => {
      timer = undefined
      void load(search)
    }, SEARCH_DELAY_MS)
  }

  return {
    cancel,
    savePosition() { position?.save() },
    listScrolled() { position?.scrolled() },
    rememberNavigation(event: MouseEvent) { position?.remember(event) },
    next(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-pr-next]') : null
      if (!link || results.querySelectorAll('[data-pr-entry]').length >= MAX_LOADED_ROWS) return
      event.preventDefault()
      if (request || timer || composing) return
      const search = new URLSearchParams(scope()).get('q') ?? ''
      status('')
      pending('page')
      void load(search, link, event.detail === 0)
    },
    submit(event: SubmitEvent) {
      if (event.submitter?.hasAttribute('data-pr-search-submit') && listFormScope(form) === initialFormScope) {
        event.preventDefault()
        if (!composing) schedule(true, true)
      }
      else cancel()
    },
    input(event: InputEvent) {
      if (!composing && !event.isComposing) schedule(event.inputType === 'insertFromPaste')
    },
    startComposition() {
      composing = true
      cancel()
    },
    endComposition() {
      composing = false
      schedule()
    },
    keydown(event: KeyboardEvent) {
      if (composing || event.isComposing || event.defaultPrevented) return
      if (event.key === 'Escape' && input.value) {
        event.preventDefault()
        event.stopPropagation()
        input.value = ''
        schedule(true)
      }
    },
  }
}
