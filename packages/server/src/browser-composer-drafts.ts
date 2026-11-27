const draftPrefix = 'harness.composer.v1:'

interface ComposerDraft {
  text: string
  files?: unknown[]
  createdAt?: number
  [field: string]: unknown
}

interface DiscardMarker {
  discardedDraft: string
}

export interface DiscardedDraft {
  key: string
  claim: string
  draft: ComposerDraft
}

function read(storage: Storage, key: string): Partial<ComposerDraft & DiscardMarker> | null {
  try {
    const entry: unknown = JSON.parse(storage.getItem(key) ?? 'null')
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null
  }
  catch {
    return null
  }
}

export function discardComposerDraft(storage: Storage, key: string, claim: string, expectedText?: string): DiscardedDraft | null {
  const draft = read(storage, key)
  if (!draft || typeof draft.text !== 'string' || (!draft.text && !draft.files?.length) || (expectedText !== undefined && draft.text !== expectedText)) return null
  storage.setItem(key, JSON.stringify({ discardedDraft: claim }))
  return { key, claim, draft: { ...draft, text: draft.text } }
}

export function restoreComposerDraft(storage: Storage, offer: DiscardedDraft): boolean {
  if (read(storage, offer.key)?.discardedDraft !== offer.claim) return false
  storage.setItem(offer.key, JSON.stringify(offer.draft))
  return true
}

export function expireComposerDraft(storage: Storage, offer: DiscardedDraft): void {
  if (read(storage, offer.key)?.discardedDraft === offer.claim) storage.removeItem(offer.key)
}

export function wasComposerDraftDiscarded(storage: Storage, key: string): boolean {
  return typeof read(storage, key)?.discardedDraft === 'string'
}

export function persistDraftUndo(key: string, offer: unknown): void {
  sessionStorage.setItem(key, JSON.stringify(offer))
}

interface SidebarDraftOptions {
  root: HTMLElement
  discardTemplate: HTMLTemplateElement
  sectionTemplate: HTMLTemplateElement
  currentKey: string
  discard: (key: string) => void
  startProject: (id: string) => void
  open: (href: string) => void
}

interface SidebarDraft {
  key: string
  profile: string
  workspace?: string
  title: string
  href: string
  createdAt: number
}

const sidebarKey = /^harness\.composer\.v1:(\d+):(?:project:(\d+)|projectless)(?::draft:(web_[a-z0-9]{1,16}_[a-z0-9]{1,6}))?$/u

function draftHasContent(draft: Partial<ComposerDraft> | null): boolean {
  return Boolean(draft && (typeof draft.text === 'string' && draft.text.trim() || Array.isArray(draft.files) && draft.files.length))
}

function sidebarDraft(key: string, draft: Partial<ComposerDraft> | null): SidebarDraft | undefined {
  const match = sidebarKey.exec(key)
  if (!match || !draft || !draftHasContent(draft)) return
  const [, profile, workspace, id] = match
  const query = workspace ? new URLSearchParams({ workspace }) : new URLSearchParams({ profile: profile!, project: 'none' })
  if (id) query.set('draft', id)
  const count = Array.isArray(draft.files) ? draft.files.length : 0
  const title = (typeof draft.text === 'string' && draft.text.trim().split(/\r?\n/u, 1)[0])
    || (count === 1 ? '1 attachment' : `${count} attachments`)
  const timestamp = id ? Number.parseInt(id.split('_')[1]!, 36) : 0
  return { key, profile: profile!, workspace, title, href: '/?' + query, createdAt: Number.isFinite(draft.createdAt) ? draft.createdAt! : timestamp }
}

function plainActivation(event: MouseEvent): boolean {
  return event.button === 0 && !event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
}

