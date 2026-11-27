import type { ClientCommand, ComposerUploads, QueuedFollowUp } from '@harness/contract'

interface LocalFollowUp extends QueuedFollowUp {
  uploads?: ComposerUploads
  fileNames?: string[]
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
  transcript: () => HTMLElement | undefined
  steeringMessage: () => HTMLTemplateElement | undefined
}

export function createFollowUpActions(options: FollowUpOptions) {
  const { sessionId, editing, local, online, sending, pending, send } = options
  let retry: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let flushing: Promise<Set<string>> | undefined

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

  async function updateQueue(command: ClientCommand): Promise<void> {
    if (pending() || !online()) return
    pending.set(true)
    try {
      await send(command)
    }
    catch (error) {
      options.alert(error instanceof Error ? error.message : 'Could not update the queue.')
    }
    finally {
      pending.set(false)
    }
  }

  async function run(action: 'move' | 'remove' | 'send', id?: string, direction?: 'up' | 'down'): Promise<void> {
    if (action === 'send') await updateQueue({ type: 'session.queue.send', sessionId, id })
    else if (action === 'remove' && id) await updateQueue({ type: 'session.queue.remove', sessionId, id })
    else if (action === 'move' && id && direction) await updateQueue({ type: 'session.queue.move', sessionId, id, direction })
  }

  function steerQueued(id: string, turnId: number): Promise<void> {
    return updateQueue({ type: 'session.turn.steer', sessionId, turnId, id })
  }

  function resend(id: string): Promise<void> {
    return updateQueue({ type: 'session.queue.send', sessionId, id, confirmResend: true })
  }

  function showDelivery(turnId: number, text: string): void {
    const history = options.transcript()?.querySelector(`[data-turn="${turnId}"] [data-steering-history]`)
    const template = options.steeringMessage()
    if (!history || !template) return
    const fragment = template.content.cloneNode(true) as DocumentFragment
    const message = fragment.querySelector('[data-steering-text]')
    if (!message) return
    message.textContent = text
    history.append(fragment)
  }

  async function flushPending(retryFailed: boolean): Promise<Set<string>> {
    const accepted = new Set<string>()
    if (disposed || !online()) return accepted
    clearTimeout(retry)
    let entry = local()?.[0]
    while (entry && !disposed && online() && (!entry.error || retryFailed)) {
      const { id, text, codexSelection, freshContext, uploads } = entry
      sending.set(id)
      local.set(local().map(item => item.id === id ? { ...item, attempted: true } : item))
      try {
        await send({ type: 'session.queue.add', sessionId, text, ...(uploads ? { uploads } : {}), ...(codexSelection ? { codexSelection } : {}), ...(freshContext ? { freshContext } : {}) }, id)
        accepted.add(id)
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
        return accepted
      }
      finally {
        sending.set('')
      }
      retryFailed = false
      entry = local()?.[0]
    }
    return accepted
  }

  function flush(retryFailed = false): Promise<Set<string>> {
    // A send that will leave the thread needs the receipt from the active
    // flush, including when earlier messages are already being submitted.
    flushing ??= flushPending(retryFailed).finally(() => { flushing = undefined })
    return flushing
  }

  async function stage(entry: QueuedFollowUp): Promise<boolean> {
    const entries = local() || []
    if (!entries.some(item => item.id === entry.id)) local.set([...entries, entry])
    return (await flush()).has(entry.id)
  }

  function removeLocal(id: string): void {
    const entry = local().find(item => item.id === id)
    if (!entry || sending() === id || (entry.attempted && !entry.error)) return
    local.set(local().filter(item => item.id !== id))
    void flush()
  }

  return {
    beginEdit, endEdit, saveEdit, run, steerQueued, resend, showDelivery, flush, stage, removeLocal,
    dispose() {
      disposed = true
      clearTimeout(retry)
    },
  }
}
