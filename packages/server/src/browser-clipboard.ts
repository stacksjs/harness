export interface NativeClipboard {
  writeText?: (text: string) => unknown
  write?: (text: string) => unknown
  writeHTML?: (html: string) => unknown
  readText?: () => unknown
}

export async function writeClipboardText(target: Element, text: string, native?: NativeClipboard): Promise<void> {
  if (native?.writeText) await native.writeText(text)
  else if (native?.write) await native.write(text)
  else {
    const clipboard = target.ownerDocument.defaultView?.navigator.clipboard
    if (!clipboard) throw new Error('Clipboard unavailable')
    await clipboard.writeText(text)
  }
}

export async function readClipboardText(target: Element, native?: NativeClipboard): Promise<string> {
  if (native?.readText) {
    const result = await native.readText()
    if (typeof result === 'string') return result
    if (typeof result === 'object' && result && 'text' in result && typeof result.text === 'string') return result.text
  }
  const clipboard = target.ownerDocument.defaultView?.navigator.clipboard
  if (!clipboard) throw new Error('Clipboard unavailable')
  return clipboard.readText()
}
