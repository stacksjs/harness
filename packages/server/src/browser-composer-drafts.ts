const draftPrefix = 'harness.composer.v1:'

interface ComposerDraft {
  text: string
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
  if (!draft || typeof draft.text !== 'string' || !draft.text || (expectedText !== undefined && draft.text !== expectedText)) return null
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

export function watchSidebarDrafts(root: HTMLElement, template: HTMLTemplateElement, discard: (key: string) => void) {
  const browser = root.ownerDocument.defaultView
  if (!browser) return
  let storage: Storage
  try { storage = browser.localStorage }
  catch { return }
  const selector = '[data-sidebar-row] > a[data-sidebar-item]'
  const listeners = new AbortController()

  function update(): void {
    for (const link of root.querySelectorAll<HTMLAnchorElement>(selector)) {
      const profile = link.closest<HTMLElement>('[data-space-id]')?.dataset.spaceId
      const address = new URL(link.href)
      const session = /^\/s\/(\d+)$/.exec(address.pathname)?.[1]
      const project = address.pathname === '/' && address.searchParams.get('workspace')
      const target = session ? `session:${session}` : project ? `project:${project}` : ''
      const key = profile && target ? `${draftPrefix}${profile}:${target}` : ''
      const row = link.parentElement!
      const existing = row.querySelector<HTMLButtonElement>(':scope > [data-draft-discard-row]')
      if (!key || !read(storage, key)?.text) {
        existing?.remove()
        continue
      }
      const button = existing ?? template.content.firstElementChild?.cloneNode(true) as HTMLButtonElement | undefined
      if (!button) continue
      const title = project
        ? row.closest('[data-sidebar-section]')?.querySelector('[data-sidebar-section-header]')?.textContent?.trim()
        : link.dataset.label ?? link.textContent?.trim()
      button.setAttribute('aria-label', title ? `Discard draft for ${title}` : 'Discard draft')
      if (!existing) {
        button.addEventListener('click', () => {
          link.focus()
          discard(key)
        }, { signal: listeners.signal })
        row.append(button)
      }
    }
  }

  const rows = new MutationObserver(update)
  rows.observe(root, { childList: true, subtree: true })
  browser.addEventListener('storage', (event) => {
    if (!event.key || event.key.startsWith(draftPrefix)) update()
  }, { signal: listeners.signal })
  update()
  return {
    update,
    dispose() {
      rows.disconnect()
      listeners.abort()
      for (const button of root.querySelectorAll('[data-draft-discard-row]')) button.remove()
    },
  }
}
