/**
 * Bridges `ctx.tools` (DSH's internal tool registry) to MCP tool
 * registrations: hand-written zod input schemas for the default allowlist
 * (dsh-plugin-knowledge-hub's five memory tools — this server exposes
 * *existing* tools only, no new capability; see
 * designCognitiveBrainForDSH.md's MCP server section for why synthesis,
 * graph traversal, and knowledge-gap analysis were explicitly excluded from
 * this surface), plus the result-shape conversion back to MCP's
 * `content`/`isError` contract.
 * @module
 */

import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Default tool allowlist: dsh-plugin-knowledge-hub's five tools, and nothing else. */
export const DEFAULT_ALLOWED_TOOLS = [
  'memory_remember',
  'memory_recall',
  'memory_list',
  'memory_audit',
  'memory_related',
] as const

/**
 * Hand-written input schemas, one per tool this server knows how to expose
 * safely. A tool name in `allowedTools` with no entry here is skipped (with
 * a warning) rather than exposed with a guessed/generic schema — this
 * server is deliberately not a generic arbitrary-tool-to-MCP bridge.
 */
export const KNOWN_TOOL_SCHEMAS: Record<string, ZodRawShape> = {
  memory_remember: {
    title: z.string().describe('Short title for this memory.'),
    content: z.string().describe('The memory content, in markdown.'),
    type: z.enum(['note', 'fact', 'procedure', 'entity']).optional().describe('Defaults to "note".'),
    tags: z.array(z.string()).optional().describe('Optional tags for filtering/search.'),
    confidence: z.number().min(0).max(1).optional().describe('Optional 0-1 confidence. Defaults to 0.5.'),
    resource: z.string().optional().describe('Optional canonical source URL (OKF-compatible).'),
  },
  memory_recall: {
    query: z.string().describe('Natural-language search query.'),
    limit: z.number().optional().describe('Max results (default 5).'),
    tags: z.array(z.string()).optional().describe('Optional: only return memories having ALL these tags.'),
  },
  memory_list: {
    tags: z.array(z.string()).optional().describe('Optional: only list memories having ALL these tags.'),
    limit: z.number().optional().describe('Max results (default 50).'),
  },
  memory_audit: {
    entryId: z.string().optional().describe('Optional: only events for this memory id.'),
    operation: z.enum(['create', 'update', 'delete']).optional(),
    limit: z.number().optional().describe('Max events (default 50).'),
  },
  memory_related: {
    id: z.string().describe('Id of an existing memory, as returned by memory_recall or memory_list.'),
    limit: z.number().optional().describe('Max results (default 5).'),
  },
}

/**
 * Convert a DSH `ToolExecutionResult`-shaped outcome into MCP's
 * `CallToolResult` (`content`/`isError`) contract. DSH's `ContentBlock`
 * union already has a `{ type: 'text', text: string }` member that maps
 * directly; any other block type (image, reasoning, tool-call/-result) is
 * summarized as text rather than dropped silently, since MCP clients here
 * are thin external callers with no DSH-specific rendering.
 */
export function toMcpOutcome(result: { isError?: boolean; content: readonly unknown[] }): CallToolResult {
  const content = result.content.map((block): { type: 'text'; text: string } => {
    if (typeof block === 'object' && block !== null && 'type' in block) {
      const typed = block as { type: unknown; text?: unknown }
      if (typed.type === 'text' && typeof typed.text === 'string') return { type: 'text', text: typed.text }
    }
    return { type: 'text', text: JSON.stringify(block) }
  })
  return { isError: result.isError === true, content }
}
