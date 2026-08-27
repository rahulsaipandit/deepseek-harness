import { describe, expect, it } from 'vitest'
import { findConsolidationProposals } from '../src/consolidation.ts'
import type { ConsolidationCandidateNote } from '../src/consolidation.ts'

function note(overrides: Partial<ConsolidationCandidateNote> & Pick<ConsolidationCandidateNote, 'id' | 'createdAt'>): ConsolidationCandidateNote {
  return {
    title: overrides.id,
    tags: [],
    content: '',
    ...overrides,
  }
}

describe('findConsolidationProposals — supersede (contradiction)', () => {
  it('proposes superseding the older note when two tag-overlapping notes contradict', () => {
    const notes = [
      note({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', tags: ['theme'], content: 'Dark mode is enabled for all editors.' }),
      note({ id: 'new', createdAt: '2026-02-01T00:00:00.000Z', tags: ['theme'], content: 'Dark mode is disabled now.' }),
    ]
    const proposals = findConsolidationProposals(notes, { similarityThreshold: 0.92 })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ action: 'supersede', keepId: 'new', supersedeIds: ['old'] })
  })

  it('does not propose superseding notes with no shared tag, even if content contradicts', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['theme'], content: 'Dark mode is enabled.' }),
      note({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z', tags: ['unrelated'], content: 'Dark mode is disabled.' }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92 })).toEqual([])
  })

  it('does not propose superseding two tag-overlapping notes with unrelated, non-contradictory content', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['shared'], content: 'Buy milk on the way home.' }),
      note({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z', tags: ['shared'], content: 'The quarterly report is due Friday.' }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92 })).toEqual([])
  })
})

describe('findConsolidationProposals — merge (near-duplicate)', () => {
  const embeddings: Record<string, number[]> = {
    a: [1, 0, 0],
    b: [0.99, 0.01, 0],
    c: [0.98, 0.02, 0],
    unrelated: [0, 0, 1],
  }
  const getEmbedding = (id: string): number[] | undefined => embeddings[id]

  it('proposes merging two near-duplicate, tag-overlapping notes, keeping the newer one', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z', tags: ['preferences'] }),
    ]
    const proposals = findConsolidationProposals(notes, { similarityThreshold: 0.92, getEmbedding })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ action: 'merge', keepId: 'b', supersedeIds: ['a'] })
    expect(proposals[0]?.similarity).toBeGreaterThanOrEqual(0.92)
  })

  it('does not propose merging notes below the similarity threshold', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'unrelated', createdAt: '2026-02-01T00:00:00.000Z', tags: ['preferences'] }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92, getEmbedding })).toEqual([])
  })

  it('is skipped entirely (no merge proposals) when getEmbedding is omitted', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z', tags: ['preferences'] }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92 })).toEqual([])
  })

  it('clusters 3+ mutually-similar notes into one merge proposal, keeping the newest', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'b', createdAt: '2026-02-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'c', createdAt: '2026-03-01T00:00:00.000Z', tags: ['preferences'] }),
    ]
    const proposals = findConsolidationProposals(notes, { similarityThreshold: 0.92, getEmbedding })
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.keepId).toBe('c')
    expect(proposals[0]?.supersedeIds.sort()).toEqual(['a', 'b'])
  })

  it('does not merge notes lacking a computed embedding (getEmbedding returns undefined)', () => {
    const notes = [
      note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences'] }),
      note({ id: 'no-embedding', createdAt: '2026-02-01T00:00:00.000Z', tags: ['preferences'] }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92, getEmbedding })).toEqual([])
  })
})

describe('findConsolidationProposals — general behavior', () => {
  it('returns nothing for a single note', () => {
    const notes = [note({ id: 'a', createdAt: '2026-01-01T00:00:00.000Z', tags: ['x'] })]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92 })).toEqual([])
  })

  it('returns nothing for an empty set of notes', () => {
    expect(findConsolidationProposals([], { similarityThreshold: 0.92 })).toEqual([])
  })

  it('only compares each pair once even when notes share multiple tags', () => {
    const notes = [
      note({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z', tags: ['a', 'b'], content: 'Dark mode is enabled.' }),
      note({ id: 'new', createdAt: '2026-02-01T00:00:00.000Z', tags: ['a', 'b'], content: 'Dark mode is disabled.' }),
    ]
    expect(findConsolidationProposals(notes, { similarityThreshold: 0.92 })).toHaveLength(1)
  })

  it('a note claimed as a supersede target by two independent proposals in one run resolves to a single proposal, contradiction taking priority over merge', () => {
    // M is: (a) the older, superseded member of a merge cluster with K (via
    // "preferences", near-duplicate embeddings), and (b) independently
    // contradicted by S (via "theme") — a note appearing in supersedeIds of
    // two proposals from the same findConsolidationProposals() call.
    const embeddings: Record<string, number[]> = { k: [1, 0, 0], m: [0.99, 0.01, 0] }
    const getEmbedding = (id: string): number[] | undefined => embeddings[id]

    const notes = [
      note({ id: 'k', createdAt: '2026-03-01T00:00:00.000Z', tags: ['preferences'], content: 'I enjoy quiet mornings.' }),
      note({ id: 'm', createdAt: '2026-01-01T00:00:00.000Z', tags: ['preferences', 'theme'], content: 'Dark mode is enabled.' }),
      note({ id: 's', createdAt: '2026-02-01T00:00:00.000Z', tags: ['theme'], content: 'Dark mode is disabled.' }),
    ]
    const proposals = findConsolidationProposals(notes, { similarityThreshold: 0.92, getEmbedding })

    // Only the supersede (contradiction) proposal survives — the merge
    // proposal had nothing left to claim once "m" was taken, so it's dropped
    // rather than reported with an empty or partial supersedeIds list.
    expect(proposals).toHaveLength(1)
    expect(proposals[0]).toMatchObject({ action: 'supersede', keepId: 's', supersedeIds: ['m'] })
  })
})
