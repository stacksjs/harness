import type { WorkspaceReviewMode } from './diff'
import type { NativeClipboard } from './browser-clipboard'
import { writeClipboardText } from './browser-clipboard'

export interface DiffLineLocation {
  path: string
  side: 'before' | 'after'
  line: number
}

export interface DiffLineLink extends DiffLineLocation {
  mode: WorkspaceReviewMode | 'session'
  target?: string
}

interface DiffLine {
  kind: 'context' | 'addition' | 'deletion'
  text: string
  before: number | null
  after: number | null
  newlineNote?: string
}

interface DiffHunk {
  header: string
  lines: DiffLine[]
}

interface DiffRow {
  id: number
  header?: string
  cells: (DiffLine | null)[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const gitEscapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

function patchPath(header: string): string | undefined {
  const token = header.slice(4).replace(/\t$/u, '')
  if (token === '/dev/null') return undefined
  if (!token.startsWith('"')) return token.slice(2)
  const bytes: number[] = []
  for (const part of token.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/gu)) {
    const escaped = part[1]
    if (escaped) bytes.push(gitEscapes[escaped] ?? Number.parseInt(escaped, 8))
    else for (const byte of encoder.encode(part[2])) bytes.push(byte)
  }
  return decoder.decode(new Uint8Array(bytes)).slice(2)
}

export function parseWorkspacePatch(patch: string): ReadonlyMap<string, DiffHunk[]> {
  const files = new Map<string, DiffHunk[]>()
  let original: string | undefined
  let current: string | undefined
  let before = 0
  let after = 0
  let hunk: DiffHunk | undefined

  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      original = undefined
      current = undefined
      hunk = undefined
    }
    else if (text.startsWith('@@ ')) {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text)
      const path = current ?? original
      if (!range || path === undefined) continue
      before = Number(range[1])
      after = Number(range[2])
      hunk = { header: text, lines: [] }
      const hunks = files.get(path)
      if (hunks) hunks.push(hunk)
      else files.set(path, [hunk])
    }
    else if (!hunk) {
      if (text.startsWith('--- ')) original = patchPath(text)
      else if (text.startsWith('+++ ')) current = patchPath(text)
    }
    else {
      switch (text[0]) {
        case ' ': hunk.lines.push({ kind: 'context', before: before++, after: after++, text: text.slice(1) }); break
        case '-': hunk.lines.push({ kind: 'deletion', before: before++, after: null, text: text.slice(1) }); break
        case '+': hunk.lines.push({ kind: 'addition', before: null, after: after++, text: text.slice(1) }); break
        case '\\': {
          const previous = hunk.lines.at(-1)
          if (previous) previous.newlineNote = text.slice(2)
          break
        }
      }
    }
  }

  return files
}

export function workspaceDiffRows(hunks: DiffHunk[], split: boolean, limit: number): { rows: DiffRow[], more: boolean } {
  const rows: DiffRow[] = []
  for (const row of diffRows(hunks, split)) {
    if (rows.length === limit) return { rows, more: true }
    rows.push(row)
  }
  return { rows, more: false }
}

function* diffRows(hunks: DiffHunk[], split: boolean): Generator<DiffRow> {
  let id = 0
  for (const hunk of hunks) {
    yield { id: id++, header: hunk.header, cells: [] }
    let index = 0
    while (index < hunk.lines.length) {
      const line = hunk.lines[index++]!
      if (split && (line.kind === 'deletion' || line.kind === 'addition')) {
        const deletions = line.kind === 'deletion' ? [line] : []
        const additions = line.kind === 'addition' ? [line] : []
        while (index < hunk.lines.length) {
          const next = hunk.lines[index]!
          if (next.kind === 'deletion') deletions.push(next)
          else if (next.kind === 'addition') additions.push(next)
          else break
          index++
        }
        const count = Math.max(deletions.length, additions.length)
        for (let offset = 0; offset < count; offset++)
          yield { id: id++, cells: [deletions[offset] ?? null, additions[offset] ?? null] }
      }
      else yield { id: id++, cells: split ? [line, line] : [line] }
    }
  }
}

/** Render at most a page around a linked line, even when the patch has thousands of rows. */
export function workspaceDiffLinkedRows(hunks: DiffHunk[], split: boolean, limit: number, location: DiffLineLocation, pageSize = limit) {
  const lead = Math.min(24, Math.floor(pageSize / 2))
  const id = linkedRowId(hunks, split, location)
  const start = id === undefined || id < pageSize ? 0 : id - lead
  const rows: DiffRow[] = []
  for (const row of diffRows(hunks, split)) {
    if (row.id < start) continue
    if (rows.length === limit) return { rows, earlier: start > 0, more: true }
    rows.push(row)
  }
  return { rows, earlier: start > 0, more: false }
}

function linkedRowId(hunks: DiffHunk[], split: boolean, location: DiffLineLocation): number | undefined {
  for (const row of diffRows(hunks, split)) {
    const cells = split ? [row.cells[location.side === 'before' ? 0 : 1]] : row.cells
    if (cells.some(cell => cell?.[location.side] === location.line)) return row.id
  }
}

