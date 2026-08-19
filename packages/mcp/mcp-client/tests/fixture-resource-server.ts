/**
 * Minimal MCP server over stdio for e2e testing the resources bridge
 * (resources.ts) — separate from fixture-server.ts (tools-only) so adding
 * resource support here can't perturb the many existing tool-focused tests
 * that depend on that fixture's exact shape.
 *
 * Run: node fixture-resource-server.ts
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer(
  { name: 'fixture-resource-server', version: '1.0.0' },
  { capabilities: { resources: {} } },
)

server.registerResource(
  'greeting',
  'fixture://greeting.txt',
  { title: 'Greeting', description: 'A plain-text greeting resource.', mimeType: 'text/plain' },
  async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'Hello from the fixture resource server.' }],
  }),
)

server.registerResource(
  'notes',
  'fixture://notes.md',
  { title: 'Notes', description: 'A second resource, to exercise listing more than one.', mimeType: 'text/markdown' },
  async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Notes\n\nSome fixture content.' }],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
