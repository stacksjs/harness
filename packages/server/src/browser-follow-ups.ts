import type { ClientCommand, QueuedFollowUp } from '@harness/contract'

interface LocalFollowUp extends QueuedFollowUp {
  attempted?: boolean
  error?: string
}

interface Writable<T> {
  (): T
  set(value: T): void
}

interface FollowUpOptions {
  sessionId: number
  online: () => boolean
  inputBlocked: () => boolean
  editor: () => HTMLTextAreaElement | undefined
  setText: (text: string) => void
  rememberDraft: () => void
  restoreDraft: () => void
  hasDraft: () => boolean
  editing: Writable<QueuedFollowUp | null>
  local: Writable<LocalFollowUp[]>
  sending: Writable<string>
  pending: Writable<boolean>
  send: (command: ClientCommand, id?: string) => Promise<void>
  alert: (message: string) => void
}

export function createFollowUpActions(options: FollowUpOptions) {
  const { sessionId, editing, local, online, sending, pending, send } = options
  let retry: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function beginEdit(entry: QueuedFollowUp): void {
    const box = options.editor()
    if (!box || options.inputBlocked()) return
    if (!editing()) options.rememberDraft()
    editing.set(entry)
    box.value = entry.text
    options.setText(entry.text)
    box.setSelectionRange(entry.text.length, entry.text.length)
    box.focus()
  }

  function endEdit(saveOrphan = false): void {
    const box = options.editor()
    const entry = editing()
    if (!entry || !box) return
    const text = box.value
    editing.set(null)
    box.value = ''
    options.setText('')
    if (saveOrphan && !options.hasDraft() && text !== entry.text) {
      box.value = text
      options.rememberDraft()
      return
    }
    options.restoreDraft()
    box.focus({ preventScroll: true })
  }

  async function saveEdit(text: string): Promise<void> {
    const entry = editing()
    if (!entry) return
    await send({ type: 'session.queue.edit', sessionId, id: entry.id, text, previousText: entry.text })
    endEdit()
  }

  async function run(action: 'move' | 'remove' | 'send', id?: string, direction?: 'up' | 'down'): Promise<void> {
    if (pending() || !online()) return
    pending.set(true)
    try {
      if (action === 'send') await send({ type: 'session.queue.send', sessionId, ...(id ? { id } : {}) })
      else if (action === 'remove' && id) await send({ type: 'session.queue.remove', sessionId, id })
      else if (action === 'move' && id && direction) await send({ type: 'session.queue.move', sessionId, id, direction })
    }
    catch (error) {
      options.alert(error instanceof Error ? error.message : 'Could not update the queue.')
    }
    finally {
      pending.set(false)
    }
  }

  async function flush(retryFailed = false): Promise<void> {
    if (disposed || !online() || sending()) return
    clearTimeout(retry)
    let entry = local()?.[0]
    while (entry && !disposed && online() && (!entry.error || retryFailed)) {
      const { id, text } = entry
      sending.set(id)
      local.set(local().map(item => item.id === id ? { ...item, attempted: true } : item))
      try {
        await send({ type: 'session.queue.add', sessionId, text }, id)
        local.set(local().filter(item => item.id !== id))
      }
      catch (error) {
        if (error instanceof Error && error.name === 'CommandConnectionError') {
          if (!disposed && online()) retry = setTimeout(() => void flush(), 1500)
        }
        else {
          const message = error instanceof Error ? error.message : 'Could not queue the message.'
          local.set(local().map(item => item.id === id ? { ...item, error: message } : item))
        }
        return
      }
      finally {
        sending.set('')
      }
      retryFailed = false
      entry = local()?.[0]
    }
  }

  function stage(entry: QueuedFollowUp): void {
    const entries = local() || []
    if (!entries.some(item => item.id === entry.id)) local.set([...entries, entry])
    void flush()
  }

  function removeLocal(id: string): void {
    const entry = local().find(item => item.id === id)
    if (!entry || sending() === id || (entry.attempted && !entry.error)) return
    local.set(local().filter(item => item.id !== id))
    void flush()
  }

  return {
    beginEdit, endEdit, saveEdit, run, flush, stage, removeLocal,
    dispose() {
      disposed = true
      clearTimeout(retry)
    },
  }
}
