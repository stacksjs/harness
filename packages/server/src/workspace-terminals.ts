import type { PtyOptions } from './pty'
import type { ProjectScript } from './project-scripts'
import type { SavedTerminalScope, TerminalHistoryStore } from './terminal-history'
import { Terminal } from '@harness/ansi'
import { Pty } from './pty'
import { terminalHistory } from './terminal-history'

export interface TerminalScope {
  workspaceId: number
  sessionId?: number
  resumeKey?: string
}

interface WorkspaceTerminal<Peer> {
  id: number
  scope: TerminalScope
  shell: 'system' | 'den'
  cols: number
  rows: number
  peers: Set<Peer>
  pty: Pty
  model?: Terminal
  savedScope?: SavedTerminalScope
  pendingHistory?: ReturnType<typeof setTimeout>
  exit?: { code: number | null }
  stopOnSettle?: boolean
}

function savedTerminalScope(scope: TerminalScope): SavedTerminalScope | undefined {
  if (scope.sessionId === undefined || !scope.resumeKey) return
  return { workspaceId: scope.workspaceId, sessionId: scope.sessionId, resumeKey: scope.resumeKey }
}

/** Keep a thread's terminal independent of the sockets that render it. */
export class WorkspaceTerminals<Peer> {
  private readonly terminals = new Map<number, WorkspaceTerminal<Peer>>()
  private nextId = 0

  constructor(
    private readonly send: (peer: Peer, frame: unknown) => void,
    private readonly history: TerminalHistoryStore,
  ) {}

  resume(peer: Peer, scope: TerminalScope): boolean {
    if (!scope.resumeKey) return false
    for (const terminal of this.terminals.values()) {
      if (terminal.scope.workspaceId === scope.workspaceId && terminal.scope.sessionId === scope.sessionId
        && terminal.scope.resumeKey === scope.resumeKey) {
        this.attach(peer, terminal)
        return true
      }
    }
    return false
  }

  savedHistory(scope: TerminalScope): string | undefined {
    const saved = savedTerminalScope(scope)
    if (saved) return this.history.read(saved)
  }

  processIds(scope: { workspaceId: number, sessionId: number }): number[] {
    const ids: number[] = []
    for (const terminal of this.terminals.values()) {
      if (terminal.exit || terminal.scope.sessionId !== scope.sessionId || terminal.scope.workspaceId !== scope.workspaceId) continue
      const pid = terminal.pty.processId
      if (pid !== undefined) ids.push(pid)
    }
    return ids
  }

  open(peer: Peer, scope: TerminalScope, shell: WorkspaceTerminal<Peer>['shell'], options: PtyOptions, saved?: string, script?: ProjectScript): void {
    // Scratch directory creation can yield between the first resume check and opening.
    if (this.resume(peer, scope)) return
    const { cols, rows } = options
    const savedScope = savedTerminalScope(scope)
    const model = savedScope ? new Terminal({ cols, rows, ...terminalHistory }) : undefined
    const restoring = saved !== undefined && model?.restoreHistory(saved) === true
    if (restoring) model?.write('[Host restarted. Previous output restored.]\r\n')
    if (savedScope) {
      try { this.history.register(savedScope) }
      catch (error) {
        if (script) throw error
        this.warnHistory()
      }
    }
    const terminal: WorkspaceTerminal<Peer> = {
      id: ++this.nextId, scope, shell, cols, rows, peers: new Set(), pty: new Pty(options),
      model, savedScope,
      stopOnSettle: script?.stopOnSettle,
    }
    this.terminals.set(terminal.id, terminal)
    terminal.pty.onData((data) => {
      if (!this.terminals.has(terminal.id)) return
      terminal.model?.write(data)
      if (terminal.model && !terminal.pendingHistory)
        terminal.pendingHistory = setTimeout(() => this.flushHistory(terminal), 500)
      this.broadcast(terminal, { t: 'term-data', termId: terminal.id, data })
    })
    terminal.pty.onExit((code) => {
      if (!this.terminals.has(terminal.id)) return
      terminal.exit = { code }
      this.flushHistory(terminal)
      this.broadcast(terminal, { t: 'term-exit', termId: terminal.id, code })
      if (!scope.resumeKey) this.terminals.delete(terminal.id)
    })
    this.attach(peer, terminal, restoring, script?.autoOpenPreview ? script.previewUrl : undefined)
  }

