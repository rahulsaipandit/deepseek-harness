import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, Config } from '../src/index.ts'

/** Minimal fake `ctx` covering only what `apply()` touches: `ctx.tools.register` and an optional logger. */
function makeCtx(): { ctx: Context; tools: Map<string, ToolDefinition> } {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } },
    logger: { warn: () => {}, info: () => {} },
  } as unknown as Context
  return { ctx, tools }
}

/** Fake `ctx` with `llm` + `webServer` + `get`/`effect`, for enableConceptGraph tests. `conceptsPerNote` controls the fake LLM's JSON response, one call per note. */
function makeConceptGraphCtx(conceptsPerNote: string[][]): { ctx: Context; tools: Map<string, ToolDefinition>; dataRouteHandler: () => Promise<unknown> } {
  const tools = new Map<string, ToolDefinition>()
  let call = 0
  let dataHandler: ((req: unknown, res: { writeHead: (code: number) => void; end: (body: string) => void }) => Promise<void>) | undefined

  async function * fakeStream(): AsyncIterable<StreamChunk> {
    const concepts = conceptsPerNote[call] ?? []
    call += 1
    const text = JSON.stringify({ chunks: [{ concepts }] })
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const ctx = {
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool) } },
    logger: { warn: () => {}, info: () => {} },
    effect: (execute: () => unknown) => { execute() },
    get: (service: string) => {
      if (service === 'llm') return { stream: fakeStream, listProviders: () => [{ id: 'test-provider', name: 'Test' }] }
      if (service === 'webServer') {
        return {
          host: '127.0.0.1',
          port: 4321,
          register: (route: { path: string; handler: typeof dataHandler }) => {
            if (route.path.endsWith('data.json')) dataHandler = route.handler as typeof dataHandler
            return () => {}
          },
        }
      }
      return undefined
    },
  } as unknown as Context

  return {
    ctx,
    tools,
    dataRouteHandler: async () => {
      let body = ''
      await dataHandler?.({}, { writeHead: () => {}, end: (text: string) => { body = text } })
      return JSON.parse(body)
    },
  }
}

function exec() {
  return { agent: undefined, signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]
}

describe('apply', () => {
  let vaultPath: string

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'knowledge-hub-plugin-'))
  })

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true })
  })

  it('rejects an empty vaultPath at load time, before registering any tool', () => {
    const { ctx, tools } = makeCtx()
    expect(() => apply(ctx, Config({ vaultPath: '  ' }))).toThrow(/vaultPath/)
    expect(tools.size).toBe(0)
  })

  it('registers exactly the five documented tools', () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))
    expect([...tools.keys()].sort()).toEqual([
      'memory_audit',
      'memory_list',
      'memory_recall',
      'memory_related',
      'memory_remember',
    ])
  })

  it('memory_remember writes a file, indexes it, and logs an audit event; memory_recall then finds it', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))

    const remembered = await tools.get('memory_remember')!.execute(
      { title: 'Editor preference', content: 'Rahul prefers dark-mode editors and switches themes immediately.', tags: ['preferences'] },
      exec(),
    )
    expect(remembered.id).toMatch(/^mem_/)

    const audited = await tools.get('memory_audit')!.execute({ entryId: remembered.id }, exec())
    expect(audited.events).toHaveLength(1)
    expect(audited.events[0]?.operation).toBe('create')

    const recalled = await tools.get('memory_recall')!.execute({ query: 'dark-mode editors' }, exec())
    expect(recalled.results.map((r: { id: string }) => r.id)).toContain(remembered.id)
  })

  it('memory_list filters by tags and orders newest first', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))

    await tools.get('memory_remember')!.execute({ title: 'First', content: 'first content', tags: ['x'] }, exec())
    await tools.get('memory_remember')!.execute({ title: 'Second', content: 'second content', tags: ['x', 'y'] }, exec())

    const onlyY = await tools.get('memory_list')!.execute({ tags: ['y'] }, exec())
    expect(onlyY.items).toHaveLength(1)
    expect(onlyY.items[0]?.title).toBe('Second')

    const all = await tools.get('memory_list')!.execute({ tags: ['x'] }, exec())
    expect(all.items.map((i: { title: string }) => i.title)).toEqual(['Second', 'First'])
  })

  it('memory_related finds another memory by content similarity, excluding itself', async () => {
    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))

    const a = await tools.get('memory_remember')!.execute(
      { title: 'Dark editors', content: 'Rahul prefers dark-mode editors for everything.' },
      exec(),
    )
    await tools.get('memory_remember')!.execute(
      { title: 'Unrelated', content: 'The weather in Bangalore was pleasant today.' },
      exec(),
    )

    const related = await tools.get('memory_related')!.execute({ id: a.id }, exec())
    expect(related.results.every((r: { id: string }) => r.id !== a.id)).toBe(true)
  })

  it('startup rescan finds hand-written markdown files that were never created via memory_remember', async () => {
    await writeFile(
      join(vaultPath, 'hand.md'),
      '---\nid: hand\ntitle: Hand-written note\ntype: note\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\nWritten directly to disk before the plugin ever started.\n',
      'utf8',
    )

    const { ctx, tools } = makeCtx()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))

    const recalled = await tools.get('memory_recall')!.execute({ query: 'written directly to disk' }, exec())
    expect(recalled.results.map((r: { id: string }) => r.id)).toContain('hand')
  })
})

