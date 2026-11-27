import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { repositoryGit } from './repository-commit'
import { readRepositoryStatus } from './repository-status'
import { featureBranchDestination, RepositorySyncError, repositorySyncPreview, syncRepository } from './repository-sync'

export interface PublicationTarget {
  remote: string
  destinationKey: string
  ref: string
}

export interface PublicationReceipt extends PublicationTarget {
  id: string
  sessionId: number
  path: string
  requestKey: string
  base: string
  branch: string
  newBranch: boolean
  commit?: string
  outcome?: string
}

export function publicationKey(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function previewCommitPublication(path: string, canCreateBranch: boolean) {
  const [current, feature] = await Promise.all([
    repositorySyncPreview(path, 'push'),
    canCreateBranch ? featureBranchDestination(path) : null,
  ])
  return {
    current: { remote: current.remote, ref: current.ref, defaultTarget: current.defaultTarget, revision: current.revision, problem: current.problem },
    feature: feature && { remote: feature.remote, problem: feature.problem, revision: publicationKey([path, feature.destinationKey]) },
    currentTarget: { remote: current.remote, ref: current.ref, destinationKey: current.destinationKey },
    featureTarget: feature,
  }
}

export function publicationMarker(receipt: PublicationReceipt) {
  return 'harness publication ' + receipt.id
}

/** Store the confirmed destination and expected parent before invoking native Git. */
export class RepositoryPublications {
  constructor(private readonly databasePath: string) {}

  private access<T>(use: (db: Database) => T): T {
    using db = new Database(this.databasePath)
    db.exec('PRAGMA busy_timeout = 1000')
    db.exec(`CREATE TABLE IF NOT EXISTS harness_repository_publications (
      id TEXT PRIMARY KEY,
      session_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      receipt TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS harness_pending_publications
      ON harness_repository_publications (session_id, path, completed)`)
    return use(db)
  }

  read(id: string): PublicationReceipt | null {
    const row = this.access(db => db.query<{ receipt: string }, [string]>(
      'SELECT receipt FROM harness_repository_publications WHERE id = ?',
    ).get(id))
    return row ? JSON.parse(row.receipt) : null
  }

  latest(sessionId: number, path: string): PublicationReceipt | null {
    const row = this.access(db => db.query<{ receipt: string }, [number, string]>(
      'SELECT receipt FROM harness_repository_publications WHERE session_id = ? AND path = ? AND completed = 0 ORDER BY rowid DESC LIMIT 1',
    ).get(sessionId, path))
    return row ? JSON.parse(row.receipt) : null
  }

  begin(receipt: PublicationReceipt) {
    const { changes } = this.access(db => db.query(
      'INSERT INTO harness_repository_publications (id, session_id, path, receipt) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
    ).run(receipt.id, receipt.sessionId, receipt.path, JSON.stringify(receipt)))
    if (changes !== 1) throw new RepositorySyncError('This publication was already started. Reopen the Git review to check its status.')
  }

  save(receipt: PublicationReceipt) {
    this.access(db => db.query(
      'UPDATE harness_repository_publications SET receipt = ?, completed = ? WHERE id = ?',
    ).run(JSON.stringify(receipt), receipt.outcome ? 1 : 0, receipt.id))
  }

  /** A lost response or restart between the Git write and SQLite update can recover the exact commit. */
  async recover(receipt: PublicationReceipt): Promise<PublicationReceipt> {
    if (receipt.commit) return receipt
    const { path, branch, base } = receipt
    const status = await readRepositoryStatus(path)
    if (status?.branch !== branch || !status.head || status.head === base) return receipt
    const row = await repositoryGit(path, ['reflog', 'show', '-1', '--format=%H%x00%gs', 'refs/heads/' + branch]).catch(() => null)
    const [head, message] = row?.stdout.trimEnd().split('\0') ?? []
    if (head !== status.head || !message?.startsWith(publicationMarker(receipt) + ': ')) return receipt
    const parent = (await repositoryGit(path, ['rev-parse', '--verify', head + '^']).catch(() => null))?.stdout.trim()
    if (parent !== base) return receipt
    const committed = { ...receipt, commit: head }
    this.save(committed)
    return committed
  }

  async push(receipt: PublicationReceipt, authorize: () => boolean) {
    if (receipt.outcome) return receipt.outcome
    const review = await this.pushReview(receipt)
    if (review.problem) throw new RepositorySyncError(review.problem)
    const result = await syncRepository(receipt.path, 'push', review, authorize, receipt.newBranch)
    this.save({ ...receipt, outcome: result.message })
    return result.message
  }

  async pushReview(receipt: PublicationReceipt) {
    const review = await repositorySyncPreview(receipt.path, 'push')
    const problem = !receipt.commit || review.head !== receipt.commit || review.branch !== receipt.branch
      ? 'The checkout moved. Review the current branch before pushing.'
      : review.destinationKey !== receipt.destinationKey || review.ref !== receipt.ref
        ? 'The publishing destination changed. Open Push to review its new destination.'
        : review.problem
    return { ...review, problem }
  }
}
