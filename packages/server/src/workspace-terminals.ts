import type { PtyOptions } from './pty'
import { Terminal } from '@harness/ansi'
import { Pty } from './pty'

export const terminalHistory = { scrollback: 5000, scrollbackBytes: 8 * 1024 * 1024 } as const

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
  exit?: { code: number | null }
}

/** Keep a thread's terminal independent of the sockets that render it. */
export class WorkspaceTerminals<Peer> {
  private readonly terminals = new Map<number, WorkspaceTerminal<Peer>>()
  private nextId = 0

  constructor(private readonly send: (peer: Peer, frame: unknown) => void) {}

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

  open(peer: Peer, scope: TerminalScope, shell: WorkspaceTerminal<Peer>['shell'], options: PtyOptions): void {
    // Scratch directory creation can yield between the first resume check and opening.
    if (this.resume(peer, scope)) return
    const { cols, rows } = options
    const terminal: WorkspaceTerminal<Peer> = {
      id: ++this.nextId, scope, shell, cols, rows, peers: new Set(), pty: new Pty(options),
      ...(scope.resumeKey ? { model: new Terminal({ cols, rows, ...terminalHistory }) } : {}),
    }
    this.terminals.set(terminal.id, terminal)
    terminal.pty.onData((data) => {
      terminal.model?.write(data)
      this.broadcast(terminal, { t: 'term-data', termId: terminal.id, data })
    })
    terminal.pty.onExit((code) => {
      terminal.exit = { code }
      this.broadcast(terminal, { t: 'term-exit', termId: terminal.id, code })
      if (!scope.resumeKey) this.terminals.delete(terminal.id)
    })
    this.attach(peer, terminal, false)
  }

  private attach(peer: Peer, terminal: WorkspaceTerminal<Peer>, replay = true): void {
    terminal.peers.add(peer)
    this.send(peer, {
      t: 'term-opened', termId: terminal.id, workspaceId: terminal.scope.workspaceId,
      shell: terminal.shell, cols: terminal.cols, rows: terminal.rows,
      ...(replay && terminal.model ? { checkpoint: terminal.model.checkpoint() } : {}),
      ...(terminal.exit ? { exit: terminal.exit } : {}),
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
    if (terminal?.peers.has(peer)) this.remove(terminal)
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

  prune(exists: (scope: TerminalScope) => boolean): void {
    for (const terminal of this.terminals.values()) {
      if (!exists(terminal.scope)) this.remove(terminal)
    }
  }

  private remove(terminal: WorkspaceTerminal<Peer>): void {
    this.terminals.delete(terminal.id)
    this.broadcast(terminal, { t: 'term-closed', termId: terminal.id })
    terminal.peers.clear()
    if (!terminal.exit) terminal.pty.kill()
  }
}
