import type { Database } from 'bun:sqlite'
import type { QuestionRequest, SignalAddress, WaitOutcome } from './signals'
import { validAnswer, workflowSignalTtl } from './signals'

type WaitRow = {
  run_id: string
  name: string
  channel: string | null
  request: string | null
  outcome: string | null
  opened_at: number
  deadline: number | null
  resolved_at: number | null
}

type SignalRow = {
  id: string
  target: string
  name: string
  run: number
  value: string
  state: 'buffered' | 'delivered' | 'discarded'
}

type SignalResult = { status: 'buffered' | 'delivered', replayed: boolean } | { error: 'missing' | 'conflict' | 'invalid' }

const expired: WaitOutcome = { expired: true }

export class WorkflowWaitStore {
  constructor(private readonly db: Database, private readonly owns: (id: string, owner: string, now: number) => boolean) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS harness_workflow_waits (
        run_id TEXT NOT NULL, name TEXT NOT NULL, channel TEXT, request TEXT, outcome TEXT,
        opened_at INTEGER NOT NULL, deadline INTEGER, resolved_at INTEGER,
        PRIMARY KEY (run_id, name)
      );
      CREATE INDEX IF NOT EXISTS harness_workflow_wait_due ON harness_workflow_waits (deadline) WHERE outcome IS NULL;
      CREATE INDEX IF NOT EXISTS harness_workflow_wait_channel ON harness_workflow_waits (channel) WHERE outcome IS NULL;
      CREATE TABLE IF NOT EXISTS harness_workflow_signals (
        profile INTEGER NOT NULL, id TEXT NOT NULL, target TEXT NOT NULL, name TEXT NOT NULL, run INTEGER NOT NULL,
        value TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY (profile, id)
      );
      CREATE INDEX IF NOT EXISTS harness_workflow_signal_address
        ON harness_workflow_signals (profile, target, name, run) WHERE state = 'buffered';
      CREATE INDEX IF NOT EXISTS harness_workflow_signal_expiry ON harness_workflow_signals (expires_at);
    `)
  }

  private lookup(id: string, name: string) {
    return this.db.query<WaitRow, [string, string]>('SELECT * FROM harness_workflow_waits WHERE run_id = ? AND name = ?').get(id, name)
  }

  outcome(runId: string, name: string) {
    const row = this.lookup(runId, name)
    return row?.outcome ? JSON.parse(row.outcome) as WaitOutcome : null
  }

  private wake(row: Pick<WaitRow, 'run_id' | 'name'>, outcome: WaitOutcome, now: number) {
    this.db.query('UPDATE harness_workflow_waits SET outcome = ?, resolved_at = ? WHERE run_id = ? AND name = ? AND outcome IS NULL')
      .run(JSON.stringify(outcome), now, row.run_id, row.name)
    this.db.query(`UPDATE harness_workflow_runs SET status = 'running', detail = NULL, updated_at = ?
      WHERE id = ? AND status = 'waiting'`).run(now, row.run_id)
  }

  open(profile: number, workflow: string, id: string, owner: string, name: string,
    options: { channel?: string, request?: string, timeoutMs?: number }, now: number,
  ) {
    return this.db.transaction(() => {
      if (!this.owns(id, owner, now)) return null
      const prior = this.lookup(id, name)
      if (prior) {
        if (!prior.outcome && prior.deadline !== null && prior.deadline <= now) {
          this.wake(prior, expired, now)
          return { outcome: expired }
        }
        return { outcome: prior.outcome === null ? null : JSON.parse(prior.outcome) as WaitOutcome }
      }
      const { channel, request, timeoutMs } = options
      this.db.query(`INSERT INTO harness_workflow_waits (run_id, name, channel, request, opened_at, deadline)
        VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, channel ?? null, request ?? null, now, timeoutMs === undefined ? null : now + timeoutMs)
      const signals = this.db.query<SignalRow, [number, number, string, string, string, string | null]>(
        `SELECT * FROM harness_workflow_signals WHERE profile = ? AND state = 'buffered' AND expires_at > ?
          AND ((run = 1 AND target = ? AND name = ?) OR (run = 0 AND target = ? AND name = ?)) ORDER BY rowid`,
      ).all(profile, now, id, name, workflow, channel ?? null)
      const question = request === undefined ? null : JSON.parse(request) as QuestionRequest
      for (const signal of signals) {
        const value = JSON.parse(signal.value)
        if (question && !validAnswer(question, value)) {
          this.db.query(`UPDATE harness_workflow_signals SET state = 'discarded' WHERE profile = ? AND id = ?`).run(profile, signal.id)
          continue
        }
        this.db.query(`UPDATE harness_workflow_signals SET state = 'delivered' WHERE profile = ? AND id = ?`).run(profile, signal.id)
        const outcome = { expired: false, value } as const
        this.wake({ run_id: id, name }, outcome, now)
        return { outcome }
      }
      return { outcome: null }
    }).immediate()
  }

  park(id: string, owner: string, names: string[], now: number) {
    return this.db.transaction(() => {
      if (!this.owns(id, owner, now)) return 'lost'
      const unresolved = this.db.query<{ total: number }, [string, string]>(`
        SELECT count(*) AS total FROM harness_workflow_waits
        WHERE run_id = ? AND name IN (SELECT value FROM json_each(?)) AND outcome IS NULL`).get(id, JSON.stringify(names))
      if (unresolved?.total !== names.length) return 'ready'
      this.db.query(`UPDATE harness_workflow_runs SET status = 'waiting', updated_at = ?, owner = NULL, lease_until = NULL
        WHERE id = ?`).run(now, id)
      return 'parked'
    }).immediate()
  }

  signal(profile: number, address: SignalAddress, key: string, serialized: string, now: number, openQuestionOnly: boolean): SignalResult {
    const direct = 'runId' in address
    const target = direct ? address.runId : address.workflow
    const name = direct ? address.wait : address.channel
    return this.db.transaction((): SignalResult => {
      this.db.query('DELETE FROM harness_workflow_signals WHERE profile = ? AND id = ? AND expires_at <= ?').run(profile, key, now)
      const prior = this.db.query<SignalRow, [number, string]>('SELECT * FROM harness_workflow_signals WHERE profile = ? AND id = ?').get(profile, key)
      if (prior) return prior.run === Number(direct) && prior.target === target && prior.name === name && prior.value === serialized
        && prior.state !== 'discarded' ? { status: prior.state, replayed: true } : { error: 'conflict' }

      let wait: WaitRow | null
      if (direct) {
        const run = this.db.query<{ status: string }, [string, number]>('SELECT status FROM harness_workflow_runs WHERE id = ? AND profile = ?').get(target, profile)
        if (!run) return { error: 'missing' }
        const candidate = this.lookup(target, name)
        wait = ['running', 'waiting', 'paused'].includes(run.status) && candidate && !candidate.outcome
          && (candidate.deadline === null || candidate.deadline > now) ? candidate : null
        if (openQuestionOnly && !wait?.request) return { error: 'conflict' }
      }
      else {
        wait = this.db.query<WaitRow, [number, string, string, number]>(`SELECT w.* FROM harness_workflow_waits w
          JOIN harness_workflow_runs r ON r.id = w.run_id
          WHERE r.profile = ? AND r.name = ? AND w.channel = ? AND w.outcome IS NULL
            AND r.status IN ('running', 'waiting', 'paused') AND (w.deadline IS NULL OR w.deadline > ?)
          ORDER BY w.opened_at, w.rowid LIMIT 1`).get(profile, target, name, now)
      }

      const value = JSON.parse(serialized)
      if (wait?.request && !validAnswer(JSON.parse(wait.request), value)) return { error: 'invalid' }
      const status = wait ? 'delivered' : 'buffered'
      this.db.query(`INSERT INTO harness_workflow_signals (profile, id, target, name, run, value, state, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(profile, key, target, name, Number(direct), serialized, status, now + workflowSignalTtl)
      if (wait) this.wake(wait, { expired: false, value }, now)
      return { status, replayed: false }
    }).immediate()
  }

  sweep(now: number) {
    const due = this.db.query<WaitRow, [number]>(`SELECT w.* FROM harness_workflow_waits w
      JOIN harness_workflow_runs r ON r.id = w.run_id
      WHERE w.outcome IS NULL AND w.deadline <= ? AND r.status IN ('running', 'waiting', 'paused')
      ORDER BY w.deadline LIMIT 100`).all(now)
    if (due.length) this.db.transaction(() => {
      for (const row of due) {
        const pending = this.lookup(row.run_id, row.name)
        if (pending && !pending.outcome && pending.deadline !== null && pending.deadline <= now)
          this.wake(row, expired, now)
      }
    }).immediate()
    this.db.query(`DELETE FROM harness_workflow_signals WHERE rowid IN
      (SELECT rowid FROM harness_workflow_signals WHERE expires_at <= ? LIMIT 100)`).run(now)
  }

  questions(profile: number, now: number, run?: string) {
    return this.db.query<WaitRow & { title: string }, [number, number, string | null, string | null]>(`
      SELECT w.*, r.title FROM harness_workflow_waits w JOIN harness_workflow_runs r ON r.id = w.run_id
      WHERE r.profile = ? AND r.status IN ('running', 'waiting', 'paused') AND w.request IS NOT NULL
        AND w.outcome IS NULL AND (w.deadline IS NULL OR w.deadline > ?) AND (? IS NULL OR r.id = ?)
      ORDER BY w.opened_at, w.rowid LIMIT 100`).all(profile, now, run ?? null, run ?? null)
      .map(row => ({ runId: row.run_id, title: row.title, name: row.name, request: JSON.parse(row.request!) as QuestionRequest,
        askedAt: new Date(row.opened_at).toISOString(), deadline: row.deadline === null ? null : new Date(row.deadline).toISOString(),
      }))
  }

  history(run: string) {
    return this.db.query<WaitRow & { run_status: string, run_ended_at: number | null }, [string]>(`
      SELECT w.*, r.status AS run_status, r.ended_at AS run_ended_at FROM harness_workflow_waits w
      JOIN harness_workflow_runs r ON r.id = w.run_id WHERE run_id = ? ORDER BY w.opened_at, w.rowid`).all(run)
      .map(row => {
        const outcome = row.outcome ? JSON.parse(row.outcome) as WaitOutcome : null
        const cancelled = row.run_status === 'cancelled' && !outcome
        const ended = row.resolved_at ?? (cancelled ? row.run_ended_at : null)
        return {
          name: row.name, kind: row.request ? 'ask' as const : 'wait' as const,
          status: outcome ? 'completed' as const : cancelled ? 'failed' as const : 'running' as const, attempts: 1,
          detail: cancelled ? 'Run cancelled.' : outcome?.expired ? 'Timed out.' : row.request ? null : row.channel ? 'Channel ' + row.channel : null,
          result: outcome && !outcome.expired ? outcome.value : null,
          startedAt: new Date(row.opened_at).toISOString(),
          endedAt: ended === null ? null : new Date(ended).toISOString(),
        }
      })
  }
}
