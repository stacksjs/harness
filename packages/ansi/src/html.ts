/**
 * Grid → HTML. The one renderer both consumers share: a terminal surface
 * paints a viewport, a transcript paints a snapshot — same cells, same spans.
 *
 * Indexed colors 0-15 become classes so a theme can re-tint them (the CSS
 * custom properties in `TERMINAL_CSS`); 16-255 and truecolor become inline
 * styles because they are exact by definition — there is nothing for a theme
 * to decide.
 */

import type { Cell, Style, TerminalRow } from './terminal'
import { terminalUrlRanges, terminalWebUrl } from './links'

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ESCAPES[ch] ?? ch)
}

/** The xterm 256-color cube, computed rather than tabled. */
export function indexedToHex(index: number): string {
  if (index < 16) {
    // The base 16 are theme territory; callers only need this for 16+, but a
    // stable answer beats a throw. These are xterm's defaults.
    const base = [
      '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
      '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
    ]
    return base[index] ?? '#000000'
  }
  if (index < 232) {
    const cube = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    const channels = [Math.floor(cube / 36) % 6, Math.floor(cube / 6) % 6, cube % 6]
    return `#${channels.map(v => (steps[v] ?? 0).toString(16).padStart(2, '0')).join('')}`
  }
  const gray = 8 + (index - 232) * 10
  return `#${gray.toString(16).padStart(2, '0').repeat(3)}`
}

function styleKey(style: Style): string {
  return `${String(style.fg)}|${String(style.bg)}|${+style.bold}${+style.dim}${+style.italic}${+style.underline}${+style.inverse}${+style.strike}`
}

function openSpan(style: Style): string {
  const classes: string[] = []
  const inline: string[] = []

  // Inverse swaps at render time, so the swap also swaps theme classes.
  const fg = style.inverse ? style.bg : style.fg
  const bg = style.inverse ? (style.fg ?? 'inv') : style.bg

  if (typeof fg === 'number') {
    if (fg < 16) classes.push(`t-fg-${fg}`)
    else inline.push(`color:${indexedToHex(fg)}`)
  }
  else if (typeof fg === 'string') {
    inline.push(`color:${fg}`)
  }

  if (typeof bg === 'number') {
    if (bg < 16) classes.push(`t-bg-${bg}`)
    else inline.push(`background:${indexedToHex(bg)}`)
  }
  else if (bg === 'inv') {
    classes.push('t-inv')
  }
  else if (typeof bg === 'string') {
    inline.push(`background:${bg}`)
  }

  if (style.bold) classes.push('t-bold')
  if (style.dim) classes.push('t-dim')
  if (style.italic) classes.push('t-italic')
  if (style.underline) classes.push('t-underline')
  if (style.strike) classes.push('t-strike')

  if (classes.length === 0 && inline.length === 0) return ''
  const cls = classes.length ? ` class="${classes.join(' ')}"` : ''
  const sty = inline.length ? ` style="${inline.join(';')}"` : ''
  return `<span${cls}${sty}>`
}

/**
 * Render rows of cells as HTML lines.
 *
 * One `<span>` per run of identically-styled cells, one text line per row —
 * the container is expected to be `white-space: pre` and monospace, which is
 * what keeps a grid a grid.
 */
