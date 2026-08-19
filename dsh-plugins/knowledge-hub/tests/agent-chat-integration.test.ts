/**
 * End-to-end integration tests for the knowledge-hub plugin as an AI
 * agent/chat session would actually use it: a real Cordis `Context` +
 * real `ToolRuntime`, dispatched through `ctx.tools.execute()` (the genuine
 * agent-facing call path — schema validation, `presentCall`, concurrency
 * safety — not `ToolDefinition.execute()` called directly, which every other
 * test file in this package uses for speed/isolation).
 *
 * Three scenarios, each a stand-in for a real chat/agent capability:
 *  1. Memory + RAG — a multi-turn conversation where facts told to the
 *     assistant in early turns are recalled, browsed, and audited in later
 *     turns via hybrid (BM25) search, with a contradiction surfaced back to
 *     the agent to relay to the user; a "no bleed" negative case (stored
 *     context must not leak into an unrelated query); and a progressive
 *     multi-turn buildup case (a synthesis question surfaces several earlier
 *     turns' notes, not just the latest one) — the latter two adapted from
 *     `docs/packages/tests/testMemoryGoals.md`'s Playwright-driven behavioral
 *     test plan for a different (LLM-holds-the-conversation) chat product;
 *     see the comment above those two tests for what carried over as-is vs.
 *     what had to change for a tool-call-driven architecture.
 *  2. Semantic augmentation — real local embeddings (`@xenova/transformers`,
 *     network permitting) proving hybrid search finds a paraphrased,
 *     keyword-disjoint query that BM25-only search misses entirely, and that
 *     `memory_related` surfaces a semantically-similar note over an
 *     unrelated one with no shared vocabulary. Skips itself (not a failure)
 *     when the model can't be loaded, matching the plugin's own
 *     graceful-degradation design — see `src/embedding.ts`.
 *  3. Concept graph — an opt-in, LLM-extracted graph (fake `ctx.llm`, no
 *     network) that lets an agent tell a user how two notes it wrote in
 *     different turns relate, via the URL `memory_remember` hands back.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply, Config } from '../src/index.ts'
import { createLocalEmbeddingFunction } from '../src/embedding.ts'

const testSignal = new AbortController().signal
let callSeq = 0
function nextCallId(): CallId {
  return CallId(`agent-chat-integration-${++callSeq}`)
}

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Drives a tool exactly the way an agent loop would: through the registry's real dispatch path, not the bare `ToolDefinition`. */
async function callTool(ctx: Context, name: string, args: unknown): Promise<any> {
  const result = await ctx.tools.execute({ signal: testSignal, callId: nextCallId(), name, arguments: args })
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.error)}`)
  return result.value as any
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(onTimeout) })
  })
}

// Probed once at module load: real network + a loadable model. When either
// is unavailable, the semantic-search suite below skips itself rather than
// failing the whole run — the same graceful degradation `apply()` itself
// falls back to (see src/embedding.ts).
const realEmbeddingFn = await withTimeout(
  createLocalEmbeddingFunction({}, () => {}),
  60_000,
  null,
)

describe('agent chat session — memory + RAG (hybrid search), hermetic', () => {
  let vaultPath: string
  let ctx: Context

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'knowledge-hub-chat-'))
    ctx = await mountRegistry()
    apply(ctx, Config({ vaultPath, enableEmbeddings: false }))
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(vaultPath, { recursive: true, force: true })
  })

  it('offers the model exactly the five documented memory tools', () => {
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toEqual(expect.arrayContaining([
      'memory_remember', 'memory_recall', 'memory_list', 'memory_audit', 'memory_related',
    ]))
  })

  it('a fact told across early turns is recalled, browsed, and audited in a later turn', async () => {
    // Turn 1-3: the user shares context with the assistant over a conversation.
    const editorPref = await callTool(ctx, 'memory_remember', {
      title: 'Editor preference',
      content: 'Rahul prefers dark-mode editors and switches themes within minutes of installing a new tool.',
      tags: ['preferences', 'editor'],
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Timezone',
      content: 'Rahul is based in Bangalore, IST timezone.',
      tags: ['preferences', 'profile'],
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Deploy procedure',
      content: 'To deploy the harness, run the build script then restart the profile.',
      tags: ['procedure'],
      type: 'procedure',
    })

    // Turn 4 (much later): the user asks something that requires recall.
    const recalled = await callTool(ctx, 'memory_recall', { query: 'dark-mode editor theme preference' })
    expect(recalled.results.map((r: { id: string }) => r.id)).toContain(editorPref.id)

    // Turn 5: the user asks the assistant to justify/browse what it remembers.
    const listed = await callTool(ctx, 'memory_list', { tags: ['preferences'] })
    expect(listed.items.map((i: { title: string }) => i.title).sort()).toEqual(['Editor preference', 'Timezone'])

    // Turn 6: the user asks when that was recorded — the audit trail an agent can cite.
    const audited = await callTool(ctx, 'memory_audit', { entryId: editorPref.id })
    expect(audited.events).toHaveLength(1)
    expect(audited.events[0].operation).toBe('create')
    expect(audited.events[0].summary).toContain('Editor preference')
  })

  it('surfaces a possible contradiction to the agent when new info conflicts with an earlier turn', async () => {
    await callTool(ctx, 'memory_remember', {
      title: 'Theme preference',
      content: 'Dark mode is enabled for all editors.',
      tags: ['preferences', 'theme'],
    })

    // A later turn, the user changes their mind — the agent should be told,
    // so it can surface the change to the user rather than silently drift.
    const updated = await callTool(ctx, 'memory_remember', {
      title: 'Theme preference updated',
      content: 'Dark mode is disabled now.',
      tags: ['preferences', 'theme'],
    })

    expect(updated.possibleContradiction).toBeDefined()
    expect(updated.possibleContradiction.title).toBe('Theme preference')
  })

  it('a procedure told in one turn is retrievable as RAG context for answering a how-to question later', async () => {
    await callTool(ctx, 'memory_remember', {
      title: 'Deploy procedure',
      content: 'To deploy the harness, run the build script then restart the profile.',
      type: 'procedure',
      tags: ['ops'],
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Unrelated grocery note',
      content: 'Buy milk and eggs on the way home.',
      tags: ['personal'],
    })

    const recalled = await callTool(ctx, 'memory_recall', { query: 'how do I deploy the harness' })
    expect(recalled.results[0]?.title).toBe('Deploy procedure')
  })

  // The next two tests adapt patterns from docs/packages/tests/testMemoryGoals.md
  // (a Playwright-driven behavioral test plan for a different, chat-UI-based
  // memory+RAG product) to this tool-call-driven architecture. Two patterns
  // from that plan don't yet have an analog here and are worth carrying over:
  //  - the "no bleed" negative case (that doc's RAG-03/CH-04/MC-05): stored
  //    context must not leak into unrelated queries as if it were relevant.
  //  - progressive context buildup across turns (that doc's PERS-02): a later
  //    query drawing on several earlier turns should surface all of them, not
  //    just the most recent one.
  // One adaptation was necessary, not optional: that source plan tests a
  // system where an LLM holds the full conversation and RAG is a supplement,
  // so a content-free follow-up like "given all of this, what should I focus
  // on?" is answerable. Here, memory_recall is a keyword+semantic SEARCH tool
  // with no conversation history of its own — verified directly that such a
  // content-free query fails to surface prior turns at all (lexical search
  // has nothing to match). The realistic analog is a follow-up query that
  // still references the topics from those turns, which is how a tool-calling
  // agent actually re-queries memory in practice.

  it('memory_recall ranks the on-topic note above unrelated stored context for an off-topic query (adapted from "no bleed" tests: RAG-03/CH-04/MC-05)', async () => {
    await callTool(ctx, 'memory_remember', {
      title: 'Job change goal',
      content: "I'm looking for a new VP Engineering role, actively job searching this quarter.",
      tags: ['goals'],
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Engineering org profile',
      content: 'Our engineering org has grown to 40 people and we are Series C stage.',
      tags: ['profile'],
    })
    const hikingNote = await callTool(ctx, 'memory_remember', {
      title: 'Weekend hiking find',
      content: 'Discovered a great half-day hiking trail near Seattle with views of the sound.',
      tags: ['personal'],
    })

    // A query with nothing to do with the job-search/org-profile notes above
    // must not have those notes crowd out the one that's actually on-topic.
    const recalled = await callTool(ctx, 'memory_recall', { query: 'What is a good hiking trail near Seattle for a half-day trip?' })
    expect(recalled.results[0]?.id).toBe(hikingNote.id)
  })

  it('memory_recall surfaces context from multiple earlier turns for a combined follow-up query (adapted from PERS-02 progressive context buildup)', async () => {
    // Turn 1 and turn 2: two separate facts shared earlier in the conversation.
    const turn1 = await callTool(ctx, 'memory_remember', {
      title: 'Stakeholder overload',
      content: 'I manage a large engineering team and feel overwhelmed by all the different stakeholders I have to manage.',
    })
    const turn2 = await callTool(ctx, 'memory_remember', {
      title: 'CEO CTO tension',
      content: 'The biggest issue is that my CEO and CTO have very different priorities.',
    })
    // Distractors from unrelated earlier turns, to prove this isn't a trivial "vault has 2 notes" result.
    await callTool(ctx, 'memory_remember', { title: 'Grocery list', content: 'Need to buy milk, eggs, bread, and coffee this weekend.' })
    await callTool(ctx, 'memory_remember', { title: 'Movie night plan', content: 'Watch the new sci-fi movie with friends on Friday night.' })

    // Turn 3: a synthesis question that touches both turn-1 and turn-2 topics.
    const recalled = await callTool(ctx, 'memory_recall', {
      query: 'How should I handle competing priorities from my CEO and CTO while managing engineering team stakeholders?',
      limit: 2,
    })
    const ids = recalled.results.map((r: { id: string }) => r.id)
    expect(ids).toEqual(expect.arrayContaining([turn1.id, turn2.id]))
  })
})

describe.skipIf(realEmbeddingFn === null)('agent chat session — semantic augmentation (real local embeddings)', () => {
  let vaultPath: string

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'knowledge-hub-semantic-'))
  })

  afterEach(async () => {
    await rm(vaultPath, { recursive: true, force: true })
  })

  it('hybrid recall answers a paraphrased question with real semantic embeddings, no shared vocabulary with the stored note', async () => {
    const ctx = await mountRegistry()
    apply(ctx, Config({ vaultPath, enableEmbeddings: true }))

    const themeNote = await callTool(ctx, 'memory_remember', {
      title: 'Theme habit',
      content: 'Rahul recolors every fresh IDE to a somber charcoal tint the moment he installs it.',
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Recipe',
      content: 'Simmer the tomatoes with garlic and basil for twenty minutes before serving over pasta.',
    })

    // Deliberately paraphrased: no word here appears in themeNote's content or title.
    const recalled = await callTool(ctx, 'memory_recall', { query: 'What color scheme does the user prefer for their code editor?' })
    expect(recalled.results[0]?.id).toBe(themeNote.id)

    await ctx.fiber.dispose()
  }, 120_000)

  it('memory_related surfaces a genuinely related note over an unrelated one across 3+ notes (regression: fuseHybrid rank-only tie-breaking, fixed 2026-08-19)', async () => {
    // This exact scenario — a related "sibling" note losing a 3-way
    // tie-break to a vocabulary-disjoint "recipe" note — is what surfaced
    // the fuseHybrid()/vectorSearch() bugs documented in
    // designCognitiveBrainForDSH.md: vectorSearch() never passed Orama's
    // `mode: 'vector'`, so it silently ran a no-op fulltext search instead
    // of a real vector search, and fuseHybrid()'s reciprocal-rank fusion
    // discarded real similarity magnitude even once given real scores. Both
    // are fixed in memory-index.ts; this guards the fix at the tool level.
    const ctx = await mountRegistry()
    apply(ctx, Config({ vaultPath, enableEmbeddings: true }))

    const source = await callTool(ctx, 'memory_remember', {
      title: 'Theme habit',
      content: 'Rahul recolors every fresh IDE to a somber charcoal tint the moment he installs it.',
    })
    const sibling = await callTool(ctx, 'memory_remember', {
      title: 'Editor setup',
      content: 'He also disables all animations and picks a monospace font whenever he sets up a new code editor.',
    })
    await callTool(ctx, 'memory_remember', {
      title: 'Recipe',
      content: 'Simmer the tomatoes with garlic and basil for twenty minutes before serving over pasta.',
    })

    const related = await callTool(ctx, 'memory_related', { id: source.id })
    expect(related.results[0]?.id).toBe(sibling.id)

    await ctx.fiber.dispose()
  }, 120_000)

  it('the real embedding model scores a semantically related pair far higher than an unrelated one', async () => {
    // Direct check of the layer RAG/semantic search actually depends on —
    // real @xenova/transformers output, not the higher-level fusion (whose
    // limitations are documented above). This is the property that must
    // hold for "semantic augmentation" to mean anything at all.
    const fn = realEmbeddingFn!
    function cosine(a: number[], b: number[]): number {
      let dot = 0, na = 0, nb = 0
      for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
      return dot / Math.sqrt(na * nb)
    }

    const battery = await fn('Electric vehicle battery packs rely on lithium-ion cells whose capacity fades with repeated charge cycles.')
    const agingModel = await fn('Repeated charging and discharging gradually reduces how much energy a rechargeable cell can hold.')
    const sourdough = await fn('Feed your sourdough starter with equal parts flour and water once a day to keep it active.')

    const relatedSimilarity = cosine(battery, agingModel)
    const unrelatedSimilarity = cosine(battery, sourdough)
    expect(relatedSimilarity).toBeGreaterThan(unrelatedSimilarity * 10)
  }, 120_000)
})

describe('agent chat session — concept graph augmentation (fake ctx.llm, no network)', () => {
  let vaultPath: string
  let ctx: Context
  let dataRouteHandler: (() => Promise<{ nodes: { label: string }[]; edges: unknown[] }>) | undefined

  beforeEach(async () => {
    vaultPath = await mkdtemp(join(tmpdir(), 'knowledge-hub-graph-'))
    ctx = await mountRegistry()
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(vaultPath, { recursive: true, force: true })
  })

  function provideFakeLlmAndWebServer(conceptsPerNote: string[][]): void {
    let call = 0
    async function * stream(): AsyncGenerator<StreamChunk> {
      const concepts = conceptsPerNote[call] ?? []
      call += 1
      const text = JSON.stringify({ chunks: [{ concepts }] })
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    ctx.provide('llm', {
      stream,
      listProviders: () => [{ id: 'test-provider', name: 'Test' }],
    } as unknown as Context['llm'])

    let handler: ((req: unknown, res: { writeHead: (code: number) => void; end: (body: string) => void }) => Promise<void>) | undefined
    ctx.provide('webServer', {
      host: '127.0.0.1',
      port: 4321,
      register: (route: { path: string; handler: typeof handler }) => {
        if (route.path.endsWith('data.json')) handler = route.handler as typeof handler
        return () => {}
      },
    } as unknown as Context['webServer'])
    dataRouteHandler = async () => {
      let body = ''
      await handler?.({}, { writeHead: () => {}, end: (t: string) => { body = t } })
      return JSON.parse(body)
    }
  }

  it('an agent can tell the user how two notes written in different turns relate, via the graph URL it gets back', async () => {
    provideFakeLlmAndWebServer([
      ['GraphQL schema design'],
      ['GraphQL schema design'],
    ])
    apply(ctx, Config({
      vaultPath, enableEmbeddings: false, enableConceptGraph: true, conceptGraphModel: 'test-model',
    }))

    const first = await callTool(ctx, 'memory_remember', {
      title: 'API design notes',
      content: 'Discussed GraphQL schema design with the team today.',
    })
    expect(first.conceptGraphUrl).toBe('http://127.0.0.1:4321/knowledge-hub/concept-graph')

    const second = await callTool(ctx, 'memory_remember', {
      title: 'Follow-up API notes',
      content: 'More thoughts on GraphQL schema design after the review.',
    })
    expect(second.conceptGraphUrl).toBe(first.conceptGraphUrl)

    const graph = await dataRouteHandler!()
    const labels = graph.nodes.map(n => n.label)
    expect(labels).toContain('API design notes')
    expect(labels).toContain('Follow-up API notes')
    expect(labels).toContain('GraphQL schema design')
  })
})
