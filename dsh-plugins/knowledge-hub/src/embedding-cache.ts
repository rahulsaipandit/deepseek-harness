/**
 * Content-hash-keyed embedding cache: avoids recomputing a note's embedding
 * on every plugin boot when its content hasn't changed since the last time
 * it was embedded. See designCognitiveBrainForDSH.md §5.1/§5.4 — without
 * this, `memory-index.ts` re-embeds the entire vault from scratch on every
 * start, and a hand-edited note's stale embedding never gets refreshed
 * until the note happens to be rewritten. The same content hash serves
 * both purposes: "skip recomputation" on the happy path, and "this note
 * changed, recalibrate it" on the hand-edit path.
 *
 * A disposable, versioned JSON sidecar file, following the exact pattern
 * `concept-graph.ts` already uses for its own cache — safe to delete
 * anytime; the next boot just re-embeds everything once.
 * @module dsh-plugin-knowledge-hub/embedding-cache
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const EMBEDDING_CACHE_VERSION = 1

export interface EmbeddingCacheEntry {
  contentHash: string
  embedding: number[]
}

export interface EmbeddingCache {
  version: number
  entries: Record<string, EmbeddingCacheEntry>
}

export function emptyEmbeddingCache(): EmbeddingCache {
  return { version: EMBEDDING_CACHE_VERSION, entries: {} }
}

/** Stable content hash, used both as a cache key and as the hand-edit change-detection signal. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function cachePath(vaultPath: string): string {
  return resolve(vaultPath, '.embedding-cache.json')
}

/** Read the cached embeddings, or an empty cache if absent/corrupt/wrong version — always safe, never throws. */
export async function readEmbeddingCache(vaultPath: string): Promise<EmbeddingCache> {
  try {
    const raw = await readFile(cachePath(vaultPath), 'utf8')
    const parsed = JSON.parse(raw) as EmbeddingCache
    if (parsed.version !== EMBEDDING_CACHE_VERSION || typeof parsed.entries !== 'object' || parsed.entries === null) {
      return emptyEmbeddingCache()
    }
    return parsed
  } catch {
    return emptyEmbeddingCache()
  }
}

export async function writeEmbeddingCache(vaultPath: string, cache: EmbeddingCache): Promise<void> {
  const path = cachePath(vaultPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, JSON.stringify(cache), { mode: 0o600 })
}

/** Drop entries for ids no longer present in the vault, so the cache doesn't grow unbounded as notes are removed. */
export function pruneEmbeddingCache(cache: EmbeddingCache, liveIds: ReadonlySet<string>): EmbeddingCache {
  const entries: Record<string, EmbeddingCacheEntry> = {}
  for (const [id, entry] of Object.entries(cache.entries)) {
    if (liveIds.has(id)) entries[id] = entry
  }
  return { version: cache.version, entries }
}
