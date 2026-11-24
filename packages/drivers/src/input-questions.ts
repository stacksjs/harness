import type { InputAnswer, InputOption, InputQuestion } from '@harness/contract'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown, max = 2048): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= max ? value : undefined
}

function optionsOf(values: unknown, parse: (value: unknown) => InputOption | undefined): InputOption[] | undefined {
  if (!Array.isArray(values) || values.length > 32) return undefined
  const options: InputOption[] = []
  for (const value of values) {
    const option = parse(value)
    if (!option || options.some(existing => existing.value === option.value)) return undefined
    options.push(option)
  }
  return options
}

export function toolInputQuestions(value: unknown, provider: 'claude' | 'codex'): InputQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return undefined
  const questions: InputQuestion[] = []
  for (const raw of value) {
    const item = record(raw)
    const question = text(item?.question)
    const id = provider === 'claude' ? question : text(item?.id, 256)
    if (!item || !question || !id || questions.some(previous => previous.id === id)) return undefined
    const options = optionsOf(item.options ?? [], (rawOption) => {
      const option = record(rawOption)
      const label = text(option?.label, 512)
      return label ? { value: label, label, description: text(option?.description) } : undefined
    })
    if (!options) return undefined
    const multiple = provider === 'claude' && item.multiSelect === true && options.length > 0
    questions.push({
      id,
      header: text(item.header, 128),
      question,
      kind: multiple ? 'multiple' : options.length ? 'choice' : 'text',
      options,
      allowOther: !multiple && (provider === 'claude' || item.isOther === true),
      sensitive: item.isSecret === true,
    })
  }
  return questions
}

interface AcpForm {
  questions: InputQuestion[]
  content: (answers: InputAnswer[]) => Record<string, string | string[] | number | boolean>
}

function enumOptions(values: unknown, titled: boolean): InputOption[] | undefined {
  return optionsOf(values, (entry) => {
    const item = titled ? record(entry) : undefined
    const value = titled ? item?.const : entry
    if (typeof value !== 'string' || value.length > 512) return undefined
    const label = text(item?.title, 512) ?? (value.trim() || '(Empty value)')
    return { value, label, description: text(item?.description) }
  })
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function acpInputForm(value: unknown, fallback: unknown): AcpForm | undefined {
  const schema = record(value)
  const properties = Object.entries(record(schema?.properties) ?? {})
  if (schema?.type !== 'object' || properties.length === 0 || properties.length > 12) return undefined
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  if ([...required].some(id => typeof id !== 'string' || !properties.some(([name]) => name === id))) return undefined
  const types = new Map<string, string>()
  const questions: InputQuestion[] = []
  for (const [id, raw] of properties) {
    const field = record(raw)
    const question = text(field?.description) ?? text(fallback) ?? text(field?.title) ?? id
    if (!field || !text(id, 256) || typeof field.type !== 'string') return undefined
    const descriptor: InputQuestion = {
      id,
      header: text(field.title, 128),
      question,
      kind: 'text',
      options: [],
      optional: !required.has(id),
      sensitive: field.format === 'password',
    }
    switch (field.type) {
      case 'string': {
        if (field.enum != null || field.oneOf != null) {
          const options = enumOptions(field.oneOf ?? field.enum, field.oneOf != null)
          if (!options?.length) return undefined
          descriptor.kind = 'choice'
          descriptor.options = options
        }
        break
      }
      case 'boolean':
        descriptor.kind = 'choice'
        descriptor.options = [{ label: 'Yes', value: 'true' }, { label: 'No', value: 'false' }]
        break
      case 'number':
      case 'integer':
        descriptor.kind = field.type
        break
      case 'array': {
        const items = record(field.items)
        const options = enumOptions(items?.anyOf ?? items?.enum, items?.anyOf != null)
        if (!options?.length) return undefined
        const min = nonnegativeInteger(field.minItems) ? field.minItems : 0
        const max = nonnegativeInteger(field.maxItems) ? Math.min(field.maxItems, options.length) : options.length
        if (min > max || max === 0) return undefined
        descriptor.kind = 'multiple'
        descriptor.options = options
        descriptor.minSelections = min
        descriptor.maxSelections = max
        break
      }
      default:
        return undefined
    }
    types.set(id, field.type)
    questions.push(descriptor)
  }
  const companions = new Map<string, InputQuestion>()
  for (const question of questions) {
    if (question.kind !== 'choice' || !question.optional || types.get(question.id) !== 'string') continue
    const companion = questions.find(field => field.id === question.id + '__other')
    if (!companion?.optional || companion.kind !== 'text' || companion.sensitive) continue
    question.allowOther = true
    companions.set(question.id, companion)
  }
  const companionIds = new Set([...companions.values()].map(field => field.id))
  return {
    questions: questions.filter(question => !companionIds.has(question.id)),
    content(answers) {
      return Object.fromEntries(answers.map(({ questionId, values }) => {
        const value = values[0] ?? ''
        const companion = companions.get(questionId)
        const question = companion ? questions.find(question => question.id === questionId) : undefined
        if (companion && !question?.options.some(option => option.value === value)) return [companion.id, value]
        switch (types.get(questionId)) {
          case 'array': return [questionId, values]
          case 'boolean': return [questionId, value === 'true']
          case 'number':
          case 'integer': return [questionId, Number(value)]
          default: return [questionId, value]
        }
      }))
    },
  }
}
