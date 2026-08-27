/**
 * Opt-in, per-query concept-graph expansion for `memory_recall`'s
 * `expandWithGraph` flag: given the note ids `memory_recall` already found
 * via hybrid search, finds other notes connected to them through the
 * concept graph — either because they share a concept directly (0 edge
 * hops: every concept a note's own chunks produced, including ones sharing
 * a slug with a concept extracted from a different note, counts as hop 0 —
 * a W2 same-file edge only ever connects two concepts already produced by
 * the SAME note, so it can never reveal a note beyond that), or because a
 * further W1 wikilink note-note edge hop reaches a directly linked note.
 * This costs nothing beyond an in-memory graph walk — the concept graph
 * itself is already built at write time (one bounded LLM call per new
 * note, designCognitiveBrainForDSH.md §4), so traversing it per query is
 * cheap and bounded, unlike the automatic, every-query traversal that
 * design rejected.
 *
 * `hops` is a parameter (not yet exposed on the tool schema — ship at 1 for
 * now, per that same section's deliberately narrow v1 scope) so depth can
 * grow later without changing this function's shape.
 * @module dsh-plugin-knowledge-hub/graph-expansion
 */

import type { ConceptGraph } from './concept-graph.ts'

export interface GraphNeighbor {
  noteId: string
  /** Concept labels connecting this neighbor to one of the source notes. */
  viaConcepts: string[]
}

/**
 * Expand a set of source note ids by `hops` edge-traversal steps through
 * the concept graph, collecting every OTHER note reachable.
 * @param graph - the concept graph to traverse (already loaded from cache).
 * @param sourceNoteIds - note ids to expand from (typically `memory_recall`'s direct hits).
 * @param excludeNoteIds - note ids to never return (the source notes themselves, or notes already surfaced).
 * @param hops - edge-traversal depth beyond the source notes' own concepts. Defaults to 1.
 * @returns neighbor notes, each with the concept label(s) that connected it — a note reachable through more than one path lists all of them.
 */
export function findGraphNeighborNotes(
  graph: ConceptGraph,
  sourceNoteIds: readonly string[],
  excludeNoteIds: ReadonlySet<string>,
  hops = 1,
): GraphNeighbor[] {
  if (graph.nodes.length === 0 || sourceNoteIds.length === 0) return []
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  const results = new Map<string, Set<string>>()

  function collectNotesFrom(nodeIds: ReadonlySet<string>, sourceNoteId: string): void {
    for (const nodeId of nodeIds) {
      const node = nodesById.get(nodeId)
      if (!node) continue
      for (const noteId of node.noteIds) {
        if (noteId === sourceNoteId || excludeNoteIds.has(noteId)) continue
        if (!results.has(noteId)) results.set(noteId, new Set())
        results.get(noteId)!.add(node.label)
      }
    }
  }

  for (const sourceNoteId of sourceNoteIds) {
    let frontier = new Set(graph.nodes.filter(node => node.noteIds.includes(sourceNoteId)).map(node => node.id))
    const visited = new Set(frontier)
    // Hop 0: notes sharing a concept directly with this source note.
    collectNotesFrom(frontier, sourceNoteId)

    for (let hop = 0; hop < hops; hop++) {
      const next = new Set<string>()
      for (const edge of graph.edges) {
        if (frontier.has(edge.source) && !visited.has(edge.target)) next.add(edge.target)
        if (frontier.has(edge.target) && !visited.has(edge.source)) next.add(edge.source)
      }
      if (next.size === 0) break
      for (const id of next) visited.add(id)
      collectNotesFrom(next, sourceNoteId)
      frontier = next
    }
  }

  return [...results.entries()].map(([noteId, concepts]) => ({ noteId, viaConcepts: [...concepts] }))
}
