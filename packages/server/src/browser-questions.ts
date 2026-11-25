import type { EventPayload, InputAnswer, InputQuestion, QuestionAttachment } from '@harness/contract'
import { MAX_QUESTION_ATTACHMENTS, questionAllowsAttachments, validInputAnswers } from '@harness/contract'
import { escapeTranscriptText } from './transcript-markdown'

interface Signal<T> {
  (): T
  set: (value: T) => void
}

interface QuestionDraft {
  id: string
  choices?: string[]
  text?: string
  other?: boolean
}

interface QuestionFormOptions {
  state: <T>(value: T) => Signal<T>
  initialRequests: PendingQuestion[]
  sessionId: number
  focus: (target: 'card' | 'answer' | 'prompt') => void
  hasFocus: (target: 'card' | 'prompt') => boolean
  send: (requestId: string, answers: InputAnswer[] | null) => Promise<void>
  recordActivity: (request: { requestId: string, turnId: number, attachments?: QuestionAttachment[] }, outcome: Outcome) => void
}

type InputEvent = Extract<EventPayload, { type: 'input.requested' | 'input.resolved' }>
type Outcome = Extract<InputEvent, { type: 'input.resolved' }>['outcome'] | 'pending'
type PendingQuestion = Pick<Extract<InputEvent, { type: 'input.requested' }>, 'requestId' | 'turnId' | 'questions'>

export function paintQuestionFiles(root: Element | null, sessionId: number, request: { requestId: string, attachments?: QuestionAttachment[] }): void {
  if (!root || !request.attachments?.length) return
  const row = root.querySelector(`[data-question-request="${CSS.escape(request.requestId)}"]`)
  if (!row || row.querySelector('[data-question-files]')) return
  const list = row.ownerDocument.createElement('div')
  list.setAttribute('data-question-files', '')
  for (const file of request.attachments) {
    const link = row.ownerDocument.createElement('a')
    link.className = 'block break-words underline'
    link.href = `/s/${sessionId}/question-attachments/${file.id}`
    link.download = ''
    link.innerHTML = escapeTranscriptText(file.name)
    list.append(link)
  }
  row.append(list)
}

/** State and validation for the stx question card. The template owns the markup. */
interface DraftAttachment {
  key: string
  questionId: string
  name: string
  file?: File
  status: 'uploading' | 'ready' | 'failed'
  id?: string
  error?: string
}

