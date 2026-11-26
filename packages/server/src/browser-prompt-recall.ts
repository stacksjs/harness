type Direction = 'backward' | 'forward'

interface RecallEntry {
  id: string
  text: string
}

function transcriptPrompts(transcript: HTMLElement): RecallEntry[] {
  const history: RecallEntry[] = []
  for (const row of transcript.querySelectorAll<HTMLElement>('[data-turn]')) {
    if (row.querySelector('[data-automatic-compaction]:not([hidden])')) continue
    const text = row.querySelector('[data-user-prompt]')?.textContent
    const id = row.dataset.turn
    if (!id || !text?.trim()) continue
    // Consecutive repeats share one position, using the most recent turn.
    if (history.at(-1)?.text === text) history.pop()
    history.push({ id, text })
  }
  return history
}

/** Measure the native textarea's line breaks without scrolling or changing its selection. */
function caretAtVisualEdge(editor: HTMLTextAreaElement, direction: Direction): boolean {
  const start = editor.selectionStart
  if (start !== editor.selectionEnd) return false

  const value = editor.value
  const edge = direction === 'backward' ? 0 : value.length
  if (start === edge) return true

  const doc = editor.ownerDocument
  const view = doc.defaultView
  if (!view || !editor.clientWidth) return false
  const style = view.getComputedStyle(editor)
  const mirror = doc.createElement('div')
  mirror.setAttribute('aria-hidden', 'true')
  Object.assign(mirror.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    margin: '0',
    border: '0',
    boxSizing: 'border-box',
    width: `${editor.clientWidth}px`,
    paddingInline: style.paddingInline,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    fontStyle: style.fontStyle,
    fontStretch: style.fontStretch,
    fontKerning: style.fontKerning,
    fontFeatureSettings: style.fontFeatureSettings,
    fontVariationSettings: style.fontVariationSettings,
    lineHeight: style.lineHeight,
    direction: style.direction,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    whiteSpace: style.whiteSpace,
    wordBreak: style.wordBreak,
    overflowWrap: style.overflowWrap,
    tabSize: style.tabSize,
  })
  // A trailing newline needs a measurable position on its empty final line.
  const text = doc.createTextNode(value + '\u200b')
  mirror.append(text)
  doc.body.append(mirror)
  try {
    const range = doc.createRange()
    const lineAt = (offset: number): number => {
      range.setStart(text, offset)
      range.collapse(true)
      return range.getBoundingClientRect().top
    }
    return Math.abs(lineAt(start) - lineAt(edge)) < 1
  }
  finally {
    mirror.remove()
  }
}

export function createPromptRecall() {
  let recalled: RecallEntry | undefined
  return {
    reset() { recalled = undefined },
    step(event: KeyboardEvent, editor: HTMLTextAreaElement, transcript: HTMLElement): boolean {
      if (event.defaultPrevented || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
        || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return false
      if (recalled?.text !== editor.value) recalled = undefined
      if (!recalled && editor.value) return false

      const direction = event.key === 'ArrowUp' ? 'backward' : 'forward'
      if (!recalled && direction === 'forward') return false
      if (!caretAtVisualEdge(editor, direction)) return false

      const history = transcriptPrompts(transcript)
      const active = recalled && (history.find(entry => entry.id === recalled?.id && entry.text === recalled.text)
        ?? history.findLast(entry => entry.text === recalled?.text))
      if (recalled && !active) return false
      const index = active ? history.indexOf(active) : history.length
      const entry = history[index + (direction === 'backward' ? -1 : 1)]
      if (!entry && direction === 'backward') return false

      event.preventDefault()
      recalled = entry
      const value = entry?.text ?? ''
      editor.value = value
      editor.setSelectionRange(value.length, value.length)
      editor.scrollTop = editor.scrollHeight
      return true
    },
  }
}
