import type { WorkspaceDiff } from './diff'

/** Refresh a visible Changes pane without asking Git to rebuild an unchanged patch. */
export function watchWorkspaceChanges(sessionId: number, show: (diff: WorkspaceDiff) => void, unavailable: () => void): () => void {
  const controller = new AbortController()
  const { signal } = controller
  let timer: ReturnType<typeof setTimeout> | undefined
  let knownRevision: string | undefined

  async function refresh(): Promise<void> {
    const query = knownRevision ? `?knownRevision=${encodeURIComponent(knownRevision)}` : ''
    try {
      const response = await fetch(`/s/${sessionId}/diff${query}`, { cache: 'no-store', signal })
      if (response.status === 204) return
      if (!response.ok) throw new Error('Workspace changes are unavailable')
      const diff: WorkspaceDiff & { revision?: string } = await response.json()
      if (signal.aborted) return
      knownRevision = diff.error ? undefined : diff.revision
      show(diff)
    }
    catch {
      if (signal.aborted) return
      knownRevision = undefined
      unavailable()
    }
    finally {
      if (!signal.aborted) timer = setTimeout(refresh, 2000)
    }
  }

  void refresh()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}
