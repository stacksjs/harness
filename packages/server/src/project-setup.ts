import type { ProjectScript } from './project-scripts'
import { Database } from 'bun:sqlite'

export interface ProjectSetupScope {
  workspaceId: number
  sessionId: number
  checkout: string
}

interface ProjectJob {
  scriptId: string
  name: string
  resumeKey: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'skipped'
  exitCode: number | null
}

interface SetupReceipt extends ProjectJob {
  wait: number
}

export interface SettlementReceipt extends ProjectSetupScope, ProjectJob {
  seq: number
  settledAt: number
  fingerprint: string
}

type StartSetup = (receipt: SetupReceipt) => Promise<number | null>
type JobExit = number | null | 'skipped'

const settlementColumns = 'workspace_id AS workspaceId, session_id AS sessionId, checkout, seq, settledAt, scriptId, name, resumeKey, fingerprint, status, exitCode'

/** Private receipts contain identities and outcomes. Commands and output stay in their existing stores. */
export class ProjectSetup {
  private readonly db: Database
  private readonly jobs = new Map<string, Promise<JobExit>>()
  private closed = false

  constructor(databasePath: string) {
    this.db = new Database(databasePath)
    this.db.exec('PRAGMA busy_timeout = 250; PRAGMA secure_delete = ON')
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_project_setup (
      workspace_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      checkout TEXT NOT NULL,
      scriptId TEXT NOT NULL,
      name TEXT NOT NULL,
      resumeKey TEXT NOT NULL UNIQUE,
      wait INTEGER NOT NULL,
      status TEXT NOT NULL,
      exitCode INTEGER,
      PRIMARY KEY (workspace_id, session_id, checkout)
    ) WITHOUT ROWID`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_project_setup_history (
      resumeKey TEXT PRIMARY KEY, workspace_id INTEGER NOT NULL, session_id INTEGER NOT NULL, exitCode INTEGER
    ) WITHOUT ROWID`)
    this.db.exec(`CREATE TABLE IF NOT EXISTS harness_project_settlements (
      workspace_id INTEGER NOT NULL,
      session_id INTEGER NOT NULL,
      checkout TEXT NOT NULL,
      seq INTEGER NOT NULL,
      settledAt INTEGER NOT NULL,
      scriptId TEXT NOT NULL,
      name TEXT NOT NULL,
      resumeKey TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      exitCode INTEGER,
      PRIMARY KEY (session_id, seq)
    ) WITHOUT ROWID`)
    this.db.exec("CREATE INDEX IF NOT EXISTS harness_pending_settlements ON harness_project_settlements (settledAt, seq) WHERE status = 'pending'")
  }

  reserve(scope: ProjectSetupScope, script: ProjectScript): void {
    this.db.query(`INSERT OR IGNORE INTO harness_project_setup VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`)
      .run(scope.workspaceId, scope.sessionId, scope.checkout, script.id, script.name, crypto.randomUUID(), Number(Boolean(script.waitForSetup)))
  }

  read(scope: ProjectSetupScope): SetupReceipt | null {
    const receipt = this.db.query<SetupReceipt, [number, number, string]>(`SELECT scriptId, name, resumeKey, wait, status, exitCode
      FROM harness_project_setup WHERE workspace_id = ? AND session_id = ? AND checkout = ?`)
      .get(scope.workspaceId, scope.sessionId, scope.checkout)
    return this.withInterruption(receipt)
  }

  reserveSettlement(writer: Database, scope: ProjectSetupScope, seq: number, settledAt: number, script: ProjectScript, fingerprint: string): void {
    writer.query(`INSERT INTO harness_project_settlements VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL)`)
      .run(scope.workspaceId, scope.sessionId, scope.checkout, seq, settledAt, script.id, script.name, crypto.randomUUID(), fingerprint)
  }

  pendingSettlements(sessionId?: number): SettlementReceipt[] {
    return sessionId === undefined
      ? this.db.query<SettlementReceipt, []>(`SELECT ${settlementColumns} FROM harness_project_settlements WHERE status = 'pending' ORDER BY settledAt, seq`).all()
      : this.db.query<SettlementReceipt, [number]>(`SELECT ${settlementColumns} FROM harness_project_settlements WHERE session_id = ? AND status = 'pending' ORDER BY seq`).all(sessionId)
  }

  latestSettlement(scope: ProjectSetupScope): SettlementReceipt | null {
    const receipt = this.db.query<SettlementReceipt, [number, number, string]>(`SELECT ${settlementColumns} FROM harness_project_settlements
      WHERE session_id = ? AND workspace_id = ? AND checkout = ? ORDER BY seq DESC LIMIT 1`)
      .get(scope.sessionId, scope.workspaceId, scope.checkout)
    return this.withInterruption(receipt)
  }

  runSettlement(receipt: SettlementReceipt, start: () => Promise<JobExit>): void {
    this.launch('harness_project_settlements', receipt.resumeKey, start)
  }

  private withInterruption<T extends ProjectJob>(receipt: T | null): T | null {
    if (receipt?.status === 'running' && !this.jobs.has(receipt.resumeKey)) receipt.status = 'interrupted'
    return receipt
  }

  history(workspaceId: number, sessionId: number, resumeKey: string): { exitCode: number | null } | null {
    return this.db.query<{ exitCode: number | null }, [number, number, string]>(`SELECT exitCode FROM harness_project_setup
        WHERE workspace_id = ?1 AND session_id = ?2 AND resumeKey = ?3
      UNION ALL SELECT exitCode FROM harness_project_setup_history
        WHERE workspace_id = ?1 AND session_id = ?2 AND resumeKey = ?3
      UNION ALL SELECT exitCode FROM harness_project_settlements
        WHERE workspace_id = ?1 AND session_id = ?2 AND resumeKey = ?3`)
      .get(workspaceId, sessionId, resumeKey)
  }

  async run(scope: ProjectSetupScope, signal: AbortSignal, start: StartSetup): Promise<string | null> {
    const receipt = this.read(scope)
    if (!receipt || signal.aborted) return null
    let job = this.jobs.get(receipt.resumeKey)
    if (receipt.status === 'pending') {
      job = this.launch('harness_project_setup', receipt.resumeKey, () => signal.aborted ? null : start(receipt))
      if (!job) return 'The setup run changed. Open Project scripts and try again.'
    }
    if (!receipt.wait || receipt.status === 'completed' || receipt.status === 'skipped') return null
    const code = job ? await job : receipt.exitCode
    if (code === 0 || signal.aborted) return null
    return code === null
      ? 'Worktree setup was interrupted. Open Project scripts to check the terminal, then retry or continue without setup.'
      : `Worktree setup exited with code ${code}. Open Project scripts to check the terminal, then retry or continue without setup.`
  }

  private launch(table: 'harness_project_setup' | 'harness_project_settlements', key: string,
    start: () => Promise<JobExit> | JobExit,
  ): Promise<JobExit> | undefined {
    const claim = this.db.query(`UPDATE ${table} SET status = 'running' WHERE resumeKey = ? AND status = 'pending'`).run(key)
    if (!claim.changes) return
    const job = Promise.resolve().then(start).catch(() => null).then((code) => {
      this.jobs.delete(key)
      if (!this.closed) {
        const status = code === 'skipped' ? 'skipped' : code === null ? 'interrupted' : code === 0 ? 'completed' : 'failed'
        this.db.query(`UPDATE ${table} SET status = ?, exitCode = ? WHERE resumeKey = ?`)
          .run(status, code === 'skipped' ? null : code, key)
      }
      return code
    })
    this.jobs.set(key, job)
    void job.catch(() => {})
    return job
  }

  resolve(scope: ProjectSetupScope, action: 'retry-setup' | 'skip-setup', script?: ProjectScript): boolean {
    const receipt = this.read(scope)
    if (!receipt || (receipt.status !== 'failed' && receipt.status !== 'interrupted')) return false
    if (action === 'skip-setup') {
      return this.db.query(`UPDATE harness_project_setup SET status = 'skipped' WHERE resumeKey = ? AND status IN ('failed', 'running', 'interrupted')`)
        .run(receipt.resumeKey).changes > 0
    }
    if (!script?.runOnWorktreeCreate) return false
    return this.db.transaction(() => {
      const result = this.db.query(`UPDATE harness_project_setup SET scriptId = ?, name = ?, resumeKey = ?, wait = ?, status = 'pending', exitCode = NULL
        WHERE resumeKey = ? AND status IN ('failed', 'running', 'interrupted')`)
        .run(script.id, script.name, crypto.randomUUID(), Number(Boolean(script.waitForSetup)), receipt.resumeKey)
      if (result.changes) this.db.query('INSERT INTO harness_project_setup_history VALUES (?, ?, ?, ?)')
        .run(receipt.resumeKey, scope.workspaceId, scope.sessionId, receipt.exitCode)
      return result.changes > 0
    }).immediate()
  }

  prune(exists: (scope: { workspaceId: number, sessionId: number }) => boolean): void {
    const scopes = this.db.query<{ workspaceId: number, sessionId: number }, []>(`SELECT workspace_id AS workspaceId, session_id AS sessionId FROM harness_project_setup
      UNION SELECT workspace_id AS workspaceId, session_id AS sessionId FROM harness_project_setup_history
      UNION SELECT workspace_id AS workspaceId, session_id AS sessionId FROM harness_project_settlements`).all()
    this.db.transaction(() => {
      for (const scope of scopes) {
        if (exists(scope)) continue
        this.db.query('DELETE FROM harness_project_setup WHERE workspace_id = ? AND session_id = ?').run(scope.workspaceId, scope.sessionId)
        this.db.query('DELETE FROM harness_project_setup_history WHERE workspace_id = ? AND session_id = ?').run(scope.workspaceId, scope.sessionId)
        this.db.query('DELETE FROM harness_project_settlements WHERE workspace_id = ? AND session_id = ?').run(scope.workspaceId, scope.sessionId)
      }
    }).immediate()
  }

  close(): void {
    this.closed = true
    this.db.close()
  }
}
