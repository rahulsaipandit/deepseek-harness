import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { BROWSER_TOOL_NAMES, registerBrowserTools } from '../src/tools.ts'
import type { BridgeServer } from '../src/server.ts'

function makeCtx(): { ctx: Context; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register: (tool: ToolDefinition) => {
        tools.set(tool.name, tool)
        return () => { tools.delete(tool.name) }
      },
    },
  } as unknown as Context
  return { ctx, tools }
}

function fakeBridge(requestTool: BridgeServer['requestTool']): BridgeServer {
  return { requestTool } as unknown as BridgeServer
}

function execFor(agentId?: string): Parameters<ToolDefinition['execute']>[1] {
  return {
    agent: agentId === undefined ? undefined : { id: agentId },
    signal: new AbortController().signal,
  } as unknown as Parameters<ToolDefinition['execute']>[1]
}

const OPTIONS = { toolTimeoutMs: 90_000, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

describe('registerBrowserTools', () => {
  it('registers exactly the documented browser_* tool set', () => {
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(vi.fn()), OPTIONS)
    expect([...tools.keys()].sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
  })

  it('returns one disposer per tool that removes it from the registry', () => {
    const { ctx, tools } = makeCtx()
    const disposers = registerBrowserTools(ctx, fakeBridge(vi.fn()), OPTIONS)
    expect(disposers.size).toBe(BROWSER_TOOL_NAMES.length)
    disposers.get('browser_snapshot')!()
    expect(tools.has('browser_snapshot')).toBe(false)
  })

  it('browser_snapshot forwards the calling agent id as the bridge sessionId', async () => {
    const requestTool = vi.fn(async () => ({ text: 'a snapshot' }))
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(requestTool), OPTIONS)
    await tools.get('browser_snapshot')!.execute({}, execFor('session-42'))
    expect(requestTool).toHaveBeenCalledWith('browser_snapshot', {}, expect.anything(), OPTIONS.toolTimeoutMs, 'session-42')
  })

  it('omits the sessionId argument when no agent is present on the execution', async () => {
    const requestTool = vi.fn(async () => ({ text: 'a snapshot' }))
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(requestTool), OPTIONS)
    await tools.get('browser_snapshot')!.execute({}, execFor(undefined))
    expect(requestTool).toHaveBeenCalledWith('browser_snapshot', {}, expect.anything(), OPTIONS.toolTimeoutMs)
  })

  it('browser_navigate forwards the url argument unchanged', async () => {
    const requestTool = vi.fn(async () => ({ text: 'ok' }))
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(requestTool), OPTIONS)
    await tools.get('browser_navigate')!.execute({ url: 'https://example.com/' }, execFor('s1'))
    expect(requestTool).toHaveBeenCalledWith('browser_navigate', { url: 'https://example.com/' }, expect.anything(), OPTIONS.toolTimeoutMs, 's1')
  })

  it('normalizes a non-text extension result into a diagnostic text payload instead of throwing', async () => {
    const requestTool = vi.fn(async () => ({ somethingElse: true }))
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(requestTool), OPTIONS)
    const result = await tools.get('browser_click')!.execute({ index: 1 }, execFor('s1'))
    expect((result as { text: string }).text).toMatch(/returned no text/)
  })

  it('a bridge rejection (e.g. no extension connected) propagates as the execute() rejection', async () => {
    const requestTool = vi.fn(async () => { throw new Error('no browser extension is connected to the bridge') })
    const { ctx, tools } = makeCtx()
    registerBrowserTools(ctx, fakeBridge(requestTool), OPTIONS)
    await expect(tools.get('browser_reload')!.execute({}, execFor('s1'))).rejects.toThrow(/no browser extension is connected/)
  })
})
