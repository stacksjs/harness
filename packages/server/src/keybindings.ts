/**
 * The keyboard registry.
 *
 * Every window chord the workspace answers is declared here once, with its
 * default binding, so the Keyboard settings section can list them, rebind
 * them, and refuse a chord that another command already owns. Before this
 * existed each chord was an `if (event.metaKey || event.ctrlKey)` branch in
 * the island: nothing could enumerate them, so nothing could show or change
 * them, and two branches claiming one chord would simply have the earlier one
 * win.
 *
 * Pure, and shared by the server and the page. The page needs the same parser
 * the stored overrides were written with, and the server renders the defaults
 * into the settings pane before the island hydrates.
 */

/**
 * `mod` is the platform's primary modifier: Command on Apple keyboards,
 * Control everywhere else. It is one flag rather than two bindings because a
 * binding should not have to be re-recorded per platform, and because the
 * live handlers have always accepted either key for these chords.
 */
export interface Chord {
  key: string
  mod: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export interface KeybindingCommand {
  id: string
  label: string
  description: string
  /** Default chord, in the same text form stored overrides use. */
  chord: string
  scope?: 'terminal' | 'global'
  appleChord?: string
  craftChord?: string
}

export interface KeybindingPlatform {
  apple?: boolean
  craft?: boolean
}

export interface KeybindingContext extends KeybindingPlatform {
  terminalFocus?: boolean
}

/**
 * The registry. Order is display order in the settings pane.
 *
 * `Escape` is deliberately absent: it closes whichever sheet is open, every
 * dialog depends on it, and a rebound Escape would strand a modal open.
 */
export const keybindingCommands: readonly KeybindingCommand[] = [
  {
    id: 'settings.open',
    label: 'Open settings',
    description: 'Open the settings sheet at its last section.',
    chord: 'Mod+,',
    scope: 'global',
  },
  {
    id: 'thread.search',
    label: 'Search threads',
    description: 'Search thread titles, projects, branches, and message text.',
    chord: 'Mod+K',
  },
  {
    id: 'transcript.find',
    label: 'Find in thread',
    description: 'Find text within the open transcript.',
    chord: 'Mod+F',
  },
  {
    id: 'thread.startWithoutProject',
    label: 'Start without a project',
    description: 'Open a scratch thread with no project attached.',
    chord: 'Mod+Alt+N',
  },
  {
    id: 'composer.stash',
    label: 'Stash or restore prompt',
    description: 'Save the draft or open the stash when the composer is empty.',
    chord: 'Mod+S',
  },
  {
    id: 'thread.undo',
    label: 'Undo thread action',
    description: 'Restore the previous thread position while Undo is available.',
    chord: 'Mod+Z',
  },
  {
    id: 'terminal.toggle',
    label: 'Toggle the terminal',
    description: 'Show or hide the docked workspace terminal.',
    chord: 'Ctrl+`',
    scope: 'global',
  },
  {
    id: 'terminal.new',
    label: 'New terminal',
    description: 'Open a separate tab from a focused terminal.',
    chord: 'Alt+Shift+N',
    craftChord: 'Mod+N',
    scope: 'terminal',
  },
  {
    id: 'terminal.split',
    label: 'Split terminal side by side',
    description: 'Add a pane beside the focused terminal.',
    chord: 'Alt+Shift+D',
    appleChord: 'Mod+D',
    scope: 'terminal',
  },
  {
    id: 'terminal.splitVertical',
    label: 'Split terminal top and bottom',
    description: 'Add a pane to the focused terminal group and stack its panes.',
    chord: 'Alt+Shift+V',
    appleChord: 'Mod+Shift+D',
    scope: 'terminal',
  },
  {
    id: 'terminal.close',
    label: 'End terminal session',
    description: 'End the focused shell and clear its scrollback.',
    chord: 'Alt+Shift+W',
    craftChord: 'Mod+W',
    scope: 'terminal',
  },
]

/** Command id to command, for lookups that must not scan. */
const byId = new Map(keybindingCommands.map(command => [command.id, command]))

function keybindingScopes(command: KeybindingCommand): readonly string[] {
  if (command.scope === 'global') return ['workspace', 'terminal']
  return [command.scope ?? 'workspace']
}

/**
 * Letter and punctuation keys addressed by physical position.
 *
 * `event.key` is the wrong input for a chord that carries Alt: macOS answers
 * Alt+N with `˜` and Alt+F with `ƒ`, so a binding recorded as `n` would never
 * match again. `event.code` is layout-dependent in the other direction, which
 * is why only this fixed set is mapped and everything else falls back to the
 * key itself.
 */
const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: '\'',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Space: 'Space',
}

/** Named keys a chord may use on their own, with their canonical spelling. */
const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  space: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
}

/** Chords the workspace keeps for itself, whatever a stored override says. */
const RESERVED = new Set(['Escape', 'Tab'])

