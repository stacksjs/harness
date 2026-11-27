type SearchResult = {
  html: string
  scope: string
  search: string
  draft: string
  filterCount: number
}

const SEARCH_DELAY_MS = 250
const REVIEW_KEYS = ['selectedUrl', 'selectionProfile', 'tab', 'detailPage', 'reviewHead', 'reviewBase', 'reviewLine', 'reviewStart'] as const
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
  for (const key of ['q', 'page']) {
    const value = list.get(key)
    if (value) target.searchParams.set(key, value)
    else target.searchParams.delete(key)
  }
  return target.pathname + target.search + target.hash
}

export function pullRequestLiveSearch(input: HTMLInputElement, results: HTMLElement, scope: () => string,
  applied: (result: SearchResult) => void, pending: (value: boolean) => void, status: (message: string) => void) {
  const view = input.ownerDocument.defaultView
  const form = input.form
  if (!view || !form) return
  const browser = view
  const initialFormScope = listFormScope(form)
  let timer: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | undefined
  let composing = false

  function cancel() {
    clearTimeout(timer)
    request?.abort()
    request = undefined
    pending(false)
  }

  async function load(search: string) {
    if (!results.isConnected) return
    const controller = new AbortController()
    request = controller
    const params = new URLSearchParams(scope())
    const address = new URLSearchParams(browser.location.search)
    for (const key of REVIEW_KEYS) {
      const value = address.get(key)
      if (value) params.set(key, value)
    }
    params.set('q', search)

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
      const url = new URL(browser.location.href)
      if (result.search) url.searchParams.set('q', result.search)
      else url.searchParams.delete('q')
      url.searchParams.delete('page')
      browser.history.replaceState(browser.history.state, '', url)
      results.replaceChildren(fragment)
      const workspace = results.closest('[data-pr-workspace-columns]')
      const links = workspace?.querySelectorAll(
        '[data-pr-workspace-detail] a[href^="/pull-requests?"], [data-pr-workspace-detail] form[action^="/pull-requests/"], [data-pr-clear-filters]',
      )
      for (const link of links ?? []) {
        const attribute = link.localName === 'form' ? 'action' : 'href'
        const address = link.getAttribute(attribute)
        if (address) link.setAttribute(attribute, withCurrentPullRequestQuery(address, browser.location))
      }
      applied(result)
      const count = fragment.querySelectorAll('[data-pr-row]').length
      status(count === 1 ? '1 pull request shown.' : count + ' pull requests shown.')
    }
    catch {
      if (!controller.signal.aborted) status('Could not update pull requests. Edit your search or press Enter to retry.')
    }
    finally {
      if (request === controller) {
        request = undefined
        pending(false)
      }
    }
  }

  function schedule(immediate = false, force = false) {
    cancel()
    status('')
    const search = input.value.trim()
    if (!force && search === (new URLSearchParams(scope()).get('q') ?? '')) return
    pending(true)
    if (immediate) void load(search)
    else timer = setTimeout(() => void load(search), SEARCH_DELAY_MS)
  }

  return {
    cancel,
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
