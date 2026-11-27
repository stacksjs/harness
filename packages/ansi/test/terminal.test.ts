import { describe, expect, it } from 'bun:test'
import { toHtml } from '../src/html'
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

it('restores output, the alternate buffer, and an unfinished escape sequence', () => {
  const original = new Terminal({ cols: 32, rows: 3, scrollback: 10 })
  original.write('earlier\r\nworking\r\n%\r\n\x1b[?2004h\x1b[?1049h\x1b[31mλ result\x1b[?104')
  const restored = Terminal.fromCheckpoint(JSON.parse(JSON.stringify(original.checkpoint())), { scrollback: 10 })
  expect(restored.onAltScreen).toBe(true)
  expect(restored.toText()).toBe('λ result')
  expect(restored.viewport()[0]?.[0]?.style.fg).toBe(1)
  expect(restored.formatPaste('pasted')).toBe('\x1b[200~pasted\x1b[201~')
  restored.write('9l\x1b]133;D;7\x07')
  expect(restored.onAltScreen).toBe(false)
  expect(restored.toText()).toBe('earlier\nworking\n%')
  expect(restored.shellActivity.lastExitStatus).toBe(7)
})

it('preserves OSC 8 links across SGR, reconnect, wrapping, and saved scrollback', () => {
  const options = { cols: 16, rows: 2, scrollback: 10 }
  const first = new Terminal(options)
  first.write('\x1b]8;id=one;https://example.test/a?q=1&')
  const second = Terminal.fromCheckpoint(first.checkpoint(), options)
  second.write('z=2\x1b\\linked \x1b[31mcolored\x1b[0m label\x1b]8;;\x07\r\nplain')
  expect(second.viewport().flat().find(cell => cell.ch === 'p')?.style.link).toBeUndefined()
  const saved = new Terminal(options)
  expect(saved.restoreHistory(second.saveHistory())).toBe(true)
  const html = toHtml(saved.snapshot(), true)
  expect(html).toContain('href="https://example.test/a?q=1&amp;z=2"')
  expect(html).toContain('colored')
  expect(html).toContain('target="_blank" rel="noopener noreferrer"')
  expect(toHtml(saved.snapshot())).not.toContain('<a ')
})

it('does not turn an unsupported or oversized OSC 8 target into a link', () => {
  const t = new Terminal({ cols: 100, rows: 3 })
  t.write('\x1b]8;;data:text/plain,link\x07inert\x1b]8;;\x07 ')
  t.write('\x1b]8;;https://account:secret@example.test\x07blocked\x1b]8;;\x07 ')
  t.write('\x1b]8;;https://example.test/' + 'a'.repeat(4300))
  const restored = Terminal.fromCheckpoint(t.checkpoint())
  restored.write('\x07long\x1b]8;;\x07')
  expect(restored.toText()).toBe('inert blocked long')
  expect(toHtml(restored.snapshot(), true)).not.toContain('<a ')
})

it('recognizes printed web addresses across ANSI spans and leaves nearby punctuation as text', () => {
  const t = new Terminal({ cols: 120, rows: 3 })
  t.write('🌲 (ht\x1b[31mtps://example.test/a_(b)?one=1&two=2\x1b[0m).')
  const html = toHtml(t.snapshot(), true)
  expect(html).toContain('🌲 (<a data-terminal-link href="https://example.test/a_(b)?one=1&amp;two=2"')
  expect(html).toContain('&amp;two=2</span></a>).')
})

it('links complete source paths and compiler locations without linking remote addresses as files', () => {
  const options = { cols: 24, rows: 3, scrollback: 40 }
  const terminal = new Terminal(options)
  terminal.write('see "notes & tests/source map.ts":18:7 next\r\n')
  terminal.write('src/views/(main)/index.ts(42,7): error TS2322: fixture\r\n')
  terminal.write('src/contact@support.vue:12:3: fixture\r\n')
  terminal.write('GET /docs/files?q=1 redis://machine/app/logs git@host:group/repo.git\r\n')
  terminal.write('See https://example.test/fs/file.ts:8:2\r\n')
  const html = toHtml(terminal.snapshot(true), true, true)
  expect(html.match(/data-terminal-file=/gu)).toHaveLength(3)
  expect(html).toContain('data-terminal-file="notes &amp; tests/source map.ts:18:7"')
  expect(html).toContain('data-terminal-file="src/views/(main)/index.ts:42:7"')
  expect(html).toContain('data-terminal-file="src/contact@support.vue:12:3"')
  expect(html).toContain('href="https://example.test/fs/file.ts:8:2"')
})