function canonicalKey(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  const named = NAMED_KEYS[text.toLowerCase()]
  if (named) return named
  if (text.length === 1) {
    const upper = text.toUpperCase()
    // Letters and digits canonicalize to uppercase so `Mod+k` and `Mod+K`
    // are one binding; punctuation has no case to fold.
    return /[a-z0-9]/i.test(text) ? upper : text
  }
  return null
}

/**
 * Parse a chord, or null when the text is not one this app can answer.
 *
 * Null covers the invalid-preference case the settings pane recovers from: a
 * hand-edited store, a binding left behind by an older build, or a chord with
 * no modifier at all, which would swallow ordinary typing.
 */
export function parseChord(text: unknown): Chord | null {
  if (typeof text !== 'string') return null
  const parts = text.split('+').map(part => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const keyText = parts.pop() as string
  const chord: Chord = { key: '', mod: false, ctrl: false, alt: false, shift: false }
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod': case 'cmd': case 'command': case 'meta': chord.mod = true; break
      case 'ctrl': case 'control': chord.ctrl = true; break
      case 'alt': case 'option': case 'opt': chord.alt = true; break
      case 'shift': chord.shift = true; break
      default: return null
    }
  }
  const key = canonicalKey(keyText)
  if (!key || RESERVED.has(key)) return null
  // At least one modifier, always: a bare letter would fire while typing in
  // the composer, and a bare function key is not a chord this app offers.
  if (!chord.mod && !chord.ctrl && !chord.alt) return null
  chord.key = key
  return chord
}

/** Canonical text for a chord, and the identity two chords are compared by. */
export function chordText(chord: Chord): string {
  const parts: string[] = []
  if (chord.mod) parts.push('Mod')
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key)
  return parts.join('+')
}

const SYMBOLS: Record<string, string> = {
  Enter: '↩',
  Space: '␣',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
}

/**
 * Human-readable chord, in the idiom of the platform it will be pressed on.
 *
 * Apple keyboards get the glyphs with no separators, the way every macOS menu
 * writes them; everything else gets words joined by `+`.
 */
export function formatChord(chord: Chord, apple: boolean): string {
  const key = SYMBOLS[chord.key] ?? chord.key
  if (apple) {
    let text = ''
    if (chord.ctrl) text += '⌃'
    if (chord.alt) text += '⌥'
    if (chord.shift) text += '⇧'
    if (chord.mod) text += '⌘'
    return text + key
  }
  const parts: string[] = []
  if (chord.mod || chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(key)
  return parts.join('+')
}

/**
 * The chord as `aria-keyshortcuts` names it.
 *
 * A `Mod` chord yields two tokens, Meta and Control, because the attribute
 * has no notion of a platform-primary modifier and a screen reader should
 * announce the one its user can actually press.
 */
export function ariaKeyshortcuts(chord: Chord, appleTerminal = false): string {
  const tail = (chord.alt ? 'Alt+' : '') + (chord.shift ? 'Shift+' : '') + chord.key
  if (chord.ctrl && !chord.mod) return `Control+${tail}`
  if (!chord.mod) return tail
  if (appleTerminal) return `${chord.ctrl ? 'Control+' : ''}Meta+${tail}`
  return `Meta+${tail} Control+${tail}`
}

/** Craft menu accelerators use AppKit modifiers even when a web binding accepts aliases. */
export function craftShortcut(text: string): string | undefined {
  const chord = parseChord(text)
  return chord ? chordText(chord).toLowerCase().replace(/^mod\b/, 'cmd').replace(/\+arrow(?=up|down|left|right)/, '+') : undefined
}

/** Format a stored chord string, falling back to the text when unparsable. */
export function formatChordText(text: string, apple: boolean): string {
  const chord = parseChord(text)
  return chord ? formatChord(chord, apple) : text
}

export type Keybindings = Record<string, string>

/** Every command at its default chord. */
function defaultChord(command: KeybindingCommand, platform: KeybindingPlatform): string {
  if (platform.apple && platform.craft && command.craftChord) return command.craftChord
  return (platform.apple && command.appleChord) || command.chord
}

export function defaultKeybindings(platform: KeybindingPlatform = {}): Keybindings {
  const bindings: Keybindings = {}
  for (const command of keybindingCommands) bindings[command.id] = defaultChord(command, platform)
  return bindings
}

export interface ResolvedKeybindings {
  /** Every registered command, mapped to the chord actually in force. */
  bindings: Keybindings
  /** Overrides that were kept, so the pane can offer a per-row reset. */
  overrides: Keybindings
  /**
   * Stored entries that were discarded, with why. Surfaced rather than
   * swallowed: a preference that silently reverts looks like a lost setting.
   */
  rejected: { id: string, chord: unknown, reason: 'unknown-command' | 'invalid-chord' | 'conflict' }[]
}

/**
 * Fold stored overrides onto the defaults.
 *
 * Takes `unknown` because its real input is `JSON.parse` of a browser store
 * that any other build, or any user, may have written. Anything unusable is
 * dropped and reported, and the command keeps its default, so a corrupt store
 * costs one binding rather than the keyboard.
 */
export function resolveKeybindings(stored: unknown, platform: KeybindingPlatform = {}): ResolvedKeybindings {
  const bindings = defaultKeybindings(platform)
  const overrides: Keybindings = {}
  const rejected: ResolvedKeybindings['rejected'] = []
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [id, value] of Object.entries(stored as Record<string, unknown>)) {
      const command = byId.get(id)
      if (!command) {
        rejected.push({ id, chord: value, reason: 'unknown-command' })
        continue
      }
      const chord = parseChord(value)
      if (!chord) {
        rejected.push({ id, chord: value, reason: 'invalid-chord' })
        continue
      }
      const text = chordText(chord)
      if (text === defaultChord(command, platform)) continue
      bindings[id] = text
      overrides[id] = text
    }
  }
  // A store can hold a collision even though the pane refuses to save one:
  // an override written by another build, or one that landed on a chord the
  // other command had not been moved off yet. A command sitting on its
  // default outranks one carrying an override, and between two overrides the
  // earlier command wins, so the resolution never leaves a default unreachable
  // and never depends on object key order. Reverting one override can collide
  // with another, which is why this repeats until the table is stable; each
  // pass drops at least one override, so it cannot run longer than there are
  // commands.
  const overridden = new Set(Object.keys(overrides))
  for (let pass = 0; pass <= keybindingCommands.length; pass++) {
    const claims = new Map<string, string[]>()
    for (const command of keybindingCommands) {
      const text = bindings[command.id] as string
      for (const scope of keybindingScopes(command)) {
        const claim = `${scope}:${text}`
        const ids = claims.get(claim)
        if (ids) ids.push(command.id)
        else claims.set(claim, [command.id])
      }
    }
    const collision = [...claims.values()].find(ids => ids.length > 1)
    if (!collision) break
    const winner = collision.find(id => !overridden.has(id)) ?? collision[0]
    for (const id of collision) {
      // Only an override can lose. Two defaults cannot collide — the registry
      // test asserts that — so there is always something to give up here.
      if (id === winner || !overridden.has(id)) continue
      rejected.push({ id, chord: bindings[id] as string, reason: 'conflict' })
      overridden.delete(id)
      delete overrides[id]
      bindings[id] = defaultChord(byId.get(id) as KeybindingCommand, platform)
    }
  }
  return { bindings, overrides, rejected }
}

