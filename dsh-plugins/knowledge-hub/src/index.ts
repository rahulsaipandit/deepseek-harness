/**
 * `memory_remember` / `memory_recall` / `memory_list` / `memory_audit` /
 * `memory_related`: a lean, markdown-file personal knowledge hub — the
 * DSH-as-hub design from `docs/designCognitiveBrainForDSH.md`. Markdown
 * files (with YAML frontmatter) are the durable, human-auditable source of
 * truth; a hybrid BM25+vector index (`memory-index.ts`, adapted from
 * cognitiveBrain's `OramaIndex`) makes them searchable; every write is
 * logged to an append-only audit trail (`audit-log.ts`). No knowledge
 * graph, no LLM enrichment pipeline, no auto-synthesis — see the design doc
 * for why each of those was deliberately left out of v1.
 * @module dsh-plugin-knowledge-hub
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createAuditLog } from './audit-log.ts'
import { chunkByHeading } from './chunking.ts'
import { findContradiction } from './contradiction.ts'
import { createLlmConceptExtractor } from './concept-extractor.ts'
import { mergeNoteIntoGraph, readConceptGraphCache, writeConceptGraphCache } from './concept-graph.ts'
import type { ConceptExtractor } from './concept-extractor.ts'
import { createLocalEmbeddingFunction, type EmbeddingFunction } from './embedding.ts'
import { hashContent, pruneEmbeddingCache, readEmbeddingCache, writeEmbeddingCache } from './embedding-cache.ts'
import type { EmbeddingCache } from './embedding-cache.ts'
import { nextId } from './id.ts'
import { MemoryIndex } from './memory-index.ts'
import type { MemoryFile, MemoryFrontmatter } from './types.ts'
import { createVaultStore } from './vault-store.ts'
import { buildTitleIndex, extractWikilinks, resolveWikilinks } from './wikilinks.ts'
import { registerConceptGraphServer } from './web/concept-graph-server.ts'

export const name = 'knowledge-hub'
export const inject = ['tools']

export const Config = z.object({
  /** Absolute path to the markdown vault root. Required — a real deployment must point this at wherever the user's notes actually live. */
  vaultPath: z.string(),
  /** Local embedding model, loaded via @xenova/transformers. */
  embeddingModel: z.string().default('Xenova/all-MiniLM-L6-v2'),
  /** Vector dimensionality; must match embeddingModel's actual output size. */
  embeddingDimensions: z.number().default(384),
  /** false = BM25-only, no model load at all. */
  enableEmbeddings: z.boolean().default(true),
  /** Max results memory_recall/memory_related may return in one call. */
  maxRecallResults: z.number().default(20),
  /** LLM-extracted concept graph, incremental-only (new notes never re-run over past notes). Off by default: unlike embeddings, this puts a real LLM call in the write path. */
  enableConceptGraph: z.boolean().default(false),
  /** Provider route passed to ctx.llm.stream(). Required when enableConceptGraph is true; omitted otherwise defaults to the first registered provider. */
  conceptGraphProvider: z.string().default(''),
  /** Model id passed to ctx.llm.stream(). Required when enableConceptGraph is true. */
  conceptGraphModel: z.string().default(''),
  /** Base path the concept-graph page and its data route are served under. */
  conceptGraphWebPath: z.string().default('/knowledge-hub/concept-graph'),
})

export type Config = Schemastery.TypeT<typeof Config>

interface RememberArgs {
  title: string
  content: string
  type?: string
  tags?: string[]
  confidence?: number
  resource?: string
}

interface RecallArgs {
  query: string
  limit?: number
  tags?: string[]
}

interface ListArgs {
  tags?: string[]
  limit?: number
}

interface AuditArgs {
  entryId?: string
  operation?: string
  limit?: number
}

interface RelatedArgs {
  id: string
  limit?: number
}

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`knowledge-hub: ${field} must be a positive integer`)
  }
}

