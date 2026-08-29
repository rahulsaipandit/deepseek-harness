/**
 * Optional one-shot LLM summarization/tagging of a captured post, via the
 * provider-neutral `ctx.llm` seam — same "send text, get structured JSON
 * back" pattern as `dsh-plugin-knowledge-hub/src/concept-extractor.ts`.
 * Entirely opt-in: this plugin runs fine with no LLM configured at all
 * (free entity-extraction tags only, see `entity-extract.ts`), and nothing
 * here selects or assumes any particular provider — point `llmProvider` at
 * whichever `ctx.llm`-registered adapter you use (e.g. the harness's native
 * DeepSeek adapter), never hardcoded to one vendor.
 * @module dsh-plugin-social-capture/summarize
 */

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CapturePayload } from './capture-payload.ts'

export interface SocialSummary {
  summary: string
  tags: string[]
}

export type SocialSummarizer = (payload: CapturePayload) => Promise<SocialSummary | undefined>

const MAX_TAGS = 8

function buildPrompt(payload: CapturePayload): string {
  const lines = [
    `Platform: ${payload.platform}`,
    payload.author ? `Author: ${payload.author}` : undefined,
    'Post text:',
    payload.text ?? '(no text captured)',
    '',
    'Write a one-to-two sentence summary of this post, and up to 8 short',
    'lowercase topic tags (single words or short hyphenated phrases, no',
    '"#" prefix).',
    '',
    'Respond with ONLY a JSON object of exactly this shape:',
    '{"summary": "...", "tags": ["...", "..."]}',
  ].filter((line): line is string => line !== undefined)
  return lines.join('\n')
}

function parseResponse(text: string): SocialSummary | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { summary?: unknown; tags?: unknown }
  if (typeof record.summary !== 'string' || !Array.isArray(record.tags)) return undefined
  if (!record.tags.every(tag => typeof tag === 'string')) return undefined
  return { summary: record.summary, tags: record.tags.slice(0, MAX_TAGS).map(tag => tag.toLowerCase()) }
}

export interface SocialSummarizerConfig {
  provider: string
  model: string
}

/** Create a summarizer backed by the resolved `llm` service. Returns `undefined` (never throws) on any LLM/parse failure. */
export function createLlmSocialSummarizer(llm: LlmRuntime, config: SocialSummarizerConfig, onError?: (error: unknown) => void): SocialSummarizer {
  return async (payload: CapturePayload): Promise<SocialSummary | undefined> => {
    try {
      const assembler = new BlockAssembler()
      const message = createUserMessage({
        content: [{ type: 'text', text: buildPrompt(payload) }],
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
      const parsed = parseResponse(text.trim())
      if (!parsed) onError?.(new Error('social-capture: summarizer returned an unparseable response'))
      return parsed
    } catch (error) {
      onError?.(error)
      return undefined
    }
  }
}
