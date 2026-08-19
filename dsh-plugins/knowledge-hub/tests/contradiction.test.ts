import { describe, expect, it } from 'vitest'
import { findContradiction } from '../src/contradiction.ts'

describe('findContradiction', () => {
  it('flags opposite phrasing (is / is not)', () => {
    const reason = findContradiction('The server is running', 'The server is not running')
    expect(reason).toBeDefined()
  })

  it('flags opposite phrasing (enabled / disabled)', () => {
    const reason = findContradiction('Dark mode is enabled', 'Dark mode is disabled')
    expect(reason).toBeDefined()
  })

  it('flags opposite phrasing (always / never)', () => {
    const reason = findContradiction('Always deploy on Fridays', 'Never deploy on Fridays')
    expect(reason).toBeDefined()
  })

  it('returns undefined for unrelated content with no pattern hit', () => {
    expect(findContradiction('The sky is blue', 'Coffee tastes bitter')).toBeUndefined()
  })

  it('returns undefined when both notes assert the same side', () => {
    expect(findContradiction('The server is running', 'The server is running fine')).toBeUndefined()
  })

  it('returns undefined when one note has neither side of a pattern', () => {
    expect(findContradiction('The server is running', 'Completely unrelated text')).toBeUndefined()
  })
})
