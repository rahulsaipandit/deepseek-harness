import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyEmbeddingCache,
  hashContent,
  pruneEmbeddingCache,
  readEmbeddingCache,
  writeEmbeddingCache,
} from '../src/embedding-cache.ts'

describe('hashContent', () => {
  it('is stable for identical input and differs for different input', () => {
    expect(hashContent('same text')).toBe(hashContent('same text'))
    expect(hashContent('same text')).not.toBe(hashContent('different text'))
  })
})

describe('embedding cache read/write', () => {
  let vaultPath: string

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'kh-embedding-cache-'))
  })

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true })
  })

  it('returns an empty cache when no cache file exists yet', async () => {
    const cache = await readEmbeddingCache(vaultPath)
    expect(cache.entries).toEqual({})
  })

  it('round-trips entries through write then read', async () => {
    const cache = emptyEmbeddingCache()
    cache.entries['mem_1'] = { contentHash: hashContent('hello'), embedding: [0.1, 0.2, 0.3] }
    await writeEmbeddingCache(vaultPath, cache)

    const reloaded = await readEmbeddingCache(vaultPath)
    expect(reloaded.entries['mem_1']).toEqual({ contentHash: hashContent('hello'), embedding: [0.1, 0.2, 0.3] })
  })

  it('discards a cache file with a mismatched version instead of throwing', async () => {
    await writeFile(join(vaultPath, '.embedding-cache.json'), JSON.stringify({ version: 999, entries: {} }), 'utf8')
    const cache = await readEmbeddingCache(vaultPath)
    expect(cache.entries).toEqual({})
  })

  it('discards a corrupt cache file instead of throwing', async () => {
    await writeFile(join(vaultPath, '.embedding-cache.json'), '{not valid json', 'utf8')
    const cache = await readEmbeddingCache(vaultPath)
    expect(cache.entries).toEqual({})
  })
})

describe('pruneEmbeddingCache', () => {
  it('drops entries for ids no longer present in the vault', () => {
    const cache = emptyEmbeddingCache()
    cache.entries['still-here'] = { contentHash: 'h1', embedding: [1] }
    cache.entries['deleted-note'] = { contentHash: 'h2', embedding: [2] }

    const pruned = pruneEmbeddingCache(cache, new Set(['still-here']))

    expect(pruned.entries).toEqual({ 'still-here': { contentHash: 'h1', embedding: [1] } })
  })

  it('is a no-op when every cached id is still live', () => {
    const cache = emptyEmbeddingCache()
    cache.entries['a'] = { contentHash: 'h', embedding: [1] }
    const pruned = pruneEmbeddingCache(cache, new Set(['a']))
    expect(pruned.entries).toEqual(cache.entries)
  })
})