it('restores explicit file links without embedding file URLs as browser navigation', () => {
  const options = { cols: 21, rows: 3, scrollback: 8 }
  const terminal = new Terminal(options)
  terminal.write('\x1b]8;;file:///project/source%20map.ts#L4C2\x07Source map\x1b]8;;\x07\r\n')
  terminal.write('\x1b]8;;file:///project/nope%00.ts\x07Inert\x1b]8;;\x07')
  const saved = new Terminal(options)
  expect(saved.restoreHistory(terminal.saveHistory())).toBe(true)
  const rows = saved.snapshot(true)
  expect(toHtml(rows, true)).not.toContain('data-terminal-link')
  const html = toHtml(rows, true, true)
  expect(html.match(/data-terminal-file=/gu)).toHaveLength(1)
  expect(html).toContain('data-terminal-file="file:///project/source%20map.ts#L4C2">Source map</a>')
  expect(html).not.toContain('href="file:')
})

it('keeps each relative link in its original OSC 7 directory after reflow and replay', () => {
  const options = { cols: 18, rows: 3, scrollback: 20 }
  const terminal = new Terminal(options)
  terminal.write('\x1b]7;file:///checkout/team%20')
  const attached = Terminal.fromCheckpoint(terminal.checkpoint(), options)
  attached.write('A\x1b\\src/compiler-output.ts:2:7 \r\n')
  attached.write('\x1b]7;file:///checkout/team-B\x07src/compiler-output.ts:2:7 \r\n')
  attached.write('\x1b]7;file:///checkout/rejected%00\x07')
  attached.write('\x1b]7;file:///checkout/' + 'x'.repeat(4300) + '\x07')
  const reopened = Terminal.fromCheckpoint(JSON.parse(JSON.stringify(attached.checkpoint())), options)
  reopened.write('src/next.ts:3:4\r\n')
  reopened.resize(38, 3)
  const saved = new Terminal({ ...options, cols: 20 })
  expect(saved.restoreHistory(reopened.saveHistory())).toBe(true)
  const html = toHtml(saved.snapshot(true), true, true)
  expect(html).toContain('data-terminal-file="src/compiler-output.ts:2:7" data-terminal-cwd="file:///checkout/team%20A"')
  expect(html).toContain('data-terminal-file="src/compiler-output.ts:2:7" data-terminal-cwd="file:///checkout/team-B"')
  expect(html).toContain('data-terminal-file="src/next.ts:3:4" data-terminal-cwd="file:///checkout/team-B"')
  expect(toHtml(saved.snapshot(true), true)).not.toContain('data-terminal-cwd')
  expect(saved.toText()).not.toContain('file:///')
})

it('gives every soft-wrapped segment the complete target and one keyboard stop', () => {
  const options = { cols: 18, rows: 2, scrollback: 10, scrollbackBytes: 4096 }
  const url = 'https://example.test/releases/1.2/download'
  const first = new Terminal(options)
  first.write('Open ' + url + ' now\r\n')
  const checkpoint = JSON.parse(JSON.stringify(first.checkpoint()))
  const restored = Terminal.fromCheckpoint(checkpoint, options)
  const saved = new Terminal(options)
  expect(saved.restoreHistory(restored.saveHistory())).toBe(true)
  for (const terminal of [first, restored, saved]) {
    const html = toHtml(terminal.snapshot(true), true)
    expect(html.match(/<a data-terminal-link/g)).toHaveLength(1)
    expect(html).toContain(`href="${url}" aria-label="${url}"`)
    expect(html.match(/<a[^>]*>([^<]*)<\/a>/u)?.[1]).toContain('\n')
    expect(toHtml(terminal.snapshot())).not.toContain('<a ')
  }
})

it('requires a complete soft wrap and keeps explicit line feeds separate', () => {
  const url = 'https://example.test'
  const hard = term(url.length, 3)
  hard.write(url + '\r\n/separate-line')
  expect(toHtml(hard.snapshot(true), true)).not.toContain('href="' + url + '/separate-line"')

  const soft = term(url.length, 3)
  soft.write(url)
  expect(toHtml(soft.snapshot(true), true)).not.toContain('<a ')
  soft.write('/complete')
  expect(toHtml(soft.snapshot(true), true)).toContain('href="' + url + '/complete"')

  const space = term(url.length, 3)
  space.write(url + ' ')
  expect(toHtml(space.snapshot(true), true)).toContain('href="' + url + '/"')
})

