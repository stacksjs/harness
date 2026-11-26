import { describe, expect, it } from 'bun:test'
import {
  ariaKeyshortcuts,
  chordText,
  conflictingCommand,
  craftShortcut,
  defaultKeybindings,
  formatChord,
  keybindingCommands,
  matchCommand,
  parseChord,
  resolveKeybindings,
} from '../src/keybindings'
import { createKeybindingStore } from '../src/keybindings-store'
import type { KeybindingStorage } from '../src/keybindings-store'

/** A keyboard event as the registry reads one: a code, a key, four flags. */
function press(init: { code?: string, key?: string, meta?: boolean, ctrl?: boolean, alt?: boolean, shift?: boolean }): KeyboardEvent {
  return {
    code: init.code ?? '',
    key: init.key ?? '',
    metaKey: init.meta === true,
    ctrlKey: init.ctrl === true,
    altKey: init.alt === true,
    shiftKey: init.shift === true,
  } as KeyboardEvent
}

function fakeStorage(initial: string | null = null): KeybindingStorage & { value: string | null } {
  return {
    value: initial,
    getItem(key) {
      return key === 'harness.keybindings.v1' ? this.value : null
    },
    setItem(_key, value) {
      this.value = value
    },
    removeItem() {
      this.value = null
    },
  }
}

describe('the keyboard registry', () => {
  it('ships a parsable, modified, unique default for every command', () => {
    const seen = new Set<string>()
    for (const command of keybindingCommands) {
      const chord = parseChord(command.chord)
      expect(chord, command.id).not.toBeNull()
      // Canonical, so a stored override of the default compares equal to it.
      expect(chordText(chord!)).toBe(command.chord)
      expect(seen.has(command.chord), `${command.id} duplicates ${command.chord}`).toBe(false)
      seen.add(command.chord)
    }
  })

  it('parses modifier spellings and folds key case', () => {
    expect(parseChord('mod+k')).toEqual({ key: 'K', mod: true, ctrl: false, alt: false, shift: false })
    expect(chordText(parseChord('Cmd+Shift+p')!)).toBe('Mod+Shift+P')
    expect(chordText(parseChord('command+alt+n')!)).toBe('Mod+Alt+N')
    expect(chordText(parseChord('control+`')!)).toBe('Ctrl+`')
    expect(chordText(parseChord('Mod+Option+ArrowUp')!)).toBe('Mod+Alt+ArrowUp')
    expect(chordText(parseChord('ctrl+enter')!)).toBe('Ctrl+Enter')
  })

  it('refuses chords the workspace cannot answer', () => {
    expect(parseChord('K')).toBeNull()
    expect(parseChord('Shift+K')).toBeNull()
    expect(parseChord('Mod+Escape')).toBeNull()
    expect(parseChord('Mod+Tab')).toBeNull()
    expect(parseChord('Hyper+K')).toBeNull()
    expect(parseChord('Mod+F13')).toBeNull()
    expect(parseChord('')).toBeNull()
    expect(parseChord(null)).toBeNull()
    expect(parseChord(42)).toBeNull()
  })

  it('announces both primary modifiers to assistive technology', () => {
    expect(ariaKeyshortcuts(parseChord('Mod+K')!)).toBe('Meta+K Control+K')
    expect(ariaKeyshortcuts(parseChord('Mod+Alt+N')!)).toBe('Meta+Alt+N Control+Alt+N')
    expect(ariaKeyshortcuts(parseChord('Mod+Shift+K')!)).toBe('Meta+Shift+K Control+Shift+K')
    // A Control-only chord is one token: there is no Command spelling of it.
    expect(ariaKeyshortcuts(parseChord('Ctrl+`')!)).toBe('Control+`')
    expect(ariaKeyshortcuts(parseChord('Alt+ArrowUp')!)).toBe('Alt+ArrowUp')
  })

  it('writes a chord the way the platform does', () => {
    expect(formatChord(parseChord('Mod+,')!, true)).toBe('⌘,')
    expect(formatChord(parseChord('Mod+,')!, false)).toBe('Ctrl+,')
    expect(formatChord(parseChord('Mod+Alt+N')!, true)).toBe('⌥⌘N')
    expect(formatChord(parseChord('Mod+Alt+N')!, false)).toBe('Ctrl+Alt+N')
    expect(formatChord(parseChord('Ctrl+`')!, true)).toBe('⌃`')
    expect(formatChord(parseChord('Mod+Shift+Enter')!, true)).toBe('⇧⌘↩')
  })
})

