import { expect, it } from 'bun:test'
import { renderPullRequestCommentMarkdown, renderTranscriptMarkdown } from '../src/transcript-markdown'

it('renders prose, tables and open fences using the same renderer for streaming and history', () => {
  const html = renderTranscriptMarkdown('## Result\n\n**Passed**\n\n| Test | Result |\n| --- | --- |\n| Build | OK |\n\n```ts\nconst size = 2 < 3\n')
  expect(html).toContain('<h2>Result</h2>')
  expect(html).toContain('<strong>Passed</strong>')
  expect(html).toContain('<td>Build</td>')
  expect(html).toContain('data-copy-code>Copy code')
  expect(html).toContain('<code data-code-language="ts">const size = 2 &lt; 3\n</code>')
})

it('renders model content without active HTML, external image loading or arbitrary local paths', () => {
  const html = renderTranscriptMarkdown([
    '<strong data-fixture="demo">Raw text</strong>',
    '{{ 1 + 1 }}',
    '![sample](https://example.test/media.png)',
    '[Unscoped](/drivers)',
    '[Thread](/s/12#turn-2)',
    '[Open](https://example.test/guide)',
  ].join('\n\n'))
  expect(html).toContain('&lt;strong data-fixture=&quot;demo&quot;&gt;')
  expect(html).toContain('{<!---->{ 1 + 1 }}')
  expect(html).not.toContain('<img')
  expect(html).not.toContain('/media.png')
  expect(html).not.toContain('href="/drivers"')
  expect(html).toContain('href="/s/12#turn-2">Thread')
  expect(html).toContain('href="https://example.test/guide" target="_blank" rel="noopener noreferrer"')
})

it('omits raw GitHub markup and hidden review markers while retaining them literally in code', () => {
  const html = renderPullRequestCommentMarkdown([
    'Review **this**. <!-- hidden metadata -->',
    '<script>alert(1)</script>',
    '```html',
    '<!-- example syntax -->',
    '```',
  ].join('\n\n'))
  expect(html).toContain('<strong>this</strong>')
  expect(html).not.toContain('hidden metadata')
  expect(html).not.toContain('alert(1)')
  expect(html).toContain('&lt;!-- example syntax --&gt;')
})
