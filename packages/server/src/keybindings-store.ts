/**
 * Stored keyboard overrides.
 *
 * Bindings are a client preference, not host state: they live in the browser
 * store beside the follow-up behavior and the default driver, which is what
 * keeps two environments served from one host independent — a rebind on the
 * loopback origin does not reach the paired remote one, and neither writes to
 * the event log.
 *
 * Only overrides are written. Storing the full table would freeze today's
 * defaults into every browser, so a later change to a default chord would
 * reach nobody who had ever opened this pane.
 */

import { chordText, conflictingCommand, parseChord, resolveKeybindings } from './keybindings'
import type { KeybindingCommand, Keybindings, ResolvedKeybindings } from './keybindings'

export const KEYBINDINGS_KEY = 'harness.keybindings.v1'

/** The slice of `Storage` this needs, so a test can pass a plain object. */
export interface KeybindingStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export type SaveResult =
  | { ok: true, resolved: ResolvedKeybindings }
  | { ok: false, reason: 'invalid' }
  | { ok: false, reason: 'conflict', command: KeybindingCommand }

export interface KeybindingStore {
  read: () => ResolvedKeybindings
  save: (id: string, chord: string) => SaveResult
  reset: (id: string) => ResolvedKeybindings
  resetAll: () => ResolvedKeybindings
}

/**
 * Open the override store.
 *
 * Every read goes back to storage rather than to a cached copy: another tab on
 * the same origin may have rebound a chord, and a stale table would answer a
 * keypress with the wrong command.
 */
export function createKeybindingStore(storage: KeybindingStorage, key = KEYBINDINGS_KEY): KeybindingStore {
  function read(): ResolvedKeybindings {
    let stored: unknown = null
    try {
      const raw = storage.getItem(key)
      // A quota-blocked or disabled store, and a store holding something that
      // is not JSON, both resolve to the defaults rather than throwing: the
      // keyboard is not the place to take the page down.
      stored = raw ? JSON.parse(raw) : null
    }
    catch {
      stored = null
    }
    return resolveKeybindings(stored)
  }

  function write(overrides: Keybindings): ResolvedKeybindings {
    try {
      if (Object.keys(overrides).length) storage.setItem(key, JSON.stringify(overrides))
      else storage.removeItem(key)
    }
    catch {
      // Unwritable storage still rebinds for this page; it just will not
      // survive the reload. Reporting it as a failed save would be wrong.
    }
    return read()
  }

  return {
    read,
    save(id, chord) {
      const parsed = parseChord(chord)
      if (!parsed) return { ok: false, reason: 'invalid' }
      const text = chordText(parsed)
      const current = read()
      if (!(id in current.bindings)) return { ok: false, reason: 'invalid' }
      const conflict = conflictingCommand(current.bindings, text, id)
      // Refused rather than reassigned. Taking a chord away from the other
      // command would leave it silently unbound, and the person rebinding
      // this one would not know.
      if (conflict) return { ok: false, reason: 'conflict', command: conflict }
      const overrides = { ...current.overrides }
      const resolved = resolveKeybindings({ ...overrides, [id]: text })
      // Back to default is an override removed, not an override recorded.
      if (resolved.overrides[id] === undefined) delete overrides[id]
      else overrides[id] = text
      return { ok: true, resolved: write(overrides) }
    },
    reset(id) {
      const { overrides } = read()
      delete overrides[id]
      return write(overrides)
    },
    resetAll() {
      return write({})
    },
  }
}
