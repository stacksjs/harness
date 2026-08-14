import { describe, expect, it } from 'bun:test'
import { stripAnsi, Terminal } from '../src/terminal'

/**
 * Sequences below are either verbatim from live tools (the git diff fixture
 * was recorded with `od -c` from a real `git -c color.diff=always diff`) or
 * the canonical spellings of patterns real CLIs emit — progress bars over
 * `\r`, spinners over `\x1b[K`, full-screen apps over 1049. Both beat
 * invention: a terminal that only renders sequences it invented for its own
 * tests renders nothing real.
 */

function term(cols = 20, rows = 5): Terminal {
  return new Terminal({ cols, rows })
}

describe('printing and wrap', () => {
  it('prints text at the cursor', () => {
    const t = term()
    t.write('hello')
    expect(t.toText()).toBe('hello')
  })

  it('wraps only when the next printable arrives, not on the last column', () => {
    // Deferred wrap: an exactly-cols-wide line followed by \r\n must stay one
    // line. Eager wrap would put every full-width progress bar on two.
    const t = term(5, 4)
    t.write('12345\r\nnext')
    expect(t.toText()).toBe('12345\nnext')
  })

  it('wraps a line longer than the viewport', () => {
    const t = term(5, 4)
    t.write('1234567')
    expect(t.toText()).toBe('12345\n67')
  })

  it('advances to 8-column tab stops', () => {
    const t = term(20, 2)
    t.write('a\tb')
    expect(t.toText()).toBe('a       b')
  })
})

describe('carriage return and overwrite', () => {
  it('renders the last write of a progress line', () => {
    // The single most common animation in CLI output. A renderer without
    // cursor state shows every frame concatenated.
    const t = term()
    t.write('done 10%\rdone 50%\rdone 99%')
    expect(t.toText()).toBe('done 99%')
  })

  it('clears the remnant of a longer earlier frame with EL', () => {
    const t = term()
    t.write('downloading 99%\rdone\x1B[K')
    expect(t.toText()).toBe('done')
  })

  it('backspace moves, it does not erase', () => {
    const t = term()
    t.write('abc\b\bX')
    expect(t.toText()).toBe('aXc')
  })
})

describe('cursor addressing', () => {
  it('moves absolutely with CUP, 1-based', () => {
    const t = term(10, 3)
    t.write('\x1B[2;3HX')
    expect(t.toText()).toBe('\n  X')
  })

  it('moves relatively and clamps at the edges', () => {
    const t = term(10, 3)
    t.write('abc\x1B[10D\x1B[10AX')
    expect(t.toText()).toBe('Xbc')
  })

  it('saves and restores the cursor, both spellings', () => {
    const t = term(10, 3)
    t.write('ab\x1B7cd\x1B8X')
    expect(t.toText()).toBe('abXd')
    const u = term(10, 3)
    u.write('ab\x1B[scd\x1B[uX')
    expect(u.toText()).toBe('abXd')
  })
})

describe('erase', () => {
  it('ED 2 clears the screen but keeps scrollback', () => {
    const t = term(10, 2)
    t.write('one\r\ntwo\r\nthree')
    t.write('\x1B[2J')
    expect(t.toText()).toBe('one')
    t.write('\x1B[3J')
    expect(t.toText()).toBe('')
  })

  it('ED 0 erases from the cursor down', () => {
    const t = term(10, 3)
    t.write('aaa\r\nbbb\r\nccc\x1B[2;2H\x1B[0J')
    expect(t.toText()).toBe('aaa\nb')
  })

  it('EL variants erase within the line', () => {
    const t = term(10, 2)
    t.write('abcdef\x1B[3G\x1B[1K')
    // EL 1 erases through the cursor column inclusive.
    expect(t.toText()).toBe('   def')
  })
})

