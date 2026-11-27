/**
 * The emulator core: an escape stream in, a cell grid out.
 *
 * This is deliberately a pure state machine — no PTY, no rendering, no timers.
 * PLAN.md's M6 named the missing piece precisely ("nothing that renders ANSI"),
 * and the missing piece is this model, not the chrome around it: once bytes
 * become a grid of styled cells, a terminal surface is a renderer over it, and
 * tool output in a transcript is the same renderer with a smaller viewport.
 *
 * Coverage is the common-output subset, chosen the way the drivers choose
 * events: what real CLIs emit. SGR in all three color widths, cursor motion,
 * erase, deferred wrap, scrollback, the alternate screen. Unknown sequences
 * are consumed and dropped — for a transcript renderer, silently skipping a
 * sequence we do not model beats leaking half of it as text. Known punts, so
 * nobody rediscovers them: scroll regions (DECSTBM), wide/combining glyph
 * width, and tab stops other than every 8 columns.
 */

import { MAX_TERMINAL_URL, terminalWebUrl } from './links'

/** One cell's appearance. Shared by reference; never mutated after creation. */
export interface Style {
  /** `null` = default; 0-255 = indexed; '#rrggbb' = truecolor. */
  fg: number | string | null
  bg: number | string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
  link?: string
}

export interface Cell {
  ch: string
  style: Style
}

export interface TerminalRow extends Array<Cell> {
  /** Width of the preceding row at automatic wrap, or -1 if it was clipped. */
  wrapFrom?: number
}

export const DEFAULT_STYLE: Style = Object.freeze({
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  strike: false,
})

const BLANK: Cell = Object.freeze({ ch: ' ', style: DEFAULT_STYLE })

function blankRow(cols: number): TerminalRow {
  return Array<Cell>(cols).fill(BLANK)
}

type PackedRow = Array<[text: string, style: (Style & { wrapFrom?: number }) | null]>

function packRow(row: Cell[]): PackedRow {
  const result: PackedRow = []
  let lastStyle: Style | undefined
  for (const { ch, style } of row) {
    if (style === lastStyle) result.at(-1)![0] += ch
    else result.push([ch, style === DEFAULT_STYLE ? null : style])
    lastStyle = style
  }
  return result
}

function unpackRow(row: PackedRow, wrapFrom?: number): TerminalRow {
  const cells: TerminalRow = row.flatMap(([text, style]) => [...text].map(ch => ch === ' ' && !style ? BLANK : { ch, style: style ?? DEFAULT_STYLE }))
  if (wrapFrom) cells.wrapFrom = wrapFrom
  return cells
}

function packedWraps(rows: TerminalRow[]): number[] | undefined {
  if (rows.some(row => row.wrapFrom !== undefined)) return rows.map(row => row.wrapFrom ?? 0)
}

function packHistoryRow(row: TerminalRow): string {
  const cells = packRow(row)
  // Keep the original run tuple shape so older hosts can read the text.
  const first = cells[0]
  if (first && row.wrapFrom !== undefined) first[1] = { ...(first[1] ?? DEFAULT_STYLE), wrapFrom: row.wrapFrom }
  return JSON.stringify(cells)
}

function validHistoryColor(value: unknown): boolean {
  return value === null
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 255)
    || (typeof value === 'string' && /^#[\da-f]{6}$/iu.test(value))
}

function validHistoryStyle(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const style = value as Record<string, unknown>
  return validHistoryColor(style.fg) && validHistoryColor(style.bg)
    && ['bold', 'dim', 'italic', 'underline', 'inverse', 'strike'].every(key => typeof style[key] === 'boolean')
    && (style.link === undefined || (typeof style.link === 'string' && terminalWebUrl(style.link) === style.link))
    && (style.wrapFrom === undefined || style.wrapFrom === -1
      || (typeof style.wrapFrom === 'number' && Number.isInteger(style.wrapFrom) && style.wrapFrom >= 2 && style.wrapFrom <= 500))
}

function validHistoryRow(value: unknown): value is PackedRow {
  if (!Array.isArray(value) || value.length > 500) return false
  let columns = 0
  for (const run of value) {
    if (!Array.isArray(run) || run.length !== 2 || typeof run[0] !== 'string' || !validHistoryStyle(run[1])) return false
    if (run[0].length > 1000 || /[\u0000-\u001F\u007F]/u.test(run[0])) return false
    columns += [...run[0]].length
    if (columns > 500) return false
  }
  return true
}

