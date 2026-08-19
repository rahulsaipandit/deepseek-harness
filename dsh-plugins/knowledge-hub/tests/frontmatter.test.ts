import { describe, expect, it } from 'vitest'
import { parseMemoryFile, serializeMemoryFile } from '../src/frontmatter.ts'
import type { MemoryFile } from '../src/types.ts'

describe('parseMemoryFile / serializeMemoryFile', () => {
  it('round-trips a well-formed memory file', () => {
    const file: MemoryFile = {
      frontmatter: {
        id: 'mem_1',
        title: 'Test note',
        type: 'note',
        tags: ['a', 'b'],
        createdAt: '2026-08-18T10:00:00.000Z',
        confidence: 0.8,
        sourceCount: 1,
      },
      content: 'Hello world.',
      path: '/tmp/mem_1.md',
    }
    const raw = serializeMemoryFile(file)
    const parsed = parseMemoryFile(raw, file.path)
    expect(parsed).toBeDefined()
    expect(parsed?.frontmatter).toEqual(file.frontmatter)
    expect(parsed?.content).toBe(file.content)
  })

  it('defaults confidence and sourceCount, and tags to []', () => {
    const raw = `---\nid: mem_2\ntitle: Minimal\ntype: note\ncreatedAt: "2026-08-18T10:00:00.000Z"\n---\nBody.\n`
    const parsed = parseMemoryFile(raw, '/tmp/mem_2.md')
    expect(parsed?.frontmatter.tags).toEqual([])
    expect(parsed?.frontmatter.confidence).toBe(0.5)
    expect(parsed?.frontmatter.sourceCount).toBe(1)
  })

  it('returns undefined for malformed YAML rather than throwing', () => {
    const raw = `---\nid: [unterminated\n---\nBody.\n`
    expect(parseMemoryFile(raw, '/tmp/bad.md')).toBeUndefined()
  })

  it('returns undefined when a required field is missing', () => {
    const raw = `---\ntitle: No id\ntype: note\ncreatedAt: "2026-08-18T10:00:00.000Z"\n---\nBody.\n`
    expect(parseMemoryFile(raw, '/tmp/bad2.md')).toBeUndefined()
  })

  it('returns undefined for an invalid type value', () => {
    const raw = `---\nid: mem_3\ntitle: Bad type\ntype: not-a-real-type\ncreatedAt: "2026-08-18T10:00:00.000Z"\n---\nBody.\n`
    expect(parseMemoryFile(raw, '/tmp/bad3.md')).toBeUndefined()
  })

  it('returns undefined when there is no frontmatter block at all', () => {
    expect(parseMemoryFile('just plain text', '/tmp/bad4.md')).toBeUndefined()
  })
})