  private attach(peer: Peer, terminal: WorkspaceTerminal<Peer>, replay = true, openPreview?: string): void {
    terminal.peers.add(peer)
    this.send(peer, {
      t: 'term-opened', termId: terminal.id, workspaceId: terminal.scope.workspaceId,
      shell: terminal.shell, cols: terminal.cols, rows: terminal.rows,
      ...(replay && terminal.model ? { checkpoint: terminal.model.checkpoint() } : {}),
      ...(terminal.exit ? { exit: terminal.exit } : {}),
      ...(openPreview ? { openPreview } : {}),
    })
  }

  private broadcast(terminal: WorkspaceTerminal<Peer>, frame: unknown): void {
    for (const peer of terminal.peers) this.send(peer, frame)
  }

  input(peer: Peer, id: number, data: string): void {
    const terminal = this.terminals.get(id)
    if (terminal?.peers.has(peer) && !terminal.exit) terminal.pty.write(data)
  }

  resize(peer: Peer, id: number, cols: number, rows: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal?.peers.has(peer) || terminal.exit || (terminal.cols === cols && terminal.rows === rows)) return
    terminal.cols = cols
    terminal.rows = rows
    terminal.model?.resize(cols, rows)
    terminal.pty.resize(cols, rows)
    if (terminal.scope.resumeKey) this.broadcast(terminal, { t: 'term-sized', termId: id, cols, rows })
  }

  close(peer: Peer, id: number): void {
    const terminal = this.terminals.get(id)
    if (!terminal?.peers.has(peer)) return
    try {
      if (terminal.savedScope) this.history.remove(terminal.savedScope)
    }
    catch {
      this.send(peer, { t: 'term-error', termId: terminal.id, message: 'Could not clear this terminal’s saved output. Try ending it again.' })
      return
    }
    this.remove(terminal)
  }

  detach(peer: Peer, id: number): void {
    const terminal = this.terminals.get(id)
    if (terminal?.scope.resumeKey) terminal.peers.delete(peer)
  }

  disconnect(peer: Peer): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.peers.delete(peer) && !terminal.scope.resumeKey) this.remove(terminal)
    }
  }

  stopScriptJobs(sessionId: number): void {
    for (const terminal of this.terminals.values()) {
      if (terminal.scope.sessionId !== sessionId || terminal.exit || !terminal.stopOnSettle) continue
      this.flushHistory(terminal)
      terminal.exit = { code: null }
      terminal.pty.kill()
      this.broadcast(terminal, { t: 'term-exit', termId: terminal.id, code: null })
    }
  }

  prune(exists: (scope: TerminalScope) => boolean): void {
    for (const terminal of this.terminals.values()) {
      if (!exists(terminal.scope)) this.remove(terminal)
    }
    try { this.history.prune(exists) }
    catch { this.warnHistory() }
  }

  shutdown(): void {
    for (const terminal of this.terminals.values()) {
      this.flushHistory(terminal)
      // A server stop is a disconnect. Sending term-closed would erase the tab on clients.
      this.remove(terminal, false)
    }
    this.history.close()
  }

  private flushHistory(terminal: WorkspaceTerminal<Peer>): void {
    if (!terminal.pendingHistory || !terminal.model || !terminal.savedScope) return
    clearTimeout(terminal.pendingHistory)
    terminal.pendingHistory = undefined
    try { this.history.write(terminal.savedScope, terminal.model.saveHistory()) }
    catch { this.warnHistory() }
  }

  private warnHistory(): void {
    console.warn('Harness could not update saved terminal history.')
  }

  private remove(terminal: WorkspaceTerminal<Peer>, notify = true): void {
    clearTimeout(terminal.pendingHistory)
    this.terminals.delete(terminal.id)
    if (notify) this.broadcast(terminal, { t: 'term-closed', termId: terminal.id })
    terminal.peers.clear()
    if (!terminal.exit) terminal.pty.kill()
  }
}
