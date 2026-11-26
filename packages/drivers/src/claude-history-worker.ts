import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { parentPort } from 'node:worker_threads'
import type { ConversationRewindInput, ForkInput, ForkResult } from './types'

type ClaudeForkInput = Pick<ForkInput, 'providerSessionId' | 'providerTurnId' | 'inheritedProviderTurnIds'>

export type ClaudeHistoryRequest =
  | { type: 'fork', input: ClaudeForkInput }
  | { type: 'rewind', input: ConversationRewindInput }
  | { type: 'resume', providerSessionId: string, resumeSessionAt: string }

export type ClaudeHistoryResult<T extends ClaudeHistoryRequest> = T['type'] extends 'fork' ? ForkResult | null : boolean

async function verifyClaudeRewind(input: ConversationRewindInput): Promise<boolean> {
  const history = (await getSessionMessages(input.providerSessionId)).filter(message => message.type !== 'system')
  const assistantAt = (id: string) => history.findIndex(message => message.uuid === id && message.type === 'assistant')
  const head = input.activeResumeSessionAt ? assistantAt(input.activeResumeSessionAt) : history.length - 1
  const selected = assistantAt(input.beforeTurnId)
  const retained = input.retainedTurnId ? assistantAt(input.retainedTurnId) : undefined
  return head >= selected && selected >= 0 && history[head]?.uuid === input.newestTurnId
    && history[head]?.type === 'assistant' && (retained === undefined || (retained >= 0 && retained < selected))
}

async function forkClaudeHistory(input: ClaudeForkInput): Promise<ForkResult | null> {
  // Search the selected Claude home by ID. A renamed project or a worktree
  // can have saved the source conversation under a different directory.
  const source = await getSessionMessages(input.providerSessionId)
  const boundary = source.findIndex(message => message.type === 'assistant' && message.uuid === input.providerTurnId)
  if (boundary === -1) return null

  const { sessionId } = await forkSession(input.providerSessionId, { upToMessageId: input.providerTurnId })
  if (!sessionId || sessionId === input.providerSessionId) throw new Error('The fork did not get a separate conversation.')

  const copied = await getSessionMessages(sessionId)
  if (copied.length !== boundary + 1 || !copied.every((message, index) => {
    const original = source[index]!
    return message.type === original.type && JSON.stringify(message.message) === JSON.stringify(original.message)
  })) throw new Error('The fork did not stop at the selected response.')

  // Claude gives the copied messages new UUIDs. A fork of this fork needs
  // the new UUIDs even when the selected response came from the first thread.
  const requested = new Set([input.providerTurnId, ...(input.inheritedProviderTurnIds ?? [])])
  return {
    providerSessionId: sessionId,
    copiedProviderTurnIds: Object.fromEntries(copied.flatMap((message, index) => {
      const original = source[index]!
      return requested.has(original.uuid) ? [[original.uuid, message.uuid]] : []
    })),
  }
}

async function run(request: ClaudeHistoryRequest): Promise<ForkResult | null | boolean> {
  if (request.type === 'fork') return forkClaudeHistory(request.input)
  if (request.type === 'rewind') return verifyClaudeRewind(request.input)
  const messages = await getSessionMessages(request.providerSessionId)
  return messages.some(message => message.type === 'assistant' && message.uuid === request.resumeSessionAt)
}

parentPort?.once('message', (request: ClaudeHistoryRequest) => {
  void run(request).then(
    result => parentPort?.postMessage({ result }),
    () => parentPort?.postMessage({ error: true }),
  )
})
