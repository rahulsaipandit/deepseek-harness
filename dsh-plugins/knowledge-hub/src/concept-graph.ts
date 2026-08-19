/**
 * LLM-extracted concept graph: nodes are extracted concepts (not notes),
 * built incrementally — only ever from newly-written notes, never
 * backfilled over the existing vault. Adapted from Tolaria's ADR-0175
 * (`docs/packages/cognitiveBrain/docs/designKnowledgeGraph.md`), itself
 * adapted from github.com/rahulnyk/knowledge_graph. See
 * designCognitiveBrainForDSH.md §1.5 for why this is architecturally
 * distinct from the rejected `InProcessGraph` (incremental-only, never
 * traversed at search time, disposable cache).
 * @module dsh-plugin-knowledge-hub/concept-graph
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export const CONCEPT_GRAPH_CACHE_VERSION = 1

export interface ConceptNode {
  id: string
  label: string
  degree: number
  community: number
  noteIds: string[]
}

export interface ConceptEdge {
  source: string
  target: string
  scope: 'same-file' | 'cross-file'
  weight: number
  noteIds: string[]
}

export interface ConceptGraph {
  version: number
  nodes: ConceptNode[]
  edges: ConceptEdge[]
}

export function emptyConceptGraph(): ConceptGraph {
  return { version: CONCEPT_GRAPH_CACHE_VERSION, nodes: [], edges: [] }
}

/** Normalize a concept label into a stable node id. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'concept'
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}::${b}` : `${b}::${a}`
}

export interface MergeNoteInput {
  noteId: string
  noteTitle: string
  /** Concepts extracted per chunk (same-chunk concepts get W2 same-file edges). */
  chunkConcepts: string[][]
  /** Titles of other notes this note wikilinks to (already resolved to exist). */
  wikilinkTargetTitles: string[]
}

/**
 * Merge one newly-extracted note into the graph, in place — the only
 * mutation path; there is no batch/backfill entry point by design. Safe to
 * call twice with the same `noteId` and identical inputs: no duplicate
 * nodes, no double-counted edge weight (each edge tracks which note ids
 * already contributed to it).
 */
export function mergeNoteIntoGraph(graph: ConceptGraph, input: MergeNoteInput): void {
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]))
  const edgesByKey = new Map(graph.edges.map(edge => [edgeKey(edge.source, edge.target), edge]))

  function getOrCreateNode(label: string, noteId?: string): ConceptNode {
    const id = slugify(label)
    let node = nodesById.get(id)
    if (!node) {
      node = { id, label, degree: 0, community: 0, noteIds: [] }
      nodesById.set(id, node)
    }
    if (noteId && !node.noteIds.includes(noteId)) node.noteIds.push(noteId)
    return node
  }

  function addEdge(sourceId: string, targetId: string, scope: ConceptEdge['scope'], noteId: string): void {
    if (sourceId === targetId) return
    const key = edgeKey(sourceId, targetId)
    let edge = edgesByKey.get(key)
    if (!edge) {
      edge = { source: sourceId, target: targetId, scope, weight: 0, noteIds: [] }
      edgesByKey.set(key, edge)
    }
    if (edge.noteIds.includes(noteId)) return // this note already asserted this edge — idempotent no-op
    edge.noteIds.push(noteId)
    edge.weight += 1
  }

  const primary = getOrCreateNode(input.noteTitle, input.noteId)

  for (const concepts of input.chunkConcepts) {
    const ids = [...new Set(concepts.map(name => getOrCreateNode(name, input.noteId).id))]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]
        const b = ids[j]
        if (a && b) addEdge(a, b, 'same-file', input.noteId)
      }
    }
  }

  for (const targetTitle of input.wikilinkTargetTitles) {
    const target = getOrCreateNode(targetTitle)
    addEdge(primary.id, target.id, 'cross-file', input.noteId)
  }

  graph.nodes = [...nodesById.values()]
  graph.edges = [...edgesByKey.values()]
  recomputeDegreeAndCommunity(graph)
}

/** Recompute true degree (edge count, not chunk occurrences) and connected-component community ids. */
function recomputeDegreeAndCommunity(graph: ConceptGraph): void {
  const degree = new Map<string, number>()
  for (const node of graph.nodes) degree.set(node.id, 0)
  for (const edge of graph.edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
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
  for (const node of graph.nodes) parent.set(node.id, node.id)
  for (const edge of graph.edges) union(edge.source, edge.target)

  const communityIndex = new Map<string, number>()
  for (const node of graph.nodes) {
    const root = find(node.id)
    if (!communityIndex.has(root)) communityIndex.set(root, communityIndex.size)
  }

  for (const node of graph.nodes) {
    node.degree = degree.get(node.id) ?? 0
    node.community = communityIndex.get(find(node.id)) ?? 0
  }
}

// ── Disposable JSON cache ────────────────────────────────────────────────

function cachePath(vaultPath: string): string {
  return resolve(vaultPath, '.concept-graph.json')
}

/** Read the cached graph, or an empty one if absent/corrupt/wrong version — always safe, never throws. */
export async function readConceptGraphCache(vaultPath: string): Promise<ConceptGraph> {
  try {
    const raw = await readFile(cachePath(vaultPath), 'utf8')
    const parsed = JSON.parse(raw) as ConceptGraph
    if (parsed.version !== CONCEPT_GRAPH_CACHE_VERSION || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return emptyConceptGraph()
    }
    return parsed
  } catch {
    return emptyConceptGraph()
  }
}

export async function writeConceptGraphCache(vaultPath: string, graph: ConceptGraph): Promise<void> {
  const path = cachePath(vaultPath)
  await mkdir(dirname(path), { recursive: true })
  await writeFileAtomic(path, JSON.stringify(graph, null, 2), { mode: 0o600 })
}
