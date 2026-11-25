import { decode, encode } from '@harness/contract'

interface SessionSocketOptions {
  url: string
  sessionId: number
  cursor: () => number
  onSocket: (socket: WebSocket | null) => void
  onOnline: (online: boolean) => void
  onFrame: (frame: unknown) => void
}

/** Reconnect with the last applied event cursor and wait for replay before sending. */
export function createSessionSocket(options: SessionSocketOptions) {
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 300
  let disposed = false

  function open(): void {
    clearTimeout(retry)
    if (disposed || socket) return
    const current = new WebSocket(options.url)
    current.binaryType = 'arraybuffer'
    socket = current
    options.onSocket(current)

    current.addEventListener('open', () => {
      if (!disposed) current.send(encode({ t: 'subscribe', sessionId: options.sessionId, sinceSeq: options.cursor() }))
    })
    current.addEventListener('message', event => {
      if (disposed || socket !== current || !(event.data instanceof ArrayBuffer)) return
      let frame: { t?: string, sessionId?: number } | null
      try {
        frame = decode(new Uint8Array(event.data)) as typeof frame
      }
      catch { return }
      if (frame?.t === 'subscribed' && frame.sessionId === options.sessionId) {
        delay = 300
        options.onOnline(true)
      }
      else {
        options.onFrame(frame)
      }
    })
    current.addEventListener('close', () => {
      if (disposed || socket !== current) return
      socket = null
      options.onSocket(null)
      options.onOnline(false)
      retry = setTimeout(open, delay)
      delay = Math.min(delay * 2, 5000)
    })
  }

  return {
    open,
    send(frame: unknown): boolean {
      if (socket?.readyState !== WebSocket.OPEN) return false
      socket.send(encode(frame))
      return true
    },
    dispose() {
      disposed = true
      clearTimeout(retry)
      socket?.close()
      socket = null
      options.onSocket(null)
    },
  }
}
