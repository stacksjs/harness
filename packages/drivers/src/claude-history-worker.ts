import { forkSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk'
import { parentPort } from 'node:worker_threads'
import type { ForkInput, ForkResult } from './types'

type ClaudeForkInput = Pick<ForkInput, 'providerSessionId' | 'providerTurnId' | 'inheritedProviderTurnIds'>

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

parentPort?.once('message', (input: ClaudeForkInput) => {
  void forkClaudeHistory(input).then(
    result => parentPort?.postMessage({ result }),
    () => parentPort?.postMessage({ error: true }),
  )
})
