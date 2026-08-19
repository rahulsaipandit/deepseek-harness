import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateToken, readTokenFile, resolveToken, verifyToken, writeTokenFile } from '../src/token.ts'

describe('verifyToken', () => {
  it('accepts an exact match', () => {
    expect(verifyToken('secret', 'secret')).toBe(true)
  })

  it('rejects a mismatch, an empty expected token, and a length mismatch', () => {
    expect(verifyToken('secret', 'wrong')).toBe(false)
    expect(verifyToken('', 'anything')).toBe(false)
    expect(verifyToken('secret', 'secretx')).toBe(false)
  })
})

describe('generateToken', () => {
  it('produces a 64-hex-char (256-bit) token by default', () => {
    const token = generateToken()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('token file persistence and resolveToken', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'web-terminal-token-'))
    file = join(dir, 'nested', 'token')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('an explicitly configured token wins over any file', async () => {
    const result = await resolveToken('configured-token', file)
    expect(result).toEqual({ token: 'configured-token', file, generated: false })
    expect(await readTokenFile(file)).toBeUndefined() // never persisted when explicitly configured
  })

  it('reuses a persisted token when present', async () => {
    await writeTokenFile('persisted-token', file)
    const result = await resolveToken(undefined, file)
    expect(result).toEqual({ token: 'persisted-token', file, generated: false })
  })

  it('generates and persists a fresh token when neither is present', async () => {
    const result = await resolveToken(undefined, file)
    expect(result.generated).toBe(true)
    expect(result.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await readTokenFile(file)).toBe(result.token)
  })
})
