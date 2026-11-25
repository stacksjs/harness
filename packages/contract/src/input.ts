export interface InputOption {
  value: string
  label: string
  description?: string
}

export interface InputQuestion {
  id: string
  header?: string
  question: string
  kind: 'text' | 'number' | 'integer' | 'choice' | 'multiple'
  options: InputOption[]
  allowOther?: boolean
  optional?: boolean
  sensitive?: boolean
  minSelections?: number
  maxSelections?: number
}

export interface InputAnswer {
  questionId: string
  values: string[]
  attachmentIds?: string[]
}

export interface QuestionAttachment {
  id: string
  questionId: string
  name: string
  size: number
  image: boolean
}

export const MAX_QUESTION_ATTACHMENTS = 100
export const MAX_QUESTION_FILE_BYTES = 50 * 1024 * 1024
export const MAX_QUESTION_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_QUESTION_TOTAL_IMAGE_BYTES = 80 * 1024 * 1024
export function questionAllowsAttachments(question: InputQuestion): boolean {
  return !question.sensitive && (question.kind === 'text' || (question.kind === 'choice' && question.allowOther === true))
}

export type InputResponse = { answers: InputAnswer[] | null } | { value: string }

/** Older clients send one free-text value. Keep that shape for one question. */
export function inputResponseValues(response: InputResponse, questions: InputQuestion[]): InputAnswer[] | null | undefined {
  if ('answers' in response) return response.answers
  return questions.length === 1 && typeof response.value === 'string'
    ? [{ questionId: questions[0]!.id, values: [response.value] }]
    : undefined
}

export const MAX_INPUT_ANSWER_LENGTH = 4096

/** Check the browser's answer against the outstanding provider request. */
export function validInputAnswers(questions: InputQuestion[], answers: unknown): answers is InputAnswer[] {
  if (!Array.isArray(answers) || answers.length > questions.length) return false
  const seen = new Set<string>()
  const attachments = new Set<string>()
  for (const answer of answers) {
    if (!answer || typeof answer.questionId !== 'string' || seen.has(answer.questionId)) return false
    const question = questions.find(question => question.id === answer.questionId)
    const values: unknown = answer.values
    if (!question || !Array.isArray(values) || values.length > Math.max(1, question.options.length)
      || values.some(value => typeof value !== 'string' || value.length > MAX_INPUT_ANSWER_LENGTH)) return false
    const ids: unknown = answer.attachmentIds
    if (ids !== undefined) {
      if (!questionAllowsAttachments(question) || !Array.isArray(ids) || ids.length > MAX_QUESTION_ATTACHMENTS) return false
      for (const id of ids) {
        if (typeof id !== 'string' || !/^[a-f\d-]{36}$/u.test(id) || attachments.has(id)) return false
        attachments.add(id)
      }
      if (attachments.size > MAX_QUESTION_ATTACHMENTS) return false
    }
    if (!values.length && Array.isArray(ids) && ids.length) {
      seen.add(question.id)
      continue
    }
    if (question.kind === 'multiple') {
      if (new Set(values).size !== values.length
        || values.length < (question.minSelections ?? 1)
        || values.length > (question.maxSelections ?? question.options.length)
        || values.some(value => !question.options.some(option => option.value === value))) return false
    }
    else {
      if (values.length !== 1) return false
      const value = values[0] as string
      if (question.kind === 'choice') {
        if (!question.options.some(option => option.value === value) && !(question.allowOther && value.trim())) return false
      }
      else if (!value.trim()
        || (question.kind === 'number' && !Number.isFinite(Number(value)))
        || (question.kind === 'integer' && !Number.isSafeInteger(Number(value)))) return false
    }
    seen.add(question.id)
  }
  return questions.every(question => question.optional || seen.has(question.id))
}