describe('stored overrides', () => {
  it('keeps a valid override and reports what it could not use', () => {
    const resolved = resolveKeybindings({
      'thread.search': 'Mod+Shift+K',
      'settings.open': 'Mod+Escape',
      'thread.gone': 'Mod+G',
      'terminal.toggle': 'Ctrl+`',
    })
    expect(resolved.bindings['thread.search']).toBe('Mod+Shift+K')
    expect(resolved.overrides).toEqual({ 'thread.search': 'Mod+Shift+K' })
    // An override equal to the default is not an override, so its row offers
    // no reset.
    expect(resolved.overrides['terminal.toggle']).toBeUndefined()
    // Unusable entries fall back rather than unbinding the command.
    expect(resolved.bindings['settings.open']).toBe('Mod+,')
    expect(resolved.rejected).toEqual([
      { id: 'settings.open', chord: 'Mod+Escape', reason: 'invalid-chord' },
      { id: 'thread.gone', chord: 'Mod+G', reason: 'unknown-command' },
    ])
  })

  it('recovers the defaults from a store that is not a binding table', () => {
    for (const stored of [null, undefined, 'Mod+K', 42, ['Mod+K']]) {
      expect(resolveKeybindings(stored).bindings).toEqual(defaultKeybindings())
      expect(resolveKeybindings(stored).rejected).toEqual([])
    }
  })

  it('drops the override, not the default, when a store holds a collision', () => {
    // A collision can only arrive from outside the pane, which refuses to
    // save one. Whichever command is on its default keeps the chord, so no
    // default is ever left unreachable.
    const stolen = resolveKeybindings({ 'thread.search': 'Mod+F' })
    expect(stolen.bindings['transcript.find']).toBe('Mod+F')
    expect(stolen.bindings['thread.search']).toBe('Mod+K')
    expect(stolen.overrides).toEqual({})
    expect(stolen.rejected).toEqual([{ id: 'thread.search', chord: 'Mod+F', reason: 'conflict' }])

    const reversed = resolveKeybindings({ 'transcript.find': 'Mod+K' })
    expect(reversed.bindings['thread.search']).toBe('Mod+K')
    expect(reversed.bindings['transcript.find']).toBe('Mod+F')
    expect(reversed.rejected).toEqual([{ id: 'transcript.find', chord: 'Mod+K', reason: 'conflict' }])
  })

  it('keeps a swap that collides only while it is half applied', () => {
    // Two commands trading chords is a valid end state, and the result must
    // not depend on which key the store happened to list first.
    const swapped = resolveKeybindings({ 'thread.search': 'Mod+F', 'transcript.find': 'Mod+K' })
    expect(swapped.bindings['thread.search']).toBe('Mod+F')
    expect(swapped.bindings['transcript.find']).toBe('Mod+K')
    expect(swapped.rejected).toEqual([])
    const reordered = resolveKeybindings({ 'transcript.find': 'Mod+K', 'thread.search': 'Mod+F' })
    expect(reordered.bindings).toEqual(swapped.bindings)
    expect(reordered.rejected).toEqual([])
  })

  it('resolves a chain of collisions down to one survivor per chord', () => {
    // Three commands on one chord: the default holder keeps it and both
    // overrides are reported, rather than one surviving by position.
    const piled = resolveKeybindings({ 'thread.search': 'Mod+,', 'transcript.find': 'Mod+,' })
    expect(piled.bindings['settings.open']).toBe('Mod+,')
    expect(piled.bindings['thread.search']).toBe('Mod+K')
    expect(piled.bindings['transcript.find']).toBe('Mod+F')
    expect(piled.overrides).toEqual({})
    expect(piled.rejected.map(entry => entry.id).sort()).toEqual(['thread.search', 'transcript.find'])
    expect(new Set(Object.values(piled.bindings)).size).toBe(Object.keys(piled.bindings).length)
  })

  it('names the command a chord already belongs to', () => {
    const bindings = defaultKeybindings()
    expect(conflictingCommand(bindings, 'Mod+K', 'transcript.find')?.id).toBe('thread.search')
    expect(conflictingCommand(bindings, 'Mod+K', 'thread.search')).toBeNull()
    expect(conflictingCommand(bindings, 'Mod+Shift+K', 'thread.search')).toBeNull()
  })

  it('lets a focused terminal command share a chord with a workspace command', () => {
    const native = { apple: true, craft: true }
    const stored = { 'thread.search': 'Mod+D' }
    const resolved = resolveKeybindings(stored, native)
    const chord = press({ code: 'KeyD', meta: true })
    expect(resolved.overrides).toEqual(stored)
    expect(matchCommand(resolved.bindings, chord, native)).toBe('thread.search')
    expect(matchCommand(resolved.bindings, chord, { ...native, terminalFocus: true })).toBe('terminal.split')
    expect(conflictingCommand(resolved.bindings, 'Mod+D', 'terminal.new')?.id).toBe('terminal.split')
    expect(conflictingCommand(resolved.bindings, 'Mod+D', 'thread.search')).toBeNull()
  })
})

