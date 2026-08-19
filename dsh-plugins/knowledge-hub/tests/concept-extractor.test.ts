import type { LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { createLlmConceptExtractor } from '../src/concept-extractor.ts'
import type { Chunk } from '../src/chunking.ts'

function fakeLlm(responseText: string): LlmRuntime {
  async function * fakeStream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: responseText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: responseText } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  return { stream: fakeStream } as unknown as LlmRuntime
}

describe('createLlmConceptExtractor', () => {
  const chunks: Chunk[] = [{ heading: 'Intro', text: 'React hooks let you use state in function components.' }]

  it('parses a well-formed JSON response into concepts per chunk', async () => {
    const extractor = createLlmConceptExtractor(
      fakeLlm('{"chunks": [{"concepts": ["React hooks", "function components"]}]}'),
      { provider: 'test', model: 'test-model' },
    )
    const result = await extractor('My note', chunks)
    expect(result).toEqual([['React hooks', 'function components']])
  })

  it('falls back to empty concepts per chunk on unparseable output, without throwing', async () => {
    const errors: unknown[] = []
    const extractor = createLlmConceptExtractor(
      fakeLlm('not json at all'),
      { provider: 'test', model: 'test-model' },
      error => errors.push(error),
    )
    const result = await extractor('My note', chunks)
    expect(result).toEqual([[]])
    expect(errors).toHaveLength(1)
  })

  it('falls back to empty concepts when the chunk count does not match', async () => {
    const extractor = createLlmConceptExtractor(
      fakeLlm('{"chunks": [{"concepts": ["a"]}, {"concepts": ["b"]}]}'), // 2 entries, but only 1 chunk requested
      { provider: 'test', model: 'test-model' },
    )
    const result = await extractor('My note', chunks)
    expect(result).toEqual([[]])
  })

  it('returns [] immediately for zero chunks, without calling the LLM', async () => {
    let called = false
    const llm = { stream: () => { called = true; return (async function * () {})() } } as unknown as LlmRuntime
    const extractor = createLlmConceptExtractor(llm, { provider: 'test', model: 'test-model' })
    const result = await extractor('My note', [])
    expect(result).toEqual([])
    expect(called).toBe(false)
  })
})
