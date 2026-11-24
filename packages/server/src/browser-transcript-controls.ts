import { setTranscriptCodeWrap } from './transcript-markdown'

interface NativeClipboard {
  writeText?: (text: string) => Promise<void>
  write?: (text: string) => Promise<void>
  writeHTML?: (html: string) => Promise<void>
}

function tableCell(node: Node, markdown: boolean): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    return markdown ? text.replace(/[\\|*_\[\]<>`~]/gu, '\\$&') : text
  }
  if (!(node instanceof Element)) return ''
  if (node.tagName === 'BR') return markdown ? '<br>' : '\n'
  if (markdown && node.tagName === 'CODE') {
    const code = (node.textContent ?? '').replaceAll('|', '\\|')
    const fenceLength = Math.max(0, ...Array.from(code.matchAll(/`+/gu), match => match[0].length)) + 1
    const fence = '`'.repeat(fenceLength)
    const padding = code.startsWith('`') || code.endsWith('`') ? ' ' : ''
    return fence + padding + code + padding + fence
  }
  const content = Array.from(node.childNodes, child => tableCell(child, markdown)).join('')
  if (!markdown || !content) return content
  if (node.tagName === 'STRONG') return '**' + content + '**'
  if (node.tagName === 'EM') return '*' + content + '*'
  if (node.tagName === 'S') return '~~' + content + '~~'
  const href = node.tagName === 'A' ? node.getAttribute('href') : null
  return href ? '[' + content + '](<' + href + '>)' : content
}

function tableMarkdown(table: HTMLTableElement): string {
  const rows = [...table.rows]
  const body = rows.map(row => '| ' + [...row.cells].map(cell => tableCell(cell, true).trim()).join(' | ') + ' |')
  const header = rows[0]
  if (header) {
    const alignment = [...header.cells].map(cell => {
      if (cell.style.textAlign === 'center') return ':---:'
      if (cell.style.textAlign === 'right') return '---:'
      if (cell.style.textAlign === 'left') return ':---'
      return '---'
    })
    body.splice(1, 0, '| ' + alignment.join(' | ') + ' |')
  }
  return body.join('\n')
}

function tableCsv(table: HTMLTableElement): string {
  return [...table.rows].map(row => [...row.cells].map((cell) => {
    const text = tableCell(cell, false)
    return /[,"\r\n]/u.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text
  }).join(',')).join('\n')
}

async function writeText(target: Element, native: NativeClipboard | undefined, text: string): Promise<void> {
  if (native?.writeText) await native.writeText(text)
  else if (native?.write) await native.write(text)
  else {
    const clipboard = target.ownerDocument.defaultView?.navigator.clipboard
    if (!clipboard) throw new Error('Clipboard unavailable')
    await clipboard.writeText(text)
  }
}

async function writeHtml(target: Element, native: NativeClipboard | undefined, html: string): Promise<void> {
  const richHtml = '<meta charset="utf-8">' + html
  if (native?.writeHTML) {
    await native.writeHTML(richHtml)
    return
  }
  const view = target.ownerDocument.defaultView
  if (!view?.navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
    throw new Error('HTML clipboard unavailable')
  await view.navigator.clipboard.write([new ClipboardItem({
    'text/html': new Blob([richHtml], { type: 'text/html' }),
    'text/plain': new Blob([html], { type: 'text/plain' }),
  })])
}

export async function useTranscriptControl(target: EventTarget | null, native?: NativeClipboard): Promise<string | undefined> {
  if (!(target instanceof Element)) return
  const wrap = target.closest('[data-wrap-code]')
  if (wrap) {
    setTranscriptCodeWrap(wrap, wrap.getAttribute('aria-pressed') !== 'true')
    return
  }
  const copy = target.closest('[data-copy-code], [data-copy-table]')
  if (!copy) return
  const format = copy.getAttribute('data-copy-table')
  if (!format) {
    const code = copy.closest('.transcript-code')?.querySelector('code')?.textContent
    if (code != null) {
      await writeText(copy, native, code)
      return 'Code copied to clipboard.'
    }
    return
  }
  const table = copy.closest('.transcript-table')?.querySelector('table')
  if (!table) return
  if (format === 'html') await writeHtml(copy, native, table.outerHTML)
  else await writeText(copy, native, format === 'csv' ? tableCsv(table) : tableMarkdown(table))
  const details = copy.closest('details')
  if (details) {
    details.open = false
    details.querySelector('summary')?.focus()
  }
  return 'Table copied to clipboard.'
}

export function closeTranscriptMenu(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !(event.target instanceof Element)) return
  const menu = event.target.closest<HTMLDetailsElement>('.transcript-table-actions[open]')
  if (!menu) return
  event.preventDefault()
  menu.open = false
  menu.querySelector('summary')?.focus()
}
