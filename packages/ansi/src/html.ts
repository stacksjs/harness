/**
 * Grid → HTML. The one renderer both consumers share: a terminal surface
 * paints a viewport, a transcript paints a snapshot — same cells, same spans.
 *
 * Indexed colors 0-15 become classes so a theme can re-tint them (the CSS
 * custom properties in `TERMINAL_CSS`); 16-255 and truecolor become inline
 * styles because they are exact by definition — there is nothing for a theme
 * to decide.
 */

import type { Cell, Style } from './terminal'
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
export function toHtml(rows: Cell[][], links = false): string {
  const lines: string[] = []
  for (const row of rows) {
    const text = links && row.some(cell => cell.ch === ':') ? row.map(cell => cell.ch).join('') : ''
    // The grid can wrap a URL at its right edge. Without a terminator on this
    // row, there is no complete inferred target. Explicit links carry theirs.
    const ranges = text ? terminalUrlRanges(text).filter(range => range.end < text.length) : []
    let line = ''
    let open = ''
    let key = ''
    let style: Style | undefined
    let explicitLink: string | null = null
    let activeLink: string | null = null
    let textOffset = 0
    let rangeIndex = 0
    for (const cell of row) {
      const styleChanged = style !== cell.style
      if (links && styleChanged) explicitLink = cell.style.link ? terminalWebUrl(cell.style.link) : null
      while (ranges[rangeIndex] && ranges[rangeIndex]!.end <= textOffset) rangeIndex++
      const range = ranges[rangeIndex]
      const link = explicitLink ?? (range && range.start <= textOffset ? range.url : null)
      const linkChanged = link !== activeLink
      if (linkChanged) {
        if (open) line += '</span>'
        if (activeLink) line += '</a>'
        if (link) line += `<a data-terminal-link href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">`
        activeLink = link
        open = ''
        key = ''
      }
      if (styleChanged || linkChanged) {
        style = cell.style
        const cellKey = styleKey(style)
        if (cellKey !== key) {
          if (open) line += '</span>'
          open = openSpan(style)
          line += open
          key = cellKey
        }
      }
      line += escapeHtml(cell.ch)
      textOffset += cell.ch.length
    }
    if (open) line += '</span>'
    if (activeLink) line += '</a>'
    lines.push(line.replace(/ +$/, ''))
  }
  return lines.join('\n')
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