describe('matching a keypress', () => {
  const bindings = defaultKeybindings()

  it('accepts either primary modifier and rejects both at once', () => {
    expect(matchCommand(bindings, press({ code: 'KeyK', key: 'k', meta: true }))).toBe('thread.search')
    expect(matchCommand(bindings, press({ code: 'KeyK', key: 'k', ctrl: true }))).toBe('thread.search')
    expect(matchCommand(bindings, press({ code: 'KeyK', key: 'k', meta: true, ctrl: true }))).toBeNull()
    expect(matchCommand(bindings, press({ code: 'KeyK', key: 'k' }))).toBeNull()
  })

  it('keeps a Control-only chord distinct from the primary modifier', () => {
    expect(matchCommand(bindings, press({ code: 'Backquote', key: '`', ctrl: true }))).toBe('terminal.toggle')
    expect(matchCommand(bindings, press({ code: 'Backquote', key: '`', meta: true }))).toBeNull()
  })

  it('reads the physical key, so a modified layout still matches', () => {
    // macOS answers Option+N with `˜` and Option+F with `ƒ`: a chord read
    // from `event.key` would stop matching the moment Alt is held.
    expect(matchCommand(bindings, press({ code: 'KeyN', key: '˜', meta: true, alt: true }))).toBe('thread.startWithoutProject')
    expect(matchCommand(bindings, press({ code: 'Comma', key: ',', meta: true }))).toBe('settings.open')
  })

  it('separates chords that differ only by Shift or Alt', () => {
    expect(matchCommand(bindings, press({ code: 'KeyF', key: 'f', meta: true }))).toBe('transcript.find')
    expect(matchCommand(bindings, press({ code: 'KeyF', key: 'f', meta: true, shift: true }))).toBeNull()
    expect(matchCommand(bindings, press({ code: 'KeyN', key: 'n', meta: true }))).toBeNull()
  })

  it('follows an override to the new chord and off the old one', () => {
    const rebound = resolveKeybindings({ 'thread.search': 'Mod+Shift+K' }).bindings
    expect(matchCommand(rebound, press({ code: 'KeyK', key: 'k', meta: true, shift: true }))).toBe('thread.search')
    expect(matchCommand(rebound, press({ code: 'KeyK', key: 'k', meta: true }))).toBeNull()
  })

  it('keeps terminal commands local to the focused pane and protects shell Control keys', () => {
    const desktop = { apple: true, craft: true }
    const terminal = { ...desktop, terminalFocus: true }
    const native = defaultKeybindings(desktop)
    const split = press({ code: 'KeyD', meta: true })
    expect(matchCommand(native, split, desktop)).toBeNull()
    expect(matchCommand(native, split, terminal)).toBe('terminal.split')
    expect(matchCommand(native, press({ code: 'KeyD', meta: true, shift: true }), terminal)).toBe('terminal.splitVertical')
    expect(matchCommand(native, press({ code: 'KeyN', meta: true }), terminal)).toBe('terminal.new')
    expect(matchCommand(native, press({ code: 'KeyW', meta: true }), terminal)).toBe('terminal.close')
    expect(matchCommand(native, press({ code: 'KeyD', ctrl: true }), terminal)).toBeNull()
    expect(matchCommand(native, press({ code: 'KeyK', ctrl: true }), terminal)).toBeNull()
    expect(matchCommand(native, press({ code: 'Backquote', ctrl: true }), terminal)).toBe('terminal.toggle')
    expect(matchCommand(bindings, press({ code: 'KeyW', ctrl: true }), { terminalFocus: true })).toBeNull()
    expect(matchCommand(bindings, press({ code: 'KeyW', alt: true, shift: true }), { terminalFocus: true })).toBe('terminal.close')
  })

  it('keeps browser-reserved new and close chords out of defaults and formats Craft accelerators', () => {
    const browser = defaultKeybindings({ apple: true })
    expect(browser['terminal.new']).toBe('Alt+Shift+N')
    expect(browser['terminal.close']).toBe('Alt+Shift+W')
    expect(ariaKeyshortcuts(parseChord('Mod+Shift+D')!, true)).toBe('Meta+Shift+D')
    expect(craftShortcut('Mod+Shift+D')).toBe('cmd+shift+d')
    expect(craftShortcut('Ctrl+Alt+ArrowUp')).toBe('ctrl+alt+up')
  })
})

