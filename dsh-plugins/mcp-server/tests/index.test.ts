import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

/** Records every `ctx.tools.execute()` call and returns a scripted result. */
function makeFakeTools(executeResult: ToolExecutionResult) {
  const calls: ToolExecutionInput[] = []
  return {
    calls,
    get: vi.fn((name: string): ToolDefinition | undefined => (
      name === 'memory_recall'
        ? { name, description: 'Search the knowledge hub.', parameters: {}, output: { schema: {}, render: () => [] } } as unknown as ToolDefinition
        : undefined
    )),
    execute: vi.fn(async (input: ToolExecutionInput) => {
      calls.push(input)
      return executeResult
    }),
  }
}

function makeCtx(tools: ReturnType<typeof makeFakeTools>) {
  let capturedRoute: WebRoute | undefined
  const ctx = {
    tools,
    webServer: {
      register: (route: WebRoute) => {
        capturedRoute = route
        return () => {}
      },
    },
    effect: (fn: () => unknown) => fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as Context
  return { ctx, getRoute: () => capturedRoute }
}

describe('apply — registration and safety checks', () => {
  it('throws when allowedTools is empty', async () => {
    const tools = makeFakeTools({ isError: false, content: [] } as unknown as ToolExecutionResult)
    const { ctx } = makeCtx(tools)
    await expect(apply(ctx, Config({ allowedTools: [], token: 'x' }))).rejects.toThrow(/allowedTools/)
  })

  it('throws when none of the configured tools resolve or have a known schema', async () => {
    const tools = makeFakeTools({ isError: false, content: [] } as unknown as ToolExecutionResult)
    const { ctx } = makeCtx(tools)
    await expect(apply(ctx, Config({ allowedTools: ['not_a_real_tool'], token: 'x' }))).rejects.toThrow(/no tool in allowedTools/)
  })

  it('skips (with a warning) a configured tool that has a schema but is not actually registered in ctx.tools', async () => {
    const tools = makeFakeTools({ isError: false, content: [] } as unknown as ToolExecutionResult)
    const { ctx } = makeCtx(tools)
    // memory_remember has a known schema but this fake ctx.tools only resolves memory_recall.
    await apply(ctx, Config({ allowedTools: ['memory_remember', 'memory_recall'], token: 'x' }))
    expect(tools.get).toHaveBeenCalledWith('memory_remember')
  })

  it('registers the route at the configured path', async () => {
    const tools = makeFakeTools({ isError: false, content: [] } as unknown as ToolExecutionResult)
    const { ctx, getRoute } = makeCtx(tools)
    await apply(ctx, Config({ allowedTools: ['memory_recall'], token: 'x', path: '/custom-mcp' }))
    expect(getRoute()?.path).toBe('/custom-mcp')
    expect(getRoute()?.kind).toBe('exact')
  })
})

describe('apply — live HTTP behavior', () => {
  let server: Server
  let baseUrl: string
  let getRoute: () => WebRoute | undefined
  let toolsFake: ReturnType<typeof makeFakeTools>

  async function startServerWithRoute(config: Parameters<typeof Config>[0]) {
    toolsFake = makeFakeTools({ isError: false, content: [{ type: 'text', text: 'found: dark mode' }] } as unknown as ToolExecutionResult)
    const made = makeCtx(toolsFake)
    await apply(made.ctx, Config(config))
    getRoute = made.getRoute
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const route = getRoute()
      if (!route) { res.writeHead(500).end(); return }
      void route.handler(req, res)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('a loopback caller with no token can complete a real MCP tool call end-to-end', async () => {
    await startServerWithRoute({ allowedTools: ['memory_recall'], token: 'unused-since-loopback' })

    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`))
    await client.connect(transport)

    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toEqual(['memory_recall'])

    const result = await client.callTool({ name: 'memory_recall', arguments: { query: 'theme preference' } })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'found: dark mode' }])
    expect(toolsFake.calls[0]?.name).toBe('memory_recall')
    expect(toolsFake.calls[0]?.arguments).toEqual({ query: 'theme preference' })

    await client.close()
  })

  it('rejects a non-loopback caller with no bearer token', async () => {
    await startServerWithRoute({ allowedTools: ['memory_recall'], token: 'the-real-token' })
    const route = getRoute()
    expect(route).toBeDefined()

    const fakeReq = {
      headers: {},
      method: 'POST',
      socket: { remoteAddress: '203.0.113.5' },
    } as unknown as IncomingMessage
    const chunks: string[] = []
    const fakeRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn((body?: string) => { if (body) chunks.push(body) }),
    } as unknown as ServerResponse

    await route!.handler(fakeReq, fakeRes)

    expect(fakeRes.writeHead).toHaveBeenCalledWith(401, expect.anything())
  })

  it('accepts a non-loopback caller presenting the correct bearer token', async () => {
    await startServerWithRoute({ allowedTools: ['memory_recall'], token: 'the-real-token' })
    const route = getRoute()

    const fakeReq = {
      headers: { authorization: 'Bearer the-real-token' },
      method: 'POST',
      socket: { remoteAddress: '203.0.113.5' },
      on: vi.fn(),
    } as unknown as IncomingMessage
    const fakeRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as ServerResponse

    await route!.handler(fakeReq, fakeRes)

    // Reaching the transport (rather than a 401) is what we're checking —
    // the transport itself will separately reject this as a malformed
    // request body, which is fine; the point is auth didn't block it.
    expect(fakeRes.writeHead).not.toHaveBeenCalledWith(401, expect.anything())
  })

  it('rate-limits a non-loopback caller past the configured request budget', async () => {
    await startServerWithRoute({ allowedTools: ['memory_recall'], token: 'the-real-token', rateLimit: 1, rateLimitWindowMs: 60_000 })
    const route = getRoute()

    function makeReqRes() {
      const req = {
        headers: { authorization: 'Bearer the-real-token' },
        method: 'POST',
        socket: { remoteAddress: '203.0.113.9' },
        on: vi.fn(),
      } as unknown as IncomingMessage
      const res = {
        setHeader: vi.fn(),
        writeHead: vi.fn().mockReturnThis(),
        end: vi.fn(),
      } as unknown as ServerResponse
      return { req, res }
    }

    const first = makeReqRes()
    await route!.handler(first.req, first.res)
    expect(first.res.writeHead).not.toHaveBeenCalledWith(429, expect.anything())

    const second = makeReqRes()
    await route!.handler(second.req, second.res)
    expect(second.res.writeHead).toHaveBeenCalledWith(429, expect.anything())
  })

  it('responds to a CORS preflight OPTIONS request for an allowed origin', async () => {
    await startServerWithRoute({ allowedTools: ['memory_recall'], token: 'the-real-token', corsOrigins: ['https://example.com'] })
    const route = getRoute()

    const fakeReq = {
      headers: { origin: 'https://example.com' },
      method: 'OPTIONS',
      socket: { remoteAddress: '203.0.113.5' },
    } as unknown as IncomingMessage
    const fakeRes = {
      setHeader: vi.fn(),
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    } as unknown as ServerResponse

    await route!.handler(fakeReq, fakeRes)

    expect(fakeRes.setHeader).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'https://example.com')
    expect(fakeRes.writeHead).toHaveBeenCalledWith(204)
  })
})
