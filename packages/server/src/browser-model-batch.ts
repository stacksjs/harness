import type { ClientCommand, ComposerUploads } from '@harness/contract'

interface ModelBatchTarget {
  id: string
  sessionId: number
  name: string
  create: Extract<ClientCommand, { type: 'session.create' }>
}

interface ModelBatch {
  text: string
  uploads?: ComposerUploads
  targets: ModelBatchTarget[]
}

export async function sendModelBatch(
  batch: ModelBatch,
  send: (command: ClientCommand, id: string) => Promise<unknown>,
  settled: (target: ModelBatchTarget, error?: string) => void,
): Promise<void> {
  await Promise.all(batch.targets.map(async (target) => {
    try {
      await send(target.create, target.id)
      await send({
        type: 'session.turn.start',
        sessionId: target.sessionId,
        text: batch.text,
        ...(batch.uploads ? { uploads: batch.uploads } : {}),
      }, target.id + '_first')
    }
    catch (cause) {
      settled(target, cause instanceof Error ? cause.message : 'Could not start this thread.')
      return
    }
    settled(target)
  }))
}
