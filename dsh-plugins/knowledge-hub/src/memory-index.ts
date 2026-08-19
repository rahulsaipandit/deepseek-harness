/**
 * Hybrid BM25 + vector search index over `@orama/orama`. Adapted from
 * cognitiveBrain's `adapters/web/OramaIndex.ts`: keeps the Orama plumbing,
 * hybrid search, and RRF fusion; strips ~250 lines of GA/CB query-intent
 * regex heuristics tuned for a system with entity/relation graph edges this
 * plugin doesn't have (see designCognitiveBrainForDSH.md §2.2). A single
 * fixed 'mixed' retrieval-weight preset replaces per-query intent detection.
 * @module dsh-plugin-knowledge-hub/memory-index
 */

import { type AnyOrama, create, insert, remove, search } from '@orama/orama'
import type { EmbeddingFunction } from './embedding.ts'

export interface MemoryIndexDoc {
  id: string
  title: string
  content: string
  type: string
  tags: string[]
  createdAt: string
  confidence: number
  sourceCount: number
  /** Precomputed embedding (e.g. from `embedding-cache.ts`) — when set, skips calling `embeddingFn` for this doc. */
  vector?: number[]
}

export interface MemoryIndexResult {
  id: string
  score: number
}

export interface MemoryIndexConfig {
  embeddingFn?: EmbeddingFunction
  dimensions?: number
}

interface OramaDocument {
  id: string
  title: string
  content: string
  type: string
  tags: string
  createdAt: string
  confidence: number
  sourceCount: number
  vector?: number[]
}

interface RetrievalWeights {
  similarity: number
  recency: number
  reliability: number
}

/** Single fixed weight preset — no per-query intent classification. */
const WEIGHTS: RetrievalWeights = { similarity: 0.4, recency: 0.2, reliability: 0.4 }

/** Reciprocal Rank Fusion score. */
function rrfScore(rank: number, k = 60): number {
  return 1 / (k + rank)
}

function toOramaDoc(doc: MemoryIndexDoc): OramaDocument {
  return {
    id: doc.id,
    title: doc.title,
    content: doc.content,
    type: doc.type,
    tags: doc.tags.join(' '),
    createdAt: doc.createdAt,
    confidence: doc.confidence,
    sourceCount: doc.sourceCount,
  }
}

export class MemoryIndex {
  private db: AnyOrama | null = null
  private readonly embeddingFn: EmbeddingFunction | null
  private readonly dimensions: number

  constructor(config: MemoryIndexConfig = {}) {
    this.embeddingFn = config.embeddingFn ?? null
    this.dimensions = config.dimensions ?? 384
  }

  async initialize(): Promise<void> {
    if (this.db) return
    const schema: Record<string, unknown> = {
      id: 'string',
      title: 'string',
      content: 'string',
      type: 'string',
      tags: 'string',
      createdAt: 'string',
      confidence: 'number',
      sourceCount: 'number',
    }
    if (this.embeddingFn) schema['vector'] = `vector[${this.dimensions}]`
    this.db = await create({ schema } as never)
  }

  private ensureDb(): AnyOrama {
    if (!this.db) throw new Error('[MemoryIndex] Not initialized. Call initialize() first.')
    return this.db
  }

  async index(doc: MemoryIndexDoc): Promise<void> {
    const db = this.ensureDb()
    try {
      await remove(db, doc.id)
    } catch {
      // fine — doc may not exist yet
    }
    const oramaDoc = toOramaDoc(doc)
    if (doc.vector) {
      oramaDoc.vector = doc.vector
    } else if (this.embeddingFn) {
      oramaDoc.vector = await this.embeddingFn(doc.content || doc.title)
    }
    await insert(db, oramaDoc as never)
  }

  async indexMany(docs: MemoryIndexDoc[]): Promise<void> {
    if (this.embeddingFn) {
      const embeddingFn = this.embeddingFn
      const embeddings = await Promise.all(docs.map(d => d.vector ?? embeddingFn(d.content || d.title)))
      const db = this.ensureDb()
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        if (!doc) continue
        try {
          await remove(db, doc.id)
        } catch {
          // fine
        }
        const oramaDoc = toOramaDoc(doc)
        const embedding = embeddings[i]
        if (embedding) oramaDoc.vector = embedding
        await insert(db, oramaDoc as never)
      }
    } else {
      await Promise.all(docs.map(d => this.index(d)))
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await remove(this.ensureDb(), id)
    } catch {
      // ignore — doc may not exist
    }
  }

  async search(query: string, topK = 10): Promise<MemoryIndexResult[]> {
    const db = this.ensureDb()

    if (!this.embeddingFn) {
      const hits = await bm25Search(db, query, topK * 2)
      return applyRankedScores(hits, topK)
    }

    const queryEmbedding = await this.embeddingFn(query)
    const [vectorHits, bm25Hits] = await Promise.all([
      vectorSearch(db, queryEmbedding, topK * 2),
      bm25Search(db, query, topK * 2),
    ])
    return fuseHybrid(vectorHits, bm25Hits, topK)
  }

  async close(): Promise<void> {
    this.db = null
  }
}

