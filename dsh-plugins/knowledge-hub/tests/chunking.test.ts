import { describe, expect, it } from 'vitest'
import { chunkByHeading } from '../src/chunking.ts'

describe('chunkByHeading', () => {
  it('returns one chunk for a headingless note', () => {
    const chunks = chunkByHeading('Just a plain paragraph with no headings.')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.heading).toBeUndefined()
    expect(chunks[0]?.text).toBe('Just a plain paragraph with no headings.')
  })

  it('splits on headings of any level', () => {
    const chunks = chunkByHeading('# Title\nIntro text.\n\n## Section A\nBody A.\n\n### Section B\nBody B.\n')
    expect(chunks.map(c => c.heading)).toEqual(['Title', 'Section A', 'Section B'])
    expect(chunks.map(c => c.text)).toEqual(['Intro text.', 'Body A.', 'Body B.'])
  })

  it('returns [] for an empty (frontmatter-only) body', () => {
    expect(chunkByHeading('')).toEqual([])
    expect(chunkByHeading('   \n  \n')).toEqual([])
  })

  it('drops a heading with no body text before the next heading', () => {
    const chunks = chunkByHeading('# Empty Section\n## Real Section\nContent here.\n')
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.heading).toBe('Real Section')
  })
})