describe('the override store', () => {
  it('resolves and resets terminal overrides against platform defaults', () => {
    const mac = { apple: true, craft: true }
    const storage = fakeStorage()
    const store = createKeybindingStore(storage, undefined, mac)
    expect(store.read().bindings['terminal.close']).toBe('Mod+W')
    expect(store.save('terminal.close', 'Alt+Shift+W').ok).toBe(true)
    expect(store.read().overrides).toEqual({ 'terminal.close': 'Alt+Shift+W' })
    expect(store.reset('terminal.close').bindings['terminal.close']).toBe('Mod+W')
  })

  it('saves, reports, and resets one binding', () => {
    const storage = fakeStorage()
    const store = createKeybindingStore(storage)
    expect(store.read().overrides).toEqual({})

    const saved = store.save('thread.search', 'mod+shift+k')
    expect(saved.ok).toBe(true)
    // Canonicalized on the way in, so the store holds one spelling.
    expect(JSON.parse(storage.value!)).toEqual({ 'thread.search': 'Mod+Shift+K' })
    expect(store.read().bindings['thread.search']).toBe('Mod+Shift+K')

    expect(store.reset('thread.search').overrides).toEqual({})
    // An empty table is removed rather than written as `{}`.
    expect(storage.value).toBeNull()
  })

  it('refuses a chord another command owns and leaves the binding alone', () => {
    const storage = fakeStorage()
    const store = createKeybindingStore(storage)
    const result = store.save('transcript.find', 'Mod+K')
    expect(result).toEqual({ ok: false, reason: 'conflict', command: keybindingCommands.find(c => c.id === 'thread.search') })
    expect(storage.value).toBeNull()
    expect(store.read().bindings['transcript.find']).toBe('Mod+F')
  })

  it('refuses an unbindable chord and an unregistered command', () => {
    const store = createKeybindingStore(fakeStorage())
    expect(store.save('thread.search', 'K')).toEqual({ ok: false, reason: 'invalid' })
    expect(store.save('thread.search', 'Mod+Escape')).toEqual({ ok: false, reason: 'invalid' })
    expect(store.save('thread.invented', 'Mod+J')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('records a chord equal to the default as no override at all', () => {
    const storage = fakeStorage(JSON.stringify({ 'thread.search': 'Mod+Shift+K' }))
    const store = createKeybindingStore(storage)
    const saved = store.save('thread.search', 'Mod+K')
    expect(saved.ok).toBe(true)
    expect(store.read().overrides).toEqual({})
    expect(storage.value).toBeNull()
  })

  it('keeps every other override when one is reset', () => {
    const storage = fakeStorage(JSON.stringify({ 'thread.search': 'Mod+Shift+K', 'settings.open': 'Mod+Alt+,' }))
    const store = createKeybindingStore(storage)
    expect(store.reset('thread.search').overrides).toEqual({ 'settings.open': 'Mod+Alt+,' })
    expect(store.resetAll().overrides).toEqual({})
    expect(store.read().bindings).toEqual(defaultKeybindings())
  })

  it('falls back to the defaults on a corrupt or unreadable store', () => {
    expect(createKeybindingStore(fakeStorage('{not json')).read().bindings).toEqual(defaultKeybindings())
    const hostile: KeybindingStorage = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {
        throw new Error('blocked')
      },
      removeItem() {
        throw new Error('blocked')
      },
    }
    const store = createKeybindingStore(hostile)
    expect(store.read().bindings).toEqual(defaultKeybindings())
    // An unwritable store still answers the save; it just cannot keep it.
    expect(store.save('thread.search', 'Mod+Shift+K').ok).toBe(true)
  })
})
