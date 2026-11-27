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

interface TerminalPathRange { start: number, end: number, path: string }

/** The terminal can display a file URI, but the host must resolve and scope it. */
export function terminalLinkUrl(value: string): string | null {
  const web = terminalWebUrl(value)
  if (web) return web
  if (value.length > MAX_TERMINAL_URL || !/^file:\/\//iu.test(value) || /[\s\u0000-\u001F\u007F\\]/u.test(value)) return null
  try {
    const url = new URL(value)
    const path = decodeURIComponent(url.pathname)
    return !url.username && !url.password && !url.port && !url.search
      && (!url.hash || /^#L[1-9]\d*(?:C[1-9]\d*)?$/u.test(url.hash))
      && !/[\u0000-\u001F\u007F]/u.test(path) && url.href.length <= MAX_TERMINAL_URL ? url.href : null
  }
  catch { return null }
}

const locationSuffix = /(?::\d+){1,2}$/u
const typeScriptLocation = /\((\d+),(\d+)\)$/u
const absolutePath = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.\.?[\\/])/u
// Terminal path forms follow T3 Code at 431da7f4e55b82b386e68a9f32c543fac2efedf5.
// Upstream notice: ../../drivers/T3CODE-LICENSE.md.
const pathToken = /(?<![\p{L}\p{M}\p{N}._$+@-])(?:[A-Za-z]:[\\/]|[~.]{1,2}[\\/]|\/|\\\\)[^\s"'\x60<>]+|(?<![\p{L}\p{M}\p{N}._$+@-])[\p{L}\p{M}\p{N}._$+@-]+(?:[\\/](?:\([\p{L}\p{M}\p{N}._-]+\)(?=[\\/])|[\p{L}\p{M}\p{N}._$+@?[\]-]+))+\/?(?:(?::\d+){1,2}|\(\d+,\d+\))?|(?<![\p{L}\p{M}\p{N}._$+@-])[\p{L}\p{M}\p{N}._$+@-]+\.[\p{L}][\p{L}\p{M}\p{N}_-]*(?::\d+:\d+|\(\d+,\d+\)(?=:\s+(?:error|warning) TS\d+:))/gu
const quotedToken = /(["'\x60])([^\r\n]*?)\1((?::\d+){1,2})?/gu
const powerShellPrompt = /^PS ((?:[A-Za-z]:[\\/]|\\\\|\/)[^>\r\n]+)>/u
const nonPaths = /(?<![\w.+-])[A-Za-z][\w.+-]+:\/\/[^\s"'\x60<>]+|\b(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|proxying)\s+["'\x60]?\/[^\s?]*\?\S*/gu
const scpRemote = /(?<![\w.@-])[\w.-]+@[\w.-]+:[^\s"'\x60<>]+/gu

function trimPathToken(value: string): string {
  let end = value.replace(/[.,;:!?]+$/u, '').length
  for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
    let excess = value.split(close).length - value.split(open).length
    while (excess-- > 0 && value[end - 1] === close) end--
  }
  return value.slice(0, end)
}

export function terminalPathRanges(line: string): TerminalPathRange[] {
  // Paths are bounded by the resolver as well. Avoid scanning unusually long
  // generated lines (for example long base64 or minified tool output).
  if (line.length > MAX_TERMINAL_URL * 4 || !/[\\/"'\x60]|:\d+:\d+|\(\d+,\d+\):/u.test(line)) return []
  const excluded = Array.from(line.matchAll(nonPaths), match => ({ start: match.index, end: match.index + match[0].length }))
  const remoteTails = Array.from(line.matchAll(scpRemote), match => ({
    start: match.index + match[0].indexOf(':') + 1, end: match.index + match[0].length,
  }))
  const quoted: TerminalPathRange[] = []
  const prompt = powerShellPrompt.exec(line)?.[1]
  if (prompt) quoted.push({ start: 3, end: 3 + prompt.length, path: prompt })
  for (const match of line.matchAll(quotedToken)) {
    const content = match[2]!
    const suffix = match[3] ?? ''
    const filename = content.replace(locationSuffix, '')
    if (!absolutePath.test(filename) && !/^[^\\/:<>|]+[\\/]/u.test(filename)
      && !/^[\p{L}\p{M}\p{N}._$+@ -]+\.\p{L}[\p{L}\p{M}\p{N}_-]*$/u.test(filename)) continue
    quoted.push({ start: match.index + 1, end: match.index + match[0].length - (suffix ? 0 : 1), path: content + suffix })
  }
  const paths = quoted.filter(candidate => !excluded.some(range => range.start < candidate.end && candidate.start < range.end))
  const occupied = [...excluded, ...quoted].toSorted((left, right) => left.start - right.start)
  let index = 0
  for (const match of line.matchAll(pathToken)) {
    const start = match.index
    const value = trimPathToken(match[0])
    const end = start + value.length
    while (occupied[index] && occupied[index]!.end <= start) index++
    if (!value || value.length > MAX_TERMINAL_URL || (occupied[index] && occupied[index]!.start < end)) continue
    const path = /^:\s+(?:error|warning) TS\d+:/u.test(line.slice(end)) ? value.replace(typeScriptLocation, ':$1:$2') : value
    paths.push({ start, end, path })
  }
  return paths.filter(range => range.path.length <= MAX_TERMINAL_URL && !remoteTails.some(tail => range.start >= tail.start && range.end <= tail.end))
    .toSorted((left, right) => left.start - right.start)
}
