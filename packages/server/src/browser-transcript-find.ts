interface Match {
  message: HTMLElement
  range: Range
}

const MESSAGE_BODY = '[data-user-prompt], [data-response], [data-steering-text]'
const NON_MESSAGE_TEXT = 'button, summary, [hidden], [aria-hidden="true"], .sr-only'

function collectMatches(transcript: HTMLElement, pattern: RegExp): Match[] {
  const matches: Match[] = []
  const document = transcript.ownerDocument
  for (const message of transcript.querySelectorAll<HTMLElement>(MESSAGE_BODY)) {
    const nodes: Array<{ node: Text, offset: number }> = []
    const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT)
    let text = ''
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (!node.length || node.parentElement?.closest(NON_MESSAGE_TEXT)) continue
      nodes.push({ node, offset: text.length })
      text += node.data
    }

    let nodeIndex = 0
    function position(offset: number): [Text, number] {
      while (nodes[nodeIndex + 1] && offset >= nodes[nodeIndex + 1]!.offset)
        nodeIndex++
      const part = nodes[nodeIndex]!
      return [part.node, offset - part.offset]
    }

    for (const match of text.matchAll(pattern)) {
      const range = document.createRange()
      range.setStart(...position(match.index))
      range.setEnd(...position(match.index + match[0].length))
      matches.push({ message, range })
    }
  }
  return matches
}

export function createTranscriptFinder(transcript: HTMLElement, publish: (index: number, count: number) => void) {
  const highlights = typeof Highlight === 'undefined' ? undefined : CSS.highlights
  const marked = highlights ? new Highlight() : undefined
  const current = highlights ? new Highlight() : undefined
  if (current) current.priority = 2
  if (marked) marked.priority = 1

  let pattern: RegExp | undefined
  let matches: Match[] = []
  let index = -1
  let active: Match | undefined
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  function paint(scroll: boolean): void {
    active?.message.removeAttribute('data-find-current')
    active = matches[index]
    current?.clear()
    if (active) {
      if (current) current.add(active.range)
      else active.message.setAttribute('data-find-current', '')
      if (scroll) {
        const target = active.range.getBoundingClientRect()
        const viewport = transcript.getBoundingClientRect()
        if (target.top < viewport.top + 56 || target.bottom > viewport.bottom)
          transcript.scrollTop += target.top - viewport.top - viewport.height / 2
        const anchor = active.range.startContainer.parentElement
        const horizontal = anchor?.closest<HTMLElement>('pre, .transcript-table-scroll')
        if (horizontal) {
          const bounds = horizontal.getBoundingClientRect()
          if (target.left < bounds.left || target.right > bounds.right)
            horizontal.scrollLeft += target.left - bounds.left - bounds.width / 2
        }
      }
    }

    publish(index, matches.length)
  }

  function refresh(reset: boolean): void {
    matches = pattern ? collectMatches(transcript, pattern) : []
    index = matches.length ? Math.max(0, Math.min(reset ? 0 : index, matches.length - 1)) : -1
    marked?.clear()
    for (const match of matches) marked?.add(match.range)
    paint(reset)
  }

  const observer = new MutationObserver(() => {
    if (!pattern || refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      refresh(false)
    }, 120)
  })
  observer.observe(transcript, { childList: true, characterData: true, subtree: true })

  return {
    search(query: string) {
      clearTimeout(refreshTimer)
      refreshTimer = undefined
      const text = query.trim()
      pattern = text ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu') : undefined
      if (marked && current) {
        highlights?.set('harness-find-result', marked)
        highlights?.set('harness-find-current', current)
      }
      refresh(true)
    },
    step(direction: number) {
      if (active && !transcript.contains(active.range.startContainer)) refresh(false)
      if (!matches.length) return
      index = (index + direction + matches.length) % matches.length
      paint(true)
    },
    close() {
      observer.disconnect()
      clearTimeout(refreshTimer)
      active?.message.removeAttribute('data-find-current')
      if (highlights?.get('harness-find-result') === marked) highlights?.delete('harness-find-result')
      if (highlights?.get('harness-find-current') === current) highlights?.delete('harness-find-current')
      matches = []
      active = undefined
    },
  }
}
