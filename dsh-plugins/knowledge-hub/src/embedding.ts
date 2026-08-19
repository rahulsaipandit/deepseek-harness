/**
 * Local embedding function via `@xenova/transformers`
 * (`Xenova/all-MiniLM-L6-v2`, 384 dims — matches `memory-index.ts`'s default
 * and is independently corroborated by cognitiveBrain's own
 * `EmbeddingService.web.ts` default). Lazily loaded and memoized; on load
 * failure, returns `null` so callers degrade to keyword-only search rather
 * than fail outright.
 * @module dsh-plugin-knowledge-hub/embedding
 */

export type EmbeddingFunction = (text: string) => Promise<number[]>

export interface LocalEmbeddingConfig {
  model?: string
}

interface FeatureExtractionPipeline {
  (text: string, options: { pooling: 'mean'; normalize: boolean }): Promise<unknown>
}

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined

async function loadPipeline(model: string): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import('@xenova/transformers')
      return (await pipeline('feature-extraction', model)) as unknown as FeatureExtractionPipeline
    })()
  }
  return pipelinePromise
}

/**
 * Coerce a `@xenova/transformers` feature-extraction pipeline's output into
 * a plain `number[]`. Ported near-verbatim from cognitiveBrain's
 * `memsoftstore/.../transformerOutputNormalizer.ts`: pipeline output shape
 * varies (a tensor-like object with `.data`, a nested array, or a plain
 * array) depending on model/version, so this defensively handles each case.
 */
export function normalizeEmbeddingOutput(output: unknown): number[] {
  if (output === null || output === undefined) {
    throw new Error('knowledge-hub: embedding pipeline returned no output')
  }
  const withData = output as { data?: unknown }
  if (withData.data !== undefined) {
    return Array.from(withData.data as ArrayLike<number>)
  }
  if (Array.isArray(output)) {
    const first = output[0]
    if (Array.isArray(first)) return Array.from(first as number[])
    return Array.from(output as number[])
  }
  if (ArrayBuffer.isView(output)) {
    return Array.from(output as unknown as ArrayLike<number>)
  }
  throw new Error('knowledge-hub: unrecognized embedding pipeline output shape')
}

/**
 * Create a local embedding function. Returns `null` (never throws) if the
 * model fails to load — offline first run with nothing cached yet, disk
 * quota, etc. — so callers can fall back to keyword-only search.
 */
export async function createLocalEmbeddingFunction(
  config: LocalEmbeddingConfig = {},
  onError?: (error: unknown) => void,
): Promise<EmbeddingFunction | null> {
  const model = config.model ?? 'Xenova/all-MiniLM-L6-v2'
  try {
    const extractor = await loadPipeline(model)
    return async (text: string): Promise<number[]> => {
      const output = await extractor(text, { pooling: 'mean', normalize: true })
      return normalizeEmbeddingOutput(output)
    }
  } catch (error) {
    onError?.(error)
    return null
  }
}
