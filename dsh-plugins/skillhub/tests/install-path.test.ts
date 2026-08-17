import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSafeSkillRelativePath, resolveSkillDir, resolveWithinSkillDir, UnsafeSkillPathError } from '../src/install-path.ts'

describe('assertSafeSkillRelativePath', () => {
  it('accepts allowlisted, well-formed paths', () => {
    expect(() => assertSafeSkillRelativePath('SKILL.md')).not.toThrow()
    expect(() => assertSafeSkillRelativePath('reference/notes.md')).not.toThrow()
    expect(() => assertSafeSkillRelativePath('a/b/c.json')).not.toThrow()
  })

  it('rejects traversal segments', () => {
    expect(() => assertSafeSkillRelativePath('../escape.md')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('a/../../escape.md')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('./a.md')).toThrow(UnsafeSkillPathError)
  })

  it('rejects absolute and drive-letter paths', () => {
    expect(() => assertSafeSkillRelativePath('/etc/passwd')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('C:/Windows/win.ini')).toThrow(UnsafeSkillPathError)
  })

  it('rejects backslashes and null bytes', () => {
    expect(() => assertSafeSkillRelativePath('a\\b.md')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('a\0b.md')).toThrow(UnsafeSkillPathError)
  })

  it('rejects disallowed extensions', () => {
    expect(() => assertSafeSkillRelativePath('script.sh')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('payload.exe')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('no-extension')).toThrow(UnsafeSkillPathError)
  })

  it('rejects empty segments and empty/overlong paths', () => {
    expect(() => assertSafeSkillRelativePath('')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath('a//b.md')).toThrow(UnsafeSkillPathError)
    expect(() => assertSafeSkillRelativePath(`${'a'.repeat(600)}.md`)).toThrow(UnsafeSkillPathError)
  })
})

describe('resolveWithinSkillDir', () => {
  const skillDir = resolve('/install-root', 'my-skill')

  it('resolves a safe relative path under the skill dir', () => {
    expect(resolveWithinSkillDir(skillDir, 'SKILL.md')).toBe(join(skillDir, 'SKILL.md'))
    expect(resolveWithinSkillDir(skillDir, 'reference/notes.md')).toBe(join(skillDir, 'reference', 'notes.md'))
  })

  it('throws for a path that would escape the skill dir', () => {
    expect(() => resolveWithinSkillDir(skillDir, '../../etc/passwd.md')).toThrow(UnsafeSkillPathError)
  })
})

describe('resolveSkillDir', () => {
  const installRoot = resolve('/install-root')

  it('resolves a valid skill name under the install root', () => {
    expect(resolveSkillDir(installRoot, 'my-skill')).toBe(join(installRoot, 'my-skill'))
  })

  it('throws if the resolved directory would escape the install root', () => {
    expect(() => resolveSkillDir(installRoot, '..')).toThrow(UnsafeSkillPathError)
  })
})
