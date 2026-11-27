export const MAX_TERMINAL_URL = 4096

/** Terminal output can address the web without supplying credentials or browser schemes. */
export function terminalWebUrl(value: string): string | null {
  if (value.length > MAX_TERMINAL_URL || !/^https?:\/\//iu.test(value) || /[\s\u0000-\u001F\u007F\\]/u.test(value)) return null
  try {
    const url = new URL(value)
    return url.hostname && !url.username && !url.password && url.href.length <= MAX_TERMINAL_URL ? url.href : null
  }
  catch { return null }
}

interface TerminalUrlRange { start: number, end: number, url: string }

export function terminalUrlRanges(line: string): TerminalUrlRange[] {
  const ranges: TerminalUrlRange[] = []
  for (const match of line.matchAll(/(?<![\w.+-])https?:\/\/[^\s"'`<>]+/giu)) {
    let candidate = match[0].replace(/[.,;!?]+$/u, '')
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      let excess = candidate.split(close).length - candidate.split(open).length
      while (excess-- > 0 && candidate.endsWith(close)) candidate = candidate.slice(0, -1)
    }
    const url = terminalWebUrl(candidate)
    if (url) ranges.push({ start: match.index, end: match.index + candidate.length, url })
  }
  return ranges
}