describe('scrollback', () => {
  it('keeps what scrolls off the top', () => {
    const t = term(10, 2)
    t.write('one\r\ntwo\r\nthree\r\nfour')
    expect(t.toText()).toBe('one\ntwo\nthree\nfour')
    expect(t.viewport().length).toBe(2)
  })

  it('caps the scrollback', () => {
    const t = new Terminal({ cols: 4, rows: 2, scrollback: 3 })
    for (let i = 0; i < 10; i++) t.write(`l${i}\r\n`)
    expect(t.scrollback.length).toBe(3)
  })
})

describe('the alternate screen', () => {
  it('is its own canvas, and leaves the main buffer untouched', () => {
    // What a full-screen app (vim, htop) paints must vanish when it exits —
    // that is the whole contract of 1049.
    const t = term(10, 3)
    t.write('shell$')
    t.write('\x1B[?1049h')
    t.write('\x1B[2JFULLSCREEN')
    expect(t.onAltScreen).toBe(true)
    t.write('\x1B[?1049l')
    expect(t.onAltScreen).toBe(false)
    expect(t.toText()).toBe('shell$')
  })

  it('does not pollute scrollback while active', () => {
    const t = term(10, 2)
    t.write('\x1B[?1049h')
    for (let i = 0; i < 5; i++) t.write(`frame${i}\r\n`)
    t.write('\x1B[?1049l')
    expect(t.scrollback.length).toBe(0)
  })
})

describe('SGR', () => {
  it('applies 16-color, 256-color and truecolor foregrounds', () => {
    const t = term()
    t.write('\x1B[31mr\x1B[38;5;208mo\x1B[38;2;1;2;3mt')
    const [row] = t.viewport()
    expect(row[0].style.fg).toBe(1)
    expect(row[1].style.fg).toBe(208)
    expect(row[2].style.fg).toBe('#010203')
  })

  it('treats the empty SGR as a full reset, the way git spells it', () => {
    // Recorded: git emits `\x1b[m`, not `\x1b[0m`.
    const t = term()
    t.write('\x1B[1;31mred\x1B[mplain')
    const [row] = t.viewport()
    expect(row[0].style.bold).toBe(true)
    expect(row[3].style).toMatchObject({ fg: null, bold: false })
  })

  it('accumulates attributes and clears them selectively', () => {
    const t = term()
    t.write('\x1B[1m\x1B[4ma\x1B[24mb')
    const [row] = t.viewport()
    expect(row[0].style).toMatchObject({ bold: true, underline: true })
    expect(row[1].style).toMatchObject({ bold: true, underline: false })
  })

  it('consumes extended-color parameters without bleeding into later codes', () => {
    // 38;5;n;4 — the 4 is underline, not part of the color.
    const t = term()
    t.write('\x1B[38;5;100;4mx')
    const [row] = t.viewport()
    expect(row[0].style.fg).toBe(100)
    expect(row[0].style.underline).toBe(true)
  })

  it('bright backgrounds map to indices 8-15', () => {
    const t = term()
    t.write('\x1B[101mx')
    expect(t.viewport()[0][0].style.bg).toBe(9)
  })
})

describe('sequences we deliberately drop', () => {
  it('swallows OSC titles and hyperlinks whole, both terminators', () => {
    const t = term(30, 2)
    t.write('\x1B]0;window title\x07before')
    t.write('\x1B]8;;https://x\x1B\\after')
    expect(t.toText()).toBe('beforeafter')
  })

  it('swallows charset designation and unknown CSI finals', () => {
    const t = term()
    t.write('\x1B(Bok\x1B[2 qmore')
    expect(t.toText()).toBe('okmore')
  })
})

