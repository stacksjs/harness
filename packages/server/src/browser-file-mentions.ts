interface FileMention {
  start: number
  end: number
  query: string
}

interface FileMentionMenu {
  paths: string[]
  selected: number
  status: 'loading' | 'ready' | 'error'
}

interface FileMentionOptions {
  editor: () => HTMLTextAreaElement | null | undefined
  popup: () => HTMLElement | null | undefined
  scope: { session: string } | { workspace: string }
  updateMenu: (menu: FileMentionMenu | null) => void
  inserted: () => void
}

function mentionAtCursor(editor: HTMLTextAreaElement): FileMention | null {
  const { value, selectionStart: cursor, selectionEnd } = editor
  if (cursor !== selectionEnd || editor.readOnly || editor.form?.hidden) return null
  let start = cursor
  while (start > 0 && cursor - start <= 200 && !/\s/u.test(value.charAt(start - 1))) start--
  if (value[start] !== '@' || start === cursor || cursor - start > 200) return null
  let end = cursor
  while (end < value.length && end - start <= 200 && !/\s/u.test(value.charAt(end))) end++
  return end - start <= 200 ? { start, end, query: value.slice(start + 1, cursor) } : null
}

function sameMention(left: FileMention | null, right: FileMention | null): boolean {
  return Boolean(left && right && left.start === right.start && left.end === right.end && left.query === right.query)
}

function fileLink(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/[\\\[\]*_&<>]/gu, '\\$&').replace(/\s+/gu, ' ')
  const encoded = path.split('/').map(segment => encodeURIComponent(segment)).join('/').replace(/[()]/gu, character => character === '(' ? '%28' : '%29')
  return `[${name}](${encoded})`
}

export function createFileMentionPicker({ editor, popup, scope, updateMenu, inserted }: FileMentionOptions) {
  let active: FileMention | null = null
  let menu: FileMentionMenu | null = null
  let request: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function show(next: FileMentionMenu | null): void {
    menu = next
    updateMenu(next)
  }

  function close(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    request?.abort()
    request = undefined
    active = null
    if (menu) show(null)
  }

  async function search(mention: FileMention, controller: AbortController): Promise<void> {
    const params = new URLSearchParams(scope)
    params.set('q', mention.query)
    try {
      const reply = await fetch(`/workspace-files/search?${params}`, { signal: controller.signal })
      if (!reply.ok) throw new Error('Workspace search failed')
      const { results } = await reply.json() as { results: string[] }
      if (!controller.signal.aborted) show({ paths: results, selected: results.length ? 0 : -1, status: 'ready' })
    }
    catch {
      if (!controller.signal.aborted) show({ paths: [], selected: -1, status: 'error' })
    }
  }

  function update(): void {
    const input = editor()
    const mention = input ? mentionAtCursor(input) : null
    if (sameMention(mention, active)) return
    close()
    if (!mention) return
    active = mention
    const controller = new AbortController()
    request = controller
    show({ paths: [], selected: -1, status: 'loading' })
    timer = setTimeout(() => { void search(mention, controller) }, 110)
  }

  function pick(path: string): void {
    const input = editor()
    const live = input ? mentionAtCursor(input) : null
    if (!input || !live || !sameMention(live, active) || !menu?.paths.includes(path)) return
    const follows = input.value[live.end]
    input.setRangeText(fileLink(path) + (!follows || !/\s/u.test(follows) ? ' ' : ''), live.start, live.end, 'end')
    if (follows === ' ') input.setSelectionRange(input.selectionStart + 1, input.selectionEnd + 1)
    close()
    input.focus({ preventScroll: true })
    inserted()
  }

  function keydown(event: KeyboardEvent): boolean {
    if (!menu || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
    if (event.key === 'Escape') close()
    else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && menu.paths.length) {
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const selected = (menu.selected + delta + menu.paths.length) % menu.paths.length
      show({ ...menu, selected })
      popup()?.querySelector(`#composer-file-option-${selected}`)?.scrollIntoView({ block: 'nearest' })
    }
    else if ((event.key === 'Enter' || event.key === 'Tab') && menu.paths[menu.selected]) pick(menu.paths[menu.selected]!)
    else if (event.key !== 'Enter' || menu.status !== 'loading') return false
    event.preventDefault()
    return true
  }

  return { update, close, pick, keydown }
}
