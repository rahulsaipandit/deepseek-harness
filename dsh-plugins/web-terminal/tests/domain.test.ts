import { describe, expect, it } from 'vitest'
import { parseClientMessage } from '../src/domain.ts'

describe('parseClientMessage', () => {
  it('rejects non-JSON', () => {
    const result = parseClientMessage('not json')
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('rejects a frame with no type', () => {
    const result = parseClientMessage('{"foo":1}')
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('rejects an unknown type', () => {
    const result = parseClientMessage('{"type":"nonsense"}')
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('parses a valid hello frame', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'hello', token: 'abc' }))
    expect(result).toEqual({ type: 'hello', token: 'abc' })
  })

  it('rejects hello with an empty token', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'hello', token: '' }))
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('parses a valid input frame', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'input', text: 'ls -la', submit: true }))
    expect(result).toEqual({ type: 'input', text: 'ls -la', submit: true })
  })

  it('rejects input missing submit', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'input', text: 'ls' }))
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('parses a valid signal frame', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'signal', signal: 'SIGINT' }))
    expect(result).toEqual({ type: 'signal', signal: 'SIGINT' })
  })

  it('rejects an unrecognized signal', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'signal', signal: 'SIGWHAT' }))
    expect('code' in result && result.code).toBe('invalid_frame')
  })

  it('parses a read frame with and without optional fields', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'read' }))).toEqual({ type: 'read' })
    expect(parseClientMessage(JSON.stringify({ type: 'read', offset: 0, count: 50 })))
      .toEqual({ type: 'read', offset: 0, count: 50 })
  })

  it('rejects a read frame with a non-numeric offset', () => {
    const result = parseClientMessage(JSON.stringify({ type: 'read', offset: 'zero' }))
    expect('code' in result && result.code).toBe('invalid_frame')
  })
})
