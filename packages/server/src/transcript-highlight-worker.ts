import hljs from 'highlight.js'

export interface HighlightRequest {
  language: string
  source: string
}

self.addEventListener('message', ({ data }: MessageEvent<HighlightRequest>) => {
  const { language, source } = data
  let markup = ''
  if (hljs.getLanguage(language)) {
    try {
      markup = hljs.highlight(source, { language, ignoreIllegals: true }).value
    }
    catch {
      // A failed grammar leaves the original code readable.
    }
  }
  self.postMessage(markup)
})
