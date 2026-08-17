import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

/** Minimal fake `ctx` covering only what `apply()` touches: `ctx.tools.register` and the optional `ctx.get('credentials')`. */
function makeCtx(): { ctx: Context; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } },
    get: (_service: string) => undefined,
  } as unknown as Context
  return { ctx, tools }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function execFor(cwd: string) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]
}

describe('apply', () => {
  it('rejects a non-https registryUrl at load time, before registering any tool', () => {
    const { ctx, tools } = makeCtx()
    expect(() => apply(ctx, Config({ registryUrl: 'http://registry.example' }))).toThrow(/non-https/)
    expect(tools.size).toBe(0)
  })

  it('registers exactly the four documented tools', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))
    expect([...tools.keys()].sort()).toEqual(['skillhub_install', 'skillhub_list', 'skillhub_search', 'skillhub_uninstall'])
  })
})

describe('skillhub_search execute', () => {
  it('rejects an empty query without making a request', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tools.get('skillhub_search')!.execute({ query: '  ' }, execFor(process.cwd()))).rejects.toThrow(/1-200 characters/)
    expect(fetchImpl).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('calls only the configured registry origin', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchImpl)
    await tools.get('skillhub_search')!.execute({ query: 'notes' }, execFor(process.cwd()))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/^https:\/\/registry\.example\//)
    vi.unstubAllGlobals()
  })
})

describe('skillhub_install / skillhub_list / skillhub_uninstall lifecycle', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'skillhub-index-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(cwd, { recursive: true, force: true })
  })

  it('installs into .dsh/skills, lists it, then uninstalls it', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      name: 'demo-skill',
      version: '1.0.0',
      description: 'demo',
      category: 'demo',
      files: [{ path: 'SKILL.md', content: '# Demo' }],
    })))

    const installed = await tools.get('skillhub_install')!.execute({ name: 'demo-skill' }, execFor(cwd))
    expect(installed).toEqual({ name: 'demo-skill', version: '1.0.0', files: ['SKILL.md'] })
    expect(await readFile(join(cwd, '.dsh', 'skills', 'demo-skill', 'SKILL.md'), 'utf8')).toBe('# Demo')

    const listed = await tools.get('skillhub_list')!.execute({}, execFor(cwd))
    expect(listed.skills).toEqual([{ name: 'demo-skill', version: '1.0.0', installedAt: expect.any(Number), fileCount: 1, present: true }])

    const uninstalled = await tools.get('skillhub_uninstall')!.execute({ name: 'demo-skill' }, execFor(cwd))
    expect(uninstalled).toEqual({ name: 'demo-skill', removedFiles: ['SKILL.md'] })

    const listedAfter = await tools.get('skillhub_list')!.execute({}, execFor(cwd))
    expect(listedAfter.skills).toEqual([])
  })

  it('rejects installing a non-kebab-case name before any request is made', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    await expect(tools.get('skillhub_install')!.execute({ name: '../escape' }, execFor(cwd))).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses to uninstall a skill it never installed', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ registryUrl: 'https://registry.example' }))
    await expect(tools.get('skillhub_uninstall')!.execute({ name: 'never-installed' }, execFor(cwd))).rejects.toThrow(/refusing to remove/)
  })
})