it('retains the complete wrapped link through narrowing, widening, and restore', () => {
  const options = { cols: 20, rows: 4, scrollback: 10 }
  const url = 'https://example.test/more/longer-url'
  const t = new Terminal(options)
  t.write(url + ' ')
  t.resize(44, 4)
  expect(toHtml(t.snapshot(true), true)).toContain('href="' + url + '"')
  t.resize(12, 4)
  expect(toHtml(t.snapshot(true), true)).toContain('href="' + url + '"')
  t.resize(44, 4)
  expect(t.toText()).toBe(url)
  const restored = new Terminal(options)
  expect(restored.restoreHistory(t.saveHistory())).toBe(true)
  expect(restored.scrollback.every(row => row.length === options.cols)).toBe(true)
  expect(toHtml(restored.snapshot(true), true)).toContain('href="' + url + '"')
})

it('loads old main-screen rows without reviving the previous shell’s modes', () => {
  const options = { cols: 24, rows: 3, scrollback: 10, scrollbackBytes: 2048 }
  const old = new Terminal(options)
  old.write('old prompt\r\n\x1b[31mstyled\x1b[0m\r\n\x1b[?2004h\x1b]133;C\x07\x1b[?1049hhidden full screen\x1b[')
  const next = new Terminal(options)
  expect(next.restoreHistory(old.saveHistory())).toBe(true)
  expect(next.onAltScreen).toBe(false)
  expect(next.formatPaste('pasted')).toBe('pasted')
  expect(next.shellActivity).toEqual({ phase: 'unavailable', lastExitStatus: null })
  expect(next.toText()).toBe('old prompt\nstyled')
  expect(next.scrollback[1]?.[0]?.style.fg).toBe(1)
  next.write('fresh prompt')
  expect(next.toText()).toBe('old prompt\nstyled\nfresh prompt')
})

it('bounds saved scrollback including visible rows and refuses corrupt styles', () => {
  const options = { cols: 12, rows: 3, scrollback: 3, scrollbackBytes: 64 }
  const old = new Terminal(options)
  old.write('first\r\nsecond\r\nthird\r\nfourth\r\nvisible')
  const saved = old.saveHistory()
  expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(options.scrollbackBytes)
  const next = new Terminal(options)
  expect(next.restoreHistory(saved)).toBe(true)
  expect(next.toText()).toBe('fourth\nvisible')
  expect(next.restoreHistory('[[["bad",{"fg":"\""}]]]')).toBe(false)
  expect(next.toText()).toBe('fourth\nvisible')
  const moreBytes = { ...options, scrollbackBytes: 512 }
  const first = new Terminal(moreBytes)
  first.write('first\r\nsecond\r\nthird\r\nfourth\r\nvisible')
  const last = new Terminal(moreBytes)
  expect(last.restoreHistory(first.saveHistory())).toBe(true)
  expect(last.toText()).toBe('third\nfourth\nvisible')
})

it('keeps only the newest scrollback permitted by the byte budget', () => {
  const terminal = new Terminal({ cols: 20, rows: 1, scrollback: 5, scrollbackBytes: 70 })
  terminal.write('line one\nline two\nline three\nline four')
  expect(terminal.toText()).toBe('line two\nline three\nline four')
  terminal.write('\x1b[3J\x1b[Hline five\nline six')
  expect(terminal.toText()).toBe('line five\nline six')
})

it('honors bracketed paste modes emitted in separate PTY frames', () => {
  const terminal = term()
  const text = 'echo first\necho second'
  expect(terminal.formatPaste(text)).toBe(text)
  terminal.write('\x1B[?25;20')
  terminal.write('04h')
  expect(terminal.formatPaste(text)).toBe(`\x1B[200~${text}\x1B[201~`)
  expect(terminal.formatPaste('one\x1B[201~two')).toBe('\x1B[200~onetwo\x1B[201~')
  expect(terminal.formatPaste('')).toBe('')
  terminal.write('\x1B[?2004l')
  expect(terminal.formatPaste(text)).toBe(text)
})

