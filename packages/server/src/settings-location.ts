export const settingsSections = [
  { id: 'general', label: 'General', icon: 'i-hugeicons-settings-02' },
  { id: 'appearance', label: 'Appearance', icon: 'i-hugeicons-paint-brush-02' },
  { id: 'providers', label: 'Providers', icon: 'i-hugeicons-ai-chip' },
  { id: 'access', label: 'Access', icon: 'i-hugeicons-shield-01' },
  { id: 'archived', label: 'Archive', icon: 'i-hugeicons-archive-02' },
] as const

export type SettingsSection = typeof settingsSections[number]['id']

export function settingsSection(pathname: string): SettingsSection | null {
  if (pathname === '/settings' || pathname === '/settings/') return 'general'
  return settingsSections.find(section => pathname === `/settings/${section.id}`)?.id ?? null
}

export function workspaceReturn(value: string | null): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/'
  const base = 'http://harness.local'
  if (!URL.canParse(value, base)) return '/'
  const url = new URL(value, base)
  if (url.origin !== base || (url.pathname !== '/' && !/^\/s\/[1-9]\d*$/.test(url.pathname))) return '/'
  return url.pathname + url.search + url.hash
}
