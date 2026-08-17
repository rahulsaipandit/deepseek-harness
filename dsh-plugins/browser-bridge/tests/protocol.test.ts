import { describe, expect, it } from 'vitest'
import {
  isClientFrame,
  isRespondResult,
  isServerFrame,
  parseBridgeFrame,
} from '../src/protocol.ts'

const CAPS = { textOnly: true as const, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

describe('parseBridgeFrame', () => {
  it('parses a valid hello frame', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc', caps: CAPS }))
    expect(frame).toEqual({ t: 'hello', token: 'abc', caps: CAPS })
  })

  it('rejects a hello frame with an undersized snapshotMaxChars', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'hello', token: 'abc', caps: { ...CAPS, snapshotMaxChars: 10 } }))
    expect(frame).toBeUndefined()
  })

  it('rejects malformed JSON', () => {
    expect(parseBridgeFrame('not json')).toBeUndefined()
  })

  it('rejects a JSON array', () => {
    expect(parseBridgeFrame('[1,2,3]')).toBeUndefined()
  })

  it('rejects an object with no t field', () => {
    expect(parseBridgeFrame(JSON.stringify({ foo: 'bar' }))).toBeUndefined()
  })

  it('rejects an unknown frame type', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'not-a-real-type' }))).toBeUndefined()
  })

  it('parses a tool.call frame with an optional sessionId', () => {
    const frame = parseBridgeFrame(JSON.stringify({
      t: 'tool.call', id: '1', name: 'browser_click', args: { index: 3 }, expiresAt: 123, sessionId: 'sess-1',
    }))
    expect(frame).toEqual({ t: 'tool.call', id: '1', name: 'browser_click', args: { index: 3 }, expiresAt: 123, sessionId: 'sess-1' })
  })

  it('rejects a tool.call frame with a blank sessionId', () => {
    const frame = parseBridgeFrame(JSON.stringify({
      t: 'tool.call', id: '1', name: 'browser_click', args: {}, expiresAt: 123, sessionId: '  ',
    }))
    expect(frame).toBeUndefined()
  })

  it('rejects a tool.call frame whose args is an array', () => {
    const frame = parseBridgeFrame(JSON.stringify({ t: 'tool.call', id: '1', name: 'x', args: [], expiresAt: 1 }))
    expect(frame).toBeUndefined()
  })

  it('parses a tool.result success and failure frame', () => {
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: true, result: { text: 'hi' } })))
      .toEqual({ t: 'tool.result', id: '1', ok: true, result: { text: 'hi' } })
    expect(parseBridgeFrame(JSON.stringify({ t: 'tool.result', id: '1', ok: false, error: { code: 'timeout', message: 'x' } })))
      .toEqual({ t: 'tool.result', id: '1', ok: false, error: { code: 'timeout', message: 'x' } })
  })

  it('round-trips ping/pong', () => {
    expect(parseBridgeFrame('{"t":"ping"}')).toEqual({ t: 'ping' })
    expect(parseBridgeFrame('{"t":"pong"}')).toEqual({ t: 'pong' })
  })
})

describe('isServerFrame / isClientFrame', () => {
  it('narrows server-only and client-only frames correctly', () => {
    expect(isServerFrame({ t: 'hello.ok', caps: CAPS })).toBe(true)
    expect(isServerFrame({ t: 'hello', token: 'x', caps: CAPS })).toBe(false)
    expect(isClientFrame({ t: 'hello', token: 'x', caps: CAPS })).toBe(true)
    expect(isClientFrame({ t: 'hello.ok', caps: CAPS })).toBe(false)
  })
})

describe('isRespondResult', () => {
  it('accepts an ok result with no error', () => {
    expect(isRespondResult({ ok: true })).toBe(true)
    expect(isRespondResult({ ok: true, value: 5 })).toBe(true)
  })

  it('rejects an ok:true result that also carries an error', () => {
    expect(isRespondResult({ ok: true, error: { code: 'x', message: 'y', details: {} } })).toBe(false)
  })

  it('accepts a well-formed failure result', () => {
    expect(isRespondResult({ ok: false, error: { code: 'x', message: 'y', details: {} } })).toBe(true)
  })

  it('rejects a failure result missing details', () => {
    expect(isRespondResult({ ok: false, error: { code: 'x', message: 'y' } })).toBe(false)
  })
})