function unpackHistoryRow(row: PackedRow): TerminalRow {
  const first = row[0]
  if (first?.[1]?.wrapFrom === undefined) return unpackRow(row)
  const { wrapFrom, ...style } = first[1]
  return unpackRow([[first[0], style], ...row.slice(1)], wrapFrom)
}

const ParseState = {
  Ground: 0,
  Escape: 1,
  Csi: 2,
  Osc: 3,
  /** ESC ( or ESC ) — charset designation; the next byte is consumed. */
  Charset: 4,
} as const
type ParseState = typeof ParseState[keyof typeof ParseState]

export interface TerminalOptions {
  cols?: number
  rows?: number
  /** Lines kept above the viewport once they scroll off. */
  scrollback?: number
  /** Optional budget for the packed scrollback representation, in UTF-8 bytes. */
  scrollbackBytes?: number
  /**
   * Treat `\n` as `\r\n`. Defaults on, because the near consumer is *piped*
   * tool output, where no PTY line discipline has done the translation and a
   * strict emulator renders every LF-only stream as a staircase (the recorded
   * git fixture is exactly such a stream). A real PTY transport, whose ONLCR
   * already sends `\r\n`, can pass false — with it on, the extra `\r` is
   * idempotent anyway.
   */
  convertEol?: boolean
}

type ShellPhase = 'unavailable' | 'prompt' | 'ready' | 'running'

export class Terminal {
  private _cols: number
  private _rows: number
  private readonly scrollbackLimit: number
  private readonly scrollbackByteLimit: number
  private scrollbackBytes = 0
  private scrollbackRowBytes: number[] = []
  private readonly convertEol: boolean

  private grid: TerminalRow[]
  scrollback: TerminalRow[] = []
  private x = 0
  private y = 0
  private style: Style = DEFAULT_STYLE
  /**
   * Deferred wrap, the way real terminals do it: writing the last column
   * parks the cursor instead of wrapping, and the *next* printable wraps.
   * Eager wrap would put every exactly-`cols`-wide progress bar on two lines.
   */
  private pendingWrap = false

  private state: ParseState = ParseState.Ground
  private csiParams = ''
  private csiPrivate = false
  private oscEscape = false
  private oscData = ''
  private oscOverflow = false
  private bracketedPaste = false
  private shellPhase: ShellPhase = 'unavailable'
  private lastExitStatus: number | null = null

  /** The main buffer, parked while the alternate screen is active. */
  private savedMain: { grid: TerminalRow[], x: number, y: number } | null = null
  private savedCursor: { x: number, y: number } | null = null