export function createQuestionForm({ state, initialRequests, sessionId, focus, hasFocus, send, recordActivity }: QuestionFormOptions) {
  const pending = state(initialRequests)
  const request = () => pending()[0]
  const step = state(0)
  const drafts = state<QuestionDraft[]>([])
  const files = state<DraftAttachment[]>([])
  const inFlight = new Map<string, AbortController>()
  let nextKey = 0
  const error = state('')
  const sending = state('')
  const current = () => request()?.questions.slice(step(), step() + 1) ?? []
  const hasNext = () => step() + 1 < (request()?.questions.length ?? 0)
  const draft = (question: InputQuestion) => drafts().find(entry => entry.id === question.id)
  const choices = (question: InputQuestion) => draft(question)?.choices ?? []
  const text = (question: InputQuestion) => draft(question)?.text ?? ''
  const isOther = (question: InputQuestion) => draft(question)?.other === true
  const attachments = (question: InputQuestion) => files().filter(file => file.questionId === question.id)
  const uploadRoot = `/s/${sessionId}/question-attachments`

  function draftUrl(requestId: string, id?: string): string {
    return uploadRoot + (id ? '/' + id : '') + '?' + new URLSearchParams({ request: requestId })
  }

  async function restoreFiles(active: PendingQuestion): Promise<void> {
    try {
      const response = await fetch(draftUrl(active.requestId))
      if (!response.ok) return
      const stored = await response.json() as QuestionAttachment[]
      if (request()?.requestId !== active.requestId) return
      const recovered = stored.filter(entry => !files().some(file => file.id === entry.id)).map(entry => ({
        id: entry.id, key: entry.id, name: entry.name, questionId: entry.questionId, status: 'ready' as const,
      }))
      files.set([...files(), ...recovered])
    }
    catch {}
  }

  function removeFile(key: string): void {
    const entry = files().find(file => file.key === key)
    const active = request()
    inFlight.get(key)?.abort()
    files.set(files().filter(file => file.key !== key))
    if (entry?.id && active) void fetch(draftUrl(active.requestId, entry.id), { method: 'DELETE' }).catch(() => {})
  }

  async function upload(active: PendingQuestion, entry: DraftAttachment): Promise<void> {
    if (!entry.file || inFlight.has(entry.key)) return
    const controller = new AbortController()
    inFlight.set(entry.key, controller)
    const update = (change: Partial<DraftAttachment>) => {
      if (request()?.requestId === active.requestId)
        files.set(files().map(file => file.key === entry.key ? { ...file, ...change } : file))
    }
    update({ status: 'uploading', error: undefined })
    const query = new URLSearchParams({ request: active.requestId, question: entry.questionId, name: entry.name })
    try {
      const response = await fetch(`${uploadRoot}?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': entry.file.type || 'application/octet-stream' },
        body: entry.file,
        signal: controller.signal,
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not attach the file.')
      if (files().some(file => file.key === entry.key)) {
        files.set(files().filter(file => file.key === entry.key || file.id !== result.id))
        update({ status: 'ready', id: result.id })
      }
      else void fetch(draftUrl(active.requestId, result.id), { method: 'DELETE' }).catch(() => {})
    }
    catch (cause) {
      update({ status: 'failed', error: cause instanceof Error ? cause.message : 'Could not attach the file.' })
    }
    finally {
      inFlight.delete(entry.key)
    }
  }

  function addFiles(question: InputQuestion, selected: FileList | Iterable<File>): void {
    const active = request()
    if (!active || !questionAllowsAttachments(question) || sending()) return
    const next = Array.from(selected)
    if (next.length + files().length > MAX_QUESTION_ATTACHMENTS) {
      error.set('A question response can contain up to 100 files.')
      return
    }
    const entries = next.map(file => ({ key: 'upload-' + ++nextKey, questionId: question.id, name: file.name, file, status: 'uploading' as const }))
    files.set([...files(), ...entries])
    error.set('')
    for (const entry of entries) void upload(active, entry)
  }

  function updateDraft(question: InputQuestion, patch: Partial<QuestionDraft>): void {
    drafts.set([
      ...drafts().filter(entry => entry.id !== question.id),
      { ...draft(question), ...patch, id: question.id },
    ])
    error.set('')
  }

  function collectedAnswers(questions: InputQuestion[]): InputAnswer[] {
    return questions.flatMap((question) => {
      const enteredText = text(question)
      const values = question.options.length && !isOther(question)
        ? choices(question)
        : enteredText.trim() ? [enteredText] : []
      const explicitlyEmpty = !question.optional && question.kind === 'multiple' && question.minSelections === 0
      const attachmentIds = attachments(question).flatMap(file => file.id ? [file.id] : [])
      return values.length || explicitlyEmpty || attachmentIds.length
        ? [{ questionId: question.id, values, ...(attachmentIds.length ? { attachmentIds } : {}) }]
        : []
    })
  }

  function valid(): boolean {
    const questions = hasNext() ? current() : request()?.questions
    if (!hasNext() && files().some(file => file.status !== 'ready')) return false
    return Boolean(questions?.length && validInputAnswers(questions, collectedAnswers(questions)))
  }

  function selectOption(question: InputQuestion, value: string, checked: boolean): void {
    const selected = question.kind === 'multiple' ? choices(question).filter(choice => choice !== value) : []
    if (checked) selected.push(value)
    updateDraft(question, { other: false, choices: selected })
  }

  function shortcut(event: KeyboardEvent): void {
    const target = event.target
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing
      || (target instanceof HTMLInputElement && target.type !== 'radio' && target.type !== 'checkbox')) return
    if (!/^[1-9]$/.test(event.key)) return
    const question = current()[0]
    const option = question?.options[Number(event.key) - 1]
    if (!question || !option || sending()) return
    event.preventDefault()
    selectOption(question, option.value, question.kind !== 'multiple' || !choices(question).includes(option.value))
  }

  function setStep(index: number): void {
    step.set(index)
    error.set('')
    focus('card')
  }

  async function sendAnswer(requestId: string, answers: InputAnswer[] | null): Promise<void> {
    if (sending()) return
    sending.set(requestId)
    error.set('')
    try {
      await send(requestId, answers)
    }
    catch (cause) {
      if (sending() !== requestId) return
      sending.set('')
      error.set(cause instanceof Error ? cause.message : 'Could not send the answer. Try again.')
    }
  }

  function advance(): void {
    if (!valid() || sending()) return
    if (hasNext()) {
      setStep(step() + 1)
      return
    }
    const active = request()
    if (active) void sendAnswer(active.requestId, collectedAnswers(active.questions))
  }

  function reset(): void {
    step.set(0)
    drafts.set([])
    files.set([])
    for (const upload of inFlight.values()) upload.abort()
    error.set('')
    sending.set('')
  }

  function update(event: InputEvent): void {
    if (event.type === 'input.requested') {
      if (pending().some(request => request.requestId === event.requestId)) return
      const focusCard = !request() && hasFocus('prompt')
      pending.set([...pending(), event])
      if (request()?.requestId === event.requestId) void restoreFiles(event)
      recordActivity(event, 'pending')
      if (focusCard) focus('card')
      return
    }
    const current = request()?.requestId === event.requestId
    const restoreFocus = current && hasFocus('card')
    pending.set(pending().filter(request => request.requestId !== event.requestId))
    recordActivity(event, event.outcome)
    if (current) {
      reset()
      const next = request()
      if (next) void restoreFiles(next)
    }
    if (restoreFocus) focus(request() ? 'card' : 'prompt')
  }

  const initial = request()
  if (initial) void restoreFiles(initial)

  return {
    request, step, current, hasNext, error, sending, draft, choices, text, isOther, valid, selectOption, shortcut, advance, update,
    attachments, allowsAttachments: questionAllowsAttachments,
    pickFiles(question: InputQuestion, event: Event) {
      const input = event.target
      if (input instanceof HTMLInputElement && input.files) {
        addFiles(question, input.files)
        input.value = ''
      }
    },
    pasteFiles(question: InputQuestion, event: ClipboardEvent) {
      if (!questionAllowsAttachments(question) || !event.clipboardData?.files.length) return
      event.preventDefault()
      addFiles(question, event.clipboardData.files)
    },
    retryFile(entry: DraftAttachment) {
      const active = request()
      if (active && entry.status === 'failed') void upload(active, entry)
    },
    removeFile,
    selectionHint(question: InputQuestion) {
      const min = question.minSelections ?? 1
      const max = question.maxSelections ?? question.options.length
      if (min === max) return `Select ${min}.`
      if (min === 0) return `Select up to ${max}.`
      return `Select ${min} to ${max}.`
    },
    previous: () => setStep(Math.max(0, step() - 1)),
    chooseOther(question: InputQuestion) {
      updateDraft(question, { other: true, choices: [] })
      focus('answer')
    },
    editText: (question: InputQuestion, value: string) => updateDraft(question, { text: value }),
    clear(question: InputQuestion) {
      for (const file of attachments(question)) removeFile(file.key)
      drafts.set(drafts().filter(entry => entry.id !== question.id))
      error.set('')
    },
    decline() {
      const active = request()
      if (active) void sendAnswer(active.requestId, null)
    },
    interrupt() {
      for (const request of pending()) recordActivity(request, 'interrupted')
      pending.set([])
      reset()
    },
  }
}
