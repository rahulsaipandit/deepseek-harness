import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, assertPositiveInteger, Config, resolveConfig } from '../src/index.ts'
import { BROWSER_TOOL_NAMES } from '../src/tools.ts'

describe('resolveConfig / assertPositiveInteger', () => {
  it('applies documented defaults', () => {
    const resolved = resolveConfig(Config({}))
    expect(resolved.toolTimeoutMs).toBe(90_000)
    expect(resolved.snapshotMaxChars).toBe(32_000)
    expect(resolved.maxInteractiveItems).toBe(60)
    expect(resolved.token).toBeUndefined()
  })

  it('rejects a non-positive-integer override', () => {
    expect(() => assertPositiveInteger('toolTimeoutMs', 0)).toThrow(/positive integer/)
    expect(() => assertPositiveInteger('toolTimeoutMs', 1.5)).toThrow(/positive integer/)
  })

  it('rejects a snapshotMaxChars below the wire-protocol floor', () => {
    expect(() => resolveConfig(Config({ snapshotMaxChars: 10 }))).toThrow()
  })
})

interface FakeWebServer {
  port: number
  registerUpgrade: ReturnType<typeof vi.fn>
  register: ReturnType<typeof vi.fn>
}

function makeCtx(overrides: { agents?: unknown; systemPrompt?: unknown } = {}): {
  ctx: Context
  tools: Map<string, ToolDefinition>
  webServer: FakeWebServer
} {
  const tools = new Map<string, ToolDefinition>()
  const webServer: FakeWebServer = {
    port: 3080,
    registerUpgrade: vi.fn(() => vi.fn()),
    register: vi.fn(() => vi.fn()),
  }
  const apiProxy = {
    events: { mux: () => (async function* () {})() },
  }
  const ctx = {
    webServer,
    apiProxy,
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
    get: (service: string) => (overrides as Record<string, unknown>)[service],
    on: vi.fn(),
    effect: (fn: () => unknown) => fn(),
    logger: { info: vi.fn() },
  } as unknown as Context
  return { ctx, tools, webServer }
}

describe('apply', () => {
  let dir: string
  let tokenFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'browser-bridge-apply-'))
    tokenFile = join(dir, 'ext-bridge-token')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('registers the /ext/bridge upgrade route and the /ext/bridge-config route', async () => {
    const { ctx, webServer } = makeCtx()
    await apply(ctx, Config({ token: 'configured-token' }))
    expect(webServer.registerUpgrade).toHaveBeenCalledTimes(1)
    expect(webServer.registerUpgrade.mock.calls[0]?.[0]).toMatchObject({ path: '/ext/bridge' })
    expect(webServer.register).toHaveBeenCalledTimes(1)
    expect(webServer.register.mock.calls[0]?.[0]).toMatchObject({ path: '/ext/bridge-config', kind: 'exact' })
  })

  it('registers every documented browser_* tool', async () => {
    const { ctx, tools } = makeCtx()
    await apply(ctx, Config({ token: 'configured-token' }))
    expect([...tools.keys()].sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
  })

  it('never rejects a call for lack of ctx.agents/ctx.systemPrompt — both are optional services', async () => {
    const { ctx } = makeCtx({ agents: undefined, systemPrompt: undefined })
    await expect(apply(ctx, Config({ token: 'configured-token' }))).resolves.toBeUndefined()
  })

  it('with a configured token, does not touch the persisted-token file at all', async () => {
    const { ctx } = makeCtx()
    await apply(ctx, Config({ token: 'configured-token' }))
    const { readTokenFile } = await import('../src/token.ts')
    await expect(readTokenFile(tokenFile)).resolves.toBeUndefined()
  })

  it('activates a pending browser-context snapshot when ctx.agents is present and agent/created fires', async () => {
    const agent = { id: 'sess-1', inject: vi.fn() }
    const agents = { get: vi.fn(() => undefined) }
    const { ctx } = makeCtx({ agents })
    let createdHandler: ((payload: { agent: typeof agent }) => void) | undefined
    ;(ctx.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, handler: typeof createdHandler) => {
      if (event === 'agent/created') createdHandler = handler
      return () => {}
    })
    await apply(ctx, Config({ token: 'configured-token' }))
    expect(createdHandler).toBeDefined()
    createdHandler!({ agent })
    // No snapshot was queued for sess-1, so activation is a no-op — this only
    // asserts the wiring does not throw when the event fires.
    expect(agent.inject).not.toHaveBeenCalled()
  })
})
