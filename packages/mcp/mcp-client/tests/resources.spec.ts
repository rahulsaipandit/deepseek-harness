/**
 * End-to-end tests for the on-demand resources bridge (resources.ts):
 * `mcp__<serverName>__list_resources`/`read_resource` registered against a
 * real MCP server over stdio, plus capability-gating against a server that
 * declares no `resources` capability at all (the existing tools-only
 * fixture).
 */

import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const testToolSignal = new AbortController().signal
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const resourceFixturePath = fileURLToPath(new URL('./fixture-resource-server.ts', import.meta.url))
const toolOnlyFixturePath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

function sleep(ms: number): Promise<void> {
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

let callSeq = 0
function nextCallId(): ToolCallId {
  return ToolCallId(`resources-e2e-${++callSeq}`)
}

describe('resources bridge — server that supports resources', () => {
  let ctx: Context

  const config: Config = {
    transport: 'stdio',
    serverName: 'fixture-res',
    command: process.execPath,
    args: [resourceFixturePath],
    env: {},
    cwd: packageDir,
    toolCallTimeoutMs: 15_000,
    failOnStartupError: false,
  }

  beforeAll(async () => {
    ctx = await mountRegistry()
    await apply(ctx, config)
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(200)
  })

  it('registers list_resources and read_resource under the server namespace', () => {
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('mcp__fixture-res__list_resources')
    expect(names).toContain('mcp__fixture-res__read_resource')
  })

  it('list_resources enumerates both fixture resources', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name: 'mcp__fixture-res__list_resources',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    const text = (result.content[0] as { text: string }).text
    expect(text).toContain('fixture://greeting.txt')
    expect(text).toContain('fixture://notes.md')
  })

  it('read_resource returns the text content of a valid URI', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name: 'mcp__fixture-res__read_resource',
      arguments: { uri: 'fixture://greeting.txt' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello from the fixture resource server.' })
  })

  it('read_resource on the second resource returns its own distinct content', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name: 'mcp__fixture-res__read_resource',
      arguments: { uri: 'fixture://notes.md' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '# Notes\n\nSome fixture content.' })
  })

  it('read_resource on an unknown URI produces an isError result, not a crash', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name: 'mcp__fixture-res__read_resource',
      arguments: { uri: 'fixture://does-not-exist.txt' },
    })
    expect(result.isError).toBe(true)
  })

  it('read_resource requires a uri argument', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(),
      name: 'mcp__fixture-res__read_resource',
      arguments: {},
    })
    expect(result.isError).toBe(true)
  })
})

describe('resources bridge — server with no resources capability', () => {
  let ctx: Context

  const config: Config = {
    transport: 'stdio',
    serverName: 'fixture-no-res',
    command: process.execPath,
    args: [toolOnlyFixturePath],
    env: {},
    cwd: packageDir,
    toolCallTimeoutMs: 15_000,
    failOnStartupError: false,
  }

  beforeAll(async () => {
    ctx = await mountRegistry()
    await apply(ctx, config)
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(200)
  })

  it('does not register list_resources or read_resource for a server with no resources capability', () => {
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).not.toContain('mcp__fixture-no-res__list_resources')
    expect(names).not.toContain('mcp__fixture-no-res__read_resource')
    // Sanity: the server's real tools are still there — gating is specific to resources.
    expect(names).toContain('mcp__fixture-no-res__add')
  })
})
