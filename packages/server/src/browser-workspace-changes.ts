import type { WorkspaceDiff, WorkspaceReviewMode, WorkspaceReviewOptions } from './diff'
import type { ProjectRepository } from './project-repositories'

interface ProjectReviewOptions extends WorkspaceReviewOptions {
  repositories: ProjectRepository[]
  hasProjectRepository: boolean
}

export async function loadWorkspaceDiffContext(sessionId: number, file: string, object: string,
  comparison: { mode: WorkspaceReviewMode | 'session', target?: string, repository?: string }, signal: AbortSignal): Promise<string[]> {
  const query = new URLSearchParams({ file, object })
  if (comparison.mode !== 'session') query.set('comparison', comparison.mode)
  if (comparison.target) query.set('target', comparison.target)
  if (comparison.repository) query.set('repository', comparison.repository)
  const response = await fetch(`/s/${sessionId}/diff/context?${query}`, { cache: 'no-store', signal })
  const result = await response.json()
  if (!response.ok || typeof result.text !== 'string') throw new Error(result.error || 'Could not load unchanged lines.')
  const lines = result.text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

export async function loadWorkspaceReviewOptions(sessionId: number, base: string, repository: string, signal: AbortSignal): Promise<ProjectReviewOptions> {
  const query = new URLSearchParams()
  if (base) query.set('target', base)
  if (repository) query.set('repository', repository)
  const response = await fetch(`/s/${sessionId}/diff/options?${query}`, { cache: 'no-store', signal })
  const options = await response.json()
  if (!response.ok) throw new Error(options.error || 'Could not load Git review options.')
  return options
}

/** Refresh a visible Changes pane without asking Git to rebuild an unchanged patch. */
export function watchWorkspaceChanges(sessionId: number, show: (diff: WorkspaceDiff) => void, unavailable: (error?: string) => void,
  comparison?: { mode: WorkspaceReviewMode, target?: string, repository?: string }): () => void {
  let controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let knownRevision: string | undefined
  const fixedComparison = comparison?.mode === 'commit' || (comparison?.mode === 'turn' && Boolean(comparison.target))

  async function refresh(): Promise<void> {
    const { signal } = controller
    if (signal.aborted) return
    const params = new URLSearchParams()
    if (knownRevision) params.set('knownRevision', knownRevision)
    if (comparison) {
      params.set('comparison', comparison.mode)
      if (comparison.target) params.set('target', comparison.target)
      if (comparison.repository) params.set('repository', comparison.repository)
    }
    const query = params.size ? '?' + params : ''
    try {
      const response = await fetch(`/s/${sessionId}/diff${query}`, { cache: 'no-store', signal })
      if (response.status === 204) return
      const diff: WorkspaceDiff & { revision?: string } = await response.json()
      if (signal.aborted) return
      if (!response.ok) {
        knownRevision = undefined
        if (response.status === 404 && comparison?.repository && diff.error)
          show({ isRepository: false, scope: 'working-tree', files: [], patch: '', error: diff.error })
        else unavailable(diff.error)
        return
      }
      knownRevision = diff.error ? undefined : diff.revision
      show(diff)
    }
    catch {
      if (signal.aborted) return
      knownRevision = undefined
      unavailable()
    }
    finally {
      if (!signal.aborted && !fixedComparison) timer = setTimeout(refresh, 2000)
    }
  }

  function pause(): void {
    controller.abort()
    clearTimeout(timer)
  }
  function restore(event: PageTransitionEvent): void {
    if (!event.persisted || !controller.signal.aborted) return
    controller = new AbortController()
    knownRevision = undefined
    void refresh()
  }

  // A pane can outlive its document in WebKit's back-forward cache.
  globalThis.addEventListener('pagehide', pause)
  globalThis.addEventListener('pageshow', restore)
  void refresh()
  return () => {
    pause()
    globalThis.removeEventListener('pagehide', pause)
    globalThis.removeEventListener('pageshow', restore)
  }
}
