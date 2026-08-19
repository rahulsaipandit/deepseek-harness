/**
 * Deterministic (no LLM) `[[Target]]` wikilink extraction and title-based
 * resolution, for the concept graph's W1 (explicit relation) edges.
 * @module dsh-plugin-knowledge-hub/wikilinks
 */

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g

/** Extract wikilink target titles from text. Drops alias (`|`) and heading-anchor (`#`) suffixes. */
export function extractWikilinks(text: string): string[] {
  const targets: string[] = []
  for (const match of text.matchAll(WIKILINK)) {
    const target = match[1]?.trim()
    if (target) targets.push(target)
  }
  return targets
}

/** Resolve wikilink target titles to note ids via a case-insensitive title lookup. Unresolvable targets are silently dropped. */
export function resolveWikilinks(targets: string[], titleToId: ReadonlyMap<string, string>): string[] {
  const resolved: string[] = []
  for (const target of targets) {
    const id = titleToId.get(target.toLowerCase())
    if (id) resolved.push(id)
  }
  return resolved
}

/** Build a case-insensitive title -> id lookup from a set of (id, title) pairs. */
export function buildTitleIndex(entries: readonly { id: string; title: string }[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const entry of entries) map.set(entry.title.toLowerCase(), entry.id)
  return map
}
