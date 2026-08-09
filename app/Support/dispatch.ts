import type { ClientCommand, CommandEnvelope } from '@harness/contract'
import { connect } from './client'
import { boot } from './engine'

/**
 * Dispatch a command the way the architecture already claims it works.
 *
 * "A CLI command is a client like any other" is true of the log — every
 * command goes through the engine and lands in the same append-only stream —
 * but it was not true of the *server*. A command dispatched here opened its own
 * SQLite connection and its own `Engine`, so a running server never saw it and
 * went on serving a projection built before it happened.
 *
 * That is not cosmetic. It is why deleting a profile from the terminal left its
 * worktrees on disk: the server holds the hook that releases them and never
 * learned the profile was gone. The same shape would let a revoked device keep
 * a token the server still honours, and a newly added MCP server go unused
 * until someone restarted.
 *
 * So: through the socket when a server is listening, and straight to the log
 * when one is not. Both paths write the same events in the same order — the
 * difference is only whether the process holding the read model finds out.
 *
 * ## Why not have the server watch the log instead
 *
 * It would work, and it would be worse. The server would have to poll or watch
 * a file, then reconcile events it did not cause with reactions it must not run
 * twice — and "did I already act on this?" is exactly the question command
 * receipts exist to stop anyone asking. Dispatching through the boundary keeps
 * one writer per running process.
 */
export interface DispatchResult {
  /** Where it went, so a command can say so when it matters. */
  via: 'server' | 'log'
  /** Whether the engine recognised this as a retry of an id it had already seen. */
  replayed: boolean
  /** Sequence numbers of the events it produced, in order. */
  seqs: number[]
}

export const DEFAULT_URL = 'ws://127.0.0.1:3789/ws'

export async function dispatch(
  envelope: CommandEnvelope & { command: ClientCommand },
  url: string = DEFAULT_URL,
): Promise<DispatchResult> {
  let client: Awaited<ReturnType<typeof connect>> | null = null
  try {
    client = await connect(url)
  }
  catch {
    // No server. Fall through — the log is still the source of truth, and a
    // command that only fails because nothing happens to be listening would be
    // a worse tool than one that works offline.
    client = null
  }

  if (client) {
    try {
      const ack = await client.dispatch(envelope.id, envelope.command)
      return { via: 'server', replayed: ack.replayed, seqs: ack.seqs }
    }
    finally {
      client.close()
    }
  }

  const engine = await boot()
  const result = await engine.dispatch(envelope)
  return { via: 'log', replayed: result.replayed, seqs: result.events.map(event => event.seq) }
}
