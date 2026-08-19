/**
 * On-demand resource access: registers two synthetic tools per connected
 * server — `mcp__<serverName>__list_resources` and
 * `mcp__<serverName>__read_resource` — so a model can pull an external MCP
 * server's *resources* the same pull-based way it already calls its
 * *tools*. This is the deliberately chosen, lower-risk alternative to
 * automatic context injection: no new context-budgeting/staleness/
 * selection design surface, consistent with how every other DSH tool
 * already works (the model decides when it needs something).
 *
 * Unlike {@link syncTools}, this has no re-sync/generation-diffing
 * machinery: both tools call the live `client` at call time and always
 * reflect whatever resources currently exist upstream, so there's nothing
 * to keep in sync ahead of time — just two static tool registrations per
 * connection generation.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListResourcesResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { publicToolName } from './tools.ts'
import type { ToolBridgeOptions } from './tools.ts'

/** List without mutating the SDK's per-page output-validator cache, mirroring `listToolsUncached` in tools.ts. */
function listResourcesUncached(client: Client, cursor: string | undefined, exec: ToolExecution, opts: ToolBridgeOptions) {
  return client.request(
    { method: 'resources/list', ...cursor === undefined ? {} : { params: { cursor } } },
    ListResourcesResultSchema,
    { signal: exec.signal, timeout: opts.toolCallTimeoutMs },
  )
}

function readResourceUncached(client: Client, uri: string, exec: ToolExecution, opts: ToolBridgeOptions) {
  return client.request(
    { method: 'resources/read', params: { uri } },
    ReadResourceResultSchema,
    { signal: exec.signal, timeout: opts.toolCallTimeoutMs },
  )
}

function buildListResourcesTool(client: Client, opts: ToolBridgeOptions): ToolDefinition {
  return {
    name: publicToolName(opts.serverName, 'list_resources'),
    description: `List resources (read-only documents/context, distinct from callable tools) offered by the "${opts.serverName}" MCP server.`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
      render(_args, value) {
        const result = value as unknown as { content: [{ text: string }] }
        return [{ type: 'text', text: result.content[0].text }]
      },
    },
    async execute(_args: unknown, exec: ToolExecution) {
      const lines: string[] = []
      let cursor: string | undefined
      do {
        const response = await listResourcesUncached(client, cursor, exec, opts)
        for (const r of response.resources) {
          lines.push(`${r.uri}${r.name ? ` (${r.name})` : ''}${r.description ? `: ${r.description}` : ''}${r.mimeType ? ` [${r.mimeType}]` : ''}`)
        }
        cursor = response.nextCursor
      } while (cursor)

      const text = lines.length === 0 ? `${opts.serverName} has no resources.` : lines.join('\n')
      return { content: [{ type: 'text', text }] }
    },
  }
}

function buildReadResourceTool(client: Client, opts: ToolBridgeOptions): ToolDefinition {
  return {
    name: publicToolName(opts.serverName, 'read_resource'),
    description: `Read one resource by URI from the "${opts.serverName}" MCP server (see list_resources for available URIs).`,
    parameters: {
      type: 'object',
      properties: { uri: { type: 'string', description: 'Resource URI, as returned by list_resources.' } },
      required: ['uri'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false },
      render(_args, value) {
        const result = value as unknown as { content: [{ text: string }] }
        return [{ type: 'text', text: result.content[0].text }]
      },
    },
    async execute(args: unknown, exec: ToolExecution) {
      const uri = typeof args === 'object' && args !== null && 'uri' in args && typeof (args as { uri: unknown }).uri === 'string'
        ? (args as { uri: string }).uri
        : undefined
      if (uri === undefined) throw new Error('read_resource: "uri" is required')

      const result = await readResourceUncached(client, uri, exec, opts)
      // Trust boundary: contents arrive from an external MCP server process.
      const text = result.contents.map((entry) => {
        if ('text' in entry) return entry.text
        return `[binary content: ${entry.mimeType ?? 'unknown mime type'}, ${entry.blob.length} base64 chars, content discarded]`
      }).join('\n\n') || `(${uri} returned no content)`
      return { content: [{ type: 'text', text }] }
    },
  }
}

/**
 * Build the two on-demand resource tools for one connected client, gated on
 * the server actually advertising resource support — a server with no
 * `capabilities.resources` never gets these registered, so the model isn't
 * offered tools that would just fail every time.
 * @param client - Connected MCP Client instance (post-`initialize`, so capabilities are known).
 * @param opts - Same bridge options `syncTools` uses (server namespace, per-call timeout).
 * @returns Zero or two `ToolDefinition`s, ready for `ctx.tools.register()`.
 */
export function resourceToolDefinitions(client: Client, opts: ToolBridgeOptions): ToolDefinition[] {
  if (client.getServerCapabilities?.()?.resources === undefined) return []
  return [buildListResourcesTool(client, opts), buildReadResourceTool(client, opts)]
}
