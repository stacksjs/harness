import { Database } from 'bun:sqlite'

/** A claimed reply can be confirmed after a disconnect without writing it again. */
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
      const row = db.query<{ fingerprint: string, confirmed: number }, [string]>(
        'SELECT fingerprint, confirmed FROM harness_pull_request_reply_receipts WHERE token = ?',
      ).get(token)
      if (row) {
        if (row.fingerprint !== fingerprint) return 'conflict'
        return row.confirmed ? 'confirmed' : 'pending'
      }
      if (!canPost) return 'denied'
      db.query('INSERT INTO harness_pull_request_reply_receipts (token, fingerprint) VALUES (?, ?)').run(token, fingerprint)
      return 'claimed'
    }).immediate())
  }

  confirm(token: string, fingerprint: string): void {
    this.access(db => db.query(
      'UPDATE harness_pull_request_reply_receipts SET confirmed = 1 WHERE token = ? AND fingerprint = ?',
    ).run(token, fingerprint))
  }
}
