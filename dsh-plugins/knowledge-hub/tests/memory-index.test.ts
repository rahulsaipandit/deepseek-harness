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
})
