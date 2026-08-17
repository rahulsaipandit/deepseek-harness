import { describe, expect, it } from 'vitest'
import { assertSkillName, isSkillName } from '../src/name.ts'

describe('isSkillName', () => {
  it('accepts kebab-case names', () => {
    expect(isSkillName('my-skill')).toBe(true)
    expect(isSkillName('skill')).toBe(true)
    expect(isSkillName('a1-b2-c3')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isSkillName('')).toBe(false)
    expect(isSkillName('My-Skill')).toBe(false)
    expect(isSkillName('my_skill')).toBe(false)
    expect(isSkillName('-leading')).toBe(false)
    expect(isSkillName('trailing-')).toBe(false)
    expect(isSkillName('double--dash')).toBe(false)
    expect(isSkillName('../escape')).toBe(false)
    expect(isSkillName('has space')).toBe(false)
  })
})

describe('assertSkillName', () => {
  it('does not throw for a valid name', () => {
    expect(() => assertSkillName('valid-name')).not.toThrow()
  })

  it('throws for an invalid name', () => {
    expect(() => assertSkillName('../etc')).toThrow(/not a valid skill name/)
  })
})
