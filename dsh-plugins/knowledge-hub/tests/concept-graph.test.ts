import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  emptyConceptGraph,
  mergeNoteIntoGraph,
  readConceptGraphCache,
  slugify,
  writeConceptGraphCache,
} from '../src/concept-graph.ts'
import type { ConceptGraph } from '../src/concept-graph.ts'

function findEdge(graph: ConceptGraph, a: string, b: string) {
  const idA = slugify(a)
  const idB = slugify(b)
  return graph.edges.find(e => (e.source === idA && e.target === idB) || (e.source === idB && e.target === idA))
}

describe('mergeNoteIntoGraph', () => {
  it('creates same-file (W2) edges between concepts in the same chunk', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Deploying React Native builds',
      chunkConcepts: [['gradle configuration', 'expo eas']],
      wikilinkTargetTitles: [],
    })
    const edge = findEdge(graph, 'gradle configuration', 'expo eas')
    expect(edge).toBeDefined()
    expect(edge?.scope).toBe('same-file')
    expect(edge?.weight).toBe(1)
  })

  it('creates cross-file (W1) edges from a note\'s primary concept to a wikilinked note\'s primary concept', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Note A',
      chunkConcepts: [['topic x']],
      wikilinkTargetTitles: ['Note B'],
    })
    const edge = findEdge(graph, 'Note A', 'Note B')
    expect(edge).toBeDefined()
    expect(edge?.scope).toBe('cross-file')
  })

  it('consolidates a shared concept across two notes into one node with summed edge weight', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Note A',
      chunkConcepts: [['shared concept', 'other one']],
      wikilinkTargetTitles: [],
    })
    mergeNoteIntoGraph(graph, {
      noteId: 'note-2',
      noteTitle: 'Note B',
      chunkConcepts: [['shared concept', 'other two']],
      wikilinkTargetTitles: [],
    })
    const sharedNodes = graph.nodes.filter(n => n.id === slugify('shared concept'))
    expect(sharedNodes).toHaveLength(1)
    expect(sharedNodes[0]?.noteIds.sort()).toEqual(['note-1', 'note-2'])
  })

  it('is idempotent: merging the same note twice does not duplicate nodes/edges or double-count weight', () => {
    const graph = emptyConceptGraph()
    const input = {
      noteId: 'note-1',
      noteTitle: 'Note A',
      chunkConcepts: [['alpha', 'beta']],
      wikilinkTargetTitles: [],
    }
    mergeNoteIntoGraph(graph, input)
    const nodeCountAfterFirst = graph.nodes.length
    const edgeWeightAfterFirst = findEdge(graph, 'alpha', 'beta')?.weight

    mergeNoteIntoGraph(graph, input)
    expect(graph.nodes).toHaveLength(nodeCountAfterFirst)
    expect(findEdge(graph, 'alpha', 'beta')?.weight).toBe(edgeWeightAfterFirst)
  })

  it('recomputes true degree (edge count, not chunk occurrences) after each merge', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Note A',
      // "hub" co-occurs with three other concepts across chunks, in the same note —
      // degree should be 3 (three distinct edges), not the number of chunk mentions.
      chunkConcepts: [['hub', 'a'], ['hub', 'b'], ['hub', 'c']],
      wikilinkTargetTitles: [],
    })
    const hub = graph.nodes.find(n => n.id === slugify('hub'))
    expect(hub?.degree).toBe(3)
  })

  it('assigns the same community to concepts connected transitively, and a different one to an isolated cluster', () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Note A',
      chunkConcepts: [['x', 'y'], ['z', 'w']], // two separate clusters within one note
      wikilinkTargetTitles: [],
    })
    const x = graph.nodes.find(n => n.id === slugify('x'))
    const y = graph.nodes.find(n => n.id === slugify('y'))
    const z = graph.nodes.find(n => n.id === slugify('z'))
    expect(x?.community).toBe(y?.community)
    expect(x?.community).not.toBe(z?.community)
  })
})

describe('concept-graph cache', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'knowledge-hub-concept-graph-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('readConceptGraphCache returns an empty graph when no cache file exists', async () => {
    const graph = await readConceptGraphCache(dir)
    expect(graph.nodes).toEqual([])
    expect(graph.edges).toEqual([])
  })

  it('round-trips a graph through write then read', async () => {
    const graph = emptyConceptGraph()
    mergeNoteIntoGraph(graph, {
      noteId: 'note-1',
      noteTitle: 'Note A',
      chunkConcepts: [['alpha', 'beta']],
      wikilinkTargetTitles: [],
    })
    await writeConceptGraphCache(dir, graph)
    const read = await readConceptGraphCache(dir)
    expect(read).toEqual(graph)
  })

  it('returns an empty graph for a corrupted cache file rather than throwing', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, '.concept-graph.json'), 'not valid json', 'utf8')
    const graph = await readConceptGraphCache(dir)
    expect(graph.nodes).toEqual([])
  })
})
