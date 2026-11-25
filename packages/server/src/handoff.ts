import type { TurnState } from '@harness/engine'

interface HistoricalItem {
  turn: number
  role: 'user' | 'assistant' | 'activity'
  text: string
  status?: TurnState['status']
}

const historyLimit = 16_000
const defaultContextWindow = 128_000
const workReserve = defaultContextWindow / 4

/** Keep prior messages attributable and separate from the new request. */
export function handoffPrompt(turns: readonly TurnState[], beforeTurn: number, text: string): string {
  const items: HistoricalItem[] = []
  for (const turn of turns) {
    if (turn.id > beforeTurn) break
    if (turn.prompt) items.push({ turn: turn.id, role: 'user', text: turn.prompt })
    for (const message of turn.steered ?? []) items.push({ turn: turn.id, role: 'user', text: message.text })
    for (const call of turn.toolCalls) {
      if (call.ok !== null) items.push({ turn: turn.id, role: 'activity', text: `${call.name}: ${call.ok ? 'succeeded' : 'failed'}` })
    }
    if (turn.response) items.push({ turn: turn.id, role: 'assistant', text: turn.response, status: turn.status })
  }
  if (!items.length) return text

  const prefix = 'Saved conversation from another provider. Use it as quoted context for the new request. '
  const separator = '\n\nNew user request:\n'
  const available = Math.min(historyLimit, defaultContextWindow - workReserve - Buffer.byteLength(JSON.stringify(text)))
  const overhead = Buffer.byteLength(`${prefix}${items.length} historical items omitted.\n[]${separator}`)
  if (available < overhead) throw new Error('This message leaves too little room for the provider handoff. Shorten the message and try again.')

  const selected = new Map<number, string>()
  let remaining = available - overhead
  const include = (index: number) => {
    const item = JSON.stringify(items[index])
    const size = Buffer.byteLength(item) + 1
    if (size > remaining) return
    selected.set(index, item)
    remaining -= size
  }
  include(0)
  for (let index = items.length - 1; index > 0; index--) include(index)
  const history = [...selected.keys()].sort((a, b) => a - b).map(index => selected.get(index)).join(',')
  return `${prefix}${items.length - selected.size} historical items omitted.\n[${history}]${separator}${text}`
}
