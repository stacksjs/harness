import type { WorkspaceDiff, WorkspaceReviewMode, WorkspaceReviewOptions } from './diff'

export async function loadWorkspaceDiffContext(sessionId: number, file: string, object: string,
  comparison: { mode: WorkspaceReviewMode | 'session', target?: string }, signal: AbortSignal): Promise<string[]> {
  const query = new URLSearchParams({ file, object })
  if (comparison.mode !== 'session') query.set('comparison', comparison.mode)
  if (comparison.target) query.set('target', comparison.target)
  const response = await fetch(`/s/${sessionId}/diff/context?${query}`, { cache: 'no-store', signal })
  const result = await response.json()
  if (!response.ok || typeof result.text !== 'string') throw new Error(result.error || 'Could not load unchanged lines.')
  const lines = result.text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export async function loadWorkspaceReviewOptions(sessionId: number, base: string, signal: AbortSignal): Promise<WorkspaceReviewOptions> {
  const query = base ? '?' + new URLSearchParams({ target: base }) : ''
  const response = await fetch(`/s/${sessionId}/diff/options${query}`, { cache: 'no-store', signal })
  if (!response.ok) throw new Error('Git review options are unavailable')
  return response.json()
}

/** Refresh a visible Changes pane without asking Git to rebuild an unchanged patch. */
export function watchWorkspaceChanges(sessionId: number, show: (diff: WorkspaceDiff) => void, unavailable: () => void,
  comparison?: { mode: WorkspaceReviewMode, target?: string }): () => void {
  const controller = new AbortController()
  const { signal } = controller
  let timer: ReturnType<typeof setTimeout> | undefined
  let knownRevision: string | undefined

  async function refresh(): Promise<void> {
    const params = new URLSearchParams()
    if (knownRevision) params.set('knownRevision', knownRevision)
    if (comparison) {
      params.set('comparison', comparison.mode)
      if (comparison.target) params.set('target', comparison.target)
    }
    const query = params.size ? '?' + params : ''
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