export function toHtml(rows: TerminalRow[], links = false): string {
  const lines: string[] = []
  const explicitUrls = links ? new Map<string, string | null>() : null
  let start = 0
  let end = 0
  let logical: TerminalRow[] | null = null
  let ranges: ReturnType<typeof terminalUrlRanges> = []
  let activeLink: string | null = null
  let textOffset = 0
  let rangeIndex = 0

  function explicitTarget(cell: Cell): string | null {
    const raw = cell.style.link
    if (!raw || !explicitUrls) return null
    if (!explicitUrls.has(raw)) explicitUrls.set(raw, terminalWebUrl(raw))
    return explicitUrls.get(raw) ?? null
  }

  function inferredTarget(): string | null {
    while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= textOffset) rangeIndex++
    const range = ranges[rangeIndex]
    return range && range.start <= textOffset ? range.url : null
  }

  for (const [index, physicalRow] of rows.entries()) {
    if (index === end) {
      start = index
      end = start + 1
      while (links && rows[end]?.wrapFrom !== undefined) end++
      const multiline = end > start + 1
      logical = multiline && physicalRow.wrapFrom === undefined ? logicalRows(rows, start, end) : null
      let text = ''
      if (logical?.some(line => line.some(cell => cell.ch === ':')))
        text = logical.map(line => line.map(cell => cell.ch).join('')).join('')
      else if (links && !multiline && physicalRow.wrapFrom === undefined && physicalRow.some(cell => cell.ch === ':'))
        text = physicalRow.map(cell => cell.ch).join('')
      // A full last row can still receive more text in the next output chunk.
      ranges = text ? terminalUrlRanges(text).filter(range => range.end < text.length) : []
      rangeIndex = 0
      textOffset = 0
    }
    const row = logical?.[index - start] ?? physicalRow
    let line = ''
    let run = ''
    let open = ''
    let key = ''
    let style: Style | undefined
    let explicit: string | null = null
    for (const cell of row) {
      const styleChanged = style !== cell.style
      if (styleChanged) explicit = explicitTarget(cell)
      const link = explicit ?? (ranges.length ? inferredTarget() : null)
      const linkChanged = link !== activeLink
      if (linkChanged) {
        line += escapeHtml(run)
        run = ''
        if (open) line += '</span>'
        if (activeLink) line += '</a>'
        if (link) {
          const label = !explicit && end > start + 1 ? ` aria-label="${escapeHtml(link)}"` : ''
          line += `<a data-terminal-link href="${escapeHtml(link)}"${label} target="_blank" rel="noopener noreferrer">`
        }
        activeLink = link
        open = ''
        key = ''
      }
      if (styleChanged || linkChanged) {
        style = cell.style
        const cellKey = styleKey(style)
        if (cellKey !== key) {
          line += escapeHtml(run)
          run = ''
          if (open) line += '</span>'
          open = openSpan(style)
          line += open
          key = cellKey
        }
      }
      run += cell.ch
      if (ranges.length) textOffset += cell.ch.length
    }
    line += escapeHtml(run)
    if (open) line += '</span>'
    const continuation = index + 1 < end ? rows[index + 1]?.[0] : undefined
    if (activeLink && (!continuation || (explicitTarget(continuation) ?? inferredTarget()) !== activeLink)) {
      line += '</a>'
      activeLink = null
    }
    lines.push(line.replace(/ +$/, ''))
  }
  return lines.join('\n')
}

/** Remove only padding added after wrapping, keeping the original cell offsets. */
function logicalRows(rows: TerminalRow[], start: number, end: number): TerminalRow[] | null {
  const logical: TerminalRow[] = []
  for (let index = start; index < end; index++) {
    const row = rows[index]!
    const width = index + 1 < end ? rows[index + 1]!.wrapFrom! : row.length
    if (width > row.length || width < 0) return null
    if (width < row.length && row.slice(width).some(cell => cell.ch !== ' ' || cell.style.bg !== null || cell.style.inverse || cell.style.link)) return null
    logical.push(width === row.length ? row : row.slice(0, width))
  }
  return logical
}

/**
 * The theme contract for the 16 base colors and attributes. Ship once,
 * override the custom properties per theme; everything above 15 is inline
 * and theme-independent.
 */
export const TERMINAL_CSS = `
.t-bold { font-weight: 600; }
.t-dim { opacity: 0.6; }
.t-italic { font-style: italic; }
.t-underline { text-decoration: underline; }
.t-strike { text-decoration: line-through; }
.t-underline.t-strike { text-decoration: underline line-through; }
.t-inv { background: currentColor; }
${Array.from({ length: 16 }, (_, i) =>
  `.t-fg-${i} { color: var(--t-color-${i}); }\n.t-bg-${i} { background: var(--t-color-${i}); }`).join('\n')}
`.trim()
