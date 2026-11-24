import type { HighlightRequest } from './transcript-highlight-worker'

const MAX_SOURCE_LENGTH = 48 * 1024
const DEADLINE_MS = 5000
const TOKEN_STYLE: Record<string, string> = {
  addition: 'string',
  attr: 'name',
  attribute: 'name',
  built_in: 'name',
  comment: 'comment',
  deletion: 'keyword',
  doctag: 'comment',
  keyword: 'keyword',
  literal: 'value',
  meta: 'comment',
  name: 'name',
  number: 'value',
  params: 'name',
  property: 'name',
  regexp: 'string',
  selector: 'name',
  string: 'string',
  symbol: 'value',
  title: 'name',
  type: 'name',
  variable: 'name',
}

interface PaintedRange {
  style: string
  range: Range
}

function syntaxStyle(element: Element): string | undefined {
  for (const scope of element.classList) {
    const token = /^hljs-([\w-]+)$/u.exec(scope)?.[1]
    const style = token && TOKEN_STYLE[token.split('-')[0]!]
    if (typeof style === 'string') return style
  }
}

function collectRanges(code: Element, source: string, markup: string): PaintedRange[] {
  if (!markup) return []
  const document = code.ownerDocument
  const template = document.createElement('template')
  template.innerHTML = markup
  if (template.content.textContent !== source) return []

  const textNodes: { node: Text, start: number, end: number }[] = []
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let end = 0
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!node.length) continue
    textNodes.push({ node, start: end, end: end + node.length })
    end += node.length
  }

  let nodeIndex = 0
  function position(offset: number) {
    while (textNodes[nodeIndex] && offset > textNodes[nodeIndex]!.end) nodeIndex++
    const part = textNodes[nodeIndex]!
    return [part.node, offset - part.start] as const
  }

  const ranges: PaintedRange[] = []
  let offset = 0
  function appendTokens(node: Node, style?: string): void {
    if (node instanceof Element) style = syntaxStyle(node) ?? style
    if (!(node instanceof Text)) {
      for (const child of node.childNodes) appendTokens(child, style)
      return
    }
    const start = offset
    offset += node.length
    if (!style || start === offset) return
    const range = document.createRange()
    range.setStart(...position(start))
    range.setEnd(...position(offset))
    ranges.push({ style, range })
  }
  appendTokens(template.content)
  return ranges
}

/** Paint code off the main thread without replacing selectable transcript text. */
export function createTranscriptHighlighter(transcript: Element) {
  if (typeof Worker === 'undefined' || typeof Highlight === 'undefined' || !CSS.highlights) return

  const styles = new Map<string, Highlight>()
  const painted = new Map<Element, { source: string, ranges: PaintedRange[] }>()
  const pending = new Set<Element>()
  let worker: Worker | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let running: { code: Element, source: string } | undefined
  let stopped = false

  function erase(code: Element): void {
    for (const { style, range } of painted.get(code)?.ranges ?? []) styles.get(style)?.delete(range)
    painted.delete(code)
  }

  function stop(): void {
    stopped = true
    clearTimeout(deadline)
    worker?.terminate()
    pending.clear()
    running = undefined
    for (const [style, highlight] of styles) {
      const key = 'harness-syntax-' + style
      if (CSS.highlights.get(key) === highlight) CSS.highlights.delete(key)
    }
    styles.clear()
    painted.clear()
  }

  function paint({ data }: MessageEvent<string>): void {
    clearTimeout(deadline)
    const job = running
    running = undefined
    if (job && transcript.contains(job.code) && job.code.textContent === job.source) {
      const { code, source } = job
      const ranges = collectRanges(code, source, data)
      erase(code)
      for (const { style, range } of ranges) {
        let highlight = styles.get(style)
        if (!highlight) {
          highlight = new Highlight()
          styles.set(style, highlight)
          CSS.highlights.set('harness-syntax-' + style, highlight)
        }
        highlight.add(range)
      }
      painted.set(code, { source, ranges })
    }
    next()
  }

  function next(): void {
    if (running || stopped) return
    for (const code of pending) {
      pending.delete(code)
      const source = code.textContent ?? ''
      const language = code.getAttribute('data-code-language')
      if (!transcript.contains(code) || !language || !source || source.length > MAX_SOURCE_LENGTH
        || painted.get(code)?.source === source) continue
      try {
        if (!worker) {
          worker = new Worker('/_stx/transcript-highlight.js', { type: 'module' })
          worker.onmessage = paint
          worker.onerror = stop
        }
        running = { code, source }
        worker.postMessage({ language, source } satisfies HighlightRequest)
        deadline = setTimeout(stop, DEADLINE_MS)
      }
      catch {
        stop()
      }
      return
    }
  }

  return {
    update(root: Element) {
      if (stopped) return
      for (const code of painted.keys()) {
        if (!transcript.contains(code) || (code.textContent?.length ?? 0) > MAX_SOURCE_LENGTH) erase(code)
      }
      for (const code of root.querySelectorAll('code[data-code-language]')) {
        if (painted.get(code)?.source !== code.textContent
          && !(running?.code === code && running.source === code.textContent)) pending.add(code)
      }
      next()
    },
    stop,
  }
}
