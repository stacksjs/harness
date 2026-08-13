import { describe, expect, it } from 'bun:test'
import { indexedToHex, TERMINAL_CSS, toHtml } from '../src/html'
import { Terminal } from '../src/terminal'

function render(input: string, cols = 20, rows = 4): string {
  const t = new Terminal({ cols, rows })
  t.write(input)
  return toHtml(t.snapshot())
}

describe('html rendering', () => {
  it('groups a styled run into one span', () => {
    expect(render('\x1B[31mred red\x1B[m plain'))
      .toBe('<span class="t-fg-1">red red</span> plain')
  })

  it('splits spans exactly where the style changes', () => {
    expect(render('\x1B[1ma\x1B[31mb\x1B[mc'))
      .toBe('<span class="t-bold">a</span><span class="t-fg-1 t-bold">b</span>c')
  })

  it('escapes markup in terminal output', () => {
    // Tool output quotes code. Unescaped, the transcript executes it instead
    // of showing it.
    expect(render('<b a="1">&')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;')
  })

  it('uses classes for the themeable 16, inline styles for exact colors', () => {
    expect(render('\x1B[38;5;208mx')).toBe('<span style="color:#ff8700">x</span>')
    expect(render('\x1B[38;2;16;32;48mx')).toBe('<span style="color:#102030">x</span>')
    expect(render('\x1B[94mx')).toBe('<span class="t-fg-12">x</span>')
  })

  it('renders inverse by swapping the pair', () => {
    expect(render('\x1B[31;47;7mx')).toBe('<span class="t-fg-7 t-bg-1">x</span>')
  })

  it('gives inverse-without-colors a visible fallback', () => {
    expect(render('\x1B[7mx')).toBe('<span class="t-inv">x</span>')
  })

  it('emits one line per row and trims trailing blanks', () => {
    expect(render('a\r\n\r\nb')).toBe('a\n\nb')
  })
})

describe('the 256-color cube', () => {
  it('matches xterm at the checkpoints', () => {
    expect(indexedToHex(16)).toBe('#000000')
    expect(indexedToHex(196)).toBe('#ff0000')
    expect(indexedToHex(208)).toBe('#ff8700')
    expect(indexedToHex(231)).toBe('#ffffff')
    expect(indexedToHex(232)).toBe('#080808')
    expect(indexedToHex(255)).toBe('#eeeeee')
  })
})

describe('the theme contract', () => {
  it('ships a class and a variable for each of the 16 base colors', () => {
    for (let i = 0; i < 16; i++) {
      expect(TERMINAL_CSS).toContain(`.t-fg-${i} { color: var(--t-color-${i}); }`)
      expect(TERMINAL_CSS).toContain(`.t-bg-${i} { background: var(--t-color-${i}); }`)
    }
  })
})
