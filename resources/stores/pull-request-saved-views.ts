export interface PullRequestSavedView {
  id: string
  name: string
  scope: string
}

export const PULL_REQUEST_VIEWS_KEY = 'harness.pr-views.v1'
const activeViewKey = 'harness.pr-views.active.v1'
export const PULL_REQUEST_VIEW_NAME_LIMIT = 80
const scopeKeys = ['profile', 'state', 'sort', 'q', 'repository', 'involvement', 'draft', 'review', 'checks', 'author', 'label']

function listScope(value: string) {
  const source = new URLSearchParams(value)
  const scope = new URLSearchParams()
  for (const key of scopeKeys) {
    if (key === 'label') {
      for (const label of source.getAll(key)) scope.append(key, label)
    }
    else {
      const entry = source.get(key)
      if (entry) scope.set(key, entry)
    }
  }
  return scope
}

export function pullRequestViewMatches(saved: string, current: string): boolean {
  function key(value: string) {
    const scope = listScope(value)
    const labels = scope.getAll('label').map(label => label.toLowerCase()).sort()
    scope.delete('label')
    for (const name of ['repository', 'author']) {
      const entry = scope.get(name)
      if (entry) scope.set(name, entry.toLowerCase())
    }
    return JSON.stringify([scope.toString(), labels])
  }
  return key(saved) === key(current)
}

export function pullRequestViewHref(saved: string, current: string, currentDetail: string): string {
  const scope = listScope(saved)
  if (scope.get('profile') === listScope(current).get('profile'))
    for (const [name, value] of new URLSearchParams(currentDetail)) scope.set(name, value)
  return '/pull-requests?' + scope
}

export function pullRequestViewNameError(name: string, views: readonly PullRequestSavedView[], editingId: string | null): string {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name for this view.'
  if (trimmed.length > PULL_REQUEST_VIEW_NAME_LIMIT) return 'Use 80 characters or fewer.'
  if (views.some(view => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase()))
    return 'A view with this name already exists.'
  return ''
}

export function pullRequestViewStore(browser: Window) {
  return {
    read(): PullRequestSavedView[] {
      try {
        const stored: unknown = JSON.parse(browser.localStorage.getItem(PULL_REQUEST_VIEWS_KEY) ?? 'null')
        if (!Array.isArray(stored)) return []
        const views = new Map<string, PullRequestSavedView>()
        for (const entry of stored) {
          if (!entry || typeof entry.id !== 'string' || !entry.id || views.has(entry.id)
            || typeof entry.name !== 'string' || pullRequestViewNameError(entry.name, [], null)
            || typeof entry.scope !== 'string' || entry.scope.length > 16_384) continue
          const scope = listScope(entry.scope)
          if (!/^\d+$/u.test(scope.get('profile') ?? '')) continue
          views.set(entry.id, { id: entry.id, name: entry.name.trim(), scope: scope.toString() })
        }
        return [...views.values()]
      }
      catch {
        return []
      }
    },
    write(views: PullRequestSavedView[]): boolean {
      try {
        browser.localStorage.setItem(PULL_REQUEST_VIEWS_KEY, JSON.stringify(views))
        return true
      }
      catch {
        return false
      }
    },
    active(): string {
      try { return browser.sessionStorage.getItem(activeViewKey) ?? '' }
      catch { return '' }
    },
    select(id: string): void {
      try { browser.sessionStorage.setItem(activeViewKey, id) }
      catch { /* The applied URL still describes the view. */ }
    },
    id(): string {
      return Array.from(browser.crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('')
    },
    navigate(href: string): void {
      browser.location.assign(href)
    },
  }
}