export function hasWorkspaceDiffLine(hunks: DiffHunk[] | undefined, location: DiffLineLocation): boolean {
  return Boolean(hunks?.some(hunk => hunk.lines.some(line => line[location.side] === location.line)))
}

export function workspaceDiffLocation(hash: string): DiffLineLink | null {
  if (!hash.startsWith('#diff?')) return null
  const params = new URLSearchParams(hash.slice('#diff?'.length))
  const path = params.get('file')
  const side = params.get('side')
  const line = params.get('line')
  const mode = params.get('mode')
  const target = params.get('target') || undefined
  if (!path || path.includes('\0') || (side !== 'before' && side !== 'after') || !positiveInteger(line)) return null
  if (mode === 'commit' && !/^[\da-f]{40}(?:[\da-f]{24})?$/u.test(target ?? '')) return null
  if (mode === 'turn' && !positiveInteger(target)) return null
  if (mode === 'branch' && target && !/^refs\/(?:heads|remotes)\/.+/u.test(target)) return null
  if (mode !== 'commit' && mode !== 'turn' && mode !== 'branch' && mode !== 'session' && mode !== 'uncommitted') return null
  return { path, side, line: Number(line), mode, target }
}

function positiveInteger(value: string | null | undefined): boolean {
  return /^[1-9]\d*$/u.test(value ?? '') && Number.isSafeInteger(Number(value))
}

export function workspaceDiffLink(href: string, location: DiffLineLink): string {
  const url = new URL(href)
  const profile = url.searchParams.get('profile')
  url.search = ''
  if (profile && positiveInteger(profile)) url.searchParams.set('profile', profile)
  const params = new URLSearchParams({ file: location.path, side: location.side, line: String(location.line), mode: location.mode })
  if (location.target) params.set('target', location.target)
  url.hash = `diff?${params}`
  return url.href
}

export function currentWorkspaceDiffLink(element?: Element | null): DiffLineLink | null {
  return workspaceDiffLocation(element?.ownerDocument.location.hash ?? '')
}

export function copyWorkspaceDiffLink(element: Element, location: DiffLineLink, native?: NativeClipboard): Promise<void> {
  return writeClipboardText(element, workspaceDiffLink(element.ownerDocument.location.href, location), native)
}

export function revealWorkspaceDiffLine(pane: Element | undefined, location: DiffLineLocation, focus = false): void {
  const body = pane?.querySelector<HTMLElement>('[data-diff-body]')
  const patch = pane?.querySelector<HTMLElement>(`[data-diff-path="${CSS.escape(location.path)}"]`)
  const line = patch?.querySelector<HTMLButtonElement>(`[data-diff-side="${location.side}"][data-diff-number="${location.line}"]:not([hidden])`)
  if (!body || !patch || !line) return
  if (focus) line.focus({ preventScroll: true })
  const bodyBounds = body.getBoundingClientRect()
  const patchBounds = patch.getBoundingClientRect()
  const lineBounds = line.getBoundingClientRect()
  if (lineBounds.top < bodyBounds.top || lineBounds.bottom > bodyBounds.bottom)
    body.scrollTop += lineBounds.top - bodyBounds.top - (body.clientHeight - lineBounds.height) / 2
  if (lineBounds.left < patchBounds.left) patch.scrollLeft += lineBounds.left - patchBounds.left
  else if (lineBounds.right > patchBounds.right) patch.scrollLeft += lineBounds.right - patchBounds.right
}

export function moveWorkspaceDiffLine(event: KeyboardEvent): DiffLineLocation | null {
  if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return null
  const patch = event.currentTarget as HTMLElement
  const active = (event.target as Element).closest<HTMLButtonElement>('[data-diff-side]')
  const rows = [...patch.querySelectorAll('[data-diff-row]:not([hidden])')]
  const activeIndex = rows.indexOf(active?.closest('[data-diff-row]') ?? patch)
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
  let index = activeIndex
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = rows.length - 1
  else if (event.key === 'ArrowDown') index++
  else if (event.key === 'ArrowUp') index = activeIndex < 0 ? rows.length - 1 : activeIndex - 1

  const side = horizontal ? (event.key === 'ArrowLeft' ? 'before' : 'after') : active?.dataset.diffSide
  const buttons = rows[index]?.querySelectorAll<HTMLButtonElement>('[data-diff-side]:not([hidden]):not(:disabled)')
  if (!buttons?.length) return null
  const matching = [...buttons].find(button => button.dataset.diffSide === side)
  const next = matching ?? (horizontal ? undefined : buttons[0])
  if (!next || !patch.dataset.diffPath) return null
  event.preventDefault()
  next.focus()
  return { path: patch.dataset.diffPath, side: next.dataset.diffSide === 'before' ? 'before' : 'after', line: Number(next.dataset.diffNumber) }
}
