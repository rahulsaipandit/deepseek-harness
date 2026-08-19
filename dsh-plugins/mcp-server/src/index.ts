/**
 * Exposes a configurable allowlist of `ctx.tools` — by default,
 * `dsh-plugin-knowledge-hub`'s five memory tools — as an authenticated MCP
 * Streamable HTTP server, so an external app (e.g. Pluely) can call into
 * this DSH instance's memory/recall surface. Deliberately scoped to
 * *existing* tools only: no synthesis, no query-time knowledge-graph
 * traversal, no knowledge-gap analysis. See
 * designCognitiveBrainForDSH.md's MCP server section for why those were
 * excluded, and its "external MCP consumption" section for the companion
 * direction — DSH *consuming* an external server's tools/resources, which
 * is a separate concern from this one (DSH being called INTO).
 *
 * Transport/security posture mirrors what GBrain documents for its own MCP
 * HTTP surface (bearer-token auth, IP- and token-based rate limiting,
 * local-vs-remote trust boundary) — infrastructure, not capability, so
 * adopting the pattern doesn't reopen the capability-scope question.
 * @module dsh-plugin-mcp-server
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ipKey, RateLimiter, tokenKey } from './rate-limit.ts'
import { DEFAULT_ALLOWED_TOOLS, KNOWN_TOOL_SCHEMAS, toMcpOutcome } from './tool-bridge.ts'
import { resolveToken, verifyToken } from './token.ts'

/**
 * Stateful mode (the SDK default): one shared `StreamableHTTPServerTransport`
 * tracks the initialize handshake and every subsequent tool call across
 * requests via a server-issued session id. This DSH process is long-running,
 * not a serverless function, so there's a real process to hold that state in
 * — stateless mode (`sessionIdGenerator: undefined`) was tried first and
 * confirmed broken for this shape of server: it can't correlate the client's
 * `initialize` request with its follow-up `notifications/initialized` on the
 * same transport instance, since stateless mode is designed for a fresh
 * transport per request, not one long-lived instance answering a real
 * client's multi-request handshake.
 */
function transportOptions(): ConstructorParameters<typeof StreamableHTTPServerTransport>[0] {
  return { sessionIdGenerator: randomUUID }
}

export const name = 'mcp-server'
export const inject = ['webServer', 'tools']

export const Config = z.object({
  /** HTTP path this server is served under. */
  path: z.string().default('/mcp'),
  /** Bearer token clients must present. Explicit config wins; otherwise persisted/generated under $DSH_HOME. */
  token: z.string().default(''),
  /** Tool names to expose. Only names with a hand-written schema in tool-bridge.ts are actually registered; others are skipped with a warning. */
  allowedTools: z.array(z.string()).default([...DEFAULT_ALLOWED_TOOLS]),
  /** Requests allowed per window, per client (IP or token). */
  rateLimit: z.number().default(60),
  /** Rate-limit window, in milliseconds. */
  rateLimitWindowMs: z.number().default(60_000),
  /** Origins allowed to make cross-origin requests (CORS). Empty means no CORS headers are sent (same-origin/non-browser callers only). */
  corsOrigins: z.array(z.string()).default([]),
})

export type Config = Schemastery.TypeT<typeof Config>

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Register the MCP server route. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.allowedTools.length === 0) {
    throw new Error('mcp-server: allowedTools must not be empty')
  }

  const resolved = await resolveToken(config.token.length > 0 ? config.token : undefined)
  if (resolved.generated) {
    ctx.logger?.info?.(`mcp-server: generated a new bearer token, persisted at ${resolved.file}`)
  }

  const mcp = new McpServer(
    { name: 'dsh-knowledge-hub', version: '1.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  )

  const registered: string[] = []
  for (const toolName of config.allowedTools) {
    const schema = KNOWN_TOOL_SCHEMAS[toolName]
    if (!schema) {
      ctx.logger?.warn?.(`mcp-server: "${toolName}" has no known input schema and was not exposed — only tool names with a hand-written schema in tool-bridge.ts can be registered`)
      continue
    }
    const definition = ctx.tools.get(toolName)
    if (!definition) {
      ctx.logger?.warn?.(`mcp-server: "${toolName}" is not a registered ctx.tools entry and was not exposed`)
      continue
    }
    mcp.registerTool(toolName, { title: toolName, description: definition.description, inputSchema: schema }, async (args: Record<string, unknown>) => {
      const input: ToolExecutionInput = { callId: CallId(randomUUID()), name: toolName, arguments: args, signal: new AbortController().signal }
      const result = await ctx.tools.execute(input)
      return toMcpOutcome(result)
    })
    registered.push(toolName)
  }
  if (registered.length === 0) {
    throw new Error('mcp-server: no tool in allowedTools could be exposed (see warnings above) — refusing to start a server with nothing to serve')
  }

  const transport = new StreamableHTTPServerTransport(transportOptions())
  // Same exactOptionalPropertyTypes friction as above, this time on the SDK's
  // own `Transport` interface (`onclose?: (() => void) | undefined` vs. the
  // concrete class's `(() => void) | undefined` accessor) — connect() only
  // needs the object's shape at runtime, so the cast is safe.
  await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0])

  const rateLimiter = new RateLimiter({ limit: config.rateLimit, windowMs: config.rateLimitWindowMs })
  ctx.effect(() => {
    const pruneTimer = setInterval(() => rateLimiter.prune(), config.rateLimitWindowMs)
    pruneTimer.unref?.()
    return () => clearInterval(pruneTimer)
  }, 'mcp-server: rate-limit prune timer')

  const route: WebRoute = {
    kind: 'exact',
    path: config.path,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const origin = req.headers.origin
      if (origin && (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }

      // Local CLI-equivalent (loopback) callers can be treated as trusted the
      // same way skillhub/browser-bridge already do for local-only surfaces;
      // every other caller — this route's actual purpose — must present the
      // bearer token. GBrain's documented trust boundary (local vs. `remote`)
      // is the same shape: tighter checks once a caller isn't provably local.
      const remoteAddress = req.socket.remoteAddress
      const authHeader = req.headers.authorization
      const presentedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined
      const authenticated = isLoopback(remoteAddress) || (presentedToken !== undefined && verifyToken(resolved.token, presentedToken))
      if (!authenticated) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      const ipLimit = rateLimiter.consume(ipKey(remoteAddress ?? 'unknown'))
      const tokenLimit = presentedToken ? rateLimiter.consume(tokenKey(presentedToken)) : { allowed: true }
      if (!ipLimit.allowed || !tokenLimit.allowed) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(Math.ceil(config.rateLimitWindowMs / 1000)) })
          .end(JSON.stringify({ error: 'rate limited' }))
        return
      }

      await transport.handleRequest(req, res)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'mcp-server: route')
}
