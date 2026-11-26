export interface NativeClipboard {
  writeText?: (text: string) => unknown
  write?: (text: string) => unknown
  writeHTML?: (html: string) => unknown
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