export function watchSidebarDrafts({ root, discardTemplate, sectionTemplate, currentKey, discard, startProject, open }: SidebarDraftOptions) {
  const document = root.ownerDocument
  const browser = document.defaultView
  const rowTemplate = sectionTemplate.content.querySelector<HTMLElement>('[data-saved-draft]')
  if (!browser || !rowTemplate) return
  let storage: Storage
  try { storage = browser.localStorage }
  catch { return }
  const selector = '[data-sidebar-row] > a[data-sidebar-item]'
  const listeners = new AbortController()
  const options = { signal: listeners.signal }
  // The open draft retains its title and position from arrival. Brand-new drafts
  // join the sidebar after leaving the editor, as do drafts edited while open.
  let currentPreview = sidebarDraft(currentKey, read(storage, currentKey))

  function indexDrafts(): Map<string, SidebarDraft[]> {
    const byProfile = new Map<string, SidebarDraft[]>()
    if (currentPreview && !draftHasContent(read(storage, currentKey))) currentPreview = undefined
    for (let i = 0, length = storage.length; i < length; i++) {
      const key = storage.key(i)
      if (!key || !sidebarKey.test(key)) continue
      const saved = read(storage, key)
      const entry = key === currentKey ? currentPreview : sidebarDraft(key, saved)
      if (!entry) continue
      const list = byProfile.get(entry.profile) ?? []
      list.push(entry)
      byProfile.set(entry.profile, list)
    }
    for (const list of byProfile.values())
      list.sort((left, right) => right.createdAt - left.createdAt || right.key.localeCompare(left.key))
    return byProfile
  }

  function newSection(viewport: HTMLElement): HTMLElement | undefined {
    const section = sectionTemplate.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined
    if (!section) return
    section.querySelector('[data-saved-draft]')?.remove()
    viewport.prepend(section)
    return section
  }

  function reconcileRows(panel: HTMLElement, drafts: SidebarDraft[]): Set<string> {
    const displayed = new Set<string>()
    const viewport = panel.querySelector<HTMLElement>('.stx-sidebar-scroll')
    if (!viewport) return displayed
    const projects = new Map<string, string>()
    for (const link of panel.querySelectorAll<HTMLAnchorElement>('a[data-sidebar-item][href^="/?workspace="]')) {
      const address = new URL(link.href)
      const id = address.pathname === '/' && address.searchParams.get('workspace')
      const title = link.closest('[data-sidebar-section]')?.querySelector('[data-sidebar-section-header]')?.textContent?.trim()
      if (id && title) projects.set(id, title)
    }
    const available = drafts.filter(entry => !entry.workspace || projects.has(entry.workspace))
    const existing = viewport.querySelector<HTMLElement>(':scope > [data-saved-drafts]')
    if (!available.length) {
      existing?.remove()
      return displayed
    }
    const section = existing ?? newSection(viewport)
    const list = section?.querySelector<HTMLElement>('[data-saved-draft-list]')
    if (!list) return displayed
    const rows = new Map(Array.from(list.querySelectorAll<HTMLElement>('[data-saved-draft]'), row => [row.dataset.savedDraft!, row]))
    const focused = document.activeElement instanceof HTMLElement && list.contains(document.activeElement) ? document.activeElement : null
    let next = list.firstElementChild
    for (const entry of available) {
      displayed.add(entry.key)
      const row = rows.get(entry.key) ?? rowTemplate!.cloneNode(true) as HTMLElement
      const link = row.querySelector<HTMLAnchorElement>('[data-saved-draft-link]')!
      const title = row.querySelector<HTMLElement>('[data-saved-draft-title]')!
      const project = row.querySelector<HTMLElement>('[data-saved-draft-project]')!
      const projectName = projects.get(entry.workspace ?? '') ?? 'Without a project'
      row.dataset.savedDraft = entry.key
      if (title.textContent !== entry.title) title.textContent = entry.title
      if (project.textContent !== projectName) project.textContent = projectName
      link.setAttribute('href', entry.href)
      link.setAttribute('aria-label', `${entry.title}, Unsent draft, ${projectName}`)
      if (entry.key === currentKey) link.setAttribute('aria-current', 'page')
      const button = row.querySelector<HTMLButtonElement>('[data-draft-discard-row]')
      button?.setAttribute('aria-label', `Discard draft for ${entry.title}`)
      rows.delete(entry.key)
      if (row !== next) list.insertBefore(row, next)
      next = row.nextElementSibling
    }
    for (const row of rows.values()) row.remove()
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    return displayed
  }

  function update(): void {
    const drafts = indexDrafts()
    const listed = new Set<string>()
    for (const panel of root.querySelectorAll<HTMLElement>('[data-space-id]:not([data-space-deferred])')) {
      for (const key of reconcileRows(panel, drafts.get(panel.dataset.spaceId ?? '') ?? [])) listed.add(key)
    }
    for (const link of root.querySelectorAll<HTMLAnchorElement>(selector)) {
      const profile = link.closest<HTMLElement>('[data-space-id]')?.dataset.spaceId
      const address = new URL(link.href)
      const session = /^\/s\/(\d+)$/.exec(address.pathname)?.[1]
      const project = address.pathname === '/' && address.searchParams.get('workspace')
      const target = session ? `session:${session}` : project ? `project:${project}` : ''
      const key = profile && target ? `${draftPrefix}${profile}:${target}` : ''
      const row = link.parentElement!
      const existing = row.querySelector<HTMLButtonElement>(':scope > [data-draft-discard-row]')
      if (!key || listed.has(key) || !draftHasContent(read(storage, key))) {
        existing?.remove()
        continue
      }
      const button = existing ?? discardTemplate.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined
      if (!button) continue
      const title = project
        ? row.closest('[data-sidebar-section]')?.querySelector('[data-sidebar-section-header]')?.textContent?.trim()
        : link.dataset.label ?? link.textContent?.trim()
      button.setAttribute('aria-label', title ? `Discard draft for ${title}` : 'Discard draft')
      if (!existing) {
        button.addEventListener('click', () => {
          link.focus()
          discard(key)
        }, options)
        row.append(button)
      }
    }
  }

  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element) || !plainActivation(event)) return
    const row = event.target.closest<HTMLElement>('[data-saved-draft]')
    if (row && !row.closest('template')) {
      const link = row.querySelector<HTMLAnchorElement>('[data-saved-draft-link]')!
      if (event.target.closest('[data-draft-discard-row]')) {
        const next = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector<HTMLElement>('[data-saved-draft-link]')
        discard(row.dataset.savedDraft!)
        const fallback = root.querySelector<HTMLElement>('[data-nav-new-thread]')
        const focus = link.isConnected ? link : next ?? fallback
        focus?.focus({ preventScroll: true })
      }
      else {
        event.preventDefault()
        open(link.getAttribute('href')!)
      }
      return
    }
    const link = event.target.closest<HTMLAnchorElement>(selector)
    if (!link) return
    const url = new URL(link.href)
    const workspace = url.pathname === '/' && url.searchParams.get('workspace')
    if (!workspace || !/^\d+$/u.test(workspace)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    startProject(workspace)
  }, { ...options, capture: true })

  root.addEventListener('keydown', (event) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('[data-saved-drafts]')) return
    if (event.key === 'Enter') event.stopPropagation()
    if (event.key === ' ' && event.target.matches('[data-saved-draft-link]')) {
      event.preventDefault()
      event.stopPropagation()
      event.target.click()
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const row = event.target.closest('[data-saved-draft]')
    const next = event.key === 'ArrowDown' ? row?.nextElementSibling : row?.previousElementSibling
    event.preventDefault()
    event.stopPropagation()
    next?.querySelector<HTMLElement>('[data-saved-draft-link]')?.focus()
  }, { ...options, capture: true })

  const rows = new MutationObserver(update)
  rows.observe(root, { childList: true, subtree: true })
  browser.addEventListener('storage', (event) => {
    if (!event.key || event.key.startsWith(draftPrefix)) update()
  }, options)
  browser.addEventListener('pageshow', (event) => {
    if (event.persisted) update()
  }, options)
  update()
  return {
    update,
    restoreCurrent(offer: DiscardedDraft) {
      if (offer.key === currentKey) {
        currentPreview = sidebarDraft(offer.key, offer.draft)
        update()
      }
    },
    dispose() {
      rows.disconnect()
      listeners.abort()
      for (const node of root.querySelectorAll('[data-saved-drafts], [data-draft-discard-row]')) node.remove()
    },
  }
}
