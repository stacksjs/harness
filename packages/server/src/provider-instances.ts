import type { DriverKind } from '@harness/contract'
import type { ChatGptCredentialStore, DriverConfig } from '@harness/drivers'
import { providerConfigPath } from '@harness/drivers'
import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type SavedProviderLaunch = Pick<DriverConfig, 'binaryPath' | 'home'> & { chatGptClientId?: string }

export function chatGptCredentialDirectory(): string {
  return join(homedir(), '.harness', 'credentials', 'chatgpt')
}

interface ProviderRow {
  binary_path: string | null
  resolved_home: string | null
  config: string | null
}

interface ListedProviderRow extends ProviderRow {
  id: number
  driver_kind: DriverKind
}

interface ProviderAccountInput {
  kind: DriverKind
  name: string
  binaryPath?: string
  home?: string
  chatGptClientId?: string
}

function launchConfig(row: ProviderRow, workspacePath: string): SavedProviderLaunch {
  const chatGptClientId = providerSettings(row).chatGptClientId
  if (typeof chatGptClientId === 'string' && /^oaiapp_[\w-]+$/u.test(chatGptClientId)) return { chatGptClientId }
  const binary = row.binary_path?.trim()
  const home = row.resolved_home?.trim()
  return {
    ...(binary ? { binaryPath: /[/\\]/.test(binary) ? providerConfigPath(workspacePath, binary) : binary } : {}),
    ...(home ? { home: providerConfigPath(workspacePath, home) } : {}),
  }
}

function providerSettings(row: ProviderRow): { name?: unknown, chatGptClientId?: unknown } {
  try {
    const parsed = JSON.parse(row.config ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  }
  catch {
    return {}
  }
}

function accountName(row: ListedProviderRow): string {
  const { name } = providerSettings(row)
  if (typeof name === 'string' && name.trim()) return name.trim().slice(0, 80)
  return `Account ${row.id}`
}

export async function providerLaunchConfig(
  store: ChatGptCredentialStore,
  launch: SavedProviderLaunch,
): Promise<Pick<DriverConfig, 'home' | 'binaryPath' | 'chatGptPlan'>> {
  const { chatGptClientId, ...native } = launch
  if (!chatGptClientId) return native
  return {
    home: await store.runtimeHome(chatGptClientId),
    chatGptPlan: {
      connected: () => store.connected(chatGptClientId),
      accessToken: () => store.accessToken(chatGptClientId),
    },
  }
}

function hasProviderTable(db: Database): boolean {
  return Boolean(db.query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'provider_instances'").get())
}

/** Reads the host-side ProviderInstance model for an explicitly selected account. */
export class SavedProviderInstances {
  private db: Database | null = null

  constructor(private readonly databasePath: string) {}

  private table(): Database | null {
    const db = this.db ??= new Database(this.databasePath, { readonly: true })

    // Minimal and pre-migration databases still run default provider accounts.
    return hasProviderTable(db) ? db : null
  }

  find(instanceId: number, profileId: number, driver: DriverKind, workspacePath: string): SavedProviderLaunch | null {
    if (!Number.isSafeInteger(instanceId) || instanceId <= 0) return null

    const row = this.table()?.query<ProviderRow, [number, number, DriverKind]>(
      `SELECT binary_path, resolved_home, config FROM provider_instances
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

/** Writes provider launch settings from the host CLI. Browser clients only read their catalog. */
export function addSavedProvider(
  databasePath: string,
  profileId: number,
  input: ProviderAccountInput,
): number {
  const name = input.name.trim()
  if (!name || name.length > 80) throw new Error('Enter an account name from 1 to 80 characters.')
  if (input.binaryPath?.includes('\0') || input.home?.includes('\0'))
    throw new Error('Provider paths cannot contain a null character.')
  if (input.chatGptClientId && (input.kind !== 'codex' || input.home || input.binaryPath || !/^oaiapp_[\w-]+$/u.test(input.chatGptClientId)))
    throw new Error('Managed ChatGPT requires a valid registration and its own Codex settings.')

  using db = new Database(databasePath, { readwrite: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  if (!hasProviderTable(db)) throw new Error('Run ./buddy migrate before adding named provider accounts.')
  return db.transaction(() => {
    const profile = db.query<{ type: string, name: string }, [number]>(`
      SELECT type, json_extract(payload, '$.name') AS name FROM events
      WHERE type IN ('profile.created', 'profile.deleted') AND json_extract(payload, '$.profileId') = ?
      ORDER BY id DESC LIMIT 1
    `).get(profileId)
    if (profile?.type !== 'profile.created') throw new Error('No Harness profile has that ID.')

    const binaryPath = input.binaryPath?.trim() || null
    const home = input.home?.trim() || null
    const named = db.query<ListedProviderRow, [number, DriverKind]>(`
      SELECT id, driver_kind, config, binary_path, resolved_home FROM provider_instances
      WHERE profile_id = ? AND driver_kind = ? ORDER BY id
    `).all(profileId, input.kind).find(row => accountName(row).toLowerCase() === name.toLowerCase())
    if (named) {
      if (named.binary_path === binaryPath && named.resolved_home === home
        && providerSettings(named).chatGptClientId === input.chatGptClientId) return named.id
      throw new Error('That account name already has different launch settings.')
    }

    // Harness profiles come from the event log. Keep a row for the model's
    // foreign key when an account is first attached, including older profiles.
    db.query('INSERT INTO profiles (id, name) VALUES (?, ?) ON CONFLICT (id) DO NOTHING').run(profileId, profile.name)
    const result = db.query<{ id: number }, [number, DriverKind, string, string | null, string | null]>(`
      INSERT INTO provider_instances (profile_id, driver_kind, config, status, binary_path, resolved_home)
      VALUES (?, ?, ?, 'unknown', ?, ?) RETURNING id
    `).get(profileId, input.kind, JSON.stringify({ name, chatGptClientId: input.chatGptClientId }), binaryPath, home)
    if (!result) throw new Error('Could not save the provider account.')
    return result.id
  }).immediate()
}

export function removeSavedProvider(databasePath: string, profileId: number, accountId: number): boolean {
  using db = new Database(databasePath, { readwrite: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000')
  if (!hasProviderTable(db)) return false
  return db.query('DELETE FROM provider_instances WHERE id = ? AND profile_id = ?').run(accountId, profileId).changes === 1
}
