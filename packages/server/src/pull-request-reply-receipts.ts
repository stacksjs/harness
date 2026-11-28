import { Database } from 'bun:sqlite'

/** Claimed forge writes can be confirmed after a disconnect without repeating the write. */
export class PullRequestReplyReceipts {
  constructor(private readonly databasePath: string) {}

  private access<T>(callback: (db: Database) => T): T {
    const db = new Database(this.databasePath)
    try {
      db.exec('PRAGMA busy_timeout = 250')
      db.exec(`CREATE TABLE IF NOT EXISTS harness_pull_request_reply_receipts (
        token TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 0
      )`)
      return callback(db)
    }
    finally { db.close() }
  }

  claim(token: string, fingerprint: string, canPost: boolean): 'claimed' | 'pending' | 'confirmed' | 'conflict' | 'denied' {
    return this.access(db => db.transaction(() => {
      const existing = this.existing(db, token, fingerprint)
      if (existing) return existing
      if (!canPost) return 'denied'
      db.query('INSERT INTO harness_pull_request_reply_receipts (token, fingerprint) VALUES (?, ?)').run(token, fingerprint)
      return 'claimed'
    }).immediate())
  }

  private existing(db: Database, token: string, fingerprint: string) {
    const row = db.query<{ fingerprint: string, confirmed: number }, [string]>(
      'SELECT fingerprint, confirmed FROM harness_pull_request_reply_receipts WHERE token = ?',
    ).get(token)
    if (!row) return null
    if (row.fingerprint !== fingerprint) return 'conflict' as const
    return row.confirmed ? 'confirmed' as const : 'pending' as const
  }

  inspect(token: string, fingerprint: string) {
    return this.access(db => this.existing(db, token, fingerprint))
  }

  reject(token: string, fingerprint: string): void {
    this.access(db => db.query(
      'DELETE FROM harness_pull_request_reply_receipts WHERE token = ? AND fingerprint = ? AND confirmed = 0',
    ).run(token, fingerprint))
  }

  private resultTable(db: Database): void {
    db.exec(`CREATE TABLE IF NOT EXISTS harness_external_write_results (
      token TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`)
  }

  confirmedResult(token: string, fingerprint: string): string | null {
    return this.access(db => {
      this.resultTable(db)
      return db.query<{ value: string }, [string, string]>(`
        SELECT result.value FROM harness_external_write_results AS result
        JOIN harness_pull_request_reply_receipts AS receipt ON receipt.token = result.token
        WHERE receipt.token = ? AND receipt.fingerprint = ? AND receipt.confirmed = 1
      `).get(token, fingerprint)?.value ?? null
    })
  }

  confirm(token: string, fingerprint: string, value?: string): void {
    this.access(db => {
      const update = db.query('UPDATE harness_pull_request_reply_receipts SET confirmed = 1 WHERE token = ? AND fingerprint = ? AND confirmed = 0')
      if (value === undefined) {
        update.run(token, fingerprint)
        return
      }
      db.transaction(() => {
        this.resultTable(db)
        if (update.run(token, fingerprint).changes) {
          db.query('INSERT INTO harness_external_write_results (token, value) VALUES (?, ?)').run(token, value)
        }
      }).immediate()
    })
  }
}
