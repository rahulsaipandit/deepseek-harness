import { describe, expect, it } from 'vitest'
import { MemoryIndex } from '../src/memory-index.ts'
import type { MemoryIndexDoc } from '../src/memory-index.ts'

function doc(id: string, content: string, overrides: Partial<MemoryIndexDoc> = {}): MemoryIndexDoc {
  return {
    id,
    title: id,
    content,
    type: 'note',
    tags: [],
    createdAt: new Date().toISOString(),
    confidence: 0.5,
    sourceCount: 1,
    ...overrides,
  }
}

describe('MemoryIndex (BM25-only, no embeddingFn)', () => {
  it('ranks a lexically relevant doc above an irrelevant one', async () => {
    const index = new MemoryIndex()
    await index.initialize()
    await index.indexMany([
      doc('relevant', 'The quick brown fox jumps over the lazy dog'),
      doc('irrelevant', 'Completely unrelated content about spreadsheets'),
    ])
    const results = await index.search('fox dog', 10)
    expect(results[0]?.id).toBe('relevant')
  })

  it('remove() takes a doc out of subsequent search results', async () => {
    const index = new MemoryIndex()
    await index.initialize()
    await index.indexMany([doc('a', 'unique-term-alpha')])
    expect((await index.search('unique-term-alpha', 10)).map(r => r.id)).toContain('a')
    await index.remove('a')
    expect((await index.search('unique-term-alpha', 10)).map(r => r.id)).not.toContain('a')
  })

  it('boosts type=procedure results', async () => {
    const index = new MemoryIndex()
    await index.initialize()
    await index.indexMany([
      doc('proc', 'deploy the application to production', { type: 'procedure' }),
      doc('note', 'deploy the application to production', { type: 'note' }),
    ])
    const results = await index.search('deploy application production', 10)
    const proc = results.find(r => r.id === 'proc')
    const note = results.find(r => r.id === 'note')
    expect(proc).toBeDefined()
    expect(note).toBeDefined()
    expect(proc!.score).toBeGreaterThan(note!.score)
  })
})

describe('MemoryIndex (with a fake embeddingFn — hybrid path)', () => {
  it('search still returns results with an injected embedding function', async () => {
    const index = new MemoryIndex({
      dimensions: 3,
      embeddingFn: async (text: string) => [text.length % 7, text.length % 5, text.length % 3],
    })
    await index.initialize()
    await index.indexMany([doc('a', 'hello world'), doc('b', 'goodbye world')])
    const results = await index.search('hello', 10)
    expect(results.length).toBeGreaterThan(0)
  })

  it('index() uses a precomputed doc.vector instead of calling embeddingFn', async () => {
    let calls = 0
    const index = new MemoryIndex({
      dimensions: 3,
      embeddingFn: async () => {
        calls++
        return [1, 1, 1]
      },
    })
    await index.initialize()
    await index.index(doc('a', 'hello world', { vector: [0, 0, 0] }))
    expect(calls).toBe(0)
  })

  it('index() still calls embeddingFn when doc.vector is absent', async () => {
    let calls = 0
    const index = new MemoryIndex({
      dimensions: 3,
      embeddingFn: async () => {
        calls++
        return [1, 1, 1]
      },
    })
    await index.initialize()
    await index.index(doc('a', 'hello world'))
    expect(calls).toBe(1)
  })

  it('indexMany() calls embeddingFn only for docs missing a precomputed vector', async () => {
    let calls = 0
    const index = new MemoryIndex({
      dimensions: 3,
      embeddingFn: async () => {
        calls++
        return [1, 1, 1]
      },
    })
    await index.initialize()
    await index.indexMany([
      doc('a', 'hello world', { vector: [0, 0, 0] }),
      doc('b', 'goodbye world'),
    ])
    expect(calls).toBe(1)
  })

  /**
   * Regression for two bugs found while writing agent-chat-integration.test.ts
   * (2026-08-19), fixed together in memory-index.ts:
   *  1. vectorSearch() never passed Orama's `mode: 'vector'`, so `search()`
   *     defaulted to `'fulltext'` and silently ran an empty-term fulltext
   *     search instead — the vector signal was a complete no-op.
   *  2. fuseHybrid()'s reciprocal-rank fusion discarded real similarity
   *     magnitude even once given real scores: adjacent ranks differ by
   *     ~0.00027 (k=60), swamping genuinely large similarity gaps between
   *     runner-up documents.
   * Three docs share identical BM25-relevant terms/length (a true BM25 tie)
   * so only the vector signal can explain the ranking — a controlled,
   * well-separated embeddingFn (cosine 1.0 / 0.707 / 0) proves both bugs
   * are fixed: the signal reaches fuseHybrid at all, and its magnitude
   * — not just its rank — decides runner-up order.
   */
  it('ranks by real vector-similarity magnitude, not rank alone, when BM25 scores tie', async () => {
    const VECTORS: Record<string, number[]> = {
      'shared note about vector-a today': [1, 0, 0],
      'shared note about vector-b today': [0.5, 0.5, 0],
      'shared note about vector-c today': [0, 0, 1],
      'shared note today please': [1, 0, 0],
    }
    const index = new MemoryIndex({
      dimensions: 3,
      embeddingFn: async (text: string) => VECTORS[text] ?? [0, 0, 0],
    })
    await index.initialize()
    await index.indexMany([
      doc('a', 'shared note about vector-a today'),
      doc('b', 'shared note about vector-b today'),
      doc('c', 'shared note about vector-c today'),
    ])
    const results = await index.search('shared note today please', 10)
    expect(results.map(r => r.id)).toEqual(['a', 'b', 'c'])
  })
})
