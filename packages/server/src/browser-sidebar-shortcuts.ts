import { formatChord, parseChord } from './keybindings'
import type { Keybindings } from './keybindings'

const draftSelector = 'a[data-saved-draft-link]'
const threadSelector = 'a[data-sidebar-item][href^="/s/"]'

function sidebarPanel(root: HTMLElement, profile: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-space-id="${CSS.escape(profile)}"]:not([data-space-deferred])`)
}

function sidebarLinks(panel: HTMLElement | null): HTMLAnchorElement[] {
  if (!panel) return []
  return Array.from(panel.querySelectorAll<HTMLAnchorElement>(`${draftSelector}, ${threadSelector}`))
    .filter(link => !link.closest('[data-collapsed], [hidden], [inert], [data-sidebar-section][data-expanded="false"]'))
}

export function sidebarShortcutTarget(root: HTMLElement, profile: string, sessionId: number, command: string): string | null {
  const panel = sidebarPanel(root, profile)
  const links = sidebarLinks(panel)
  const number = /^thread\.jump\.([1-9])$/.exec(command)
  if (number) return links[Number(number[1]) - 1]?.getAttribute('href') ?? null
  const direction = command === 'thread.next' ? 1 : command === 'thread.previous' ? -1 : 0
  if (!direction) return null
  const current = sessionId
    ? panel?.querySelector<HTMLAnchorElement>(`${threadSelector}[href="/s/${sessionId}"]`)
    : panel?.querySelector<HTMLAnchorElement>(`${draftSelector}[aria-current="page"]`)
  if (!current) return sessionId ? null : links.at(direction === 1 ? 0 : -1)?.getAttribute('href') ?? null
  const index = links.indexOf(current)
  return index < 0 ? null : links[index + direction]?.getAttribute('href') ?? null
}

export function createSidebarJumpHints(
  root: HTMLElement,
  getContext: () => { profile: string, bindings?: Keybindings, apple: boolean, blocked: boolean },
): { update: (event: KeyboardEvent) => void, clear: () => void } {
  const shown = new Set<HTMLAnchorElement>()
  let pending: ReturnType<typeof setTimeout> | undefined
  let modifiers = ''
  let held = false
  const observer = new MutationObserver(render)

  function render(): void {
    const { profile, bindings, apple, blocked } = getContext()
    const links = held && !blocked && bindings ? sidebarLinks(sidebarPanel(root, profile)).slice(0, 9) : []
    const next = new Set<HTMLAnchorElement>()
    for (const [index, link] of links.entries()) {
      const chord = parseChord(bindings?.[`thread.jump.${index + 1}`])
      if (!chord) continue
      // The complete set of shortcuts is visible while a jump modifier is held.
      link.dataset.sidebarJump = formatChord(chord, apple)
      next.add(link)
    }
    for (const link of shown) if (!next.has(link)) delete link.dataset.sidebarJump
    shown.clear()
    for (const link of next) shown.add(link)
  }

  function clear(): void {
    clearTimeout(pending)
    modifiers = ''
    held = false
    observer.disconnect()
    for (const link of shown) delete link.dataset.sidebarJump
    shown.clear()
  }

  function update(event: KeyboardEvent): void {
    const { apple, bindings, blocked } = getContext()
    const mod = apple ? event.metaKey : event.ctrlKey
    const ctrl = apple && event.ctrlKey
    const matches = !blocked && (mod || ctrl || event.altKey) && Object.entries(bindings ?? {}).some(([id, value]) => {
      if (!id.startsWith('thread.jump.')) return false
      const chord = parseChord(value)
      return chord && (apple ? chord.mod === mod && chord.ctrl === ctrl : (chord.mod || chord.ctrl) === mod)
        && chord.alt === event.altKey && chord.shift === event.shiftKey
    })
    if (!matches) {
      clear()
      return
    }
    const key = `${mod}:${ctrl}:${event.altKey}:${event.shiftKey}`
    if (key === modifiers) return
    clear()
    modifiers = key
    pending = setTimeout(() => {
      held = true
      render()
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'data-collapsed', 'data-expanded', 'data-space-active'] })
    }, 200)
  }

  return { update, clear }
}
