/**
 * Free, LLM-less entity extraction over a captured post's text: hashtags,
 * @mentions, and bare URLs. Modeled on Siftly's `rawjson-extractor.ts`
 * pattern (mine cheap structure out of raw captured JSON before spending
 * any tokens) — see docs/investigateContentIngestionPlugin.md §4. Always
 * runs, regardless of whether an LLM summarizer is configured, so a
 * captured note gets *some* searchable tags even with no LLM at all.
 * @module dsh-plugin-social-capture/entity-extract
 */

const HASHTAG_RE = /#([\p{L}\p{N}_]+)/gu
const MENTION_RE = /@([\w.]+)/g
const URL_RE = /https?:\/\/[^\s)]+/g

export interface ExtractedEntities {
  hashtags: string[]
  mentions: string[]
  urls: string[]
}

/** De-duplicate case-insensitively while preserving first-seen casing. */
function uniquePreserveCase(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Extract hashtags, mentions, and bare URLs from free text. Never throws; empty input yields empty arrays. */
export function extractEntities(text: string | undefined): ExtractedEntities {
  if (!text) return { hashtags: [], mentions: [], urls: [] }
  const hashtags = uniquePreserveCase([...text.matchAll(HASHTAG_RE)].map(m => m[1]!))
  const mentions = uniquePreserveCase([...text.matchAll(MENTION_RE)].map(m => m[1]!))
  const urls = uniquePreserveCase([...text.matchAll(URL_RE)].map(m => m[0]!))
  return { hashtags, mentions, urls }
}

/** Turn extracted entities into lowercase, deduplicated tag strings suitable for `MemoryFrontmatter.tags`. */
export function entitiesToTags(entities: ExtractedEntities, limit = 15): string[] {
  const tags = [
    ...entities.hashtags.map(h => `#${h.toLowerCase()}`),
    ...entities.mentions.map(m => `@${m.toLowerCase()}`),
  ]
  return uniquePreserveCase(tags).slice(0, limit)
}
