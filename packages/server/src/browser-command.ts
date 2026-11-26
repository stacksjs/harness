import type { CommandEnvelope, ThreadUndoOffer, ThreadUndoResult } from '@harness/contract'
import { decode, encode } from '@harness/contract'

class CommandConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandConnectionError'
  }
}

interface BrowserCommandReceipt {
  seqs: number[]
  threadUndo?: ThreadUndoOffer
  undoResult?: ThreadUndoResult
}

/** Share the session socket when possible and wait for this command's own acknowledgement. */
export function sendBrowserCommand(url: string, envelope: CommandEnvelope, existing?: WebSocket): Promise<BrowserCommandReceipt> {
  const socket = existing?.readyState === WebSocket.OPEN ? existing : new WebSocket(url)
  const openedHere = socket !== existing
  if (openedHere) socket.binaryType = 'arraybuffer'

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new CommandConnectionError('The server did not confirm the request. Try again.')), 8000)

    function finish(error?: Error, receipt?: BrowserCommandReceipt): void {
      clearTimeout(timer)
      socket.removeEventListener('open', send)
      socket.removeEventListener('message', onMessage)
      socket.removeEventListener('close', onClose)
      socket.removeEventListener('error', onClose)
      if (openedHere) socket.close()
      if (error) reject(error)
      else resolve(receipt ?? { seqs: [] })
    }

    function send(): void {
      try {
        socket.send(encode({ t: 'dispatch', envelope }))
      }
      catch {
        finish(new CommandConnectionError('Could not send the request. Try again.'))
      }
    }

    function onMessage(event: MessageEvent): void {
      if (!(event.data instanceof ArrayBuffer)) return
      let frame: ({ t?: string, id?: string, message?: string } & Partial<BrowserCommandReceipt>) | null
      try {
        frame = decode(new Uint8Array(event.data)) as typeof frame
      }
      catch {
        return
      }
      if (frame?.id !== envelope.id) return
      if (frame.t === 'dispatched') finish(undefined, { seqs: frame.seqs ?? [], threadUndo: frame.threadUndo, undoResult: frame.undoResult })
      else if (frame.t === 'rejected') finish(new Error(frame.message ?? 'The server rejected the request.'))
    }

    function onClose(): void {
      finish(new CommandConnectionError('The connection closed before the server confirmed the request.'))
    }

    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onClose)
    if (socket.readyState === WebSocket.OPEN) send()
    else socket.addEventListener('open', send, { once: true })
  })
}
