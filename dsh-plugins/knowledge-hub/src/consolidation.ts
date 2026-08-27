/**
 * `memory_consolidate`'s proposal-finding logic: reduces redundancy/entropy
 * in a vault of many small atomic notes, without the two things this design
 * has otherwise deliberately avoided — an autonomous background job, and
 * any content ever getting silently rewritten. Both are structural, not
 * just documented: this module only ever *computes proposals* (pure
 * function, no I/O); `memory_consolidate` in `index.ts` is the only place
 * that ever applies one, and applying one only ever ADDS a `supersededBy`
 * frontmatter field to the superseded note(s) — the file's body, and the
 * canonical note, are never rewritten. See designCognitiveBrainForDSH.md
 * for the full write-up of why this is a different problem from GBrain's
 * or cognitiveBrain's own memory-consolidation motivations.
 *
 * Built entirely from primitives this plugin already has — no new LLM call:
 *  - `findContradiction` (contradiction.ts) decides "supersede" proposals:
 *    two tag-overlapping notes whose content asserts opposite sides of a
 *    negation pattern. The newer note supersedes the older one.
 *  - Cosine similarity over already-computed embeddings (the same ones
 *    `memory-index.ts`/the embedding cache maintain) decides "merge"
 *    proposals: near-duplicate notes restating the same fact. Requires
 *    `enableEmbeddings`; skipped entirely otherwise (`mergeAvailable: false`
 *    on the tool's result tells the caller why).
 * @module dsh-plugin-knowledge-hub/consolidation
 */

import { findContradiction } from './contradiction.ts'

export interface ConsolidationCandidateNote {
  id: string
  title: string
  tags: string[]
  createdAt: string
  content: string
}

export interface ConsolidationProposal {
  action: 'merge' | 'supersede'
  /** The note that survives — always the newer of the two, for both actions. */
  keepId: string
  /** Notes to mark `supersededBy: keepId`. */
  supersedeIds: string[]
  reason: string
  /** Cosine similarity that produced a "merge" proposal; absent for "supersede". */
  similarity?: number
}

export interface FindConsolidationProposalsOptions {
  /** Minimum cosine similarity to treat two notes as near-duplicates. */
  similarityThreshold: number
  /** Looks up a note's already-computed embedding; omit (or return undefined for some ids) to skip merge detection. */
  getEmbedding?: (id: string) => number[] | undefined
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    normA += av * av
    normB += bv * bv
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB)
  return magnitude > 0 ? dot / magnitude : 0
}

/**
 * Find merge/supersede proposals across a set of notes. Only compares notes
 * that share at least one tag (cheap prefilter — avoids an O(n²) scan of
 * unrelated notes across the whole vault). Never mutates anything; returns
 * a plain list of proposals for the caller to apply, log, or discard.
 *
 * Near-duplicate ("merge") notes are clustered via union-find, the same
 * connected-components technique `concept-graph.ts` uses — a note only
 * needs to be highly similar to ONE other member of its cluster, not to
 * every member, so a reported `similarity` reflects a real pairwise match
 * that grew the cluster, not necessarily a direct comparison against the
 * cluster's eventual keeper.
 */
export function findConsolidationProposals(
  notes: readonly ConsolidationCandidateNote[],
  options: FindConsolidationProposalsOptions,
): ConsolidationProposal[] {
  const byTag = new Map<string, ConsolidationCandidateNote[]>()
  for (const note of notes) {
    for (const tag of note.tags) {
      if (!byTag.has(tag)) byTag.set(tag, [])
      byTag.get(tag)!.push(note)
    }
  }

  const parent = new Map<string, string>()
  function find(id: string): string {
    let root = id
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string
    parent.set(id, root)
    return root
  }
  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  for (const note of notes) parent.set(note.id, note.id)

  const similarityByPair = new Map<string, number>()
  const supersedeProposals: ConsolidationProposal[] = []
  const seenPairs = new Set<string>()

  for (const bucket of byTag.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i]
        const b = bucket[j]
        if (!a || !b) continue
        const key = pairKey(a.id, b.id)
        if (seenPairs.has(key)) continue
        seenPairs.add(key)

        const contradictionReason = findContradiction(a.content, b.content)
        if (contradictionReason) {
          const [newer, older] = a.createdAt >= b.createdAt ? [a, b] : [b, a]
          supersedeProposals.push({
            action: 'supersede',
            keepId: newer.id,
            supersedeIds: [older.id],
            reason: `Contradiction: ${contradictionReason} (kept the newer note, "${newer.title}")`,
          })
          continue
        }

        if (!options.getEmbedding) continue
        const embeddingA = options.getEmbedding(a.id)
        const embeddingB = options.getEmbedding(b.id)
        if (!embeddingA || !embeddingB) continue
        const similarity = cosineSimilarity(embeddingA, embeddingB)
        if (similarity >= options.similarityThreshold) {
          union(a.id, b.id)
          similarityByPair.set(key, similarity)
        }
      }
    }
  }

  const byRoot = new Map<string, ConsolidationCandidateNote[]>()
  for (const note of notes) {
    const root = find(note.id)
    if (!byRoot.has(root)) byRoot.set(root, [])
    byRoot.get(root)!.push(note)
  }

  const mergeProposals: ConsolidationProposal[] = []
  for (const cluster of byRoot.values()) {
    if (cluster.length < 2) continue
    const sorted = [...cluster].sort((x, y) => y.createdAt.localeCompare(x.createdAt))
    const keep = sorted[0]
    if (!keep) continue
    const supersedeIds = sorted.slice(1).map(n => n.id)
    const similarities = supersedeIds
      .map(id => similarityByPair.get(pairKey(keep.id, id)))
      .filter((s): s is number => s !== undefined)
    const bestSimilarity = similarities.length > 0 ? Math.max(...similarities) : undefined
    mergeProposals.push({
      action: 'merge',
      keepId: keep.id,
      supersedeIds,
      reason: `Near-duplicate of "${keep.title}" (cosine similarity >= ${options.similarityThreshold})`,
      ...(bestSimilarity !== undefined ? { similarity: bestSimilarity } : {}),
    })
  }

  // A note can only ever be pairwise-checked once against any single other
  // note (seenPairs), but it CAN legitimately end up a candidate in two
  // unrelated proposals at once — e.g. contradicted by note A via a shared
  // "theme" tag, and separately near-duplicate-clustered with note B via a
  // shared "preferences" tag. Applying both unmodified would let whichever
  // proposal runs last silently overwrite the other's `supersededBy`
  // pointer on the same note. Resolve deterministically instead: a
  // contradiction is a stronger, more specific signal than "these happen to
  // be similar," so `supersede` proposals claim a note first; any `merge`
  // proposal that would also supersede an already-claimed note has that id
  // dropped from it (and the whole proposal is dropped if nothing is left).
  const claimed = new Set<string>()
  const resolved: ConsolidationProposal[] = []
  for (const proposal of [...supersedeProposals, ...mergeProposals]) {
    const supersedeIds = proposal.supersedeIds.filter(id => !claimed.has(id))
    if (supersedeIds.length === 0) continue
    for (const id of supersedeIds) claimed.add(id)
    resolved.push(supersedeIds.length === proposal.supersedeIds.length ? proposal : { ...proposal, supersedeIds })
  }
  return resolved
}
