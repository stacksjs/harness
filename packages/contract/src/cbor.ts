/**
 * A small CBOR codec for the wire (RFC 8949).
 *
 * Why not JSON: a streaming agent UI is dominated by tiny assistant deltas, and
 * JSON pays for every one of them twice — once escaping the text on the way out
 * and once re-parsing it on the way in. CBOR's length-prefixed strings skip
 * both, and binary payloads stop needing base64.
 *
 * Why not a library: harness depends only on first-party code, and the subset
 * the contract actually uses is small enough to be worth owning outright. We
 * encode exactly what our command and event types contain — integers, floats,
 * strings, bytes, arrays, maps, booleans, null — and refuse anything else
 * loudly rather than guessing.
 */

const MAJOR_UINT = 0
const MAJOR_NEGINT = 1
const MAJOR_BYTES = 2
const MAJOR_TEXT = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5
const MAJOR_SIMPLE = 7

const SIMPLE_FALSE = 20
const SIMPLE_TRUE = 21
const SIMPLE_NULL = 22
const SIMPLE_UNDEFINED = 23
const SIMPLE_FLOAT64 = 27

export class CborError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CborError'
  }
}

// ============================================================================
// Encoding
// ============================================================================

class Writer {
  private chunks: Uint8Array[] = []
  private length = 0

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  byte(value: number): void {
    this.push(Uint8Array.of(value))
  }

  /**
   * Major type plus argument, in the shortest form that fits — canonical CBOR.
   * Shortest-form matters beyond size: two encoders that disagree here produce
   * different bytes for the same value, and any hash or equality check over
   * frames stops working.
   */
  head(major: number, argument: number): void {
    const tag = major << 5
    if (argument < 24) {
      this.byte(tag | argument)
    }
    else if (argument < 0x100) {
      this.byte(tag | 24)
      this.byte(argument)
    }
    else if (argument < 0x10000) {
      this.byte(tag | 25)
      const b = new Uint8Array(2)
      new DataView(b.buffer).setUint16(0, argument)
      this.push(b)
    }
    else if (argument < 0x100000000) {
      this.byte(tag | 26)
      const b = new Uint8Array(4)
      new DataView(b.buffer).setUint32(0, argument)
      this.push(b)
    }
    else {
      this.byte(tag | 27)
      const b = new Uint8Array(8)
      new DataView(b.buffer).setBigUint64(0, BigInt(argument))
      this.push(b)
    }
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}

function encodeValue(writer: Writer, value: unknown): void {
  if (value === null) {
    writer.byte((MAJOR_SIMPLE << 5) | SIMPLE_NULL)
    return
  }
  if (value === undefined) {
    writer.byte((MAJOR_SIMPLE << 5) | SIMPLE_UNDEFINED)
    return
  }
  if (typeof value === 'boolean') {
    writer.byte((MAJOR_SIMPLE << 5) | (value ? SIMPLE_TRUE : SIMPLE_FALSE))
    return
  }

  if (typeof value === 'number') {
    // Integers take the integer majors; anything else is a float64. Encoding a
    // non-integer as an integer would silently truncate, which for a cost or a
    // latency is a wrong number rather than a failure.
    if (Number.isInteger(value)) {
      if (value >= 0) writer.head(MAJOR_UINT, value)
      else writer.head(MAJOR_NEGINT, -value - 1)
      return
    }
    writer.byte((MAJOR_SIMPLE << 5) | SIMPLE_FLOAT64)
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, value)
    writer.push(b)
    return
  }

  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value)
    writer.head(MAJOR_TEXT, bytes.length)
    writer.push(bytes)
    return
  }

  if (value instanceof Uint8Array) {
    writer.head(MAJOR_BYTES, value.length)
    writer.push(value)
    return
  }

  if (Array.isArray(value)) {
    writer.head(MAJOR_ARRAY, value.length)
    for (const item of value) encodeValue(writer, item)
    return
  }

  if (typeof value === 'object') {
    // `undefined` members are dropped rather than encoded, so an absent
    // optional field and an explicitly-undefined one produce identical bytes.
    // Without that, `{a: 1}` and `{a: 1, b: undefined}` would round-trip to
    // different values.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
    writer.head(MAJOR_MAP, entries.length)
    for (const [key, item] of entries) {
      encodeValue(writer, key)
      encodeValue(writer, item)
    }
    return
  }

  throw new CborError(`cannot encode ${typeof value}`)
}

