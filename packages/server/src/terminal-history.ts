import { Database } from 'bun:sqlite'

export const terminalHistory = { scrollback: 5000, scrollbackBytes: 8 * 1024 * 1024 } as const

export interface SavedTerminalScope {
  workspaceId: number
  sessionId: number
  resumeKey: string
}

/** Local display history, separate from the workspace event log and network exports. */
export class TerminalHistoryStore {
  private readonly db: Database

  constructor(databasePath: string) {
    this.db = new Database(databasePath)
    this.db.exec('PRAGMA busy_timeout = 250; PRAGMA secure_delete = ON')
    // This runtime table is additive, including for databases from older Harness builds.
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_terminal_history (
      workspace_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      resume_key TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      PRIMARY KEY (workspace_id, session_id, resume_key)
    ) WITHOUT ROWID`)
  }

  read(scope: SavedTerminalScope): string | undefined {
    return this.db.query<{ rows_json: string }, [number, number, string, number]>(
      `SELECT rows_json FROM harness_terminal_history
        WHERE workspace_id = ? AND session_id = ? AND resume_key = ?
          AND length(CAST(rows_json AS BLOB)) <= ?`,
    ).get(scope.workspaceId, scope.sessionId, scope.resumeKey, terminalHistory.scrollbackBytes)?.rows_json
  }

  register(scope: SavedTerminalScope): void {
    this.db.query('INSERT OR IGNORE INTO harness_terminal_history VALUES (?, ?, ?, ?)')
      .run(scope.workspaceId, scope.sessionId, scope.resumeKey, '[]')
  }

  write(scope: SavedTerminalScope, rows: string): void {
    this.db.query('UPDATE harness_terminal_history SET rows_json = ? WHERE workspace_id = ? AND session_id = ? AND resume_key = ?')
      .run(rows, scope.workspaceId, scope.sessionId, scope.resumeKey)
  }

  remove(scope: SavedTerminalScope): void {
    this.db.query('DELETE FROM harness_terminal_history WHERE workspace_id = ? AND session_id = ? AND resume_key = ?')
      .run(scope.workspaceId, scope.sessionId, scope.resumeKey)
  }

  prune(exists: (scope: Pick<SavedTerminalScope, 'workspaceId' | 'sessionId'>) => boolean): void {
    const scopes = this.db.query<{ workspaceId: number, sessionId: number }, []>(
      'SELECT DISTINCT workspace_id AS workspaceId, session_id AS sessionId FROM harness_terminal_history',
    ).all()
    const remove = this.db.query('DELETE FROM harness_terminal_history WHERE workspace_id = ? AND session_id = ?')
    this.db.transaction(() => {
      for (const scope of scopes) {
        if (!exists(scope)) remove.run(scope.workspaceId, scope.sessionId)
      }
    })()
  }

  close(): void {
    this.db.close()
  }
}
