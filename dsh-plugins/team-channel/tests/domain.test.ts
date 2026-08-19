import { describe, expect, it } from 'vitest'
import { validateBody, validateChannelName } from '../src/domain.ts'

describe('validateChannelName', () => {
  it('accepts a well-formed channel name', () => {
    expect(validateChannelName('marketing')).toBeUndefined()
    expect(validateChannelName('team-standup')).toBeUndefined()
    expect(validateChannelName('cfo2')).toBeUndefined()
  })

  it('rejects uppercase, leading hyphens, and empty strings', () => {
    expect(validateChannelName('Marketing')?.code).toBe('invalid_channel')
    expect(validateChannelName('-marketing')?.code).toBe('invalid_channel')
    expect(validateChannelName('')?.code).toBe('invalid_channel')
  })

  it('rejects path-escape attempts', () => {
    expect(validateChannelName('../escape')?.code).toBe('invalid_channel')
    expect(validateChannelName('a/b')?.code).toBe('invalid_channel')
  })
})

describe('validateBody', () => {
  it('accepts non-empty content', () => {
    expect(validateBody('hello')).toBeUndefined()
  })

  it('rejects empty or whitespace-only content', () => {
    expect(validateBody('')?.code).toBe('invalid_body')
    expect(validateBody('   ')?.code).toBe('invalid_body')
  })
})
