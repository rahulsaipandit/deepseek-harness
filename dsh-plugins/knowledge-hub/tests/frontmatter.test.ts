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

  it('round-trips the optional resource, contradictedBy, and supersededBy fields', () => {
    const file: MemoryFile = {
      frontmatter: {
        id: 'mem_okf',
        title: 'OKF-linked note',
        type: 'note',
        tags: [],
        createdAt: '2026-08-18T10:00:00.000Z',
        confidence: 0.5,
        sourceCount: 1,
        resource: 'https://example.com/source',
        contradictedBy: ['mem_other'],
        supersededBy: 'mem_newer',
      },
      content: 'Body.',
      path: '/tmp/mem_okf.md',
    }
    const raw = serializeMemoryFile(file)
    const parsed = parseMemoryFile(raw, file.path)
    expect(parsed?.frontmatter.resource).toBe('https://example.com/source')
    expect(parsed?.frontmatter.contradictedBy).toEqual(['mem_other'])
    expect(parsed?.frontmatter.supersededBy).toBe('mem_newer')
  })

  it('round-trips a null resource', () => {
    const file: MemoryFile = {
      frontmatter: {
        id: 'mem_null_resource',
        title: 'No external origin',
        type: 'note',
        tags: [],
        createdAt: '2026-08-18T10:00:00.000Z',
        confidence: 0.5,
        sourceCount: 1,
        resource: null,
      },
      content: 'Body.',
      path: '/tmp/mem_null_resource.md',
    }
    const raw = serializeMemoryFile(file)
    const parsed = parseMemoryFile(raw, file.path)
    expect(parsed?.frontmatter.resource).toBeNull()
  })

  it('leaves resource, contradictedBy, and supersededBy undefined when absent', () => {
    const raw = `---\nid: mem_4\ntitle: Minimal\ntype: note\ncreatedAt: "2026-08-18T10:00:00.000Z"\n---\nBody.\n`
    const parsed = parseMemoryFile(raw, '/tmp/mem_4.md')
    expect(parsed?.frontmatter.resource).toBeUndefined()
    expect(parsed?.frontmatter.contradictedBy).toBeUndefined()
    expect(parsed?.frontmatter.supersededBy).toBeUndefined()
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
