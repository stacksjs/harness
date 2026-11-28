import type { WorkflowIssue } from './definitions'
import { Database } from 'bun:sqlite'

export type WorkflowStatus = 'running' | 'paused' | 'completed' | 'cancelled'

type RunRow = {
  id: string
  profile: number
  name: string
  version: number
  revision: string
  title: string
  payload: string
  status: WorkflowStatus
  detail: string | null
  result: string | null
  started_at: number
  updated_at: number
  ended_at: number | null
}

type StepRow = {
  name: string
  status: 'running' | 'failed' | 'completed'
  attempts: number
  result: string | null
  detail: string | null
  started_at: number
  ended_at: number | null
}

type IssueIntent = { target: string, scope: string, intent: string }
export function presentRun(row: RunRow) {
  return {
    runId: row.id, workflow: row.name, version: row.version, title: row.title, status: row.status, detail: row.detail,
    result: row.result === null ? null : JSON.parse(row.result) as unknown,
    startedAt: new Date(row.started_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
  }
}

export class WorkflowStore {
  private readonly db: Database

  constructor(databasePath: string) {
    this.db = new Database(databasePath)
    this.db.exec('PRAGMA busy_timeout = 1000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_workflow_runs (
        id TEXT PRIMARY KEY, profile INTEGER NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, revision TEXT NOT NULL,
        start_key TEXT NOT NULL, payload TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        detail TEXT, result TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        ended_at INTEGER, owner TEXT, lease_until INTEGER,
        UNIQUE (profile, name, start_key)
      );
      CREATE INDEX IF NOT EXISTS harness_workflow_run_status ON harness_workflow_runs (status, lease_until);
      CREATE TABLE IF NOT EXISTS harness_workflow_steps (
        run_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        result TEXT, detail TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
        PRIMARY KEY (run_id, name)
      );
      CREATE TABLE IF NOT EXISTS harness_workflow_issue_intents (
        run_id TEXT NOT NULL, step TEXT NOT NULL, position INTEGER NOT NULL,
        target TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT NOT NULL, result TEXT,
        PRIMARY KEY (run_id, step, position)
      );
    `)
  }

  findStart(profile: number, name: string, key: string) {
    return this.db.query<RunRow, [number, string, string]>(
      'SELECT * FROM harness_workflow_runs WHERE profile = ? AND name = ? AND start_key = ?',
    ).get(profile, name, key)
  }

  start(profile: number, name: string, version: number, revision: string, key: string, payload: string, now: number) {
    return this.db.transaction(() => {
      const existing = this.findStart(profile, name, key)
      if (existing) return { row: existing, replayed: true }
      const id = crypto.randomUUID()
      this.db.query(`INSERT INTO harness_workflow_runs
        (id, profile, name, version, revision, start_key, payload, title, status, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`).run(id, profile, name, version, revision, key, payload, name, now, now)
      return { row: this.run(profile, id)!, replayed: false }
    }).immediate()
  }

  run(profile: number, id: string) {
    return this.db.query<RunRow, [number, string]>('SELECT * FROM harness_workflow_runs WHERE profile = ? AND id = ?').get(profile, id)
  }

  list(profile: number) {
    return this.db.query<RunRow, [number]>(`SELECT * FROM harness_workflow_runs
      WHERE profile = ? ORDER BY started_at DESC, id DESC LIMIT 100`).all(profile)
  }

  steps(id: string) {
    return this.db.query<StepRow, [string]>(`SELECT name, status, attempts, result, detail, started_at, ended_at
      FROM harness_workflow_steps WHERE run_id = ? ORDER BY started_at, rowid`).all(id).map(row => ({
      name: row.name, kind: 'step' as const, status: row.status, attempts: row.attempts, detail: row.detail,
      result: row.result === null ? null : JSON.parse(row.result) as unknown,
      startedAt: new Date(row.started_at).toISOString(), endedAt: row.ended_at === null ? null : new Date(row.ended_at).toISOString(),
    }))
  }

  eligible(now: number, limit: number) {
    return this.db.query<RunRow, [number, number]>(`SELECT * FROM harness_workflow_runs
      WHERE status = 'running' AND (lease_until IS NULL OR lease_until <= ?) ORDER BY started_at LIMIT ?`).all(now, limit)
  }

  claim(id: string, owner: string, now: number, leaseUntil: number) {
    return this.db.query(`UPDATE harness_workflow_runs SET owner = ?, lease_until = ?
      WHERE id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)`).run(owner, leaseUntil, id, now).changes === 1
  }

  renew(id: string, owner: string, now: number, leaseUntil: number) {
    return this.db.query(`UPDATE harness_workflow_runs SET lease_until = ?
      WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?`).run(leaseUntil, id, owner, now).changes === 1
  }

  owns(id: string, owner: string, now: number) {
    return this.db.query(`SELECT 1 FROM harness_workflow_runs
      WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?`).get(id, owner, now) !== null
  }

  release(owner: string) {
    this.db.query('UPDATE harness_workflow_runs SET owner = NULL, lease_until = NULL WHERE owner = ?').run(owner)
  }

  cancel(profile: number, id: string, now: number) {
    return this.db.transaction(() => {
      const changed = this.db.query(`UPDATE harness_workflow_runs
        SET status = 'cancelled', detail = 'Cancelled by the host user.', updated_at = ?, ended_at = ?, owner = NULL, lease_until = NULL
        WHERE profile = ? AND id = ? AND status IN ('running', 'paused')`).run(now, now, profile, id).changes
      if (changed) this.db.query(`UPDATE harness_workflow_steps
        SET status = 'failed', detail = 'Run cancelled.', ended_at = ? WHERE run_id = ? AND status = 'running'`).run(now, id)
      return this.run(profile, id)
    }).immediate()
  }

  resume(profile: number, id: string, now: number) {
    this.db.query(`UPDATE harness_workflow_runs SET status = 'running', detail = NULL, updated_at = ?
      WHERE profile = ? AND id = ? AND status = 'paused'`).run(now, profile, id)
    return this.run(profile, id)
  }

  finish(id: string, owner: string, status: 'paused' | 'completed', now: number, detail: string | null, result: string | null) {
    this.db.transaction(() => {
      const changed = this.db.query(`UPDATE harness_workflow_runs SET status = ?, detail = ?, result = ?, updated_at = ?,
        ended_at = ?, owner = NULL, lease_until = NULL WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?`)
        .run(status, detail, result, now, status === 'completed' ? now : null, id, owner, now).changes
      if (changed && status === 'paused') this.db.query(`UPDATE harness_workflow_steps
        SET status = 'failed', detail = ?, ended_at = ? WHERE run_id = ? AND status = 'running'`).run(detail, now, id)
    }).immediate()
  }

  title(id: string, owner: string, now: number, value: string) {
    this.db.query(`UPDATE harness_workflow_runs SET title = ?, updated_at = ?
      WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?`).run(value, now, id, owner, now)
  }

  beginStep(id: string, owner: string, name: string, now: number) {
    return this.db.transaction(() => {
      if (!this.owns(id, owner, now)) return null
      const previous = this.db.query<Pick<StepRow, 'status' | 'result'>, [string, string]>(
        'SELECT status, result FROM harness_workflow_steps WHERE run_id = ? AND name = ?',
      ).get(id, name)
      if (previous?.status === 'completed') return { saved: previous.result! }
      this.db.query(`INSERT INTO harness_workflow_steps (run_id, name, status, attempts, started_at)
        VALUES (?, ?, 'running', 1, ?) ON CONFLICT (run_id, name) DO UPDATE SET
        status = 'running', attempts = attempts + 1, detail = NULL, ended_at = NULL`).run(id, name, now)
      return { saved: null }
    }).immediate()
  }

  completeStep(id: string, owner: string, name: string, now: number, result: string) {
    return this.db.query(`UPDATE harness_workflow_steps SET status = 'completed', result = ?, ended_at = ?
      WHERE run_id = ? AND name = ? AND status = 'running' AND EXISTS (
        SELECT 1 FROM harness_workflow_runs WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?
      )`).run(result, now, id, name, id, owner, now).changes === 1
  }

  issueIntent(id: string, step: string, position: number) {
    return this.db.query<IssueIntent, [string, string, number]>(
      'SELECT target, scope, intent FROM harness_workflow_issue_intents WHERE run_id = ? AND step = ? AND position = ?',
    ).get(id, step, position)
  }

  saveIssueIntent(id: string, owner: string, step: string, position: number, now: number, target: string, scope: string) {
    return this.db.transaction(() => {
      if (!this.owns(id, owner, now)) return null
      const existing = this.issueIntent(id, step, position)
      if (existing) return existing
      const intent = crypto.randomUUID()
      this.db.query(`INSERT INTO harness_workflow_issue_intents (run_id, step, position, target, scope, intent)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, step, position, target, scope, intent)
      return { target, scope, intent }
    }).immediate()
  }

  recordIssue(id: string, owner: string, step: string, position: number, now: number, result: WorkflowIssue) {
    return this.db.query(`UPDATE harness_workflow_issue_intents SET result = ?
      WHERE run_id = ? AND step = ? AND position = ? AND EXISTS (
        SELECT 1 FROM harness_workflow_runs WHERE id = ? AND owner = ? AND status = 'running' AND lease_until > ?
      )`).run(JSON.stringify(result), id, step, position, id, owner, now).changes === 1
  }

  references(id: string) {
    return this.db.query<{ step: string, result: string }, [string]>(`SELECT step, result FROM harness_workflow_issue_intents
      WHERE run_id = ? AND result IS NOT NULL ORDER BY rowid`).all(id)
      .map(row => ({ step: row.step, ...JSON.parse(row.result) as WorkflowIssue }))
  }

  close() { this.db.close() }
}