  constructor(options: TerminalOptions = {}) {
    this._cols = Math.max(2, options.cols ?? 80)
    this._rows = Math.max(1, options.rows ?? 24)
    this.scrollbackLimit = options.scrollback ?? 1000
    this.scrollbackByteLimit = options.scrollbackBytes ?? Infinity
    this.convertEol = options.convertEol ?? true
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols))
  }

  get cols(): number {
    return this._cols
  }

  get rows(): number {
    return this._rows
  }

  formatPaste(text: string): string {
    if (!text || !this.bracketedPaste) return text
    return '\x1B[200~' + text.replaceAll('\x1B[201~', '') + '\x1B[201~'
  }

  get shellActivity(): { phase: ShellPhase, lastExitStatus: number | null } {
    return { phase: this.shellPhase, lastExitStatus: this.lastExitStatus }
  }

  get onAltScreen(): boolean {
    return this.savedMain !== null
  }

  private rememberRow(row: TerminalRow): void {
    const bytes = Number.isFinite(this.scrollbackByteLimit) ? new TextEncoder().encode(packHistoryRow(row)).length + 1 : 0
    this.scrollback.push(row)
    this.scrollbackRowBytes.push(bytes)
    this.scrollbackBytes += bytes
    while (this.scrollback.length > this.scrollbackLimit || this.scrollbackBytes > this.scrollbackByteLimit) {
      this.scrollback.shift()
      this.scrollbackBytes -= this.scrollbackRowBytes.shift() ?? 0
    }
  }

  /** Capture the buffers and parser position so split escape sequences can finish after a reconnect. */
  checkpoint() {
    const gridWraps = packedWraps(this.grid)
    const historyWraps = packedWraps(this.scrollback)
    const mainWraps = this.savedMain ? packedWraps(this.savedMain.grid) : undefined
    return {
      cols: this.cols, rows: this.rows, grid: this.grid.map(packRow), history: this.scrollback.map(packRow),
      x: this.x, y: this.y, cursor: this.savedCursor, style: this.style, wrap: this.pendingWrap,
      main: this.savedMain && { ...this.savedMain, grid: this.savedMain.grid.map(packRow) },
      ...(gridWraps && { gridWraps }),
      ...(historyWraps && { historyWraps }),
      ...(mainWraps && { mainWraps }),
      parser: this.state, csi: this.csiParams, csiPrivate: this.csiPrivate, osc: this.oscData, oscEscape: this.oscEscape,
      ...(this.oscOverflow && { oscOverflow: true }),
      bracketedPaste: this.bracketedPaste, shellPhase: this.shellPhase, lastExitStatus: this.lastExitStatus,
    }
  }

  static fromCheckpoint(checkpoint: TerminalCheckpoint, options: TerminalOptions = {}): Terminal {
    const terminal = new Terminal({ ...options, cols: checkpoint.cols, rows: checkpoint.rows })
    terminal.grid = checkpoint.grid.map((row, index) => unpackRow(row, checkpoint.gridWraps?.[index]))
    for (const [index, row] of checkpoint.history.entries())
      terminal.rememberRow(unpackRow(row, checkpoint.historyWraps?.[index]))
    terminal.x = checkpoint.x
    terminal.y = checkpoint.y
    terminal.savedCursor = checkpoint.cursor
    terminal.style = checkpoint.style
    terminal.pendingWrap = checkpoint.wrap
    terminal.savedMain = checkpoint.main && {
      ...checkpoint.main,
      grid: checkpoint.main.grid.map((row, index) => unpackRow(row, checkpoint.mainWraps?.[index])),
    }
    terminal.state = checkpoint.parser
    terminal.csiParams = checkpoint.csi
    terminal.csiPrivate = checkpoint.csiPrivate
    terminal.oscData = checkpoint.osc
    terminal.oscEscape = checkpoint.oscEscape
    terminal.oscOverflow = checkpoint.oscOverflow === true
    terminal.bracketedPaste = checkpoint.bracketedPaste
    terminal.shellPhase = checkpoint.shellPhase
    terminal.lastExitStatus = checkpoint.lastExitStatus
    return terminal
  }

  /** Save the main screen and scrollback as styled rows, without live PTY state. */
  saveHistory(): string {
    const screen = this.savedMain?.grid ?? this.grid
    const cursorLine = this.savedMain?.y ?? this.y
    const lastLine = Math.max(cursorLine - 1, screen.findLastIndex(row => row.wrapFrom !== undefined
      || row.some(cell => cell.ch !== ' ' || cell.style !== DEFAULT_STYLE)))
    const rows: string[] = []
    const encoder = new TextEncoder()
    let bytes = 2 // JSON array brackets
    for (let index = this.scrollback.length + lastLine; index >= 0 && rows.length < this.scrollbackLimit; index--) {
      const row = index >= this.scrollback.length ? screen[index - this.scrollback.length] : this.scrollback[index]
      if (!row) continue
      const packed = packHistoryRow(row)
      // The scrollback budget already measured these immutable rows, including a delimiter.
      const rowBytes = this.scrollbackRowBytes[index] || encoder.encode(packed).length + 1
      bytes += rowBytes - (rows.length ? 0 : 1)
      if (bytes > this.scrollbackByteLimit) break
      rows.push(packed)
    }
    return `[${rows.reverse().join(',')}]`
  }

  /** Load display rows into a fresh terminal, with its default modes and empty grid. */
  restoreHistory(saved: string): boolean {
    if (saved.length > this.scrollbackByteLimit || new TextEncoder().encode(saved).length > this.scrollbackByteLimit) return false
    let rows: unknown
    try { rows = JSON.parse(saved) }
    catch { return false }
    if (!Array.isArray(rows) || rows.length > this.scrollbackLimit || !rows.every(validHistoryRow)) return false
    for (const row of rows) this.rememberRow(unpackHistoryRow(row))
    return rows.length > 0
  }

  /**
   * Change the grid's dimensions in place, the way a real terminal does on
   * SIGWINCH: no reflow. Rows pad or truncate to the new width; growing adds
   * blank rows at the bottom; shrinking pushes rows off the *top* into
   * scrollback, so the cursor's neighbourhood — the part being looked at —
   * survives. Scrollback keeps its historical widths, which the renderer
   * already tolerates.
   */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (nextCols === this._cols && nextRows === this._rows) return

    const fit = (grid: TerminalRow[]): TerminalRow[] => grid.map((row) => {
      if (row.length === nextCols) return row
      const fitted: TerminalRow = row.slice(0, nextCols)
      if (fitted.length < nextCols) fitted.push(...blankRow(nextCols - fitted.length))
      if (row.wrapFrom !== undefined) {
        const clipped = row.wrapFrom > nextCols || row.slice(nextCols).some(cell => cell.ch !== ' ')
        fitted.wrapFrom = clipped ? -1 : row.wrapFrom
      }
      return fitted
    })

    this.grid = fit(this.grid)
    if (this.savedMain) this.savedMain.grid = fit(this.savedMain.grid)

    const fitRows = (grid: TerminalRow[], intoScrollback: boolean): { grid: TerminalRow[], removed: number } => {
      let removed = 0
      while (grid.length > nextRows) {
        const top = grid.shift()
        removed++
        if (intoScrollback && top) this.rememberRow(top)
      }
      while (grid.length < nextRows) grid.push(blankRow(nextCols))
      return { grid, removed }
    }

    // The alternate screen has no scrollback by design; its rows just drop.
    const main = fitRows(this.grid, !this.onAltScreen)
    this.grid = main.grid
    this.y = Math.max(0, this.y - main.removed)
    if (this.savedMain) {
      const saved = fitRows(this.savedMain.grid, this.onAltScreen === true)
      this.savedMain.grid = saved.grid
      this.savedMain.y = Math.min(Math.max(0, this.savedMain.y - saved.removed), nextRows - 1)
      this.savedMain.x = Math.min(this.savedMain.x, nextCols - 1)
    }

    this._cols = nextCols
    this._rows = nextRows
    this.x = Math.min(this.x, nextCols - 1)
    this.y = Math.min(this.y, nextRows - 1)
    this.pendingWrap = false
  }

  write(text: string): void {
    for (const ch of text) this.consume(ch)
  }

  private consume(ch: string): void {
    switch (this.state) {
      case ParseState.Ground:
        return this.ground(ch)

      case ParseState.Escape:
        if (ch === '[') {
          this.state = ParseState.Csi
          this.csiParams = ''
          this.csiPrivate = false
        }
        else if (ch === ']') {
          this.state = ParseState.Osc
          this.oscEscape = false
          this.oscData = ''
          this.oscOverflow = false
        }
        else if (ch === '(' || ch === ')') {
          this.state = ParseState.Charset
        }
        else if (ch === '7') {
          this.savedCursor = { x: this.x, y: this.y }
          this.state = ParseState.Ground
        }
        else if (ch === '8') {
          if (this.savedCursor) ({ x: this.x, y: this.y } = this.savedCursor)
          this.pendingWrap = false
          this.state = ParseState.Ground
        }
        else {
          // ESC M, ESC =, ESC > and friends — consumed, not modelled.
          this.state = ParseState.Ground
        }
        return

      case ParseState.Csi:
        if (ch === '?' && this.csiParams === '') {
          this.csiPrivate = true
        }
        else if ((ch >= '0' && ch <= '9') || ch === ';') {
          this.csiParams += ch
        }
        else if (ch >= '@' && ch <= '~') {
          this.state = ParseState.Ground
          this.csi(ch)
        }
        // Intermediate bytes (space, !, ", ...) are collected nowhere: the
        // sequences that carry them are ones we drop whole.
        return

      case ParseState.Osc:
        if (ch === '\x07' || (this.oscEscape && ch === '\\')) {
          this.state = ParseState.Ground
          if (this.oscData.startsWith('8;')) this.applyHyperlink()
          else if (!this.oscOverflow) this.applyShellMarker()
        }
        else if (ch === '\x1b') {
          this.oscEscape = true
        }
        else {
          // OSC 8 needs room for its target. Other commands keep the small
          // OSC 133 budget. An incomplete target must never become a link.
          const limit = this.oscData.startsWith('8;') ? MAX_TERMINAL_URL + 128 : 32
          const payload = (this.oscEscape ? '\x1b' : '') + ch
          if (this.oscData.length + payload.length <= limit && !this.oscOverflow) this.oscData += payload
          else this.oscOverflow = true
          this.oscEscape = false
        }
        return

      case ParseState.Charset:
        this.state = ParseState.Ground
    }
  }

  private applyHyperlink(): void {
    const separator = this.oscData.indexOf(';', 2)
    const link = separator < 0 || this.oscOverflow ? null : terminalWebUrl(this.oscData.slice(separator + 1))
    if (link) this.style = Object.freeze({ ...this.style, link })
    else if (this.style.link !== undefined) {
      const style = { ...this.style }
      delete style.link
      this.style = Object.freeze(style)
    }
  }

  private applyShellMarker(): void {
    if (this.oscData === '133;A') this.shellPhase = 'prompt'
    else if (this.oscData === '133;B') this.shellPhase = 'ready'
    else if (this.oscData === '133;C') this.shellPhase = 'running'
    else {
      const result = /^133;D(?:;(-?\d{1,10}))?$/.exec(this.oscData)
      if (result) {
        this.shellPhase = 'prompt'
        if (result[1] !== undefined) this.lastExitStatus = Number(result[1])
      }
    }
  }

  private ground(ch: string): void {
    switch (ch) {
      case '\x1b':
        this.state = ParseState.Escape
        return
      case '\n':
        this.pendingWrap = false
        if (this.convertEol) this.x = 0
        this.lineFeed()
        return
      case '\r':
        this.x = 0
        this.pendingWrap = false
        return
      case '\b':
        this.x = Math.max(0, this.x - 1)
        this.pendingWrap = false
        return
      case '\t':
        this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8)
        this.pendingWrap = false
        return
      case '\x07':
        return
      default:
        if (ch < ' ') return
        this.print(ch)
    }
  }

  private print(ch: string): void {
    if (this.pendingWrap) {
      this.pendingWrap = false
      this.x = 0
      this.lineFeed(this.cols)
    }
    this.grid[this.y]![this.x] = { ch, style: this.style }
    if (this.x === this.cols - 1) this.pendingWrap = true
    else this.x += 1
  }

  private lineFeed(wrapFrom?: number): void {
    if (this.y < this.rows - 1) this.y += 1
    else {
      const scrolled = this.grid.shift()!
      this.grid.push(blankRow(this.cols))
      // The alternate screen's offscreen rows are repaint debris.
      if (!this.onAltScreen) this.rememberRow(scrolled)
    }
    const row = this.grid[this.y]!
    if (wrapFrom === undefined) delete row.wrapFrom
    else row.wrapFrom = wrapFrom
  }

  private csi(final: string): void {
    const params = this.csiParams.split(';').map(p => (p === '' ? Number.NaN : Number.parseInt(p, 10)))
    const p = (index: number, fallback: number): number =>
      Number.isNaN(params[index]) || params[index] === undefined ? fallback : params[index]

    if (this.csiPrivate) {
      if (final !== 'h' && final !== 'l') return
      if (params.includes(2004)) this.bracketedPaste = final === 'h'
      // 1049 and its older variants select the alternate screen.
      if (params.some(mode => mode === 1049 || mode === 47 || mode === 1047)) {
        if (final === 'h') this.enterAlt()
        else this.exitAlt()
      }
      return
    }

    switch (final) {
      case 'm':
        return this.sgr(params)
      case 'H':
      case 'f':
        this.y = clamp(p(0, 1) - 1, 0, this.rows - 1)
        this.x = clamp(p(1, 1) - 1, 0, this.cols - 1)
        this.pendingWrap = false
        return
      case 'A':
        this.y = Math.max(0, this.y - p(0, 1))
        return
      case 'B':
        this.y = Math.min(this.rows - 1, this.y + p(0, 1))
        return
      case 'C':
        this.x = Math.min(this.cols - 1, this.x + p(0, 1))
        this.pendingWrap = false
        return
      case 'D':
        this.x = Math.max(0, this.x - p(0, 1))
        this.pendingWrap = false
        return
      case 'G':
        this.x = clamp(p(0, 1) - 1, 0, this.cols - 1)
        this.pendingWrap = false
        return
      case 'J':
        return this.eraseDisplay(p(0, 0))
      case 'K':
        return this.eraseLine(p(0, 0))
      case 's':
        this.savedCursor = { x: this.x, y: this.y }
        return
      case 'u':
        if (this.savedCursor) ({ x: this.x, y: this.y } = this.savedCursor)
        this.pendingWrap = false
        return
      default:
        // DECSTBM, insert/delete line, device queries — consumed, not modelled.
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0)
      for (let row = this.y + 1; row < this.rows; row++) this.grid[row] = blankRow(this.cols)
    }
    else if (mode === 1) {
      this.eraseLine(1)
      for (let row = 0; row < this.y; row++) this.grid[row] = blankRow(this.cols)
    }
    else if (mode === 2 || mode === 3) {
      for (let row = 0; row < this.rows; row++) this.grid[row] = blankRow(this.cols)
      if (mode === 3) {
        this.scrollback = []
        this.scrollbackRowBytes = []
        this.scrollbackBytes = 0
      }
    }
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.y]!
    const [from, to] = mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols]
    for (let col = from; col < to; col++) row[col] = { ch: ' ', style: DEFAULT_STYLE }
    if (from === 0 && to === this.cols) delete row.wrapFrom
  }

  private enterAlt(): void {
    if (this.onAltScreen) return
    this.savedMain = { grid: this.grid, x: this.x, y: this.y }
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols))
    this.x = 0
    this.y = 0
  }

  private exitAlt(): void {
    if (!this.savedMain) return
    this.grid = this.savedMain.grid
    this.x = this.savedMain.x
    this.y = this.savedMain.y
    this.savedMain = null
  }

  private sgr(params: number[]): void {
    // An empty CSI m is CSI 0 m.
    if (params.length === 1 && Number.isNaN(params[0])) params = [0]

    const next = { ...this.style }
    for (let i = 0; i < params.length; i++) {
      const raw = params[i]
      const code = raw === undefined || Number.isNaN(raw) ? 0 : raw
      switch (code) {
        case 0: Object.assign(next, DEFAULT_STYLE); break
        case 1: next.bold = true; break
        case 2: next.dim = true; break
        case 3: next.italic = true; break
        case 4: next.underline = true; break
        case 7: next.inverse = true; break
        case 9: next.strike = true; break
        case 22: next.bold = false; next.dim = false; break
        case 23: next.italic = false; break
        case 24: next.underline = false; break
        case 27: next.inverse = false; break
        case 29: next.strike = false; break
        case 39: next.fg = null; break
        case 49: next.bg = null; break
        case 38:
        case 48: {
          // 38;5;n and 38;2;r;g;b — the parameters belong to this code, so
          // the loop index must advance past what it consumes.
          const isFg = code === 38
          const kind = params[i + 1]
          if (kind === 5) {
            const value = clamp(params[i + 2] ?? 0, 0, 255)
            if (isFg) next.fg = value
            else next.bg = value
            i += 2
          }
          else if (kind === 2) {
            const [r, g, b] = [params[i + 2], params[i + 3], params[i + 4]]
              .map(v => clamp(v === undefined || Number.isNaN(v) ? 0 : v, 0, 255)) as [number, number, number]
            const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
            if (isFg) next.fg = hex
            else next.bg = hex
            i += 4
          }
          break
        }
        default:
          if (code >= 30 && code <= 37) next.fg = code - 30
          else if (code >= 90 && code <= 97) next.fg = code - 90 + 8
          else if (code >= 40 && code <= 47) next.bg = code - 40
          else if (code >= 100 && code <= 107) next.bg = code - 100 + 8
        // Anything else (blink, fonts, ideogram attrs) is dropped.
      }
    }
    this.style = Object.freeze(next)
  }

  /** The viewport rows, top to bottom. Live references — do not mutate. */
  viewport(): TerminalRow[] {
    return this.grid
  }

  /** Scrollback + viewport, trailing blank rows dropped. */
  snapshot(keepWrapBoundary = false): TerminalRow[] {
    const all = this.onAltScreen ? this.grid : [...this.scrollback, ...this.grid]
    let end = all.length
    while (end > 0 && (!keepWrapBoundary || all[end - 1]!.wrapFrom === undefined)
      && all[end - 1]!.every(cell => cell.ch === ' ')) end -= 1
    return all.slice(0, end)
  }

  /** Plain text of the snapshot — what `stripAnsi` would have produced, plus layout. */
  toText(): string {
    return this.snapshot()
      .map(row => row.map(cell => cell.ch).join('').replace(/ +$/, ''))
      .join('\n')
  }
}

export type TerminalCheckpoint = ReturnType<Terminal['checkpoint']>

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Strip escapes without a grid — for one-line labels and logs where layout
 * (cursor motion, overwrites) cannot matter. Anything that *renders* output
 * should go through the Terminal instead, or `\r` tricks reappear as garbage.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)?|[()][\x20-\x7E]|[@-Z\\-_])/g, '')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
}
