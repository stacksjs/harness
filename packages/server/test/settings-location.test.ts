import { describe, expect, it } from 'bun:test'
import { settingsSection, workspaceReturn } from '../src/settings-location'

describe('workspace settings routes', () => {
  it('recognizes the index and the implemented sections', () => {
    expect(settingsSection('/settings')).toBe('general')
    expect(settingsSection('/settings/providers')).toBe('providers')
    expect(settingsSection('/settings/keybindings')).toBe('keybindings')
    expect(settingsSection('/settings/archived')).toBe('archived')
    expect(settingsSection('/settings/not-a-section')).toBeNull()
  })

  it('restores a local workspace or thread and ignores external return targets', () => {
    expect(workspaceReturn('/?workspace=91')).toBe('/?workspace=91')
    expect(workspaceReturn('/s/782?profile=105#turn-2')).toBe('/s/782?profile=105#turn-2')
    expect(workspaceReturn('//other.example/out')).toBe('/')
    expect(workspaceReturn('/\\other.example/out')).toBe('/')
    expect(workspaceReturn('/\\[')).toBe('/')
    expect(workspaceReturn('/settings/providers')).toBe('/')
  })
})