/**
 * The command a chord would collide with, or null when it is free.
 *
 * `exclude` is the row being edited: re-recording a command's own chord is
 * not a conflict.
 */
export function conflictingCommand(bindings: Keybindings, chord: string, exclude: string): KeybindingCommand | null {
  const recorded = byId.get(exclude)
  if (!recorded) return null
  const scopes = keybindingScopes(recorded)
  for (const [id, text] of Object.entries(bindings)) {
    if (id === exclude || text !== chord) continue
    const command = byId.get(id)
    if (command && keybindingScopes(command).some(scope => scopes.includes(scope))) return command
  }
  return null
}

/** The chord a keyboard event represents, or null when it is not one. */
export function chordFromEvent(event: KeyboardEvent): Chord | null {
  const fromCode = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3)
    : /^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : CODE_KEYS[event.code]
  const key = canonicalKey(fromCode ?? event.key)
  if (!key) return null
  const chord: Chord = {
    key,
    // The page cannot know which physical key the platform calls primary, so
    // either one satisfies `mod` and a chord recorded with Control alone
    // stays distinct by also setting `ctrl`.
    mod: event.metaKey || event.ctrlKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  }
  if (!chord.mod && !chord.ctrl && !chord.alt) return null
  return chord
}

/**
 * The command an event triggers, or null.
 *
 * A Control-only binding matches a Control press exactly; a `Mod` binding
 * accepts either primary key but not a stray Control alongside Command. Shift
 * must match, so `Mod+Enter` and `Mod+Shift+Enter` stay separable.
 */
export function matchCommand(bindings: Keybindings, event: KeyboardEvent, context: KeybindingContext = {}): string | null {
  if (event.isComposing || event.keyCode === 229) return null
  const pressed = chordFromEvent(event)
  if (!pressed) return null
  for (const command of keybindingCommands) {
    if (command.scope !== 'global' && (command.scope === 'terminal') !== Boolean(context.terminalFocus)) continue
    const chord = parseChord(bindings[command.id] ?? defaultChord(command, context))
    if (!chord || chord.key !== pressed.key) continue
    if (chord.alt !== pressed.alt || chord.shift !== pressed.shift) continue
    if (command.scope === 'terminal' && context.apple) {
      if (chord.mod !== event.metaKey || chord.ctrl !== event.ctrlKey) continue
      return command.id
    }
    if (chord.ctrl && !event.ctrlKey) continue
    if (!chord.ctrl && chord.mod && event.ctrlKey && event.metaKey) continue
    if (!chord.mod && !chord.ctrl && (event.metaKey || event.ctrlKey)) continue
    if (chord.mod && !pressed.mod) continue
    return command.id
  }
  return null
}
