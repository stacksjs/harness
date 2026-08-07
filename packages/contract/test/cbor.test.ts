import { describe, expect, it } from 'bun:test'
import { CborError, decode, encode } from '../src/cbor'

function roundTrip(value: unknown): unknown {
  return decode(encode(value))
}

describe('CBOR — scalars', () => {
  it('round-trips the simple values', () => {
    expect(roundTrip(null)).toBeNull()
    expect(roundTrip(true)).toBe(true)
    expect(roundTrip(false)).toBe(false)
    expect(roundTrip(undefined)).toBeUndefined()
  })

  it('round-trips integers across every head width', () => {
    // One either side of each shortest-form boundary, since that is where an
    // encoder and decoder most easily disagree.
    for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER])
      expect(roundTrip(n)).toBe(n)
  })

  it('round-trips negative integers', () => {
    for (const n of [-1, -24, -25, -256, -257, -65536, -65537, -Number.MAX_SAFE_INTEGER])
      expect(roundTrip(n)).toBe(n)
  })

  it('round-trips non-integers as float64 without truncating', () => {
    for (const n of [0.5, -0.5, 1.25, 1e-9, 1234.5678])
      expect(roundTrip(n)).toBe(n)
  })

  it('round-trips strings including multi-byte text', () => {
    expect(roundTrip('')).toBe('')
    expect(roundTrip('hello')).toBe('hello')
    expect(roundTrip('héllo — 世界 🌍')).toBe('héllo — 世界 🌍')
  })

  it('round-trips byte strings as a copy, not a view', () => {
    const source = Uint8Array.of(1, 2, 3, 250)
    const out = roundTrip(source) as Uint8Array
    expect(Array.from(out)).toEqual([1, 2, 3, 250])
    // A view into the frame would alias, and reusing the buffer would corrupt
    // data that has already been handed to the application.
    expect(out.buffer).not.toBe(source.buffer)
  })
})

describe('CBOR — structures', () => {
  it('round-trips arrays and nesting', () => {
    expect(roundTrip([])).toEqual([])
    expect(roundTrip([1, 'two', [3, [4]]])).toEqual([1, 'two', [3, [4]]])
  })

  it('round-trips maps', () => {
    expect(roundTrip({})).toEqual({})
    expect(roundTrip({ a: 1, b: 'two', c: { d: [3] } })).toEqual({ a: 1, b: 'two', c: { d: [3] } })
  })

  it('drops undefined members so an absent field and an undefined one agree', () => {
    // Otherwise `{a: 1}` and `{a: 1, b: undefined}` produce different bytes,
    // and anything comparing frames sees a spurious difference.
    expect(encode({ a: 1, b: undefined })).toEqual(encode({ a: 1 }))
    expect(roundTrip({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('keeps an explicit null, which is a value rather than an absence', () => {
    expect(roundTrip({ a: null })).toEqual({ a: null })
    expect(encode({ a: null })).not.toEqual(encode({}))
  })
})

describe('CBOR — canonical encoding', () => {
  it('uses the shortest head for each integer', () => {
    // 23 fits in the initial byte; 24 needs one extra byte.
    expect(encode(23).length).toBe(1)
    expect(encode(24).length).toBe(2)
    expect(encode(255).length).toBe(2)
    expect(encode(256).length).toBe(3)
    expect(encode(65536).length).toBe(5)
  })

  it('encodes the same value to the same bytes every time', () => {
    const value = { seq: 7, type: 'assistant.delta', text: 'hi' }
    expect(encode(value)).toEqual(encode({ ...value }))
  })
})

describe('CBOR — refusing bad input', () => {
  it('rejects a truncated frame rather than returning a partial value', () => {
    const full = encode({ a: 'hello' })
    expect(() => decode(full.subarray(0, full.length - 2))).toThrow(CborError)
  })

  it('rejects trailing bytes, which mean the framing was wrong', () => {
    const frame = encode(1)
    const padded = new Uint8Array(frame.length + 1)
    padded.set(frame)
    expect(() => decode(padded)).toThrow(/trailing bytes/)
  })

  it('rejects non-string map keys', () => {
    // major 5 (map), one pair, key = integer 1, value = integer 2
    expect(() => decode(Uint8Array.of(0xA1, 0x01, 0x02))).toThrow(/string map keys/)
  })

  it('rejects integers beyond the safe range instead of losing precision', () => {
    // major 0, info 27, then 2^63 — well past Number.MAX_SAFE_INTEGER.
    const bytes = Uint8Array.of(0x1B, 0x80, 0, 0, 0, 0, 0, 0, 0)
    expect(() => decode(bytes)).toThrow(/safe range/)
  })

  it('refuses to encode a function', () => {
    expect(() => encode(() => {})).toThrow(CborError)
  })
})

describe('CBOR — the traffic it actually carries', () => {
  it('round-trips an assistant delta, the hottest frame on the wire', () => {
    const delta = {
      seq: 4821,
      sessionId: 12,
      commandId: 'cmd_01H',
      at: 1786000000000,
      payload: { type: 'assistant.delta', turnId: 3, text: 'The file is at src/index.ts' },
    }
    expect(roundTrip(delta)).toEqual(delta)
  })

  it('beats JSON on size for delta-shaped traffic', () => {
    const delta = { seq: 4821, sessionId: 12, payload: { type: 'assistant.delta', turnId: 3, text: 'ok' } }
    const cbor = encode(delta).length
    const json = new TextEncoder().encode(JSON.stringify(delta)).length
    expect(cbor).toBeLessThan(json)
  })

  it('round-trips a command envelope', () => {
    const envelope = {
      id: 'cmd_7f3a',
      at: 1786000000001,
      command: { type: 'session.turn.start', sessionId: 12, text: 'list the files' },
    }
    expect(roundTrip(envelope)).toEqual(envelope)
  })
})
