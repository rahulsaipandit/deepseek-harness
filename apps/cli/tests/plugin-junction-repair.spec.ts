/**
 * Regression coverage for a confirmed pnpm-on-Windows bug (pnpm@11.7.0,
 * this repo's pinned version): when a profile directory and a linked
 * package's checkout are on different drives, the junction pnpm creates
 * under the profile's `node_modules` has a malformed target — the profile
 * directory concatenated with the package's own absolute path — instead of
 * the absolute path alone. Confirmed via a real end-to-end `dsh plugin add`
 * across drives (see docs/dsh-base-bundle-boot-hang.md's sibling
 * investigation). Not fixable in this repo (the bug is inside pnpm itself),
 * so `repairMalformedJunctions` detects and recreates the junction
 * afterward instead.
 */

import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repairMalformedJunctions } from '../src/plugin.ts'

const isWindows = process.platform === 'win32'

describe.runIf(isWindows)('repairMalformedJunctions (Windows only)', () => {
  let root: string
  let nodeModules: string
  let realTarget: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-junction-repair-'))
    nodeModules = join(root, 'node_modules')
    mkdirSync(nodeModules, { recursive: true })
    realTarget = mkdtempSync(join(tmpdir(), 'dsh-junction-target-'))
    writeFileSync(join(realTarget, 'package.json'), '{"name":"fake-plugin"}', 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(realTarget, { recursive: true, force: true })
  })

  it('repairs a junction whose target is the node_modules dir concatenated with the real target', () => {
    const link = join(nodeModules, 'fake-plugin')
    // Reproduce the exact malformed shape observed from the real pnpm bug:
    // `<node_modules dir>\<real absolute target>`.
    const malformedTarget = join(nodeModules, realTarget)
    symlinkSync(malformedTarget, link, 'junction')
    expect(existsSync(link)).toBe(false) // the malformed junction doesn't resolve to anything real

    const repaired = repairMalformedJunctions(nodeModules)

    expect(repaired).toEqual(['fake-plugin'])
    expect(readlinkSync(link)).toBe(realTarget)
    expect(existsSync(join(link, 'package.json'))).toBe(true)
  })

  it('repairs a malformed junction under a scoped package directory', () => {
    mkdirSync(join(nodeModules, '@scope'), { recursive: true })
    const link = join(nodeModules, '@scope', 'fake-plugin')
    const malformedTarget = join(nodeModules, realTarget)
    symlinkSync(malformedTarget, link, 'junction')

    const repaired = repairMalformedJunctions(nodeModules)

    expect(repaired).toEqual(['@scope/fake-plugin'])
    expect(readlinkSync(link)).toBe(realTarget)
  })

  it('leaves an already-correct junction untouched', () => {
    const link = join(nodeModules, 'fake-plugin')
    symlinkSync(realTarget, link, 'junction')

    const repaired = repairMalformedJunctions(nodeModules)

    expect(repaired).toEqual([])
    expect(readlinkSync(link)).toBe(realTarget)
  })

  it('leaves a broken junction alone when its target does not match the known bug shape', () => {
    const link = join(nodeModules, 'fake-plugin')
    symlinkSync(join(tmpdir(), 'this-path-does-not-exist-at-all'), link, 'junction')

    const repaired = repairMalformedJunctions(nodeModules)

    expect(repaired).toEqual([])
  })

  it('ignores plain (non-symlink) package directories', () => {
    mkdirSync(join(nodeModules, 'plain-package'), { recursive: true })

    const repaired = repairMalformedJunctions(nodeModules)

    expect(repaired).toEqual([])
  })

  it('returns an empty array when node_modules does not exist yet', () => {
    expect(repairMalformedJunctions(join(root, 'does-not-exist'))).toEqual([])
  })
})

describe.runIf(!isWindows)('repairMalformedJunctions (non-Windows)', () => {
  it('is a no-op on non-Windows platforms', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-junction-repair-posix-'))
    try {
      mkdirSync(join(root, 'node_modules'), { recursive: true })
      expect(repairMalformedJunctions(join(root, 'node_modules'))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
