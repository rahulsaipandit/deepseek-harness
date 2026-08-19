/**
 * One bounded LLM call per new note: extract short noun-phrase concepts per
 * chunk, in a single structured-JSON-output request (never one call per
 * chunk) — imitates `packages/session/session-title-first-prompt-llm`'s
 * "send text, get structured JSON back" pattern via `ctx.llm.stream()`.
 * @module dsh-plugin-knowledge-hub/concept-extractor
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Chunk } from './chunking.ts'

/** Concepts per chunk, in the same order as the input chunks. */
export type ConceptExtractor = (noteTitle: string, chunks: Chunk[]) => Promise<string[][]>

function buildPrompt(noteTitle: string, chunks: Chunk[]): string {
  const chunkList = chunks
    .map((chunk, i) => `Chunk ${i}${chunk.heading ? ` (heading: "${chunk.heading}")` : ''}:\n${chunk.text}`)
    .join('\n\n')
  return [
    `Note title: "${noteTitle}"`,
    '',
    'For each chunk below, extract 1-6 short noun-phrase concepts it discusses',
    '(e.g. "React hooks", "deployment pipeline" — not full sentences, not named-entity',
    'people/places unless central to the concept).',
    '',
    chunkList,
    '',
    `Respond with ONLY a JSON object of exactly this shape, one entry per chunk in order, ${chunks.length} entries total:`,
    '{"chunks": [{"concepts": ["concept one", "concept two"]}, ...]}',
  ].join('\n')
}

function parseResponse(text: string, expectedChunks: number): string[][] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const chunksField = (parsed as { chunks?: unknown }).chunks
  if (!Array.isArray(chunksField)) return undefined

  const result: string[][] = []
  for (const entry of chunksField) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const concepts = (entry as { concepts?: unknown }).concepts
    if (!Array.isArray(concepts) || !concepts.every(c => typeof c === 'string')) return undefined
    result.push(concepts)
  }
  return result.length === expectedChunks ? result : undefined
}

export interface LlmConceptExtractorConfig {
  provider: string
  model: string
}

/** Create a concept extractor backed by the resolved `llm` service. Returns `[]` per chunk (never throws) on any LLM/parse failure. */
export function createLlmConceptExtractor(llm: LlmRuntime, config: LlmConceptExtractorConfig, onError?: (error: unknown) => void): ConceptExtractor {
  return async (noteTitle: string, chunks: Chunk[]): Promise<string[][]> => {
    if (chunks.length === 0) return []
    try {
      const assembler = new BlockAssembler()
      const message = createUserMessage({
        content: [{ type: 'text', text: buildPrompt(noteTitle, chunks) }],
        source: { kind: 'user' },
      })
      for await (const chunk of llm.stream({
        provider: config.provider,
        model: config.model,
        messages: [message],
      })) {
        assembler.push(chunk)
      }
      const assembled = assembler.message({ kind: 'model', provider: config.provider, model: config.model })
      const text = assembled.content.map(block => (block.type === 'text' ? block.text : '')).join('')
      const parsed = parseResponse(text.trim(), chunks.length)
      if (!parsed) {
        onError?.(new Error('knowledge-hub: concept extraction returned an unparseable response'))
        return chunks.map(() => [])
      }
      return parsed
    } catch (error) {
      onError?.(error)
      return chunks.map(() => [])
    }
  }
}