describe('a recorded git diff renders faithfully', () => {
  // Verbatim bytes from `git -c color.diff=always diff` on a three-line file
  // with one changed line (od -c dump in the working notes). Bold headers,
  // cyan hunk, red deletion, green addition, and the bare `\x1b[m` reset.
  const DIFF
    = '\x1B[1mdiff --git a/f.txt b/f.txt\x1B[m\n'
      + '\x1B[1mindex 85c3040..e50310a 100644\x1B[m\n'
      + '\x1B[1m--- a/f.txt\x1B[m\n'
      + '\x1B[1m+++ b/f.txt\x1B[m\n'
      + '\x1B[36m@@ -1,3 +1,3 @@\x1B[m\n'
      + ' alpha\x1B[m\n'
      + '\x1B[31m-beta\x1B[m\n'
      + '\x1B[32m+\x1B[m\x1B[32mBETA\x1B[m\n'
      + ' gamma\x1B[m\n'

  it('reproduces the text layout exactly', () => {
    const t = new Terminal({ cols: 40, rows: 12 })
    t.write(DIFF)
    expect(t.toText()).toBe(
      'diff --git a/f.txt b/f.txt\n'
      + 'index 85c3040..e50310a 100644\n'
      + '--- a/f.txt\n'
      + '+++ b/f.txt\n'
      + '@@ -1,3 +1,3 @@\n'
      + ' alpha\n'
      + '-beta\n'
      + '+BETA\n'
      + ' gamma',
    )
  })

  it('colors the lines the way git meant', () => {
    const t = new Terminal({ cols: 40, rows: 12 })
    t.write(DIFF)
    const rows = t.snapshot()
    expect(rows[0][0].style.bold).toBe(true)
    expect(rows[4][0].style.fg).toBe(6)
    expect(rows[6][0].style.fg).toBe(1)
    expect(rows[7][0].style.fg).toBe(2)
    expect(rows[8][1].style.fg).toBeNull()
  })
})

describe('newline conversion', () => {
  it('defaults to treating LF as CRLF, because piped output has no ONLCR', () => {
    const t = new Terminal({ cols: 10, rows: 4 })
    t.write('one\ntwo')
    expect(t.toText()).toBe('one\ntwo')
  })

  it('renders the staircase faithfully when a PTY transport turns it off', () => {
    const t = new Terminal({ cols: 10, rows: 4, convertEol: false })
    t.write('one\ntwo')
    expect(t.toText()).toBe('one\n   two')
  })
})

describe('stripAnsi', () => {
  it('removes SGR, OSC and control noise but keeps text', () => {
    expect(stripAnsi('\x1B[1;31mhot\x1B[m \x1B]0;t\x07plain\x1B(B!'))
      .toBe('hot plain!')
  })

  it('leaves newlines and tabs alone', () => {
    expect(stripAnsi('a\tb\nc')).toBe('a\tb\nc')
  })
})

describe('resize', () => {
  it('pads wider and taller without touching content', () => {
    const term = new Terminal({ cols: 10, rows: 2 })
    term.write('alpha\r\nbeta')
    term.resize(20, 4)
    expect(term.cols).toBe(20)
    expect(term.rows).toBe(4)
    expect(term.toText()).toBe('alpha\nbeta')
  })

  it('pushes rows off the top into scrollback when shrinking, keeping the cursor line', () => {
    const term = new Terminal({ cols: 10, rows: 4 })
    term.write('one\r\ntwo\r\nthree\r\nfour')
    term.resize(10, 2)
    expect(term.rows).toBe(2)
    // The viewport keeps the bottom — where the cursor lives.
    expect(term.toText()).toBe('one\ntwo\nthree\nfour')
    expect(term.scrollback.length).toBe(2)
    // The next write lands after "four", not on a mispositioned row.
    term.write('!')
    expect(term.toText()).toContain('four!')
  })

  it('truncates and clamps the cursor when narrowing', () => {
    const term = new Terminal({ cols: 20, rows: 2 })
    term.write('0123456789abcdefghij')
    term.resize(8, 2)
    expect(term.cols).toBe(8)
    expect(term.toText()).toBe('01234567')
    // Writing after the clamp must not throw or land off-grid.
    term.write('X')
    expect(term.toText().length).toBeGreaterThan(0)
  })

  it('is SIGWINCH-shaped: no reflow, scrollback keeps its historical width', () => {
    const term = new Terminal({ cols: 12, rows: 2, scrollback: 10 })
    term.write('wide-history\r\n\r\n\r\n')
    term.resize(6, 2)
    const historical = term.scrollback[0] ?? []
    expect(historical.length).toBe(12)
  })
})
