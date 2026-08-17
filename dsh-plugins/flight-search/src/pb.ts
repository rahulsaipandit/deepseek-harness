/**
 * Minimal hand-written Protobuf (proto3) wire-format writer — just enough to
 * encode the small message schema Google Flights' web frontend reads out of
 * its `tfs` search query parameter (reverse-engineered by
 * https://github.com/AWeirdDev/flights, whose `flights.proto` this mirrors
 * field-for-field). No `protobufjs` dependency: the whole schema is a
 * handful of scalar/string/nested-message fields, small enough to keep
 * auditable in one file rather than pulling in a general-purpose library.
 *
 * Only encoding is implemented (we only ever build a request), and only the
 * wire types this schema actually uses: varint (bool/int32/enum) and
 * length-delimited (string/embedded message/packed-repeated-varint).
 *
 * @module dsh-plugin-flight-search/pb
 */

/** Protobuf wire types this writer emits. */
const WIRE_VARINT = 0
const WIRE_LENGTH_DELIMITED = 2

/** Unsigned LEB128 varint encoding (every field number and length here is non-negative). */
function encodeVarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`pb: varint value must be a non-negative integer, got ${value}`)
  }
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return bytes
}

function encodeTag(fieldNumber: number, wireType: number): number[] {
  return encodeVarint((fieldNumber << 3) | wireType)
}

/** One accumulating message buffer; fields are appended in ascending field-number order by convention (not required by the wire format — decoders must accept any order). */
export class PbWriter {
  private readonly bytes: number[] = []

  /** `optional int32`/enum/bool field: omitted entirely when `value` is `undefined` (proto3 explicit presence). */
  varintField(fieldNumber: number, value: number | boolean | undefined): this {
    if (value === undefined) return this
    const n = typeof value === 'boolean' ? (value ? 1 : 0) : value
    this.bytes.push(...encodeTag(fieldNumber, WIRE_VARINT), ...encodeVarint(n))
    return this
  }

  /** `string` field: omitted entirely when `value` is `undefined` or empty (matches upstream never sending a blank string field). */
  stringField(fieldNumber: number, value: string | undefined): this {
    if (value === undefined || value.length === 0) return this
    const utf8 = new TextEncoder().encode(value)
    this.bytes.push(...encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED), ...encodeVarint(utf8.length), ...utf8)
    return this
  }

  /** Repeated `string` field: proto3 never packs strings, so each entry is its own tag+length+bytes. */
  repeatedStringField(fieldNumber: number, values: readonly string[] | undefined): this {
    if (values === undefined) return this
    for (const value of values) this.stringField(fieldNumber, value)
    return this
  }

  /** Embedded message field: omitted entirely when `message` is `undefined` (proto3 singular-message presence). */
  messageField(fieldNumber: number, message: PbWriter | undefined): this {
    if (message === undefined) return this
    const inner = message.finish()
    this.bytes.push(...encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED), ...encodeVarint(inner.length), ...inner)
    return this
  }

  /**
   * Repeated enum/int field: proto3 packs repeated scalar-numeric fields by
   * default (one tag, one length, concatenated varints) — this is NOT the
   * same wire shape as `repeatedStringField`. Omitted entirely when the
   * list is empty (matches upstream never sending an empty repeated field).
   */
  packedVarintField(fieldNumber: number, values: readonly number[] | undefined): this {
    if (values === undefined || values.length === 0) return this
    const inner: number[] = []
    for (const value of values) inner.push(...encodeVarint(value))
    this.bytes.push(...encodeTag(fieldNumber, WIRE_LENGTH_DELIMITED), ...encodeVarint(inner.length), ...inner)
    return this
  }

  finish(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}
