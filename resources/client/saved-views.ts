interface SavedView {
  id: string
  name: string
  scope: string
}

interface SavedViewsKind {
  path: string
  storageKey: string
  activeKey: string
  scopeKeys: string[]
}

export const pullRequestViews: SavedViewsKind = {
  path: '/pull-requests',
  storageKey: 'harness.pr-views.v1',
  activeKey: 'harness.pr-views.active.v1',
  scopeKeys: ['profile', 'state', 'sort', 'q', 'repository', 'involvement', 'draft', 'review', 'checks', 'author', 'label'],
}
export const issueViews: SavedViewsKind = {
  path: '/issues',
  storageKey: 'harness.issue-views.v1',
  activeKey: 'harness.issue-views.active.v1',
  scopeKeys: ['profile', 'state', 'sort', 'q', 'repository', 'involvement', 'assignee', 'label', 'hideRepository', 'hideProject'],
}

export const SAVED_VIEW_NAME_LIMIT = 80
const collectionKeys = ['label', 'hideRepository', 'hideProject']

function listScope(value: string, kind: SavedViewsKind) {
  const source = new URLSearchParams(value)
  const scope = new URLSearchParams()
  for (const key of kind.scopeKeys) {
    if (collectionKeys.includes(key)) {
      for (const value of source.getAll(key)) scope.append(key, value)
    }
    else {
      const entry = source.get(key)
      if (entry) scope.set(key, entry)
    }
  }
  return scope
}

function matchingScope(value: string, kind: SavedViewsKind) {
  const scope = listScope(value, kind)
  const collections = collectionKeys.map((key) => {
    const values = scope.getAll(key).map(value => value.toLowerCase()).sort()
    scope.delete(key)
    return values
  })
  for (const name of ['repository', 'author', 'assignee']) {
    const entry = scope.get(name)
    if (entry) scope.set(name, entry.toLowerCase())
  }
  return JSON.stringify([scope.toString(), collections])
}

function nameError(name: string, views: readonly SavedView[], editingId: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'Enter a name for this view.'
  if (trimmed.length > SAVED_VIEW_NAME_LIMIT) return 'Use 80 characters or fewer.'
  if (views.some(view => view.id !== editingId && view.name.toLowerCase() === trimmed.toLowerCase()))
    return 'A view with this name already exists.'
  return ''
}

