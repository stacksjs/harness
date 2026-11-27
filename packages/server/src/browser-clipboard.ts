export interface NativeClipboard {
  writeText?: (text: string) => unknown
  write?: (text: string) => unknown
  writeHTML?: (html: string) => unknown
  readText?: () => unknown
  read?: () => unknown
}

function craftClipboard(target: Element): NativeClipboard | undefined {
  const view = target.ownerDocument.defaultView as (Window & { craft?: { clipboard?: NativeClipboard } }) | null
  return view?.craft?.clipboard
}

export async function writeClipboardText(target: Element, text: string, native?: NativeClipboard): Promise<void> {
  native ??= craftClipboard(target)
  if (native?.writeText) await native.writeText(text)
  else if (native?.write) await native.write(text)
  else {
    const clipboard = target.ownerDocument.defaultView?.navigator.clipboard
    if (!clipboard) throw new Error('Clipboard unavailable')
    await clipboard.writeText(text)
  }
}

export async function readClipboardText(target: Element, native?: NativeClipboard): Promise<string> {
  native ??= craftClipboard(target)
  if (native?.readText || native?.read) {
    const result = await (native.readText ?? native.read)?.call(native)
    if (typeof result === 'string') return result
    if (typeof result === 'object' && result && 'text' in result && typeof result.text === 'string') return result.text
  }
  const clipboard = target.ownerDocument.defaultView?.navigator.clipboard
  if (!clipboard) throw new Error('Clipboard unavailable')
  return clipboard.readText()
}