/** Register the five knowledge-hub tools. */
export function apply(ctx: Context, config: Config): void {
  if (config.vaultPath.trim().length === 0) {
    throw new Error('knowledge-hub: vaultPath must be a non-empty absolute path')
  }
  assertPositiveInteger('embeddingDimensions', config.embeddingDimensions)
  assertPositiveInteger('maxRecallResults', config.maxRecallResults)

  const vaultPath = resolve(config.vaultPath)
  const vaultStore = createVaultStore(vaultPath)
  const auditLog = createAuditLog(vaultPath)

  let conceptExtractor: ConceptExtractor | undefined
  let graphUrl: string | undefined

  if (config.enableConceptGraph) {
    const llm = ctx.get('llm')
    const webServer = ctx.get('webServer')
    if (!llm) throw new Error('knowledge-hub: enableConceptGraph is true but no ctx.llm service is mounted')
    if (!webServer) throw new Error('knowledge-hub: enableConceptGraph is true but no ctx.webServer service is mounted')
    if (config.conceptGraphModel.trim().length === 0) {
      throw new Error('knowledge-hub: enableConceptGraph is true but conceptGraphModel is not configured')
    }
    const provider = config.conceptGraphProvider.trim().length > 0
      ? config.conceptGraphProvider
      : llm.listProviders()[0]?.id
    if (!provider) throw new Error('knowledge-hub: enableConceptGraph is true but no LLM provider is registered and conceptGraphProvider was not set')

    conceptExtractor = createLlmConceptExtractor(
      llm,
      { provider, model: config.conceptGraphModel },
      error => ctx.logger?.warn?.(`knowledge-hub: concept extraction failed for a note; the graph was left unchanged for it: ${String(error)}`),
    )
    graphUrl = registerConceptGraphServer(ctx, webServer, {
      webPath: config.conceptGraphWebPath,
      readGraph: () => readConceptGraphCache(vaultPath),
    })
  }

  let initPromise: Promise<MemoryIndex> | undefined
  let embeddingFn: EmbeddingFunction | null = null
  let embeddingCache: EmbeddingCache | undefined

  /**
   * Content-hash-keyed embedding lookup (designCognitiveBrainForDSH.md
   * §5.1/§5.4): reuses a note's cached embedding when its content hash is
   * unchanged since the last time it was embedded, and transparently
   * recomputes when it isn't — the same check covers both "skip redundant
   * work on an unchanged vault" and "a hand-edited note went stale."
   * Mutates the in-memory cache; callers persist it via `persistEmbeddingCache()`.
   */
  async function resolveEmbedding(id: string, content: string, title: string): Promise<number[] | undefined> {
    if (!embeddingFn || !embeddingCache) return undefined
    const contentHash = hashContent(content || title)
    const cached = embeddingCache.entries[id]
    if (cached && cached.contentHash === contentHash) return cached.embedding
    const embedding = await embeddingFn(content || title)
    embeddingCache.entries[id] = { contentHash, embedding }
    return embedding
  }

  async function persistEmbeddingCache(): Promise<void> {
    if (!embeddingCache) return
    try {
      await writeEmbeddingCache(vaultPath, embeddingCache)
    } catch (error) {
      ctx.logger?.warn?.(`knowledge-hub: failed to persist the embedding cache; the next boot will re-embed unnecessarily: ${String(error)}`)
    }
  }

  async function ensureInitialized(): Promise<MemoryIndex> {
    if (!initPromise) {
      initPromise = (async () => {
        embeddingFn = config.enableEmbeddings
          ? await createLocalEmbeddingFunction(
            { model: config.embeddingModel },
            error => ctx.logger?.warn?.(`knowledge-hub: embedding model failed to load, falling back to keyword-only search: ${String(error)}`),
          )
          : null
        const index = new MemoryIndex({
          dimensions: config.embeddingDimensions,
          ...(embeddingFn ? { embeddingFn } : {}),
        })
        await index.initialize()
        const files = await vaultStore.list()

        if (embeddingFn) {
          embeddingCache = pruneEmbeddingCache(
            await readEmbeddingCache(vaultPath),
            new Set(files.map(f => f.frontmatter.id)),
          )
          const docs = await Promise.all(files.map(async (file) => {
            const vector = await resolveEmbedding(file.frontmatter.id, file.content, file.frontmatter.title)
            return { ...toIndexDoc(file), ...(vector ? { vector } : {}) }
          }))
          await index.indexMany(docs)
          await persistEmbeddingCache()
        } else {
          await index.indexMany(files.map(toIndexDoc))
        }
        return index
      })()
    }
    return initPromise
  }

  /**
   * Incremental, per-new-note-only concept extraction + graph merge (see
   * designCognitiveBrainForDSH.md §1.5). Never re-runs over past notes —
   * there is deliberately no backfill entry point. One bounded LLM call.
   */
  async function updateConceptGraph(file: MemoryFile): Promise<void> {
    if (!conceptExtractor) return
    const chunks = chunkByHeading(file.content)
    if (chunks.length === 0) return

    const existing = await vaultStore.list()
    const titleToId = buildTitleIndex(existing.map(f => ({ id: f.frontmatter.id, title: f.frontmatter.title })))
    const idToTitle = new Map(existing.map(f => [f.frontmatter.id, f.frontmatter.title]))
    const wikilinkTargets = extractWikilinks(file.content)
    const wikilinkTargetTitles = resolveWikilinks(wikilinkTargets, titleToId)
      .map(id => idToTitle.get(id))
      .filter((title): title is string => title !== undefined)

    const chunkConcepts = await conceptExtractor(file.frontmatter.title, chunks)

    const graph = await readConceptGraphCache(vaultPath)
    mergeNoteIntoGraph(graph, {
      noteId: file.frontmatter.id,
      noteTitle: file.frontmatter.title,
      chunkConcepts,
      wikilinkTargetTitles,
    })
    await writeConceptGraphCache(vaultPath, graph)
  }

  /**
   * Cheap, LLM-free contradiction check (designCognitiveBrainForDSH.md
   * §5.6): searches the *existing* vault (the new note isn't indexed yet)
   * for a candidate sharing a tag with the new note, then runs the eight
   * negation-pattern pairs against both notes' content. Returns advisory
   * info only — never writes `contradictedBy` itself; that requires a
   * person or agent to confirm it (no `memory_edit` tool exists to act on
   * it automatically, by design, §5.4).
   */
  async function findPossibleContradiction(
    index: MemoryIndex,
    newTags: readonly string[],
    newContent: string,
  ): Promise<{ id: string; title: string; path: string; reason: string } | undefined> {
    if (newTags.length === 0) return undefined
    const hits = await index.search(newContent, 5)
    for (const hit of hits) {
      const candidate = await vaultStore.read(hit.id)
      if (!candidate) continue
      if (!candidate.frontmatter.tags.some(tag => newTags.includes(tag))) continue
      const reason = findContradiction(newContent, candidate.content)
      if (reason) {
        return { id: candidate.frontmatter.id, title: candidate.frontmatter.title, path: candidate.path, reason }
      }
    }
    return undefined
  }

  function toIndexDoc(file: MemoryFile) {
    return {
      id: file.frontmatter.id,
      title: file.frontmatter.title,
      content: file.content,
      type: file.frontmatter.type,
      tags: file.frontmatter.tags,
      createdAt: file.frontmatter.createdAt,
      confidence: file.frontmatter.confidence,
      sourceCount: file.frontmatter.sourceCount,
    }
  }

  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: 'Write a new markdown memory note to the knowledge hub: stores the file, indexes it for search, and logs the change to the audit trail.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short title for this memory.' },
      content: { type: 'string', required: true, description: 'The memory content, in markdown.' },
      type: { type: 'string', description: '"note" (default), "fact", "procedure", or "entity".' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering/search.' },
      confidence: { type: 'number', description: 'Optional 0-1 confidence. Defaults to 0.5.' },
      resource: { type: 'string', description: 'Optional canonical source URL this memory came from (OKF-compatible). Omit for a note with no external origin.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          path: { type: 'string', required: true },
          conceptGraphUrl: { type: 'string' },
          possibleContradiction: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              path: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Remembered (${value.id}) at ${value.path}.${value.conceptGraphUrl ? ` Concept graph: ${value.conceptGraphUrl}` : ''}`
          + (value.possibleContradiction
            ? ` Possible contradiction with "${value.possibleContradiction.title}" [${value.possibleContradiction.path}]: ${value.possibleContradiction.reason}.`
            : ''),
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args: RememberArgs) {
      const index = await ensureInitialized()

      const type = args.type ?? 'note'
      if (type !== 'note' && type !== 'fact' && type !== 'procedure' && type !== 'entity') {
        throw new Error('memory_remember: type must be one of "note", "fact", "procedure", "entity"')
      }

      const id = nextId()
      const tags = args.tags ?? []
      const frontmatter: MemoryFrontmatter = {
        id,
        title: args.title,
        type,
        tags,
        createdAt: new Date().toISOString(),
        confidence: args.confidence ?? 0.5,
        sourceCount: 1,
        ...(args.resource === undefined ? {} : { resource: args.resource }),
      }
      const file: MemoryFile = { frontmatter, content: args.content, path: '' }

      // Checked against the *existing* index, before this note is added to it,
      // so it never matches itself.
      let possibleContradiction: { id: string; title: string; path: string; reason: string } | undefined
      try {
        possibleContradiction = await findPossibleContradiction(index, tags, args.content)
      } catch (error) {
        ctx.logger?.warn?.(`knowledge-hub: contradiction check failed; proceeding without it: ${String(error)}`)
      }

      await vaultStore.write(file)
      try {
        const vector = await resolveEmbedding(id, file.content, file.frontmatter.title)
        await index.index({ ...toIndexDoc(file), ...(vector ? { vector } : {}) })
        await persistEmbeddingCache()
      } catch (error) {
        ctx.logger?.warn?.(`knowledge-hub: indexing failed after a successful write; search may be stale until restart: ${String(error)}`)
      }
      await auditLog.log({ operation: 'create', entryId: id, entryType: type, summary: `Created ${type} entry: ${args.title}` })

      if (conceptExtractor) {
        try {
          await updateConceptGraph(file)
        } catch (error) {
          ctx.logger?.warn?.(`knowledge-hub: concept-graph update failed after a successful write; the graph was left unchanged for this note: ${String(error)}`)
        }
      }

      return {
        id,
        path: resolve(vaultPath, `${id}.md`),
        ...(graphUrl ? { conceptGraphUrl: graphUrl } : {}),
        ...(possibleContradiction ? { possibleContradiction } : {}),
      }
    },
    presentCall(args: RememberArgs) {
      return { card: 'generic', title: `Remember "${args.title}"`, kind: 'edit' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search the knowledge hub by natural-language query (hybrid keyword + semantic search). Read-only.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      limit: { type: 'number', description: 'Max results (default 5).' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional: only return memories having ALL these tags.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                score: { type: 'number', required: true },
                excerpt: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No matching memories found.'
          : value.results.map(r => `"${r.title}" (score ${r.score.toFixed(2)}, tags: ${r.tags.join(',')}) — ${r.excerpt} [${r.path}]`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: RecallArgs) {
      const index = await ensureInitialized()
      const limit = Math.min(Math.max(args.limit ?? 5, 1), config.maxRecallResults)
      const hits = await index.search(args.query, limit * (args.tags && args.tags.length > 0 ? 4 : 1))

      const results: { id: string; title: string; path: string; score: number; excerpt: string; tags: string[] }[] = []
      for (const hit of hits) {
        if (results.length >= limit) break
        const file = await vaultStore.read(hit.id)
        if (!file) continue
        if (args.tags && !args.tags.every(tag => file.frontmatter.tags.includes(tag))) continue
        results.push({
          id: file.frontmatter.id,
          title: file.frontmatter.title,
          path: file.path,
          score: hit.score,
          excerpt: file.content.length > 300 ? `${file.content.slice(0, 300)}…` : file.content,
          tags: file.frontmatter.tags,
        })
      }
      return { results }
    },
    presentCall(args: RecallArgs) {
      return { card: 'generic', title: `Recall "${args.query}"`, kind: 'search' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description: 'Browse memories by tag, without a search query. Read-only.',
    parameters: {
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional: only list memories having ALL these tags.' },
      limit: { type: 'number', description: 'Max results (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                type: { type: 'string', required: true },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                createdAt: { type: 'string', required: true },
                path: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.length === 0
          ? 'No memories found.'
          : value.items.map(i => `"${i.title}" (${i.type}, tags: ${i.tags.join(',')}, ${i.createdAt})`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: ListArgs) {
      await ensureInitialized()
      const files = await vaultStore.list(args.tags && args.tags.length > 0 ? { tags: args.tags } : undefined)
      const sorted = [...files].sort((a, b) => b.frontmatter.createdAt.localeCompare(a.frontmatter.createdAt))
      const limit = args.limit ?? 50
      const items = sorted.slice(0, limit).map(file => ({
        id: file.frontmatter.id,
        title: file.frontmatter.title,
        type: file.frontmatter.type,
        tags: file.frontmatter.tags,
        createdAt: file.frontmatter.createdAt,
        path: file.path,
      }))
      return { items }
    },
    presentCall() {
      return { card: 'generic', title: 'List memories', kind: 'read' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_audit',
    description: 'Read the knowledge hub\'s audit trail: every create/update/delete, with a timestamp and summary. Read-only.',
    parameters: {
      entryId: { type: 'string', description: 'Optional: only events for this memory id.' },
      operation: { type: 'string', description: 'Optional: "create", "update", or "delete".' },
      limit: { type: 'number', description: 'Max events (default 50).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          events: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                timestamp: { type: 'string', required: true },
                operation: { type: 'string', required: true },
                entryId: { type: 'string', required: true },
                entryType: { type: 'string', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.events.length === 0
          ? 'No audit events found.'
          : value.events.map(e => `[${e.timestamp}] ${e.operation} ${e.entryType} ${e.entryId}: ${e.summary}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: AuditArgs) {
      if (args.operation !== undefined && args.operation !== 'create' && args.operation !== 'update' && args.operation !== 'delete') {
        throw new Error('memory_audit: operation must be one of "create", "update", "delete"')
      }
      const events = await auditLog.getLog({
        ...(args.entryId === undefined ? {} : { entryId: args.entryId }),
        ...(args.operation === undefined ? {} : { operation: args.operation }),
        limit: args.limit ?? 50,
      })
      return { events }
    },
    presentCall() {
      return { card: 'generic', title: 'Read audit log', kind: 'read' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_related',
    description: 'Given an existing memory id, find other memories that relate to it by content similarity — cheap, embeddings-only, no LLM call. Read-only.',
    parameters: {
      id: { type: 'string', required: true, description: 'Id of an existing memory, as returned by memory_recall or memory_list.' },
      limit: { type: 'number', description: 'Max results (default 5).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                path: { type: 'string', required: true },
                score: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No related memories found.'
          : value.results.map(r => `"${r.title}" (score ${r.score.toFixed(2)}) [${r.path}]`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args: RelatedArgs) {
      const index = await ensureInitialized()
      const source = await vaultStore.read(args.id)
      if (!source) throw new Error(`memory_related: no memory found with id "${args.id}"`)

      const limit = Math.min(Math.max(args.limit ?? 5, 1), config.maxRecallResults)
      const hits = await index.search(source.content || source.frontmatter.title, limit + 1)

      const results: { id: string; title: string; path: string; score: number }[] = []
      for (const hit of hits) {
        if (hit.id === args.id) continue
        if (results.length >= limit) break
        const file = await vaultStore.read(hit.id)
        if (!file) continue
        results.push({ id: file.frontmatter.id, title: file.frontmatter.title, path: file.path, score: hit.score })
      }
      return { results }
    },
    presentCall(args: RelatedArgs) {
      return { card: 'generic', title: `Find memories related to ${args.id}`, kind: 'search' }
    },
  }))
}