function viewStore(browser: Window, kind: SavedViewsKind) {
  return {
    read(): SavedView[] {
      try {
        const stored: unknown = JSON.parse(browser.localStorage.getItem(kind.storageKey) ?? 'null')
        if (!Array.isArray(stored)) return []
        const views = new Map<string, SavedView>()
        for (const entry of stored) {
          if (!entry || typeof entry.id !== 'string' || !entry.id || views.has(entry.id)
            || typeof entry.name !== 'string' || nameError(entry.name, [], '')
            || typeof entry.scope !== 'string' || entry.scope.length > 16_384) continue
          const scope = listScope(entry.scope, kind)
          if (!/^\d+$/u.test(scope.get('profile') ?? '')) continue
          views.set(entry.id, { id: entry.id, name: entry.name.trim(), scope: scope.toString() })
        }
        return [...views.values()]
      }
      catch {
        return []
      }
    },
    write(views: SavedView[]): boolean {
      try {
        browser.localStorage.setItem(kind.storageKey, JSON.stringify(views))
        return true
      }
      catch {
        return false
      }
    },
    active(): string {
      try { return browser.sessionStorage.getItem(kind.activeKey) ?? '' }
      catch { return '' }
    },
    select(id: string): void {
      try { browser.sessionStorage.setItem(kind.activeKey, id) }
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

interface SavedViewsState {
  ready: boolean
  views: SavedView[]
  active: SavedView | undefined
  modified: boolean
  editing: string
  name: string
  error: string
  status: string
}

export function initialSavedViews(): SavedViewsState {
  return { ready: false, views: [], active: undefined, modified: false, editing: '', name: '', error: '', status: '' }
}

interface SavedViewsMenuOptions {
  kind: SavedViewsKind
  scope: () => string
  detail: string
  profiles: string[]
  repositories: string[]
  suggestedName?: string
  elements: () => {
    menu: HTMLDetailsElement | null
    trigger: HTMLElement | null
    dialog: HTMLDialogElement | null
    nameInput: HTMLInputElement | null
  }
  publish: (state: SavedViewsState) => void
  nextTick: (callback: () => void) => unknown
  closeSibling?: () => void
}

export function savedViewsMenu(options: SavedViewsMenuOptions) {
  const { kind, elements } = options
  let snapshot = initialSavedViews()
  let store: ReturnType<typeof viewStore> | undefined
  const storageError = 'Could not save views on this device. Check browser storage and try again.'

  function publish(change: Partial<SavedViewsState>) {
    snapshot = { ...snapshot, ...change }
    options.publish(snapshot)
  }

  function refresh() {
    if (!store) return
    const views = store.read()
    const current = matchingScope(options.scope(), kind)
    const matches = (view: SavedView) => matchingScope(view.scope, kind) === current
    const storedId = store.active()
    const active = views.find(view => view.id === storedId) ?? views.find(matches)
    publish({ views, active, modified: Boolean(active && !matches(active)), ready: true })
    if ((active?.id ?? '') !== storedId) store.select(active?.id ?? '')
  }

  function closeMenu(restoreFocus = true) {
    const { menu, trigger } = elements()
    if (menu) menu.open = false
    if (restoreFocus) trigger?.focus()
  }

  function closeEditor() {
    const { dialog, trigger } = elements()
    dialog?.close()
    trigger?.focus()
  }

  return {
    mount() {
      const browser = elements().trigger?.ownerDocument.defaultView
      if (!browser) return
      store = viewStore(browser, kind)
      refresh()
    },
    refresh,
    scopeChanged() {
      publish({ status: '' })
      refresh()
    },
    storageChanged(event: StorageEvent) {
      if (event.key === kind.storageKey || event.key === null) refresh()
    },
    dismissOutside(event: PointerEvent) {
      const { menu } = elements()
      if (menu?.open && !menu.contains(event.target as Node)) closeMenu(false)
    },
    closeMenu,
    closeEditor,
    toggle() { options.closeSibling?.() },
    keydown(event: KeyboardEvent) {
      const { menu } = elements()
      if (!menu || event.defaultPrevented || event.isComposing) return
      if (event.key === 'Escape' && menu.open) {
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      if (!menu.open && (event.key === 'Home' || event.key === 'End')) return
      event.preventDefault()
      options.closeSibling?.()
      menu.open = true
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button:not([hidden])')]
      if (!buttons.length) return
      const active = menu.ownerDocument.activeElement
      const index = buttons.findIndex(button => button === active)
      const last = buttons.length - 1
      if (event.key === 'Home' || (event.key === 'ArrowDown' && index === last)) buttons[0]?.focus()
      else if (event.key === 'End' || (event.key === 'ArrowUp' && index <= 0)) buttons[last]?.focus()
      else buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus()
    },
    apply(id: string) {
      if (!store) return
      const view = store.read().find(item => item.id === id)
      if (!view) {
        refresh()
        closeMenu()
        publish({ status: 'This saved view was removed.' })
        return
      }
      const scope = listScope(view.scope, kind)
      const profile = scope.get('profile') ?? ''
      const repository = scope.get('repository')?.toLowerCase()
      const sameProfile = profile === listScope(options.scope(), kind).get('profile')
      if (!options.profiles.includes(profile) || (sameProfile && repository && !options.repositories.includes(repository))) {
        closeMenu()
        publish({ status: 'The profile or repository for this view is unavailable.' })
        return
      }
      if (sameProfile)
        for (const [name, value] of new URLSearchParams(options.detail)) scope.set(name, value)
      store.select(id)
      store.navigate(kind.path + '?' + scope)
    },
    openEditor(rename: boolean) {
      const view = rename ? snapshot.active : undefined
      const { dialog } = elements()
      publish({ editing: view?.id ?? '', name: view?.name ?? options.suggestedName ?? '', error: '', status: '' })
      closeMenu(false)
      dialog?.showModal()
      void options.nextTick(() => {
        elements().nameInput?.focus()
        elements().nameInput?.select()
      })
    },
    editName(event: InputEvent) {
      publish({ name: (event.target as HTMLInputElement).value, error: '' })
    },
    saveName() {
      if (!store) return
      const current = store.read()
      const editing = snapshot.editing
      const name = elements().nameInput?.value.trim() ?? ''
      if (editing && !current.some(view => view.id === editing)) {
        publish({ editing: '', name, error: 'This view was removed. Save it as a new view or cancel.' })
        return
      }
      const error = nameError(name, current, editing)
      if (error) {
        publish({ error })
        elements().nameInput?.focus()
        return
      }
      const id = editing || store.id()
      const next = editing ? current.map(view => view.id === id ? { ...view, name } : view)
        : [...current, { id, name, scope: listScope(options.scope(), kind).toString() }]
      if (!store.write(next)) {
        publish({ error: storageError })
        return
      }
      store.select(id)
      refresh()
      closeEditor()
      publish({ status: editing ? 'View renamed.' : 'View saved.' })
    },
    change(remove: boolean) {
      const active = snapshot.active
      if (!store || !active) return
      const current = store.read()
      closeMenu()
      if (!current.some(view => view.id === active.id)) {
        refresh()
        publish({ status: 'This saved view was removed.' })
        return
      }
      const next = remove ? current.filter(view => view.id !== active.id)
        : current.map(view => view.id === active.id ? { ...view, scope: listScope(options.scope(), kind).toString() } : view)
      if (!store.write(next)) {
        publish({ status: storageError })
        return
      }
      store.select(remove ? '' : active.id)
      refresh()
      publish({ status: remove ? 'View deleted.' : 'Saved view updated.' })
    },
  }
}
