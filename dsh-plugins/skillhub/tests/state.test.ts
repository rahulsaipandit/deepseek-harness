import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readState, writeState } from '../src/state.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skillhub-state-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readState', () => {
  it('returns an empty object when the file does not exist', async () => {
    expect(await readState(join(dir, 'missing.json'))).toEqual({})
  })

  it('returns an empty object for corrupt JSON rather than throwing', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, '{ not valid json', 'utf8')
    expect(await readState(path)).toEqual({})
  })

  it('drops malformed entries but keeps valid ones', async () => {
    const path = join(dir, 'state.json')
    await writeFile(path, JSON.stringify({
      good: { name: 'good', version: '1.0.0', files: ['SKILL.md'], installedAt: 123, registryUrl: 'https://r.example' },
      bad: { name: 'bad' },
      alsoBad: 'not an object',
    }), 'utf8')
    const state = await readState(path)
    expect(Object.keys(state)).toEqual(['good'])
    expect(state.good?.files).toEqual(['SKILL.md'])
  })
})

describe('writeState', () => {
  it('creates parent directories and persists a round-trippable file', async () => {
    const path = join(dir, 'nested', 'state.json')
    await writeState(path, { s: { name: 's', version: '1.0.0', files: ['SKILL.md'], installedAt: 1, registryUrl: 'https://r.example' } })
    const state = await readState(path)
    expect(state.s?.name).toBe('s')
  })

  it('does not leave a stray temp file behind', async () => {
    const path = join(dir, 'state.json')
    await writeState(path, {})
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toEqual({})
    expect(await readdir(dir)).toEqual(['state.json'])
  })
})
