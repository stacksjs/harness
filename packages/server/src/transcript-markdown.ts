import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })

function escapeTranscriptText(value: string): string {
  // The stx hydration fallback scans individual text nodes for template
  // expressions. Split adjacent opening braces without changing copied text.
  return markdown.utils.escapeHtml(value).replace(/\{{2,}/gu, run => [...run].join('<!---->'))
}

markdown.renderer.rules.text = (tokens, index) => escapeTranscriptText(tokens[index]!.content)
markdown.renderer.rules.code_inline = (tokens, index) => `<code>${escapeTranscriptText(tokens[index]!.content)}</code>`

function externalLink(href: string): boolean {
  if (!/^https?:\/\//iu.test(href)) return false
  try {
    const url = new URL(href)
    return !url.username && !url.password
  }
  catch {
    return false
  }
}

markdown.validateLink = href => externalLink(href)
  || /^\/s\/[1-9]\d*(?:#turn-[1-9]\d*)?$/u.test(href)
  || /^#turn-[1-9]\d*$/u.test(href)

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const link = tokens[index]!
  const href = link.attrGet('href')
  if (typeof href === 'string' && externalLink(href)) {
    link.attrSet('target', '_blank')
    link.attrSet('rel', 'noopener noreferrer')
  }
  return renderer.renderToken(tokens, index, options)
}

// Agent text alone cannot load a remote resource. Media delivered by the
// workspace can use its own scoped attachment renderer.
markdown.renderer.rules.image = (tokens, index) => escapeTranscriptText(tokens[index]!.content)

function codeBlock(code: string, language = ''): string {
  const label = language ? escapeTranscriptText(language) : 'Code'
  return `<div class="transcript-code"><div class="transcript-code-bar"><span>${label}</span><button type="button" data-copy-code>Copy code</button></div><pre tabindex="0"><code>${escapeTranscriptText(code)}</code></pre></div>\n`
}

markdown.renderer.rules.fence = (tokens, index) => {
  const { content, info } = tokens[index]!
  return codeBlock(content, info.trim().split(/\s+/u, 1)[0]?.slice(0, 40))
}
markdown.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index]!.content)

export function renderTranscriptMarkdown(source: string): string {
  return markdown.render(source)
}

/** Keep the unchanged leading blocks and replace only the changed tail. */
export function updateTranscriptMarkdown(response: Element, source: string): void {
  const template = response.ownerDocument.createElement('template')
  template.innerHTML = renderTranscriptMarkdown(source)
  let previous = response.firstChild
  while (previous && template.content.firstChild?.isEqualNode(previous)) {
    template.content.firstChild.remove()
    previous = previous.nextSibling
  }
  while (previous) {
    const next = previous.nextSibling
    previous.remove()
    previous = next
  }
  response.append(template.content)
}