it('tracks OSC 133 only as display state, through split terminators and unrelated OSC', () => {
  const terminal = term()
  terminal.write('\x1b]133;A\x1b\\❯ \x1b]133;B\x1b')
  expect(terminal.shellActivity.phase).toBe('prompt')
  terminal.write('\\')
  expect(terminal.shellActivity).toEqual({ phase: 'ready', lastExitStatus: null })
  terminal.write('\x1b]133;C\x07\x1b]0;' + 'title'.repeat(100) + '\x07')
  expect(terminal.shellActivity.phase).toBe('running')
  terminal.write('\x1b]133;D;1\x07\x1b]133;A\x07\x1b]133;B\x07')
  expect(terminal.shellActivity).toEqual({ phase: 'ready', lastExitStatus: 1 })
  terminal.write('\x1b]133;D;invalid\x07')
  expect(terminal.shellActivity.lastExitStatus).toBe(1)
  expect(terminal.toText()).toBe('❯')
})

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

  it('wraps text when narrowing and keeps the insertion point after it', () => {
    const term = new Terminal({ cols: 20, rows: 2 })
    term.write('0123456789abcdefghij')
    term.resize(8, 2)
    expect(term.cols).toBe(8)
    expect(term.toText()).toBe('01234567\n89abcdef\nghij')
    term.write('X')
    expect(term.toText()).toBe('01234567\n89abcdef\nghijX')
    term.resize(40, 2)
    expect(term.toText()).toBe('0123456789abcdefghijX')
  })

  it('reflows scrollback and joins a previously wrapped line across the viewport boundary', () => {
    const term = new Terminal({ cols: 12, rows: 2, scrollback: 10 })
    term.write('wide-history-line\r\nseparate')
    term.resize(6, 2)
    expect(term.toText()).toBe('wide-h\nistory\n-line\nsepara\nte')
    expect(term.scrollback.every(row => row.length === 6)).toBe(true)
    term.resize(32, 2)
    expect(term.toText()).toBe('wide-history-line\nseparate')
  })

  it('keeps a deferred wrap and maps a saved cursor in the same logical line', () => {
    const term = new Terminal({ cols: 12, rows: 3 })
    term.write('abcdef\x1b7ghijkl')
    term.resize(4, 3)
    expect(term.checkpoint().wrap).toBe(true)
    term.write('m')
    expect(term.toText()).toBe('abcd\nefgh\nijkl\nm')

    const saved = new Terminal({ cols: 12, rows: 3 })
    saved.write('abcde\x1b7fghijk')
    saved.resize(4, 4)
    saved.write('\x1b8!')
    expect(saved.toText()).toBe('abcd\ne!gh\nijk')
  })

  it('preserves styled blank cells and cursor positioning past the last visible character', () => {
    const term = new Terminal({ cols: 12, rows: 2 })
    term.write('start\x1b[41m  \x1b[0m\x1b[11G')
    term.resize(4, 4)
    term.write('!')
    expect(term.toText()).toBe('star\nt\n  !')
    expect(term.viewport()[1]?.slice(1, 3).map(cell => cell.style.bg)).toEqual([1, 1])
  })

  it('keeps the alternate grid fixed and reflows the parked main buffer', () => {
    const term = new Terminal({ cols: 12, rows: 2 })
    term.write('abcdefghijkl\x1b[?1049hSCREEN')
    term.resize(4, 3)
    expect(term.toText()).toBe('SCRE')
    const restored = Terminal.fromCheckpoint(JSON.parse(JSON.stringify(term.checkpoint())))
    restored.write('\x1b[?1049l!')
    expect(restored.toText()).toBe('abcd\nefgh\nijkl\n!')
  })

  it('does not create a link from a clipped legacy line or join unrelated history', () => {
    const term = new Terminal({ cols: 22, rows: 3, scrollback: 4 })
    term.write('https://example.test/partial-data ')
    const checkpoint = term.checkpoint()
    const legacy = Terminal.fromCheckpoint({ ...checkpoint, gridWraps: [0, -1, 0] })
    legacy.resize(44, 3)
    expect(toHtml(legacy.snapshot(true), true)).not.toContain('<a ')

    const short = new Terminal({ cols: 8, rows: 1, scrollback: 1 })
    short.write('lost-head on this line https://example.test/remaining  ')
    short.resize(32, 2)
    expect(toHtml(short.snapshot(true), true)).not.toContain('<a ')
  })
})
