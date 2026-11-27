import type { NativeClipboard } from './browser-clipboard'
import type { WorkspaceFileEntry, WorkspaceFilePreview } from './workspace-files'
import { writeClipboardText } from './browser-clipboard'

type Scope = { session: string } | { workspace: string }
type Folder = { entries: WorkspaceFileEntry[], next: number | null, truncated: boolean }
type Row = WorkspaceFileEntry & { depth: number, open?: boolean } | { kind: 'more', path: string, depth: number }

type ViewFile = WorkspaceFilePreview & { content: string, download: string, numbers: string, lines: number }

export interface WorkspaceFilesState {
  rows: Row[]
  query: string
  treeBusy: boolean
  treeError: string
  selected: string
  preview: ViewFile | null
  previewBusy: boolean
  previewError: string
}

export function createWorkspaceFiles(scope: Scope, changed: (state: WorkspaceFilesState) => void) {
  const folders = new Map<string, Folder>()
  const expanded = new Set<string>()
  const loading = new Map<string, AbortController>()
  let fileRequest: AbortController | undefined
  let searchRequest: AbortController | undefined
  let searchDelay: ReturnType<typeof setTimeout> | undefined
  let current: WorkspaceFilesState = {
    rows: [], query: '', treeBusy: false, treeError: '', selected: '', preview: null, previewBusy: false, previewError: '',
  }

  function set(patch: Partial<WorkspaceFilesState>): void {
    current = { ...current, ...patch }
    changed(current)
  }

  function endpoint(action: string, extras: Record<string, string>): string {
    return `/workspace-files/${action}?${new URLSearchParams({ ...scope, ...extras })}`
  }

  async function request<T>(action: string, extras: Record<string, string>, signal: AbortSignal): Promise<T> {
    const response = await fetch(endpoint(action, extras), { signal })
    if (!response.ok) throw new Error('Workspace request failed')
    return response.json() as Promise<T>
  }

  function showTree(): void {
    const rows: Row[] = []
    function add(path: string, depth: number): boolean {
      const folder = folders.get(path)
      if (!folder) return false
      let truncated = folder.truncated
      for (const entry of folder.entries) {
        const open = expanded.has(entry.path)
        rows.push({ ...entry, depth, open })
        if (open) truncated = add(entry.path, depth + 1) || truncated
      }
      if (folder.next !== null) rows.push({ kind: 'more', path, depth })
      return truncated
    }
    const truncated = add('', 0)
    set({ rows, treeBusy: loading.size > 0, treeError: truncated ? 'This folder has more entries than the browser can list.' : '' })
  }

  async function loadFolder(path: string, append = false): Promise<void> {
    if (loading.has(path)) return
    const previous = folders.get(path)
    if (append && (previous?.next === null || previous === undefined)) return
    const controller = new AbortController()
    loading.set(path, controller)
    if (!current.query.trim()) set({ treeBusy: true, treeError: '' })
    try {
      const folder = await request<Folder>('tree', { path, offset: String(append ? previous?.next ?? 0 : 0) }, controller.signal)
      if (controller.signal.aborted) return
      if (append) {
        const unique = new Map([...(previous?.entries ?? []), ...folder.entries].map(entry => [entry.path, entry]))
        folder.entries = Array.from(unique.values())
      }
      folders.set(path, folder)
      if (!current.query.trim()) showTree()
    }
    catch {
      if (!controller.signal.aborted && !current.query.trim()) set({ treeError: 'Could not list this folder.' })
    }
    finally {
      if (loading.get(path) === controller) {
        loading.delete(path)
        if (!current.query.trim()) set({ treeBusy: loading.size > 0 })
      }
    }
  }

  function toggleFolder(path: string): void {
    if (expanded.delete(path)) showTree()
    else {
      expanded.add(path)
      showTree()
      if (!folders.has(path)) void loadFolder(path)
    }
  }

  function clearSearchRequest(): void {
    if (searchDelay !== undefined) clearTimeout(searchDelay)
    searchRequest?.abort()
  }

  function search(query: string, refresh = false): void {
    clearSearchRequest()
    set({ query })
    if (!query.trim()) { showTree(); return }
    const controller = new AbortController()
    searchRequest = controller
    set({ rows: [], treeBusy: true, treeError: '' })
    searchDelay = setTimeout(async () => {
      try {
        const params: Record<string, string> = { q: query }
        if (refresh) params.refresh = '1'
        const { results } = await request<{ results: string[] }>('search', params, controller.signal)
        if (controller.signal.aborted) return
        set({ rows: results.map(path => ({ kind: 'file', path, name: path, depth: 0 })), treeBusy: false })
      }
      catch {
        if (!controller.signal.aborted) set({ treeBusy: false, treeError: 'Could not search workspace files.' })
      }
    }, 120)
  }

  async function openFile(path: string): Promise<void> {
    fileRequest?.abort()
    const controller = new AbortController()
    fileRequest = controller
    set({ selected: path, preview: null, previewBusy: true, previewError: '' })
    try {
      const file = await request<WorkspaceFilePreview>('preview', { path }, controller.signal)
      if (controller.signal.aborted) return
      const lines = file.text === undefined ? 0 : file.text.split('\n').length
      const numbers = Array.from({ length: lines }, (_, index) => index + 1).join('\n')
      set({ previewBusy: false, preview: { ...file, lines, numbers, content: endpoint('content', { path }), download: endpoint('download', { path }) } })
    }
    catch {
      if (!controller.signal.aborted) set({ previewBusy: false, previewError: 'Could not open this file.' })
    }
  }

  function back(): void {
    fileRequest?.abort()
    set({ selected: '', preview: null, previewBusy: false, previewError: '' })
  }

  function refresh(): void {
    const visibleFolders = [...folders.keys()].filter(path => path && expanded.has(path))
    for (const controller of loading.values()) controller.abort()
    loading.clear()
    folders.clear()
    if (current.query.trim()) search(current.query, true)
    void loadFolder('')
    for (const path of visibleFolders) void loadFolder(path)
    if (current.selected) void openFile(current.selected)
  }

  function dispose(): void {
    clearSearchRequest()
    fileRequest?.abort()
    for (const controller of loading.values()) controller.abort()
    loading.clear()
  }

  return { open: () => folders.has('') ? undefined : loadFolder(''), toggleFolder,
    loadMore: (path: string) => loadFolder(path, true), search, openFile, back, refresh, dispose }
}

export function workspaceFileLocation(element: Element | null | undefined): { path: string, line: number } | null {
  const url = element?.ownerDocument.location
  if (!url) return null
  const params = new URLSearchParams(url.search)
  const path = params.get('file')
  return path ? { path, line: Number(params.get('line')) || 0 } : null
}

export function copyWorkspaceFileLink(element: Element, path: string, line: number, native?: NativeClipboard): Promise<void> {
  const location = element.ownerDocument.location
  const url = new URL(location.href)
  url.searchParams.set('file', path)
  if (line > 0) url.searchParams.set('line', String(line))
  else url.searchParams.delete('line')
  url.hash = ''
  return writeClipboardText(element, url.href, native)
}

export function scrollWorkspaceFileLine(element: HTMLElement | undefined, line: number): void {
  const text = element?.querySelector<HTMLElement>('pre[data-workspace-source-text]')
  if (!element || !text) return
  const lineHeight = Number.parseFloat(text.ownerDocument.defaultView!.getComputedStyle(text).lineHeight)
  element.scrollTop = Math.max(0, (line - 1) * lineHeight - element.clientHeight / 3)
}
