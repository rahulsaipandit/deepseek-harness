import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOWED_TOOLS, KNOWN_TOOL_SCHEMAS, toMcpOutcome } from '../src/tool-bridge.ts'

describe('DEFAULT_ALLOWED_TOOLS / KNOWN_TOOL_SCHEMAS', () => {
  it('every default-allowed tool has a known schema', () => {
    for (const name of DEFAULT_ALLOWED_TOOLS) {
      expect(KNOWN_TOOL_SCHEMAS[name], `schema for ${name}`).toBeDefined()
    }
  })

  it('is exactly the five knowledge-hub tools, not more', () => {
    expect([...DEFAULT_ALLOWED_TOOLS].sort()).toEqual([
      'memory_audit',
      'memory_list',
      'memory_recall',
      'memory_related',
      'memory_remember',
    ])
  })
})

describe('toMcpOutcome', () => {
  it('passes through a text content block unchanged', () => {
    const outcome = toMcpOutcome({ content: [{ type: 'text', text: 'hello' }] })
    expect(outcome).toEqual({ isError: false, content: [{ type: 'text', text: 'hello' }] })
  })

  it('stringifies a non-text content block instead of dropping it', () => {
    const outcome = toMcpOutcome({ content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] })
    expect(outcome.content).toHaveLength(1)
    expect(outcome.content[0]?.type).toBe('text')
    expect(outcome.content[0]?.text).toContain('image')
  })

  it('defaults isError to false when absent', () => {
    expect(toMcpOutcome({ content: [] }).isError).toBe(false)
  })

  it('carries isError: true through', () => {
    expect(toMcpOutcome({ isError: true, content: [{ type: 'text', text: 'boom' }] }).isError).toBe(true)
  })

  it('handles an empty content array', () => {
    expect(toMcpOutcome({ content: [] }).content).toEqual([])
  })
})
