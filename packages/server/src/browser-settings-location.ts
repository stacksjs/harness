import { settingsSection, workspaceReturn } from './settings-location'
import type { SettingsSection } from './settings-location'

export function currentSettingsSection(): SettingsSection | null {
  return settingsSection(location.pathname)
}

export function showSettingsSection(section: SettingsSection): void {
  const open = currentSettingsSection()
  const current = new URL(location.href)
  const from = open
    ? workspaceReturn(current.searchParams.get('from'))
    : workspaceReturn(current.pathname + current.search + current.hash)
  const query = from === '/' ? '' : '?' + new URLSearchParams({ from })
  const target = `/settings/${section}${query}`
  if (open) history.replaceState(history.state, '', target)
  else history.pushState({ ...history.state, harnessSettings: true }, '', target)
}

export function leaveSettings(): void {
  if (!currentSettingsSection()) return
  const current = new URL(location.href)
  if (history.state?.harnessSettings) history.back()
  else history.replaceState(history.state, '', workspaceReturn(current.searchParams.get('from')))
}