describe('apply with enableConceptGraph', () => {
  let vaultPath: string

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'knowledge-hub-concept-graph-plugin-'))
  })

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true })
  })

  it('throws at load time when enabled without conceptGraphModel configured', () => {
    const { ctx } = makeConceptGraphCtx([])
    expect(() => apply(ctx, Config({ vaultPath, enableEmbeddings: false, enableConceptGraph: true }))).toThrow(/conceptGraphModel/)
  })

  it('memory_remember extracts concepts for a new note, merges them into the graph, and returns the graph URL', async () => {
    const { ctx, tools, dataRouteHandler } = makeConceptGraphCtx([['dark-mode editors', 'personal preferences']])
    apply(ctx, Config({ vaultPath, enableEmbeddings: false, enableConceptGraph: true, conceptGraphModel: 'test-model' }))

    const remembered = await tools.get('memory_remember')!.execute(
      { title: 'Editor preference', content: 'Rahul prefers dark-mode editors.' },
      exec(),
    )
    expect(remembered.conceptGraphUrl).toBe('http://127.0.0.1:4321/knowledge-hub/concept-graph')

    const graph = await dataRouteHandler() as { nodes: { label: string }[] }
    expect(graph.nodes.map(n => n.label).sort()).toEqual(['Editor preference', 'dark-mode editors', 'personal preferences'].sort())
  })

  it('a second memory_remember incrementally adds to the same graph without re-processing the first note', async () => {
    const { ctx, tools, dataRouteHandler } = makeConceptGraphCtx([
      ['first concept'],
      ['second concept'],
    ])
    apply(ctx, Config({ vaultPath, enableEmbeddings: false, enableConceptGraph: true, conceptGraphModel: 'test-model' }))

    await tools.get('memory_remember')!.execute({ title: 'Note One', content: 'About the first concept.' }, exec())
    await tools.get('memory_remember')!.execute({ title: 'Note Two', content: 'About the second concept.' }, exec())

    const graph = await dataRouteHandler() as { nodes: { label: string }[] }
    const labels = graph.nodes.map(n => n.label)
    expect(labels).toContain('first concept')
    expect(labels).toContain('second concept')
  })

  it('persists the graph to .concept-graph.json in the vault', async () => {
    const { ctx, tools } = makeConceptGraphCtx([['some concept']])
    apply(ctx, Config({ vaultPath, enableEmbeddings: false, enableConceptGraph: true, conceptGraphModel: 'test-model' }))
    await tools.get('memory_remember')!.execute({ title: 'A note', content: 'Content about some concept.' }, exec())

    const raw = await readFile(join(vaultPath, '.concept-graph.json'), 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.nodes.length).toBeGreaterThan(0)
  })
})
