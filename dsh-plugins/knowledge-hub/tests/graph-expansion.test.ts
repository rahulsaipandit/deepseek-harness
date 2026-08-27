import { describe, expect, it } from 'vitest'
import { emptyConceptGraph, mergeNoteIntoGraph } from '../src/concept-graph.ts'
import type { ConceptGraph } from '../src/concept-graph.ts'
import { findGraphNeighborNotes } from '../src/graph-expansion.ts'

describe('findGraphNeighborNotes', () => {
  it('returns nothing for an empty graph', () => {
    expect(findGraphNeighborNotes(emptyConceptGraph(), ['a'], new Set())).toEqual([])
  })

  it('returns nothing when given no source notes', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['x']], wikilinkTargetTitles: [] })
    expect(findGraphNeighborNotes(graph, [], new Set())).toEqual([])
  })

  it('finds a note sharing a concept directly (hop 0)', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['shared-concept']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['shared-concept']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a']))
    expect(neighbors).toEqual([{ noteId: 'b', viaConcepts: ['shared-concept'] }])
  })

  it('finds a note reachable via one W1 wikilink edge hop', () => {
    const graph = emptyConceptGraph()
    // A wikilinks to B, but they share no concept.
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-a']], wikilinkTargetTitles: ['B'] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['concept-b']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a']))
    expect(neighbors.map(n => n.noteId)).toContain('b')
  })

  it('finds a note sharing any concept from a multi-concept chunk, not just the first one', () => {
    const graph = emptyConceptGraph()
    // Both concept-x and concept-y come from A's own chunk, so both are already
    // in A's hop-0 frontier (a W2 edge only ever connects two concepts that
    // were BOTH extracted from the same note — it can't reveal a concept
    // beyond what that note's own chunks already produced).
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-x', 'concept-y']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['concept-y']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a']))
    const b = neighbors.find(n => n.noteId === 'b')
    expect(b).toBeDefined()
    expect(b?.viaConcepts).toEqual(['concept-y'])
  })

  it('hops=0 restricts to directly-shared concepts only, missing a note reachable solely via a W1 wikilink edge', () => {
    const graph = emptyConceptGraph()
    // A wikilinks to B; they share no concept, so B is only reachable via the edge hop.
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-a']], wikilinkTargetTitles: ['B'] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['concept-b']], wikilinkTargetTitles: [] })

    expect(findGraphNeighborNotes(graph, ['a'], new Set(['a']), 0)).toEqual([])
    expect(findGraphNeighborNotes(graph, ['a'], new Set(['a']), 1).map(n => n.noteId)).toContain('b')
  })

  it('excludes note ids in excludeNoteIds, e.g. notes already surfaced by hybrid search', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['shared-concept']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['shared-concept']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a', 'b']))
    expect(neighbors).toEqual([])
  })

  it('never returns the source note itself', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-x']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a']))
    expect(neighbors.map(n => n.noteId)).not.toContain('a')
  })

  it('lists all connecting concepts when a neighbor is reachable through more than one', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-x'], ['concept-y']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['concept-x'], ['concept-y']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a'], new Set(['a']))
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0]?.viaConcepts.sort()).toEqual(['concept-x', 'concept-y'])
  })

  it('aggregates neighbors across multiple source notes', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, { noteId: 'a', noteTitle: 'A', chunkConcepts: [['concept-a']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'b', noteTitle: 'B', chunkConcepts: [['concept-b']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'c', noteTitle: 'C', chunkConcepts: [['concept-a']], wikilinkTargetTitles: [] })
    mergeNoteIntoGraph(graph, { noteId: 'd', noteTitle: 'D', chunkConcepts: [['concept-b']], wikilinkTargetTitles: [] })

    const neighbors = findGraphNeighborNotes(graph, ['a', 'b'], new Set(['a', 'b']))
    expect(neighbors.map(n => n.noteId).sort()).toEqual(['c', 'd'])
  })
})

describe('findGraphNeighborNotes (graceful on a malformed/partial graph)', () => {
  it('skips an edge referencing an unknown node id rather than throwing', () => {
    const graph: ConceptGraph = {
      version: 1,
      nodes: [{ id: 'x', label: 'x', degree: 1, community: 0, noteIds: ['a'] }],
      edges: [{ source: 'x', target: 'does-not-exist', scope: 'same-file', weight: 1, noteIds: ['a'] }],
    }
    expect(() => findGraphNeighborNotes(graph, ['a'], new Set(['a']))).not.toThrow()
  })
})
