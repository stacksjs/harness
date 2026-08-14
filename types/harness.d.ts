/**
 * Shapes the harness surface shares between the server render and the island
 * (stx-standards §6.11). `.stx` script blocks are compiled as TypeScript but
 * never typechecked, so these globals are the one place the island's data
 * contract is written down — and typechecked wherever app code touches the
 * same shapes.
 */
declare global {
  /** A turn started on this page, rendered by the transcript's :for loop. */
  interface HarnessLiveTurn {
    id: number
    prompt: string
    tools: HarnessToolCall[]
    response: string
  }

  /** One tool-invocation row; its state comes from the toolResults map. */
  interface HarnessToolCall {
    callId: string
    name: string
  }

  /** One changed file in the diff panel, as /s/:id/diff reports it. */
  interface HarnessDiffFile {
    path: string
    status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
    insertions: number
    deletions: number
  }
}

export {}
