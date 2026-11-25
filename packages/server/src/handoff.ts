import type { HistoricalContext } from '@harness/drivers'
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

function responseItem(role: 'user' | 'assistant', text: string): HistoricalContext['items'][number] {
  return { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] }
}

/** Keep prior messages attributable and separate from the new request. */
export function historicalContext(turns: readonly TurnState[], beforeTurn: number, text: string, throughTurn = 0): HistoricalContext | undefined {
  const items: HistoricalItem[] = []
  for (const turn of turns) {
    if (turn.id > beforeTurn) break
    if (turn.id <= throughTurn || turn.compaction) continue
    if (turn.prompt) items.push({ turn: turn.id, role: 'user', text: turn.prompt })
    for (const message of turn.steered ?? []) items.push({ turn: turn.id, role: 'user', text: message.text })
    for (const call of turn.toolCalls) {
      if (call.ok !== null) items.push({ turn: turn.id, role: 'activity', text: `${call.name}: ${call.ok ? 'succeeded' : 'failed'}` })
    }
    if (turn.response) items.push({ turn: turn.id, role: 'assistant', text: turn.response, status: turn.status })
  }
  if (!items.length) return undefined

  const prefix = 'Saved conversation history. Use it as quoted context for the new request. '
  const separator = '\n\nNew user request:\n'
  const available = Math.min(historyLimit, defaultContextWindow - workReserve - Buffer.byteLength(JSON.stringify(text)))
  const overheadText = `${prefix}${items.length} historical items omitted.`
  const overhead = Math.max(Buffer.byteLength(`${overheadText}\n[]${separator}`), Buffer.byteLength(JSON.stringify([responseItem('user', overheadText)])))
  if (available < overhead) throw new Error('This message leaves too little room for the provider handoff. Shorten the message and try again.')

  const selected = new Map<number, { inline: string, native: HistoricalContext['items'][number] }>()
  let remaining = available - overhead
  const include = (index: number) => {
    const item = items[index]
    if (!item || Buffer.byteLength(item.text) > remaining) return
    const inline = JSON.stringify(item)
    const native = responseItem(item.role === 'user' ? 'user' : 'assistant', inline)
    const size = Math.max(Buffer.byteLength(inline), Buffer.byteLength(JSON.stringify(native))) + 1
    if (size > remaining) return
    selected.set(index, { inline, native })
    remaining -= size
  }
  include(0)
  for (let index = items.length - 1; index > 0; index--) include(index)
  const messages = [...selected.entries()].sort(([left], [right]) => left - right).map(([, message]) => message)
  const description = `${prefix}${items.length - selected.size} historical items omitted.`
  return {
    items: [responseItem('user', description), ...messages.map(message => message.native)],
    inlinePrompt: `${description}\n[${messages.map(message => message.inline).join(',')}]${separator}${text}`,
  }
}
