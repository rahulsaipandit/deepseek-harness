import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateToken,
  readTokenFile,
  resolveToken,
  verifyToken,
  writeTokenFile,
} from '../src/token.ts'

const isPosix = platform() !== 'win32'

describe('generateToken', () => {
  it('produces a 256-bit hex token by default', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces distinct tokens on each call', () => {
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('verifyToken', () => {
  it('accepts an exact match', () => {
    expect(verifyToken('abc123', 'abc123')).toBe(true)
  })

  it('rejects a mismatch of the same length', () => {
    expect(verifyToken('abc123', 'abc124')).toBe(false)
  })

  it('fails closed on length mismatch instead of throwing', () => {
    expect(verifyToken('short', 'a-much-longer-token')).toBe(false)
    expect(verifyToken('a-much-longer-token', 'short')).toBe(false)
  })

  it('fails closed when the expected token is empty', () => {
    expect(verifyToken('', '')).toBe(false)
  })
})

describe('token file persistence', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-capture-token-'))
    file = join(dir, 'nested', 'social-capture-token')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writeTokenFile creates parent directories and persists the token with a trailing newline', async () => {
    await writeTokenFile('sometoken', file)
    expect((await readFile(file, 'utf8'))).toBe('sometoken\n')
  })

  it.runIf(isPosix)('writeTokenFile persists the file mode 0600', async () => {
    await writeTokenFile('sometoken', file)
    const mode = (await stat(file)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('readTokenFile trims the persisted token', async () => {
    await writeTokenFile('sometoken', file)
    expect(await readTokenFile(file)).toBe('sometoken')
  })

  it('readTokenFile returns undefined when the file is absent', async () => {
    expect(await readTokenFile(join(dir, 'missing'))).toBeUndefined()
  })
})

describe('resolveToken', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-capture-resolve-'))
    file = join(dir, 'social-capture-token')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('prefers an explicitly configured token and does not touch the file', async () => {
    const result = await resolveToken('configured-token', file)
    expect(result).toEqual({ token: 'configured-token', file, generated: false })
    await expect(readTokenFile(file)).resolves.toBeUndefined()
  })

  it('reuses a previously persisted token', async () => {
    await writeTokenFile('persisted-token', file)
    const result = await resolveToken(undefined, file)
    expect(result).toEqual({ token: 'persisted-token', file, generated: false })
  })

  it('generates and persists a fresh token when none is configured or persisted', async () => {
    const result = await resolveToken(undefined, file)
    expect(result.generated).toBe(true)
    expect(result.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await readTokenFile(file)).toBe(result.token)
  })

  it('an empty configured token falls through to file resolution instead of being used literally', async () => {
    const result = await resolveToken('', file)
    expect(result.token).not.toBe('')
    expect(result.generated).toBe(true)
  })
})
