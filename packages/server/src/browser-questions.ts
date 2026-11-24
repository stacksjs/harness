import type { EventPayload, InputAnswer, InputQuestion } from '@harness/contract'
import { validInputAnswers } from '@harness/contract'

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
  focus: (target: 'card' | 'answer' | 'prompt') => void
  hasFocus: (target: 'card' | 'prompt') => boolean
  send: (requestId: string, answers: InputAnswer[] | null) => Promise<void>
  recordActivity: (request: { requestId: string, turnId: number }, outcome: Outcome) => void
}

type InputEvent = Extract<EventPayload, { type: 'input.requested' | 'input.resolved' }>
type Outcome = Extract<InputEvent, { type: 'input.resolved' }>['outcome'] | 'pending'
type PendingQuestion = Pick<Extract<InputEvent, { type: 'input.requested' }>, 'requestId' | 'turnId' | 'questions'>

/** State and validation for the stx question card. The template owns the markup. */
export function createQuestionForm({ state, initialRequests, focus, hasFocus, send, recordActivity }: QuestionFormOptions) {
  const pending = state(initialRequests)
  const request = () => pending()[0]
  const step = state(0)
  const drafts = state<QuestionDraft[]>([])
  const error = state('')
  const sending = state('')
  const current = () => request()?.questions.slice(step(), step() + 1) ?? []
  const hasNext = () => step() + 1 < (request()?.questions.length ?? 0)
  const draft = (question: InputQuestion) => drafts().find(entry => entry.id === question.id)
  const choices = (question: InputQuestion) => draft(question)?.choices ?? []
  const text = (question: InputQuestion) => draft(question)?.text ?? ''
  const isOther = (question: InputQuestion) => draft(question)?.other === true

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
      return values.length || explicitlyEmpty ? [{ questionId: question.id, values }] : []
    })
  }

  function valid(): boolean {
    const questions = hasNext() ? current() : request()?.questions
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
    error.set('')
    sending.set('')
  }

  function update(event: InputEvent): void {
    if (event.type === 'input.requested') {
      if (pending().some(request => request.requestId === event.requestId)) return
      const focusCard = !request() && hasFocus('prompt')
      pending.set([...pending(), event])
      recordActivity(event, 'pending')
      if (focusCard) focus('card')
      return
    }
    const current = request()?.requestId === event.requestId
    const restoreFocus = current && hasFocus('card')
    pending.set(pending().filter(request => request.requestId !== event.requestId))
    recordActivity(event, event.outcome)
    if (current) reset()
    if (restoreFocus) focus(request() ? 'card' : 'prompt')
  }

  return {
    request, step, current, hasNext, error, sending, draft, choices, text, isOther, valid, selectOption, shortcut, advance, update,
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