export function encode(value: unknown): Uint8Array {
  const writer = new Writer()
  encodeValue(writer, value)
  return writer.finish()
}

// ============================================================================
// Decoding
// ============================================================================

class Reader {
  offset = 0
  private view: DataView

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  private need(count: number): void {
    if (this.offset + count > this.bytes.length)
      throw new CborError('truncated input')
  }

  byte(): number {
    this.need(1)
    return this.bytes[this.offset++]!
  }

  slice(count: number): Uint8Array {
    this.need(count)
    const out = this.bytes.subarray(this.offset, this.offset + count)
    this.offset += count
    return out
  }

  argument(info: number): number {
    if (info < 24) return info
    if (info === 24) return this.byte()
    if (info === 25) {
      this.need(2)
      const v = this.view.getUint16(this.offset)
      this.offset += 2
      return v
    }
    if (info === 26) {
      this.need(4)
      const v = this.view.getUint32(this.offset)
      this.offset += 4
      return v
    }
    if (info === 27) {
      this.need(8)
      const v = this.view.getBigUint64(this.offset)
      this.offset += 8
      if (v > BigInt(Number.MAX_SAFE_INTEGER))
        throw new CborError('integer exceeds safe range')
      return Number(v)
    }
    throw new CborError(`unsupported additional info ${info}`)
  }

  float64(): number {
    this.need(8)
    const v = this.view.getFloat64(this.offset)
    this.offset += 8
    return v
  }

  get done(): boolean {
    return this.offset >= this.bytes.length
  }
}

function decodeValue(reader: Reader): unknown {
  const initial = reader.byte()
  const major = initial >> 5
  const info = initial & 0x1f

  switch (major) {
    case MAJOR_UINT:
      return reader.argument(info)
    case MAJOR_NEGINT:
      return -reader.argument(info) - 1
    case MAJOR_BYTES:
      // Copied, not a subarray: a view into the frame would keep the whole
      // frame alive and would mutate if the buffer is reused.
      return new Uint8Array(reader.slice(reader.argument(info)))
    case MAJOR_TEXT:
      return new TextDecoder().decode(reader.slice(reader.argument(info)))
    case MAJOR_ARRAY: {
      const length = reader.argument(info)
      const out: unknown[] = []
      for (let i = 0; i < length; i++) out.push(decodeValue(reader))
      return out
    }
    case MAJOR_MAP: {
      const length = reader.argument(info)
      const out: Record<string, unknown> = {}
      for (let i = 0; i < length; i++) {
        const key = decodeValue(reader)
        if (typeof key !== 'string')
          throw new CborError('only string map keys are supported')
        out[key] = decodeValue(reader)
      }
      return out
    }
    case MAJOR_SIMPLE:
      if (info === SIMPLE_FALSE) return false
      if (info === SIMPLE_TRUE) return true
      if (info === SIMPLE_NULL) return null
      if (info === SIMPLE_UNDEFINED) return undefined
      if (info === SIMPLE_FLOAT64) return reader.float64()
      throw new CborError(`unsupported simple value ${info}`)
    default:
      throw new CborError(`unsupported major type ${major}`)
  }
}

export function decode(bytes: Uint8Array): unknown {
  const reader = new Reader(bytes)
  const value = decodeValue(reader)
  // Trailing bytes mean the frame was not what the sender thought it was.
  // Ignoring them would turn a framing bug into silently truncated data.
  if (!reader.done)
    throw new CborError('trailing bytes after value')
  return value
}