async function bm25Search(db: AnyOrama, query: string, limit: number): Promise<{ id: string; score: number; document: OramaDocument }[]> {
  const result = (await search(db, {
    term: query,
    limit,
    boost: { title: 2, content: 1, tags: 1.5 },
    // Orama's own default (0) is its STRICTEST setting — it requires
    // near-full query-term overlap and returns zero hits otherwise, which
    // silently breaks any multi-word natural-language query against short
    // notes (confirmed directly: "Dark mode is disabled now." found zero
    // hits against a note containing "Dark mode is enabled..." at the
    // default). threshold: 1 is Orama's most lenient setting — return
    // every document sharing at least one token, ranked by score — which
    // is the correct behavior for ranked search: let the score order
    // results, don't let the search step silently drop them.
    threshold: 1,
  } as never)) as unknown as { hits: { id: string; score: number; document: OramaDocument }[] }
  return result.hits
}

async function vectorSearch(db: AnyOrama, queryEmbedding: number[], limit: number): Promise<{ id: string; score: number; document: OramaDocument }[]> {
  const result = (await search(db, {
    // `search()` dispatches on `mode`, defaulting to `'fulltext'` when
    // unset (confirmed against Orama's own source) — without this, a
    // `vector` param is silently ignored and this "vector search" was
    // actually running an empty-term fulltext search the whole time,
    // returning every doc with an arbitrary, insertion-order ranking and a
    // score of exactly 0. Found while writing agent-chat-integration.test.ts
    // (2026-08-19): `memory_related`'s real-embedding results didn't
    // reflect real cosine similarity at all. `similarity: -1` mirrors the
    // BM25 side's `threshold: 1` reasoning — Orama's own vector-search
    // default (0.8) is a relevance FILTER, silently dropping any doc below
    // it; let every doc through and let fuseHybrid's score ordering decide
    // relevance instead of the search step dropping them first.
    mode: 'vector',
    vector: { value: queryEmbedding, property: 'vector' },
    similarity: -1,
    limit,
  } as never)) as unknown as { hits: { id: string; score: number; document: OramaDocument }[] }
  return result.hits
}

/** Rank-only scoring, plus the `type==='procedure'` boost — the one CB heuristic kept, since it's cheap and graph-free. */
function applyRankedScores(hits: { id: string; document: OramaDocument }[], topK: number): MemoryIndexResult[] {
  return hits
    .map((hit, rank) => ({ id: hit.id, score: rrfScore(rank) + (hit.document.type === 'procedure' ? 0.1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** Scales to a top-hit-relative [0, 1] range so genuinely large magnitude gaps between runner-up hits survive fusion. */
function normalizedScore(score: number, maxScore: number): number {
  return maxScore > 0 ? score / maxScore : 0
}

function fuseHybrid(
  vectorHits: { id: string; score: number; document: OramaDocument }[],
  bm25Hits: { id: string; score: number; document: OramaDocument }[],
  topK: number,
): MemoryIndexResult[] {
  const scores = new Map<string, number>()
  const now = Date.now()

  // Reciprocal-rank fusion (position-only) was the original design here,
  // but it's calibrated for combining rankings from large-scale search
  // engines: with k=60, adjacent ranks 1 vs 2 differ by only ~0.00027,
  // which is negligible next to genuinely large similarity gaps in a
  // personal-notes-sized corpus. Found via agent-chat-integration.test.ts
  // (2026-08-19): a real, on-topic "sibling" note lost a 3-way ranking to
  // an unrelated "recipe" note because rank-only fusion couldn't tell a
  // 2x-larger cosine-similarity or BM25-score gap from a rounding error.
  // Min-max normalizing each list against its own top hit preserves real
  // relative magnitude instead of discarding it.
  const maxVectorScore = vectorHits[0]?.score ?? 0
  vectorHits.forEach((hit) => {
    scores.set(hit.id, (scores.get(hit.id) ?? 0) + normalizedScore(hit.score, maxVectorScore) * WEIGHTS.similarity)
  })

  const maxBm25Score = bm25Hits[0]?.score ?? 0
  bm25Hits.forEach((hit) => {
    let contribution = normalizedScore(hit.score, maxBm25Score) * WEIGHTS.similarity
    const createdMs = hit.document.createdAt ? new Date(hit.document.createdAt).getTime() : now
    const ageHours = (now - createdMs) / 3_600_000
    contribution += Math.max(0, 1 - ageHours / 168) * WEIGHTS.recency
    const reliability = (hit.document.confidence ?? 0.5) * 0.5 + Math.min((hit.document.sourceCount ?? 0) / 5, 1) * 0.5
    contribution += reliability * WEIGHTS.reliability
    if (hit.document.type === 'procedure') contribution += 0.1
    scores.set(hit.id, (scores.get(hit.id) ?? 0) + contribution)
  })

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id, score]) => ({ id, score }))
}
