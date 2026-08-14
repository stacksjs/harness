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
}

export interface Cell {
  ch: string
  style: Style
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

function blankRow(cols: number): Cell[] {
  return Array.from({ length: cols }, () => ({ ch: ' ', style: DEFAULT_STYLE }))
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

export class Terminal {
  private _cols: number
  private _rows: number
  private readonly scrollbackLimit: number
  private readonly convertEol: boolean

  private grid: Cell[][]
  scrollback: Cell[][] = []
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

  /** The main buffer, parked while the alternate screen is active. */
  private savedMain: { grid: Cell[][], x: number, y: number } | null = null
  private savedCursor: { x: number, y: number } | null = null

  constructor(options: TerminalOptions = {}) {
    this._cols = Math.max(2, options.cols ?? 80)
    this._rows = Math.max(1, options.rows ?? 24)
    this.scrollbackLimit = options.scrollback ?? 1000
    this.convertEol = options.convertEol ?? true
    this.grid = Array.from({ length: this.rows }, () => blankRow(this.cols))
  }

  get cols(): number {
    return this._cols
  }

  get rows(): number {
    return this._rows
  }

  get onAltScreen(): boolean {
    return this.savedMain !== null
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

    const fit = (grid: Cell[][]): Cell[][] => grid.map((row) => {
      if (row.length > nextCols) return row.slice(0, nextCols)
      if (row.length < nextCols) return [...row, ...blankRow(nextCols - row.length)]
      return row
    })

    this.grid = fit(this.grid)
    if (this.savedMain) this.savedMain.grid = fit(this.savedMain.grid)

    const fitRows = (grid: Cell[][], intoScrollback: boolean): { grid: Cell[][], removed: number } => {
      let removed = 0
      while (grid.length > nextRows) {
        const top = grid.shift()
        removed++
        if (intoScrollback && top) {
          this.scrollback.push(top)
          if (this.scrollback.length > this.scrollbackLimit) this.scrollback.shift()
        }
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
        // Terminated by BEL or ST (ESC \). Titles and hyperlinks are metadata
        // a transcript does not model.
        if (ch === '\x07') {
          this.state = ParseState.Ground
        }
        else if (ch === '\x1b') {
          this.oscEscape = true
        }
        else if (this.oscEscape) {
          this.state = ch === '\\' ? ParseState.Ground : ParseState.Osc
          this.oscEscape = false
        }
        return

      case ParseState.Charset:
        this.state = ParseState.Ground
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
      this.lineFeed()
    }
    this.grid[this.y]![this.x] = { ch, style: this.style }
    if (this.x === this.cols - 1) this.pendingWrap = true
    else this.x += 1
  }

  private lineFeed(): void {
    if (this.y < this.rows - 1) {
      this.y += 1
      return
    }
    const scrolled = this.grid.shift()!
    this.grid.push(blankRow(this.cols))
    // The alternate screen is a full-screen app's canvas; what scrolls off it
    // is repaint debris, not history.
    if (!this.onAltScreen) {
      this.scrollback.push(scrolled)
      if (this.scrollback.length > this.scrollbackLimit) this.scrollback.shift()
    }
  }

  private csi(final: string): void {
    const params = this.csiParams.split(';').map(p => (p === '' ? Number.NaN : Number.parseInt(p, 10)))
    const p = (index: number, fallback: number): number =>
      Number.isNaN(params[index]) || params[index] === undefined ? fallback : params[index]

    if (this.csiPrivate) {
      // 1049 (and its older halves 47/1047) is the alternate screen; 25 is
      // cursor visibility, which a grid snapshot has no use for.
      if (final === 'h' && (p(0, 0) === 1049 || p(0, 0) === 47 || p(0, 0) === 1047)) this.enterAlt()
      if (final === 'l' && (p(0, 0) === 1049 || p(0, 0) === 47 || p(0, 0) === 1047)) this.exitAlt()
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
      if (mode === 3) this.scrollback = []
    }
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.y]!
    const [from, to] = mode === 0 ? [this.x, this.cols] : mode === 1 ? [0, this.x + 1] : [0, this.cols]
    for (let col = from; col < to; col++) row[col] = { ch: ' ', style: DEFAULT_STYLE }
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
  viewport(): Cell[][] {
    return this.grid
  }

  /** Scrollback + viewport, trailing blank rows dropped. */
  snapshot(): Cell[][] {
    const all = [...this.scrollback, ...this.grid]
    let end = all.length
    while (end > 0 && all[end - 1]!.every(cell => cell.ch === ' ')) end -= 1
    return all.slice(0, end)
  }

  /** Plain text of the snapshot — what `stripAnsi` would have produced, plus layout. */
  toText(): string {
    return this.snapshot()
      .map(row => row.map(cell => cell.ch).join('').replace(/ +$/, ''))
      .join('\n')
  }
}

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
