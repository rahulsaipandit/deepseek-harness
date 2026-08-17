import { describe, expect, it } from 'vitest'
import { PbWriter } from '../src/pb.ts'

/** Decode a small varint-prefixed protobuf-ish message back for assertions, standard library only. */
function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let i = offset
  for (;;) {
    const byte = bytes[i]
    if (byte === undefined) throw new Error('truncated varint')
    value += (byte & 0x7f) * 2 ** shift
    i += 1
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, next: i }
}

describe('PbWriter', () => {
  it('encodes a varint field as tag+varint', () => {
    const bytes = new PbWriter().varintField(9, 1).finish()
    // field 9, wire type 0 (varint): tag = (9<<3)|0 = 72
    expect(Array.from(bytes)).toEqual([72, 1])
  })

  it('omits a varint field when the value is undefined', () => {
    const bytes = new PbWriter().varintField(9, undefined).finish()
    expect(bytes).toHaveLength(0)
  })

  it('encodes a multi-byte varint correctly (300)', () => {
    const bytes = new PbWriter().varintField(1, 300).finish()
    // tag = (1<<3)|0 = 8; 300 = 0b100101100 -> LEB128: 0xAC 0x02
    expect(Array.from(bytes)).toEqual([8, 0xAC, 0x02])
    const { value } = readVarint(bytes, 1)
    expect(value).toBe(300)
  })

  it('encodes a string field as tag+length+utf8 bytes', () => {
    const bytes = new PbWriter().stringField(2, 'TPE').finish()
    // tag = (2<<3)|2 = 18, length 3, then ASCII "TPE"
    expect(Array.from(bytes)).toEqual([18, 3, 84, 80, 69])
  })

  it('omits a string field when empty or undefined', () => {
    expect(new PbWriter().stringField(2, '').finish()).toHaveLength(0)
    expect(new PbWriter().stringField(2, undefined).finish()).toHaveLength(0)
  })

  it('embeds a nested message with its own length prefix', () => {
    const inner = new PbWriter().stringField(2, 'JFK')
    const bytes = new PbWriter().messageField(13, inner).finish()
    // outer tag = (13<<3)|2 = 106, inner message is 5 bytes (tag+len+"JFK")
    expect(bytes[0]).toBe(106)
    expect(bytes[1]).toBe(5)
    expect(Array.from(bytes.slice(2))).toEqual([18, 3, 74, 70, 75])
  })

  it('omits a message field entirely when undefined', () => {
    expect(new PbWriter().messageField(13, undefined).finish()).toHaveLength(0)
  })

  it('packs repeated varints into one length-delimited field', () => {
    const bytes = new PbWriter().packedVarintField(8, [1, 1, 2]).finish()
    // tag = (8<<3)|2 = 66, length 3, then three single-byte varints
    expect(Array.from(bytes)).toEqual([66, 3, 1, 1, 2])
  })

  it('omits a packed field entirely when the list is empty', () => {
    expect(new PbWriter().packedVarintField(8, []).finish()).toHaveLength(0)
  })

  it('rejects a negative varint', () => {
    expect(() => new PbWriter().varintField(1, -1)).toThrow(RangeError)
  })
})
