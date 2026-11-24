import type { DriverKind } from '@harness/contract'
import type { DriverConfig } from '@harness/drivers'
import { providerConfigPath } from '@harness/drivers'
import { Database } from 'bun:sqlite'

export type SavedProviderLaunch = Pick<DriverConfig, 'binaryPath' | 'home'>

interface ProviderRow {
  binary_path: string | null
  resolved_home: string | null
}

interface ListedProviderRow extends ProviderRow {
  id: number
  driver_kind: DriverKind
  config: string | null
}

function launchConfig(row: ProviderRow, workspacePath: string): SavedProviderLaunch {
  const binary = row.binary_path?.trim()
  const home = row.resolved_home?.trim()
  return {
    ...(binary ? { binaryPath: /[/\\]/.test(binary) ? providerConfigPath(workspacePath, binary) : binary } : {}),
    ...(home ? { home: providerConfigPath(workspacePath, home) } : {}),
  }
}

function accountName(row: ListedProviderRow): string {
  if (row.config) {
    try {
      const name = JSON.parse(row.config)?.name
      if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 80)
    }
    catch { /* Older configurations have no display name. */ }
  }
  return `Account ${row.id}`
}

/** Reads the host-side ProviderInstance model for an explicitly selected account. */
export class SavedProviderInstances {
  private db: Database | null = null

  constructor(private readonly databasePath: string) {}

  private table(): Database | null {
    const db = this.db ??= new Database(this.databasePath, { readonly: true })

    // Minimal and pre-migration databases still run default provider accounts.
    const exists = db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'provider_instances'").get()
    return exists ? db : null
  }

  find(instanceId: number, profileId: number, driver: DriverKind, workspacePath: string): SavedProviderLaunch | null {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) return null

    const row = this.table()?.query<ProviderRow, [number, number, DriverKind]>(
      `SELECT binary_path, resolved_home FROM provider_instances
       WHERE id = ? AND profile_id = ? AND driver_kind = ?`,
    ).get(instanceId, profileId, driver)
    return row ? launchConfig(row, workspacePath) : null
  }

  list(profileId: number, workspacePath: string): Array<{ id: number, kind: DriverKind, name: string, launch: SavedProviderLaunch }> {
    const rows = this.table()?.query<ListedProviderRow, [number]>(
      `SELECT id, driver_kind, config, binary_path, resolved_home FROM provider_instances
       WHERE profile_id = ? AND driver_kind IS NOT NULL ORDER BY id`,
    ).all(profileId) ?? []

    return rows.map(row => ({ id: row.id, kind: row.driver_kind, name: accountName(row), launch: launchConfig(row, workspacePath) }))
  }

  close(): void {
    this.db?.close()
  }
}
