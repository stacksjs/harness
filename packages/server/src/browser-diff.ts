import type { WorkspaceReviewMode } from './diff'
import type { DiffHunk, DiffLine } from './diff-patch'
import type { NativeClipboard } from './browser-clipboard'
import { writeClipboardText } from './browser-clipboard'

export { parseWorkspacePatch } from './diff-patch'

export interface DiffLineLocation {
  path: string
  side: 'before' | 'after'
  line: number
}

export interface DiffLineLink extends DiffLineLocation {
  mode: WorkspaceReviewMode | 'session'
  target?: string
  repository?: string
}

interface DiffRow {
  id: number
  key: string
  header?: string
  gap?: DiffGap
  cells: (DiffLine | null)[]
}

interface DiffGap {
  index: number
  before: number
  after: number
  count: number
  above: boolean
  below: boolean
}

interface VisibleContext {
  lines: string[]
  revealed: ReadonlyMap<number, { start: number, end: number }>
}

const CONTEXT_STEP = 20

export function workspaceDiffContextKey(hunks?: DiffHunk[]): string | undefined {
  const object = hunks?.[0]?.beforeObject
  if (!object || /^0+$/u.test(object) || !hunks?.every(hunk => {
    let before = 0
    let after = 0
    for (const line of hunk.lines) {
      if (line.before !== null) before++
      if (line.after !== null) after++
    }
    return before === hunk.beforeCount && after === hunk.afterCount
  })) return
  return `${object}:${hunks.map(hunk => hunk.header).join('\n')}`
}

function* diffContextGaps(hunks: DiffHunk[], lines: string[]): Generator<DiffGap> {
  let before = 1
  let after = 1
  for (let index = 0; index <= hunks.length; index++) {
    const hunk = hunks[index]
    const startBefore = hunk ? hunk.beforeStart + Number(hunk.beforeCount === 0) : lines.length + 1
    const startAfter = hunk ? hunk.afterStart + Number(hunk.afterCount === 0) : after + (startBefore - before)
    const count = startBefore - before
    if (count > 0 && startAfter - after === count && startBefore <= lines.length + 1)
      yield { index, before, after, count, above: Boolean(hunk), below: index > 0 }
    if (hunk) {
      before = startBefore + hunk.beforeCount
      after = startAfter + hunk.afterCount
    }
  }
}

export function expandWorkspaceDiffGap(context: VisibleContext, gap: DiffGap, action: 'above' | 'below' | 'all'): VisibleContext {
  const current = context.revealed.get(gap.index) ?? { start: 0, end: 0 }
  const step = action === 'all' ? gap.count : Math.min(CONTEXT_STEP, gap.count)
  const updated = action === 'above' ? { ...current, end: current.end + step } : { ...current, start: current.start + step }
  return { ...context, revealed: new Map(context.revealed).set(gap.index, updated) }
}

export function revealWorkspaceDiffContext(hunks: DiffHunk[], context: VisibleContext, location: DiffLineLocation): VisibleContext | undefined {
  for (const gap of diffContextGaps(hunks, context.lines)) {
    const offset = location.line - gap[location.side]
    if (offset >= 0 && offset < gap.count) return expandWorkspaceDiffGap(context, gap, 'all')
  }
}

export function workspaceDiffRows(hunks: DiffHunk[], split: boolean, limit: number, context?: VisibleContext): { rows: DiffRow[], more: boolean } {
  const rows: DiffRow[] = []
  for (const row of diffRows(hunks, split, context)) {
    if (rows.length === limit) return { rows, more: true }
    rows.push(row)
  }
  return { rows, more: false }
}

function* diffRows(hunks: DiffHunk[], split: boolean, context?: VisibleContext): Generator<DiffRow> {
  let id = 0
  const gaps = context ? new Map([...diffContextGaps(hunks, context.lines)].map(gap => [gap.index, gap])) : undefined
  for (let hunkIndex = 0; hunkIndex <= hunks.length; hunkIndex++) {
    const gap = gaps?.get(hunkIndex)
    if (gap && context) {
      const shown = context.revealed.get(hunkIndex) ?? { start: 0, end: 0 }
      const hiddenEnd = gap.count - shown.end
      for (let offset = 0; offset < gap.count; offset++) {
        if (offset >= shown.start && offset < hiddenEnd) {
          yield { id: id++, key: `gap-${hunkIndex}`, cells: [], gap: { ...gap, before: gap.before + offset, after: gap.after + offset, count: hiddenEnd - offset } }
          offset = hiddenEnd - 1
          continue
        }
        const before = gap.before + offset
        const after = gap.after + offset
        const line = { kind: 'context', before, after, text: context.lines[before - 1]! } as const
        yield { id: id++, key: `context-${before}`, cells: split ? [line, line] : [line] }
      }
    }
    const hunk = hunks[hunkIndex]
    if (!hunk) break
    yield { id: id++, key: `hunk-${hunkIndex}`, header: hunk.header, cells: [] }
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
          yield { id: id++, key: `edit-${deletions[offset]?.before ?? ''}-${additions[offset]?.after ?? ''}`, cells: [deletions[offset] ?? null, additions[offset] ?? null] }
      }
      else yield { id: id++, key: `line-${line.before ?? ''}-${line.after ?? ''}`, cells: split ? [line, line] : [line] }
    }
  }
}

/** Render at most a page around a linked line, even when the patch has thousands of rows. */
export function workspaceDiffLinkedRows(hunks: DiffHunk[], split: boolean, limit: number, location: DiffLineLocation, pageSize = limit, context?: VisibleContext) {
  const lead = Math.min(24, Math.floor(pageSize / 2))
  const id = linkedRowId(hunks, split, location, context)
  const start = id === undefined || id < pageSize ? 0 : id - lead
  const rows: DiffRow[] = []
  for (const row of diffRows(hunks, split, context)) {
    if (row.id < start) continue
    if (rows.length === limit) return { rows, earlier: start > 0, more: true }
    rows.push(row)
  }
  return { rows, earlier: start > 0, more: false }
}

function linkedRowId(hunks: DiffHunk[], split: boolean, location: DiffLineLocation, context?: VisibleContext): number | undefined {
  for (const row of diffRows(hunks, split, context)) {
    const cells = split ? [row.cells[location.side === 'before' ? 0 : 1]] : row.cells
    if (cells.some(cell => cell?.[location.side] === location.line)) return row.id
  }
}

export function hasWorkspaceDiffLine(hunks: DiffHunk[] | undefined, location: DiffLineLocation, context?: VisibleContext): boolean {
  if (!hunks) return false
  if (hunks.some(hunk => hunk.lines.some(line => line[location.side] === location.line))) return true
  if (!context) return false
  for (const gap of diffContextGaps(hunks, context.lines)) {
    const offset = location.line - gap[location.side]
    const revealed = context.revealed.get(gap.index)
    if (revealed && offset >= 0 && offset < gap.count)
      return offset < revealed.start || offset >= gap.count - revealed.end
  }
  return false
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
  const repository = params.get('repository') || undefined
  if (repository && (mode === 'session' || mode === 'turn')) return null
  return { path, side, line: Number(line), mode, target, ...(repository && { repository }) }
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
  if (location.repository) params.set('repository', location.repository)
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
