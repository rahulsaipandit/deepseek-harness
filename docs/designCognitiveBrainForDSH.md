# Cognitive Brain for DSH: a Hub-and-Spoke Personal Knowledge Hub

Status: **implemented** as `dsh-plugins/knowledge-hub/` — six tools (five
base tools plus `memory_consolidate`, §8), the opt-in concept graph
described in §4 with per-query graph expansion (§4.4), and 118 passing
tests with a clean typecheck. This document lays out the architecture for
turning
DeepSeek Harness (DSH) into the personal knowledge hub described in
[`docs/knowledge-hub-architecture.md`](./knowledge-hub-architecture.md),
using `docs/packages/cognitiveBrain` as a source of reusable memory logic —
mined selectively, not adopted wholesale — plus MCP and Cordis plugins as the
extensibility mechanism. The explicit goal: **a lightweight equivalent of
GBrain** — the real value of a dedicated memory/retrieval system, without the
costs that made GBrain the wrong fit (see §5). See
[`dsh-plugins/knowledge-hub/README.md`](../dsh-plugins/knowledge-hub/README.md)
for the as-built config surface and test coverage.

## 1. Hub-and-spoke, with DSH as the hub

`docs/knowledge-hub-architecture.md` established the shape: a **hub** that
owns durable, cross-tool knowledge, and **spokes** (Pluely, Tolaria, Open
Research, and DSH itself) that produce or consume it, each keeping a
local-only tier that works with zero hub uptime requirement.

That document evaluated five hub *candidates* — GBrain, Memora, a wiki-native
convention, Context-OS, and a custom lean hub built as a DSH plugin (Option
E) — and stopped short of picking one. This document picks: **DSH is the
hub**, implemented as Option E, for reasons specific to what DSH already is:

- DSH is a real Node.js process (a Cordis plugin host), not a browser
  webview. It has none of Pluely's constraints (no `@modelcontextprotocol/sdk`
  restriction) and none of Tolaria's stdio-only transport limitation — it can
  expose an HTTP-reachable surface if one is ever needed, and can spawn or
  call other MCP servers directly.
- DSH already has the two services this design depends on mounted as
  first-class Cordis services: `ctx.llm` (`@deepseek-ai/dsh-llm`) for model
  calls, and `ctx.webServer` for serving pages — both confirmed in use by
  existing plugins (`packages/session/session-title-first-prompt-llm`,
  `dsh-plugins/web-terminal`), so this design adds no new infrastructure
  DSH doesn't already have a working pattern for.
- DSH's plugin architecture ("everything is a plugin" — Cordis) is
  structurally exactly hub-and-spoke *inside* the hub as well: the knowledge
  hub is one plugin among others, composed via dependency injection, not a
  monolith with knowledge-hub logic and everything else awkwardly bolted on.

The knowledge hub itself is a single new plugin, `dsh-plugin-knowledge-hub`
(`dsh-plugins/knowledge-hub/`), holding markdown files as the durable source
of truth plus a hybrid search index over them. Everything else — a concept
graph, future multi-source ingestion, an eventual MCP server surface — is
either a capability *within* that plugin or a *separate* plugin composed
alongside it, never a new subsystem wedged into one growing memory engine.

## 2. Where Cognitive Brain fits: mined, not adopted

`docs/packages/cognitiveBrain` is a large (~500+ file) reference codebase —
actually about a dozen loosely related products, not one memory system. A
complete file-by-file inventory was done to decide what's genuinely reusable.
The headline finding: **only one directory, `memory/`, is conceptually
related to a knowledge hub at all.** The rest — `extension/`, `core/`,
`llms/`, `mcp/`, `page-agent/`, `graph-viewer/`, `page-controller/`, `ui/` —
is a Chrome browser-extension product ("Page Agent," a DOM-automation AI
agent) and its LLM-client/MCP-tool-calling plumbing, confirmed via import
grep to have zero relationship to `memory/`. `memsoftstore/` (and its
byte-identical duplicate under `lib/`) is a separate, older React Native
mobile memory system for a different, character-chat app.

Within `memory/` itself (117 files), the majority is a graph + LLM-enrichment
+ auto-synthesis cognitive architecture (`MemoryService.ts` wiring together
`InProcessGraph`, `Pipeline`, `SynthesisEngine`, `WorkingMemory`,
`ContextBuilder`) — this is the same class of system GBrain was rejected for
(§5), just implemented differently. It was **not** adopted. What survived the
inventory, and why, is below.

### 2.1 Adopted

| From `memory/src/` | Adapted into | Why it survived |
|---|---|---|
| `adapters/web/OramaIndex.ts` | `memory-index.ts` | Hybrid BM25+vector search via `@orama/orama` with reciprocal-rank-fusion — the actual retrieval engine, kept. Stripped of ~250 lines of GA/CB query-intent regex heuristics tuned for a system with entity/relation graph edges this design doesn't have. |
| `interfaces/IMemoryIndex.ts`, `interfaces/IMemoryStore.ts` (CRUD subset) | `memory-index.ts`, `vault-store.ts` (interfaces) | Clean, minimal contracts — index/search/lifecycle, and CRUD/filter/pagination — with every graph-relation method (`getRelations`/`putRelation`/`deleteRelation`) dropped. |
| `utils/nextId.ts` | `id.ts` | Trivial dependency-free id generator, ported as-is. |
| `factory.ts` | `index.ts` | The "compose store+index behind one factory, dynamic-import unused adapters" wiring pattern. |
| `types.ts` (partial) | `types.ts` | `MemoryEntry`-lite fields, `SearchOptions`/`IndexResult` shapes — with `EdgeType`/`GraphEdge`, `SynthesisQuality`/`ThinkResult`/`TieredLLMConfig`, `JobType`/`BackgroundJob` all stripped. |
| `adapters/web/IndexedDBStore.ts` (pattern only) | `vault-store.ts` | The `matchesFilter()` predicate-composition idea, retargeted at an in-memory array of parsed frontmatter records instead of IndexedDB. |
| `adapters/web/OffscreenEmbedder.ts` (interface only) | `embedding.ts` | `IEmbedder{initialize, embed, embedSingle}` — a clean minimal contract for wrapping `@xenova/transformers`. |
| `vault/ObsidianVaultProvider.ts` | `vault-store.ts` + `frontmatter.ts` | The closest analog to this design anywhere in the inventory: local filesystem, `.md` + YAML frontmatter, cache-then-search. Its hand-rolled line-by-line frontmatter parser and `queryWiki`/wikilink-lint LLM delegation were **not** kept — a real YAML library is used instead. |
| `core/audit/{MutationEvent.ts, IMutationLogStore.ts, MutationLogStore.ts}` (pattern) | new `audit-log.ts` | A genuine, graph-free, LLM-free append-only change log — `{operation, entryId, entryType, summary, timestamp}` with pagination and pruning. This is the single biggest find of the inventory: it directly answers "memory should be auditable," re-platformed from IndexedDB to a flat JSONL file to match the markdown-first, human-inspectable ethos. Explicitly distinct from the similarly-named `core/journal/MutationJournal.ts`, which is unrelated browser cache-invalidation plumbing and was discarded. |
| `memsoftstore/.../transformerOutputNormalizer.ts` | `embedding.ts` | A small, dependency-free helper normalizing varied `@xenova/transformers` pipeline output shapes into a plain `number[]` — ported near-verbatim. |

### 2.2 Deliberately not adopted, and why

- **The knowledge graph** (`core/graph/InProcessGraph.ts`, `CommunityDetector.ts`,
  `ImpactAnalyzer.ts`, `adapters/web/IndexedDBGraphStore.ts`): automatic,
  updates on every write, and — critically — **traversed on every search
  call** (`expandNeighbors()` inside `MemoryService.search()`). This is
  exactly the "token cost gets out of hand" failure mode GBrain's own
  knowledge-graph traversal was rejected for (§5); adopting it here would
  reintroduce the same problem under a different name.
- **The LLM enrichment pipeline** (`core/pipeline/*`, 10 processor stages:
  entity extraction, salience, summarization, importance scoring, insight
  generation, decay, procedure learning/evolution) and **auto-synthesis**
  (`core/synthesis/SynthesisEngine.ts`, `vault/MkdfAdapter.ts`): background
  jobs that mutate/generate content without a person asking for it — the
  "black box" quality GBrain was rejected for, reimplemented in-process
  instead of in Postgres.
- **The "wiki" subsystem** (`core/wiki/*`) looked, by name, like it might be
  the lean "raw → compiled wiki" pattern from `docs/knowledge-hub-architecture.md`'s
  Option C. Reading it disproved that: `WikiPageProcessor.buildPage()` calls
  an LLM to *generate* the wiki page from raw content (no deterministic
  path), and `WikiRetriever.search()` does title-substring matching followed
  by graph BFS traversal — no BM25/vector search anywhere. It's the same
  graph-and-LLM-synthesis pattern wearing a wiki-shaped API. If a compiled-wiki
  feature is wanted later, it needs a fresh design, not adaptation from here.
- **Everything outside `memory/`** (the browser extension, its LLM/MCP client
  plumbing, the React Native `memsoftstore`/`lib` memory system): confirmed,
  file by file, to have no import relationship to a knowledge-hub concern.
  A handful of portable algorithms were noted for the record (a pure-math
  BM25+cosine index in `extension/src/browser-ml/vector-search.ts`, a
  force-directed layout algorithm in `graph-viewer/src/layout/force.ts`,
  domain allow/deny-list matching in `extension/src/accessListControl/`) —
  none needed for v1, kept as reference points for later ingestion or
  visualization work.

The full file-by-file inventory (every one of the ~500+ source files
classified ADAPT / REFERENCE-ONLY / DISCARD, with reasoning) exists as
working notes from this design process; the table above and §2.2 are its
distilled conclusions.

## 3. The knowledge-hub plugin

### 3.1 Storage: markdown files, not a database

One file per memory, `<vaultPath>/<id>.md`, flat directory (tags organize,
not folders):

```yaml
---
id: 01JBXK7QG3Z8V6R2N4T9F5W1YB
title: "Rahul prefers dark-mode editors"
type: note                      # note | fact | procedure | entity
tags: [preferences, editor]
createdAt: "2026-08-18T10:03:00.000Z"
updatedAt: "2026-08-18T10:03:00.000Z"   # omitted until first edit
confidence: 0.8                  # optional, default 0.5
sourceCount: 1                    # optional, default 1
---
Rahul mentioned he always switches new editors to a dark theme within the
first five minutes of using them.
```

`vaultPath` is a required, absolute, externally-configurable path — the
plugin's code ships in this repo, but the actual memory content lives
wherever the user points it (their own notes folder, eventually perhaps a
Tolaria vault), git-diffable and editable in any text editor. This is the
direct answer to "memory should not be a black box stored in a database":
there is no database. Writes go through `@deepseek-ai/dsh-atomic-write`'s
`writeFileAtomic` + `withFileLock`, the same durability primitive already
used elsewhere in this repo.

### 3.2 Retrieval: hybrid search, no graph traversal

`memory-index.ts` wraps the adapted `OramaIndex` — BM25 keyword search fused
with vector similarity search (local embeddings, `@xenova/transformers`,
`Xenova/all-MiniLM-L6-v2`, 384 dimensions — independently corroborated as the
right pairing by `memsoftstore`'s own identical default) via reciprocal rank
fusion. The whole index is rebuilt in memory on plugin startup by scanning
the vault directory; there is no persisted index snapshot and no incremental
sync complexity to get wrong. `memory_recall` never touches a graph — it is
pure hybrid search, bounded and predictable in cost every time it's called.

### 3.3 Audit: the payoff of mining `core/audit/`

`audit-log.ts` appends one JSONL record per `create`/`update`/`delete` —
`{id, timestamp, operation, entryId, entryType, summary}` — to a file
alongside the vault. A `memory_audit` tool reads it back, filterable by entry
or operation. Between this and the markdown files themselves being plain
text under the user's control, "is my memory auditable" has a direct,
concrete answer: yes, on two levels — the content (open any `.md` file) and
the history of changes to it (read the audit log).

### 3.4 Tool surface: five tools, not eighty

Directly responding to the real user complaints cited against GBrain ("the
MCP for gbrain has 80 tools, feels like bloatware"):

| Tool | Purpose | Cost |
|---|---|---|
| `memory_remember` | Write a new note (file + index + audit log entry) | One embedding call (local, free) + optional concept-graph LLM call (§4, opt-in) |
| `memory_recall` | Hybrid search by query text | Local vector + BM25 search, no LLM |
| `memory_list` | Metadata-only browse, tag-filterable | No search, no LLM |
| `memory_audit` | Read the change log | File read only |
| `memory_related` | "What else relates to *this* note" — note-to-note similarity | Local vector search only, no LLM (§4.2) |

No `memory_get` (the agent already has a file-read tool once it has a
`path`), no `memory_forget`/`memory_reindex`, no bulk-backfill tool for the
concept graph — each omission is a deliberate anti-bloat decision, not an
oversight.

### 3.5 Plugging into DSH's intelligence layer: how, and verified end-to-end

Per §5.7, `dsh-agent-loop` owns the streaming LLM loop and `dsh-tools` owns
tool dispatch — this plugin's only job is to be a well-behaved
`ctx.tools`-registered dependency for that pair to call into. The mechanism
is exactly the standard Cordis pattern every other tool-providing plugin in
this repo uses, nothing knowledge-hub-specific:

```ts
export const inject = ['tools']   // declared statically, so ctx.tools resolves before apply() runs
// ...
ctx.tools.register(defineTool({ name: 'memory_remember', /* ... */ }))
```

Once registered, `dsh-tools`' pipeline (`tools/pre-execute` → guards →
`tools/execute` → `tools/post-execute` → `tools/result`, §5.7) makes the
tool available to whatever model `dsh-agent-loop` calls next turn — there
is no separate registration step, allowlist, or knowledge-hub-specific
wiring for the loop to know about. The five tools are just five more
entries in the same tool registry every other DSH tool lives in.

**Verified live (2026-08-19), not just by unit test.** Every prior test of
this plugin in this design process used either a fake `ctx` (54-test suite,
§5.2) or a scripted mock LLM. This time, a real locally-hosted model
(`qwen/qwen3.5-9b` via LM Studio, configured as `kb-test`'s default agent
model through the exact Settings → Models flow documented earlier in this
project) was given the plain task *"remember that I like dark mode"* with
no mention of tools or the plugin. The full chain ran for real:

```
dsh-agent-loop -> real LM Studio model decides to call memory_remember
  -> dsh-tools dispatches the call
  -> dsh-plugin-knowledge-hub writes mem_*.md + appends .audit-log.jsonl
  -> result fed back into the session, loop produces a final reply
```

The model chose its own title ("User Preference: Dark Mode"), tags
(`preferences`, `theme`), and confidence (`0.95`) — no scripted arguments
were involved. This is the strongest available confirmation that §5.7's
claim ("the knowledge-hub plugin's only job is to be a good `ctx.tools`
dependency") actually holds at runtime, not just on paper.

**A real gap this same test surfaced — and its root cause, corrected.** A
follow-up task — *"search my memory for what theme I prefer and tell
me"* — reached `memory_recall` (confirmed by isolating the retrieval path
directly against the same on-disk note: exact/partial keyword queries
`"theme"`, `"dark mode"`, and `"preference"` all found it; the
paraphrased query `"what theme do I prefer"` did not) but returned nothing
to the model, which reported no memory found. **This was first (wrongly)
attributed to BM25 being inherently lexical, with no stemming bridge
between "prefer" and "preference." That diagnosis was incomplete.** Found
and fixed while implementing §5.6's contradiction check (2026-08-19): the
real cause is that `memory-index.ts`'s `bm25Search()` never set Orama's
`threshold` option, so it defaulted to `0` — Orama's *strictest* setting,
requiring near-total query-term overlap with a document before returning
it at all. Confirmed directly: a query like `"Dark mode is disabled now."`
returned **zero** hits at `threshold: 0` against a note containing `"Dark
mode is enabled..."`, despite obvious token overlap (`dark`, `mode`), and
returned the expected ranked hit at `threshold: 1` (Orama's most lenient
setting — return every document sharing at least one token, ranked by
score, and let the score order results rather than the search step
silently dropping them). Fixed by setting `threshold: 1` in `bm25Search()`.
Semantic (embedding-based) recall — §5.1's point — is still the right fix
for genuinely paraphrased queries with *no* shared tokens at all (e.g.
"prefer" vs "preference," true synonyms), but this particular failure
would have reproduced even with `enableEmbeddings: true`, since it's the
BM25 half of hybrid search that was broken, not an inherent lexical-vs-
semantic limitation.

**A second bug found while writing the agent/chat integration tests
(2026-08-19), and fixed the same day.** `dsh-plugins/knowledge-hub/tests/
agent-chat-integration.test.ts` drives the plugin through a real Cordis
`Context` + `ToolRuntime` with the real `@xenova/transformers` model
(network permitting; the suite skips itself otherwise), simulating an
actual agent session. That test surfaced two compounding bugs in
`memory-index.ts`:

1. **`vectorSearch()` never passed Orama's `mode: 'vector'`.** `search()`
   dispatches on `mode`, defaulting to `'fulltext'` when unset (confirmed
   against Orama's own source) — so this "vector search" was silently
   running an empty-term fulltext search the entire time, returning every
   document with an arbitrary, insertion-order ranking and a score of
   exactly `0`. The embedding layer itself was never the problem — real
   cosine similarity correctly separated related from unrelated content by
   orders of magnitude when checked directly (a battery-chemistry note
   scored `0.60` against a battery-degradation note, `0.001` against a
   sourdough-starter note) — but none of that signal ever reached
   `fuseHybrid()`.
2. **Even with real scores, `fuseHybrid()`'s fusion was rank-only.**
   Reciprocal-rank fusion with `k=60` makes adjacent ranks 1 vs. 2 differ by
   only `0.4 * (1/61 - 1/62) ≈ 0.00011` — negligible next to genuinely large
   similarity gaps in a personal-notes-sized corpus, and its BM25
   contribution adds recency/reliability terms that are identical across
   same-batch, same-confidence notes. So even once bug 1 was fixed in
   isolation, runner-up documents (anything past the single clear top match
   in either sublist) still landed within floating-point noise of each
   other, with the actual winner decided by BM25 document-length-
   normalization behavior rather than semantic closeness. Reproduced
   concretely: a genuinely related "sibling" note still lost a 3-way
   tie-break to a vocabulary-disjoint "recipe" note even after bug 1 alone
   was fixed.

**Fix**: `vectorSearch()` now passes `mode: 'vector'` and `similarity: -1`
(mirroring the BM25 side's `threshold: 1` reasoning — don't let Orama's own
relevance filter, default `0.8`, silently drop candidates; let the score
ordering decide instead). `fuseHybrid()` now min-max normalizes each hit
list against its own top score (`score / maxScore`) instead of using
`1/(k+rank)`, so a real magnitude gap between runner-up documents survives
fusion instead of being flattened to a rank difference. Verified directly:
the sibling note now beats the recipe note, and battery/degradation/
sourdough now rank in true similarity order. Covered by a deterministic
regression test in `memory-index.test.ts` (a controlled embedding function
with a true BM25 tie across three documents, so only vector magnitude can
explain the expected ranking) and by the real-embeddings integration test
in `agent-chat-integration.test.ts`.

**A related, narrower issue, fixed the same day:** `applyRankedScores()` —
the BM25-*only* path used when `enableEmbeddings` is off — had the identical
rank-only flaw as `fuseHybrid()`, just never noticed because ranking ORDER
was always correct (Orama's own `hits` array is pre-sorted by real
relevance, and rank-only scoring can't invert an already-correct order for
the top position). The returned `score` VALUES, though, were purely
`1/(60+rank)` — a doc with overwhelmingly stronger term overlap and one with
only a single incidental shared word came back with scores differing by
~0.00027, making `score` useless as a confidence signal in this mode, even
though nothing was ever mis-ranked. Fixed by applying the same min-max
normalization `fuseHybrid()` uses: `score / topHitScore`. Verified directly:
a doc repeating both query terms scored `1.0` against a doc sharing only one
incidental term at `~0.14`, versus the old `~0.017` vs. `~0.016`. Regression
test in `memory-index.test.ts` confirmed to fail against the pre-fix code
(asserts a >2x score gap that the rank-only formula could never produce).

## 4. Two graphs are not a contradiction: the concept graph addendum

Rejecting `InProcessGraph` (§2.2) and then adding a *different* graph
capability is intentional, not a reversal — the two differ in exactly the
dimensions that made the first one heavy:

| | `InProcessGraph` (rejected) | Concept graph (adopted) |
|---|---|---|
| Nodes | Notes/entries themselves | Extracted **concepts** — an abstraction layer above notes |
| Trigger | Automatic, every write | **Only new incoming notes** — past/existing notes are never bulk-processed |
| Cost | Silently compounds every write | One bounded LLM call per new note, visible and opt-in |
| Query-time traversal | Walked on every `search()` call — the GBrain-style cost blowup | Never traversed for search; a separate, explicitly-viewed artifact |
| Storage | Live in-memory structure, serialized into the store | Disposable, versioned JSON cache — safe to delete anytime |

### 4.1 Design, adapted from Tolaria's concept-graph ADR

Modeled on [`docs/designKnowledgeGraph.md`](./designKnowledgeGraph.md)
(Tolaria's ADR-0175, itself adapted from
[rahulnyk/knowledge_graph](https://github.com/rahulnyk/knowledge_graph)):

- **Two edge types.** W2 (same-chunk proximity, always same-file) from
  concepts the LLM extracts together out of one heading-bounded chunk of a
  note. W1 (explicit relation, cross-file when applicable) from real
  `[[wikilink]]`-style references in a note's body, resolved against a
  `title → id` map built from the vault listing already held in memory.
- **One LLM call per new note**, not per chunk — all of a note's chunks are
  batched into a single structured-JSON-output call via `ctx.llm.stream()`,
  imitating the existing `packages/session/session-title-first-prompt-llm`
  pattern. No new credential is needed; it reuses whichever model DSH already
  has configured.
- **Incremental consolidation.** Because extraction only ever runs for the
  newly written note, merging is: normalize new concept names against
  existing nodes, sum edge weights for recurring pairs, add anything new,
  append this note's path as edge provenance. Community detection uses
  connected-components via union-find — the same deliberate simplification
  over full Louvain clustering that Tolaria made, "fine for small-to-medium
  graphs."
- **Never backfilled.** Old notes, or notes written by hand directly into
  the vault folder, never enter the concept graph — an explicit, confirmed
  decision, not a gap. This is what keeps the cost model bounded and
  predictable: the LLM cost is always proportional to *new* writes only.
- **Opt-in** (`enableConceptGraph: false` by default) — unlike embeddings,
  which degrade silently to keyword-only search on failure, this puts a real
  LLM call into a previously LLM-free write path, so it must be a deliberate
  choice.

### 4.2 The cheap complement: "related notes," no LLM at all

A `Smart Connections`-style feature needs no new infrastructure — `memory_related`
embeds a given note's own content and vector-searches the rest of the vault,
excluding itself. This answers "what else relates to *this* note" the way
Smart Connections does (ambient, cheap, note-to-note), which is a genuinely
different question from what the concept graph answers ("what concepts live
across my notes and how do they connect," surfacing a concept spanning five
notes none of which directly link to each other — structurally impossible
for a similarity ranking alone). They're complementary, matching the
comparison Tolaria's own design doc draws between its concept graph and
Obsidian's Smart Connections plugin.

### 4.3 Visualization: a served web page, not a chat card

DSH's chat-facing tool output is a closed set — `TextBlock`, `ReasoningBlock`,
`ImageBlock`, `ToolCallBlock`, `ToolResultBlock` (`packages/core/tools/src/schema.ts`,
`presentation.ts`) — with no interactive canvas, SVG, or iframe card type. So
the concept graph is rendered as a **separately served page**, following
`dsh-plugins/web-terminal`'s established pattern: `ctx.webServer.register()`
serving a static HTML+JS page with a hand-rolled Canvas2D force simulation
(repulsion + weighted springs + centering — the same no-dependency choice
Tolaria validated at real vault scale, avoiding a `d3-force`/`cytoscape`
dependency) plus a small JSON data route reading the current cache file.
`memory_remember`'s result text includes the graph's URL when the feature is
enabled, so the agent can hand it to the user directly.

### 4.4 Per-query graph expansion: closing the "no queryable graph" gap, opt-in

**Implemented (2026-08-19).** A follow-up comparison against GBrain's `entity`
verb surfaced a real, narrower gap distinct from the traversal question §4
already settled: GBrain lets an agent *query* its graph as part of the normal
tool surface; this plugin's concept graph, until now, was reachable only as a
passive web visualization (§4.3) — no tool could read it. Query-time
traversal itself was correctly rejected (the automatic, every-search version
is exactly GBrain's token-cost problem), but "no way to ever query the graph
from a tool call" was a gap, not a decision.

Closed via an **opt-in, per-query** flag rather than automatic traversal,
which is the actual reason this doesn't reopen the rejected question:
`memory_recall` now accepts `expandWithGraph?: boolean` (default `false`).
When set, and only when `enableConceptGraph` is on for the vault, it looks up
the concepts attached to the hybrid search's top hits in the cached
`concept-graph.json` and walks one edge hop out (`graph-expansion.ts`'s
`findGraphNeighborNotes`) to find other notes connected via a shared concept
or a `[[wikilink]]` edge that hybrid search didn't already surface. This
costs no LLM call at query time — the graph itself was already built
incrementally at write time (§4.1) — so the only cost is an in-memory walk,
bounded and paid only when a caller explicitly asks for it, never on every
`memory_recall`. When `enableConceptGraph` is off, the flag is silently a
no-op rather than an error; the result's `graphExpansionAvailable` field
tells the caller whether expansion actually ran.

**Placement is caller-selectable**, resolving a design question raised
directly: whether graph-expanded hits should be merged into the normal
ranked results or kept visibly separate. `graphResultPlacement?: 'merged' |
'separate'` (default `'merged'`) lets the caller choose per query — `'merged'`
appends graph hits to `results` marked `via: 'graph'` (direct hits are
`via: 'search'`), `'separate'` returns them in their own
`graphExpandedResults` array instead, keeping `results` to direct hits only.
Neither is privileged as "more correct" — an agent that wants one ranked list
to hand to a model uses `'merged'`; one that wants to tell the two apart
explicitly (e.g. to caveat graph-derived suggestions differently) uses
`'separate'`.

**Traversal depth is a parameter, not a decision baked into the shape.**
`findGraphNeighborNotes(graph, sourceNoteIds, excludeNoteIds, hops = 1)`
takes `hops` as an argument; `memory_recall` always calls it at the default
today, and the tool schema doesn't expose it yet — ships at 1 hop
deliberately narrow, per this design's general v1 posture, but extending
depth later (or exposing it as a tool arg) is a call-site change, not a
rewrite. One structural note from building this: a W2 (same-file)
concept-concept edge only ever connects two concepts *both* produced by the
same note's own chunks, so it can never reveal a note beyond that note's own
hop-0 frontier — genuine hop-1-only discovery in the current graph shape
comes exclusively from W1 wikilink note-note edges. Not a bug, just a
property of how `concept-graph.ts` builds edges, worth knowing before
reaching for `hops > 1` expecting it to surface more via W2 alone.

## 5. Why this is a lightweight GBrain, not a reimplementation of it

### 5.1 Architecture and cost model

| | GBrain | `dsh-plugin-knowledge-hub` (as built) |
|---|---|---|
| Memory storage | Postgres (PGLite embedded, or managed Supabase/pgvector) | Plain markdown files with YAML frontmatter, one per memory, at a user-configured `vaultPath` — git-diffable, human-editable, no database anywhere |
| Auditability | Opaque unless you query the DB directly | Two independent layers: the markdown files themselves (open any `.md`), plus an append-only JSONL audit log (`audit-log.ts`, `.audit-log.jsonl` in the vault) read back via `memory_audit` |
| Retrieval engine | pgvector hybrid search — real and capable | `memory-index.ts`: `@orama/orama` hybrid BM25 + local-embedding vector search (RRF fusion), in-process, rebuilt in memory on every plugin start — same core retrieval capability, zero server |
| Embeddings | Managed/API-based (implementation-dependent) | Fully local: `@xenova/transformers`, `Xenova/all-MiniLM-L6-v2`, 384 dims (`embedding.ts`) — no per-call cost, no network dependency, degrades gracefully to BM25-only on load failure |
| Knowledge graph | Traversed per query; real user reports call this token-expensive | No graph traversal at query time, ever — `memory_recall`/`memory_related` are pure hybrid search. The one graph that exists (`concept-graph.ts`) is opt-in, incremental-only (new notes only, never backfilled), and structurally never touched by search (§4) |
| Tool surface | 80+ operations by default (`--surface verbs` mitigates only if the caller remembers to use it) | Exactly 5 tools, no more: `memory_remember`, `memory_recall`, `memory_list`, `memory_audit`, `memory_related` — the surface is exactly as large as what's built, by construction, not by a config flag someone has to opt into |
| Network reachability | HTTP, via a managed server | Runs in-process inside DSH; the concept graph's visualization is the one thing served over HTTP (`ctx.webServer`, §4.3) — a future full MCP server surface (§6) is possible without restructuring anything already built |
| Operational cost | Real, reported: "several users fork and monitor upstream changes," managed-Postgres paid dependencies possible | No server, no paid dependencies, no upstream to track — the tradeoff is that this plugin is built and maintained here instead of adopted wholesale |
| Reload/restart cost | Not applicable — GBrain is a persistent Postgres service queried live; there is no "reload the vault" step to pay for, so it never had to solve this | **Fixed (2026-08-19), built here, not adapted from GBrain** (investigated directly — GBrain's own docs show no incremental-reindex or embedding-cache pattern to borrow, since its architecture never faces this problem): `embedding-cache.ts` is a content-hash-keyed cache (`.embedding-cache.json` in the vault) — a note is only re-embedded when its content hash has changed since the last boot. `memory-index.ts`'s Orama structures are still rebuilt in memory on every start (cheap, pure in-process tokenization), but the actually-expensive part — local-model embedding inference — now scales with *changed* notes only, not the whole vault. Covered by `embedding-cache.test.ts` plus `memory-index.test.ts`'s vector-passthrough tests (fake `embeddingFn`, no model download). The same hash also solves §5.4's hand-edit-detection problem, not just cost — see there. |

### 5.2 What actually exists today, concretely

| Capability | GBrain | This plugin |
|---|---|---|
| Write | `remember` verb → Postgres row | `memory_remember` → atomic markdown write + index + audit-log entry (`vault-store.ts`, `writeFileAtomic`) |
| Search | `recall` verb → pgvector query | `memory_recall` → `MemoryIndex.search()`, hybrid BM25+vector, tag post-filter |
| Browse | via `context_pack`/`recall` with filters | `memory_list` → metadata-only, tag-filterable, no search cost |
| Audit | not a first-class verb | `memory_audit` → reads `.audit-log.jsonl`, filterable by entry/operation |
| Note-to-note similarity | not distinguished from `recall` | `memory_related` → embeds the source note itself as the query, no LLM call (the "Smart Connections" answer, §4.2) |
| Structured knowledge graph | `entity` verb + Postgres graph tables, queried per-request | `concept-graph.ts`: LLM-extracted concept nodes, incremental merge, union-find communities, disposable JSON cache — opt-in, never queried by search |
| Graph visualization | none shipped | Force-directed Canvas2D page served at `conceptGraphWebPath` (`web/concept-graph-page.ts` + `concept-graph-server.ts`) |
| Verification | (external project, not verified here) | 54 tests across 10 files, all hermetic (no live LLM/network calls), clean `tsc --noEmit` |

The tradeoff GBrain accepted — real infrastructure investment in exchange
for a mature, general-purpose memory platform — is the one this design
declines. What's kept is the actual value: real hybrid retrieval (not
substring matching, which is what a from-scratch effort might have shipped
instead), a small stable tool contract, and durable cross-session memory —
now implemented and tested, not just specified.

### 5.3 "Can the user view/edit their memory?" — a two-tier answer elsewhere, collapsed to one here

`docs/designCognitiveBrain.md` — a broader, related spec (mobile/web/desktop
tiered "Hybrid Cognitive Memory Platform," not GBrain itself, though GBrain
informed its desktop tier) answers this question by drawing a hard line
between two things it both calls "memory," with only one editable:

- **Raw episodic memory** (conversations, browser events, T0/T1 extractions)
  — **not editable.** Explicitly designed as opaque, local-only, append-only
  working state (its §5.1, §6.4). No viewer/editor UI exists or is planned
  for it anywhere in that doc; it exists purely to feed synthesis and
  context-pack assembly, then gets evicted/compressed by retention policies.
- **Synthesized vault artifacts** (the markdown knowledge a T1/T2 LLM
  synthesis pass produces *from* that raw memory) — **editable.** Its §5.5
  requires these to "remain inspectable, editable, portable, versionable,
  and human-readable": plain Markdown + YAML frontmatter, editable directly
  in Obsidian/GitHub/whatever vault provider is connected (§6.12).
- **Skills** (`packages/cognitiveBrain/extension/src/skills/`) are also
  user-editable — created/edited via a SkillPicker UI, exportable/importable
  as SKILL.md (§6.13) — the closest that design gets to an "edit your
  memory" surface, but that's instruction content, not episodic memory.
  (On its mobile tier, skills persist in an `op-sqlite`-backed table for
  fast access, with a canonical `SKILL.md` file copy under Expo
  FileSystem's `<documentDirectory>/skills/<name>/`, per its §7.1 tech
  stack and the actual native code — i.e. even its most "editable" surface
  still keeps a database as the primary store, with the file as a synced
  copy, not the source of truth.)

That two-tier split is there for a real reason in that design: raw memory
genuinely needs an opaque representation at that volume — browser/conversation
events, tiered LLM synthesis (T0–T3), retention/eviction, salience scoring —
none of which is something a person would want to open in a text editor
*before* synthesis compresses it into an artifact.

**`dsh-plugin-knowledge-hub` has no raw tier at all, so the question
collapses to one answer instead of two.** Every memory this plugin stores
*is* a markdown file with YAML frontmatter from the moment `memory_remember`
writes it (§3.1) — there is no separate opaque event log later promoted to
human-readable form by an LLM synthesis pass, and no database anywhere
holding the canonical copy while a file trails behind it. What
`docs/designCognitiveBrain.md` calls "the vault" (its one editable,
inspectable, portable tier) is this plugin's *only* storage tier — not the
end state of a pipeline. The tradeoff is real and explicit: this design
gives up automatic synthesis entirely (raw noisy events →
compressed executive summary happens nowhere here) — whatever an agent
writes via `memory_remember` is already the final, human-facing form, since
nothing will compress or upgrade it later. That's consistent with, not a
gap relative to, this plugin's own stated scope boundary (§7): no LLM
enrichment pipeline, no auto-synthesis, by design.

### 5.4 Future extension: an editing-UI plugin, and the hand-edit-vs-recalibration conflict

Not built, and not needed for v1 — the plugin's whole current interaction
surface is five tools, and nothing writes to an *existing* note's content
today (`memory_remember` only creates new notes; there is no
`memory_edit`). But if a future companion plugin adds a **web-based editing
UI** — a served page (the same `ctx.webServer` pattern as the concept-graph
page, §4.3) letting a person open a note in a browser and hand-edit it
directly through DSH, rather than only via an external text editor — two
new conflict classes appear that don't exist today:

1. **A stale write clobbering a hand-edit.** If any process (an agent's own
   follow-up write to the same note, or a hypothetical future
   auto-improve/resynthesis feature — none exist today, but
   `docs/designCognitiveBrain.md`'s T1→T2 resynthesis relationship is
   exactly this failure mode) writes back to a note's file without checking
   what's currently on disk, it can silently overwrite whatever a person
   just hand-edited moments earlier.
2. **A hand-edit silently going stale in the index.** The reverse problem:
   a person edits a note directly, but nothing tells the search index or
   the embedding cache (§5.1) that the file changed, so `memory_recall`
   keeps returning stale embedded content until the next full rescan.

**#2 is already solved as a side effect of the content-hash-keyed embedding
cache** (§5.1, built 2026-08-19 in `embedding-cache.ts`): every note's
content hash is computed and compared on boot to decide whether to
recompute its embedding. A hand-edit changes the hash, which the cache
already treats as "recalibrate this note" — no separate mechanism needed.
The hash isn't just a performance optimization; it doubles as exactly the
change-detection signal an editing UI needs, and this half of the problem
is no longer hypothetical — it's the actual, running mechanism.

**#1 needs one of three strategies, to decide before any future editing UI
plugin is built** — deliberately left open here, not decided, since nothing
in the current tool surface needs an answer yet:

- **Hash-check-before-overwrite** — any writer compares the file's
  on-disk content hash against the hash it last read before deciding to
  write; a mismatch means someone else touched it since, and the write is
  refused (or the caller is told to re-read and retry). Cheapest to build
  — reuses the exact same hash the embedding cache already maintains — but
  a caller has to actually handle the rejection.
- **Diff-and-merge** — attempt a text-level three-way merge (last-known
  content, current disk content, new content) before failing. More
  forgiving to the user, meaningfully more code, and can still produce a
  merge conflict a person has to resolve by hand anyway.
- **Lock hand-edited notes from auto-rewrite** — the simplest option: once
  a person has hand-edited a note (detectable via the same hash mismatch),
  set a frontmatter flag (e.g. `locked: true`) that any future auto-rewrite
  feature must check and skip. Cedes automatic improvement of that note
  forever unless a person clears the flag, but needs no merge logic at all.

### 5.5 Warning the user that an edit is expensive

Any future editing UI must surface, at the point of edit — not buried in a
settings page — that saving a change to a note is not free: per §5.1's
embedding-cache design, a changed content hash forces that note's embedding
to be recomputed on the next reindex. Cheap with the default local
`@xenova/transformers` model, but a real, visible cost if a deployment has
been pointed at an API-based embedding provider instead (via the
`ctx.credentials`-scoped provider extension point, §6). A plain
confirmation alert before save — "Saving this edit will re-index this note
(recompute its embedding) the next time the vault reindexes" — is
sufficient; no rate-limiting or batching is needed, since a person editing
notes by hand won't trigger this at a volume that matters, and automation
(which could) has no UI alert to click through anyway.

### 5.6 Two cheap wins worth adopting from `docs/designCognitiveBrain.md`

Status: **implemented (2026-08-19)** — `resource` field in `types.ts`/
`frontmatter.ts`, contradiction check in `contradiction.ts` wired into
`memory_remember`. 6 new tests (`contradiction.test.ts`) plus frontmatter
round-trip and `index.ts` integration coverage; 76/76 tests passing.

A broader comparison against that doc (2026-08-19) turned up mostly
orchestration-layer concepts DSH's own agent runtime already owns
(`IIntelligenceEngine`, workflow DAGs, skill instruction injection,
`IWorkflowPersistence`) — adopting those into this plugin would be scope
creep, not a gap. Two items are different: schema-level, cheap, and
genuinely worth carrying over.

**OKF-compatible frontmatter.** That doc's §5.5 adds three fields to its
own frontmatter schema to become minimally compliant with the [Open
Knowledge Format v0.1](https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing):
`type` (already present here), `resource` (a canonical source URL, `null`
for notes with no external origin), and `timestamp` (an OKF-shaped alias
for the last-update time). This plugin's `MemoryFrontmatter` (§3.1) already
has `type`; adding `resource` costs nothing structurally — most notes will
simply omit it — and buys the same interoperability payoff their doc
identifies: any OKF-aware external tool can read this vault's notes without
translation. `timestamp` is redundant with the existing `updatedAt` field
and isn't worth adding as a second name for the same value; `resource` is
the one genuinely new field:

```yaml
---
id: 01JBXK7QG3Z8V6R2N4T9F5W1YB
title: "Rahul prefers dark-mode editors"
type: note
resource: null                  # NEW — source URL, or null for a note with no external origin
tags: [preferences, editor]
createdAt: "2026-08-18T10:03:00.000Z"
---
```

**Contradiction flagging.** That doc's `PageFrontmatter.contradictedBy[]`
field, backed by `ConflictDetector.ts` (originally catalogued as
REFERENCE-ONLY in this design's own inventory, §2.2 — "interesting but
needs entity extraction we're not building"; read in full on 2026-08-19),
flags when a new note plausibly conflicts with an existing one, e.g. "Rahul
prefers dark-mode editors" written months before "Rahul now prefers
light-mode editors." Its actual heuristic doesn't need the entity
extraction that blocked adoption: it groups candidate entries (in its case,
by shared `entities[]`; we don't have that field) and then tests content
against eight fixed negation-pattern pairs — `is`/`is not`, `can`/`cannot`,
`will`/`won't`, `always`/`never`, `enabled`/`disabled`, `active`/`inactive`,
`succeeded`/`failed`, `approved`/`rejected` — flagging a match when one
entry's content hits the positive pattern and the other hits its negation.
Zero LLM calls, zero entity model.

The adoptable version combines this with the mechanism already proposed
here, since the two signals are complementary rather than redundant:
similarity + shared tag answers "are these two notes about the same
thing," and the negation-pattern check answers "does one of them assert
the opposite of the other" — neither alone is as strong as both together,
and running eight regex tests against an already-narrowed candidate pair's
`content` costs nothing. At `memory_remember` time: run the new note's
embedding (already computed for indexing, §3.2) against the existing vault
via the same vector search `memory_related` already does (§4.2); for any
high-similarity match sharing an overlapping tag, additionally run the
eight negation-pattern pairs against both notes' content; if a pair hits,
surface it back to the caller as a soft warning with higher confidence than
similarity alone would justify — `contradictedBy` added to frontmatter only
if the calling agent confirms it's a real update, not inferred
automatically. Still no LLM call, no new dependency, opt-in at the response
level rather than a silent auto-tag.

**As built:** `findPossibleContradiction()` in `index.ts` takes the top 5
hits from a search against the *existing* vault (run before the new note
is indexed, so it never matches itself), filters to candidates sharing at
least one tag with the new note, and runs `findContradiction()`'s eight
negation-pattern pairs against the first such candidate's content. A hit
returns `{id, title, path, reason}` as `memory_remember`'s optional
`possibleContradiction` result field (and in its rendered text) — nothing
is ever written to `contradictedBy` automatically, matching the "only if
confirmed" design above; there's no `memory_edit` tool yet to act on a
confirmation, so acting on it remains a future extension.

**A second real bug surfaced while testing this** (2026-08-19, distinct
from and more consequential than the feature itself): the first version of
this test used two obviously-contradictory, tag-overlapping notes and
still found nothing. Root cause — and it explains §3.5's earlier,
incompletely-diagnosed live-test recall gap too, see the correction there
— `memory-index.ts`'s `bm25Search()` never set Orama's `threshold` option,
defaulting to `0`, Orama's strictest setting (near-total query-term overlap
required). Fixed by setting `threshold: 1`. This means the contradiction
feature was actually validating a real, independent indexing defect, not
just its own logic.

### 5.7 `IIntelligenceEngine` has no equivalent in this plugin, by design — DSH already split it four ways

`docs/designCognitiveBrain.md` names the same memory/intelligence split
this design has relied on throughout (§2.4, "Platform Separation
Principle"), but bundles the *intelligence* half into one interface:

```typescript
interface IIntelligenceEngine {
  execute(workflow: WorkflowDefinition): Promise<WorkflowResult>
  stream(workflow: WorkflowDefinition): AsyncIterable<WorkflowStreamEvent>
  executeSkill(id: string, args: unknown): Promise<unknown>
  listSkills(): SkillMeta[]
}
```

One object owns the LLM streaming loop, tool/skill dispatch, and workflow
(DAG) execution together — on web/mobile it's implemented by
`WorkflowExecutor` plus 8 fixed agent archetypes (SCOUT, LENS, QUILL,
FORGE, WEAVE, NEXUS, VISION, TOOLS); on desktop it doesn't exist at all —
an external agent platform (Claude Code, OpenClaw, Hermes) plugs into
`IBrainEngine` directly over MCP instead (§6.1.2 of that doc).

**DSH already *is* the desktop half of that story, and it goes one step
further: it splits even the "intelligence" side into separately composed
Cordis plugins, not one interface.** Investigated directly (2026-08-19):

| Responsibility inside `IIntelligenceEngine` | DSH's equivalent plugin | What it actually owns |
|---|---|---|
| The streaming LLM loop (`stream()`) | `@deepseek-ai/dsh-agent-loop` (`packages/core/agent-loop/`) | The concrete loop driver — the only package in the harness with actual loop logic, owns the real `ctx.llm.stream(request)` call, drives session/turn/step lifecycle |
| Tool/skill dispatch (`executeSkill()`) | `@deepseek-ai/dsh-tools` (`packages/core/tools/`) | Its own pipeline (`tools/pre-execute` → guards → `tools/execute` → `tools/post-execute` → `tools/result`), invoked *by* the loop via `ctx.tools.execute(...)`, not embedded inside it |
| Session/working-memory state | `@deepseek-ai/dsh-session` (`packages/core/session/`) | The event-sourced, append-only session log the LLM message history is derived from — this is DSH's version of that doc's Tier-1 "working memory" (§6.4) |
| Agent identity, decoupled from the loop | `@deepseek-ai/dsh-agent` (`packages/core/agent/`) | Just the `Agent` interface + registry + event vocabulary, with zero dependency on the loop implementation — this is what makes the loop itself swappable, and what other consumers (the web UI, an ACP bridge) program against instead of the concrete loop |

None of these four is the memory/knowledge layer — that's
`dsh-plugin-knowledge-hub` (this design's `IBrainEngine` analog), composed
alongside them as one more plugin, not merged into any of the four above.

**The consequence for this design:** `docs/designCognitiveBrain.md`'s
`IIntelligenceEngine` has no equivalent inside `dsh-plugin-knowledge-hub`,
and shouldn't get one. Adopting workflow-DAG execution, skill-instruction
injection, or `IWorkflowPersistence` into the knowledge-hub plugin (raised
and rejected in §5.6's framing) would mean re-implementing a layer DSH
already has — and arguably a *more* decoupled version of it, since DSH
keeps the loop, tool dispatch, and session state as three independently
swappable Cordis plugins rather than one bundled interface a caller has to
take or leave as a whole. The knowledge-hub plugin's only job is to be a
good `ctx.tools`-registered dependency *for* `dsh-agent-loop` to call into —
exactly the shape §1 already commits to ("the knowledge hub is one plugin
among others, composed via dependency injection").

### 5.8 The right long-term direction for storage/indexing: stay the course, two scoped follow-ups

With the embedding cache built (§5.1), it's worth being explicit about
what "long term" means here, since the temptation after any performance
fix is to keep reaching for more infrastructure. It doesn't, for this
plugin: markdown-as-source-of-truth plus an in-memory Orama index rebuilt
on every boot is the right architecture at this plugin's actual target
scale (a personal vault), indefinitely, not just for v1. Rebuilding
Orama's BM25 structures from scratch is pure in-process tokenization — it
stays cheap well into the thousands of notes, long before it would rival
the embedding-inference cost §5.1 already fixed. Reaching for SQLite or
Postgres for this plugin's own index would reintroduce exactly the
opacity/dependency tradeoff the whole design rejected GBrain for (§5.1); if
a genuine need for multi-user or much-larger-scale storage ever
materializes, the right answer is a new hub tier per §1's hub-and-spoke
framing, not rewriting this plugin.

Two things do need attention eventually, both incremental, neither an
architectural rewrite — recorded here as scoped next steps, not built now:

- **The embedding cache rewrites its entire `.embedding-cache.json` file on
  every single `memory_remember` call** (`persistEmbeddingCache()` in
  `index.ts`). Fine at today's scale, but as the vault grows this
  full-read-parse-rewrite cycle is the next thing to get slow — well before
  Orama's own rebuild does. The fix, when it matters: make the cache
  append-only JSONL, the same shape `audit-log.ts` already uses, instead of
  a single JSON blob rewritten whole on every write.

  **Concrete trigger, not a vague "when it matters":** each cache entry is
  a 64-char content hash plus a 384-dimension embedding array; `JSON.stringify`
  on a full-precision float (e.g. `-0.05416271090507507`) runs ~19
  characters per number, so one embedding serializes to ~384 × 19 ≈ 7.3KB,
  plus ~100 bytes of hash/key/structural overhead — call it **~7.5KB per
  note**. That puts 1,000 notes at ~7.5MB, 2,000 at ~15MB, 10,000 at
  ~75MB. A full read-parse-mutate-serialize-write cycle on a file in the
  low tens of MB adds real, user-visible latency — tens to low hundreds of
  milliseconds — to every `memory_remember` call. Build the JSONL version
  when **either** `.embedding-cache.json` passes roughly **10–20MB (~1,500–
  2,500 notes)**, **or** direct measurement shows the persist step adding
  more than **~100ms** to a `memory_remember` call — whichever comes first.
- **No file watcher.** Out-of-band hand-edits to a vault file are only
  picked up on the next full rescan (plugin restart), per the existing
  scope boundary in §7. This isn't hypothetical for a long-running profile
  — a `web`-profile DSH process can stay up for hours, during which a
  hand-edit made through an external editor is invisible to `memory_recall`
  until restart. Not urgent for short-lived headless tasks; a real gap for
  continuous-uptime interactive use.

  **Concrete trigger:** not a size or time threshold — this is about *how*
  notes get edited, not *how many* exist. The forcing function is a
  specific milestone: **if/when the §5.4 editing-UI plugin actually gets
  built.** Today, hand-editing a vault file while DSH is running is a rare
  edge case (someone happens to have the `.md` file open in an external
  editor mid-session). Once a browser-based editing UI is served *through*
  DSH itself, hand-editing while the process is live stops being an edge
  case and becomes the *primary* edit path — at that point "restart to see
  your own edit" is an obviously broken UX, not a tolerable gap. Absent
  that plugin ever being built, the secondary trigger is empirical: an
  actual report of `memory_recall` returning stale content after a
  hand-edit made during a long-running session.

### 5.9 A second GBrain comparison (2026-08-27): pluggable multi-KB engines, skills benchmarking, CLI orchestration, gateways, audit, backfill, self-update

A follow-up question posed a longer, more marketing-shaped description of
GBrain's own feature set — paraphrased: *"manages knowledge as structured
data through a pluggable engine architecture, connections to multiple
knowledge bases; a skills system that orchestrates how inputs resolve into
actions, with skills continuously optimized against benchmarks through an
automated process; an AI agent 'brain layer' providing synthesis, knowledge
graph traversal, and gap analysis; the main entry point for CLI operations,
orchestrating command dispatch, configuration, and connections to
processing engines; managing AI gateways and models, generating advisory
recommendations, comprehensive audit logging, backfill operations, and
self-update mechanisms"* — and asked whether DSH's architecture does the
same. Each claim was checked directly against DSH's real source (not
`docs/packages/cognitiveBrain`, which is a vendored reference copy, and not
assumed from memory):

| Claim | Found in DSH? | What's actually there |
|---|---|---|
| Pluggable engine managing **multiple** knowledge bases | **No, narrower.** | `knowledge-hub`'s `VaultStore` is one flat-directory markdown vault, one configurable path — "Local filesystem only — no MCP, no remote vault provider" per its own doc comment. No registry lets multiple heterogeneous KB backends be swapped in or run simultaneously; DSH's general Cordis-plugin pattern is whole-app composition, not a knowledge-base-specific multi-engine abstraction. |
| Skills **continuously optimized against benchmarks** through automation | **Not found.** | `packages/skill/skill` and `dsh-plugins/skillhub` install/manage skills as authored artifacts (registry, install, state). No benchmark suite, scoring loop, A/B testing, or auto-tuning code exists anywhere in the repo. Skills are written and installed, never measured or iterated on automatically. |
| "Brain layer": synthesis, graph traversal, gap analysis, nuanced answers not raw search | **Already settled — reconfirmed.** | §2.2/§4/§6.1 already reject this for `knowledge-hub` specifically. This pass confirmed the negative more broadly: `KnowledgeGapDetector.ts` and similar DO exist in this repo, but only inside `docs/packages/cognitiveBrain/` — GBrain's own vendored source, not DSH code. No other DSH subsystem does query-time graph traversal or gap analysis. |
| Main CLI entry point orchestrating dispatch/config/engine connections | **Yes, real match.** | `apps/cli/src/bin.ts` is the executable entry; `profile-boot.ts`/`plugin.ts` drive Cordis profile/plugin boot; `args.ts` handles command dispatch/config parsing; the bundle packages (`base`, `headless`, `web-app`) wire in engines (`llm`, `skill`, `knowledge-hub`, etc.) as Cordis services. This is a genuine, pre-existing DSH capability at the whole-application level — nothing to adopt, it's already the CLI's job. |
| Managing AI gateways and models | **Yes, narrower/differently shaped.** | `packages/llm/llm` (`ctx.llm`, `LlmRuntime`) is a real multi-provider adapter registry (`llm-deepseek`, `llm-pi-ai`, etc.). `packages/api/gateway` is a false match to rule out explicitly — its own README describes it as internal Host↔Client RPC dispatch, unrelated to model/provider gateway concerns. |
| Generating advisory recommendations | **Not found.** | No general recommendation-generation subsystem exists anywhere in `packages/` or `dsh-plugins/`. |
| Comprehensive (system-wide) audit logging | **Narrower than it sounds.** | Only `dsh-plugins/knowledge-hub/src/audit-log.ts` exists (§3.3). No cross-plugin or system-wide audit log package. |
| Backfill operations | **Not found, and explicitly rejected where it would matter most.** | No general backfill mechanism exists anywhere in DSH. `knowledge-hub`'s concept graph explicitly states "never backfilled," "no bulk-backfill tool" (§4.1, §9) — a deliberate decision, not a gap to close. |
| Self-update mechanisms | **Not found.** | No update-checker or self-update code anywhere in `apps/cli`; only unrelated hits were Dependabot (dev-time dependency bumps, not a runtime/CLI-facing mechanism) and git's own sample hooks. |

**Net read:** this description matches GBrain's own feature set closely —
the pluggable multi-KB engine, benchmark-optimized skills, and most of the
fifth bullet (advisory generation, comprehensive audit, backfill,
self-update) read as close paraphrases of GBrain's own documentation, not
things DSH built or was ever asked to build as part of this design. DSH's
CLI-orchestration and LLM-gateway capabilities are real and pre-existing
(items 4 and part of 5) but narrower/differently named than described. None
of the genuinely-missing items (multi-KB pluggable engine, skills
benchmarking, system-wide audit, backfill, self-update) were adopted here —
they fall outside this design's stated goal (§0: "a lightweight equivalent
of GBrain," not a full reimplementation) and would be new scope, not a gap
in what was already decided.

## 6. MCP and plugins: how features get added later

The knowledge-hub plugin is deliberately not the only place new capability
can live. Three extension points, none requiring changes to the core plugin:

- **New DSH plugins composed alongside it.** Multi-source ingestion (Slack,
  WhatsApp, bookmarks, web reads — explicit future work per
  `docs/knowledge-hub-architecture.md`) becomes a separate plugin that writes
  into the same vault format, reusing `vault-store.ts`'s markdown+frontmatter
  contract without needing to touch `memory-index.ts` or the tool surface.
  `adapters/desktop/ingestors/{FileIngestor,URLIngestor,PDFIngestor}.ts` and
  `extension/src/lib/parseHtmlToMarkdown.ts` (Defuddle-based HTML→markdown)
  are the reference points to return to when that's built.
- **An MCP server surface** — **built (2026-08-19)** as
  `dsh-plugins/mcp-server`, see §6.1 below.
- **`ctx.credentials`-scoped provider plugins** for anything needing its own
  API key independent of DSH's default model configuration (the pattern
  already established by `dsh-plugins/vision-bridge` and `skillhub`), should
  a future feature want a specific extraction or embedding model regardless
  of the harness's main chat model.

None of this requires anticipatory design work now — the point of building
the core plugin lean is that these are genuinely separable additions later,
not refactors of something that grew a monolith.

### 6.1 MCP server (outward): built, deliberately capped at existing tools

`dsh-plugins/mcp-server` exposes a configurable allowlist of `ctx.tools` —
default: the five knowledge-hub tools — as an authenticated MCP Streamable
HTTP server, so an external app (Pluely, or any MCP client) can call into
this DSH instance. This resolved a real scope tension worth recording:
the request that motivated this plugin also asked DSH to *"provide AI
agents with persistent memory by synthesizing information, traversing
knowledge graphs, and analyzing knowledge gaps"* — i.e., reproduce GBrain's
own capability tier, not just its transport. That's a direct reversal of
§2.2's rejection of auto-synthesis and §4's rejection of query-time graph
traversal, and new territory entirely for knowledge-gap analysis (GBrain's
"Autonomous Cognition" tier, never scoped here). Resolved by splitting the
request in two: the **transport/security posture** (HTTP, bearer-token
auth, IP- and token-based rate limiting, a loopback-vs-remote trust
boundary) is infrastructure, adopted directly from what GBrain documents
for its own MCP HTTP surface; the **capability surface** stayed exactly
the five existing tools, with synthesis/traversal/gap-analysis explicitly
declined, per the same reasoning that shaped this design throughout.

Implementation notes worth keeping: a hand-written zod input schema per
exposed tool (`tool-bridge.ts`) rather than a generic arbitrary-schema
bridge — an allowlisted tool name with no hand-written schema is skipped
with a warning, not exposed with a guessed shape. **Stateful mode, not
stateless**, for the Streamable HTTP transport — tried stateless first
(`sessionIdGenerator: undefined`) since it looked like the simpler,
serverless-friendly option; confirmed broken by a real client round trip
(`Client.connect()` failing on the second of two requests) because
stateless mode can't correlate a client's `initialize` request with its
follow-up `notifications/initialized` notification across one long-lived
transport instance — it's designed for a fresh transport per request, not
a persistent process, which is exactly what this plugin is. 37 tests,
including a live integration suite running a real
`@modelcontextprotocol/sdk` `Client` against a real
`StreamableHTTPServerTransport` end to end.

### 6.2 MCP client (inward): DSH consuming an external server already works today

The companion direction — an external source (a knowledge-graph service,
a Jira/Confluence-style connector) feeding *into* DSH's own chat, staying
transparent (the user explicitly configures the connection) rather than
opaque like GBrain — turned out to already exist. `packages/mcp/mcp-client`
(core DSH, not a `dsh-plugins/` addition) supports exactly this, via
configuration alone, no new code:

- **Streamable HTTP transport** for a remote server, alongside stdio for a
  local subprocess (`transport: 'streamable-http'`, `url`, `headers` for a
  static bearer token — investigated directly, 2026-08-19).
- **Automatic registration into `ctx.tools`** on connect: the external
  server's tools appear as `mcp__<serverName>__<toolName>`, available to
  every chat turn exactly like a native DSH tool — no separate exposure
  step, no per-session wiring.
- Configured as one Cordis plugin instance per external server, added as a
  `cordis.yml`/profile patch entry — e.g. pointing `url` at a Jira MCP
  connector with `headers: { Authorization: 'Bearer ...' }` is enough to
  have its tools show up in chat.

**MCP resources — built (2026-08-19).** MCP **resources** (as distinct from
tools) previously had no consumer at all — `mcp-client`'s own README used to
say "Resources and Prompts have no harness consumer and are deferred." Fixed
in `packages/mcp/mcp-client/src/resources.ts`: each connected server that
advertises a `resources` capability now gets two synthetic on-demand tools,
`mcp__<serverName>__list_resources` and `mcp__<serverName>__read_resource`,
registered once per connection generation (wired in `connection.ts`,
disposed on disconnect/reconnect like everything else). A server with no
`resources` capability gets neither tool — no dead entries offered to the
model. This is the deliberately chosen, lower-risk alternative to automatic
context injection: no new context-budgeting/staleness/selection surface, the
model just pulls resources the same way it already calls tools (confirmed
via the earlier scope decision: "on-demand tool" over automatic injection).

A real bug surfaced while building this and is now fixed alongside it: a
server that registers zero *tools* never wires up a `tools/list` JSON-RPC
handler at all (a legitimate shape for a resource-only connector — e.g. a
Jira/knowledge-graph server with nothing callable), so `syncTools()` calling
it unconditionally threw `McpError`/`MethodNotFound` and failed the whole
connection attempt. Fixed in `tools.ts` by treating that specific error as
"zero tools" instead of a fatal failure; any other error still propagates.
Covered by `packages/mcp/mcp-client/tests/resources.spec.ts` (7 tests, real
stdio fixture servers, one with a `resources` capability and one without) —
99/99 tests pass across the package with zero regressions.

## 8. Consolidation: closing the redundancy gap without reopening the black-box tradeoff

**Implemented (2026-08-19).** §5.6/§5.3 rejected porting cognitiveBrain's
daily/weekly/monthly L0→L1→L2 consolidation for two reasons: this plugin has
no raw tier to distill (every note is already the final thing an agent chose
to write), and an autonomous background job silently rewriting notes is
exactly the "black box" quality the whole design exists to avoid. Both
reasons hold — but they don't cover a real, narrower gap: a vault of small
atomic notes accumulates redundancy over time regardless (the same fact
restated across sessions, an old fact quietly contradicted by a newer one),
and that's a genuine, distinct entropy problem neither reason addresses.

**A brief investigation of GBrain's actual source** (`docs/gbrain-master`,
a partial excerpt — an admin auth-scope file and a voice-assistant "recipe,"
not the core engine) surfaced that GBrain's own synthesis need is closer to
cognitiveBrain's than initially assumed: `context-builder.example.mjs`
documents a real raw tier (`$BRAIN_ROOT/memory/YYYY-MM-DD.md`, appended
through the day) feeding into synthesized artifacts (`SOUL.md`, a "stable
emotional landscape"; `topics/<topicId>.md`, "recent turns + a 2-3 line
synthesized summary... not a raw dump"). That's a genuinely different
problem, though — giving a persistent voice-assistant persona continuity
across calls — not "keep a searchable knowledge base free of redundant
facts." Neither GBrain's nor cognitiveBrain's actual motivation is what
this plugin needed to solve; the vault-entropy problem is narrower than
both.

**Resolved via `memory_consolidate`, an on-demand tool — not an autonomous
job — built entirely from primitives this plugin already had:**

- **`supersede`** proposals reuse `findContradiction` (§5.6) exactly as
  written: two tag-overlapping notes whose content asserts opposite sides of
  a negation pattern. `memory_consolidate` is the confirmation step §5.6
  said `contradictedBy` was waiting on — that field is only ever written
  once an agent explicitly calls this tool with `dryRun: false`, never
  automatically.
- **`merge`** proposals reuse the embeddings this plugin already computes at
  write time (`embedding-cache.ts`): two or more tag-overlapping notes whose
  cached embeddings are near-duplicates (cosine similarity ≥
  `similarityThreshold`, default `0.92`), clustered via the same union-find
  technique `concept-graph.ts`'s community detection already uses. Requires
  `enableEmbeddings`; reports `mergeAvailable: false` and proposes no merges
  otherwise, rather than silently doing nothing.

**No new LLM call, no content ever rewritten.** Applying a proposal
(`dryRun: false`, the default is a preview) only ever adds one frontmatter
field, `supersededBy: <keepId>`, to the superseded note(s) — the file body,
and the kept note's content, are never touched. Every application logs to
the audit trail as an ordinary `update` operation, same as any other
mutation — nothing about this ever runs invisibly, on a schedule, or
without being asked. Superseded notes are hidden from `memory_recall`/
`memory_related` (removed from the live search index, never re-indexed on
the next boot) and from `memory_list`'s default view, but never deleted —
`memory_list({ includeSuperseded: true })` still finds them, content fully
intact. Covered by `consolidation.test.ts` (11 tests: contradiction/merge
detection, tag-overlap prefiltering, multi-note cluster collapsing, the
`mergeAvailable` gate) and `agent-chat-integration.test.ts` (dry-run vs.
apply, audit-trail verification, real-embeddings merge).

## 9. What's explicitly out of scope

The automatic, per-query knowledge graph (`InProcessGraph`); the LLM
enrichment pipeline; auto-synthesis / a compiled wiki (would need a fresh
deterministic design, not adapted from `core/wiki/`); a file watcher for
hand-edited notes (restart to pick up out-of-band edits); `memory_forget`,
`memory_reindex`, `memory_get` tools; multi-source ingestion; chunking of
note content for embeddings (chunking exists only for concept-graph
extraction, §4.1); cross-device sync; a persisted on-disk index snapshot;
any bulk/backfill tool to pull pre-existing or hand-written notes into the
concept graph; and any autonomous/scheduled trigger for
`memory_consolidate` (§8) — it runs only when explicitly called. Each is a
stated boundary, not an oversight, so scope stays legible as this evolves.

## 10. Summary: what was adopted from cognitiveBrain and GBrain, and why

The full evidence for each row below lives in the section cited; this table
exists to answer one question in one place: *of everything either reference
system does, what actually made it into `dsh-plugin-knowledge-hub`, and on
what basis was that decided.*

**The adoption criterion, applied consistently throughout:** keep a
capability if it delivers real retrieval/audit value at a cost that's
either zero, local, or bounded-and-opt-in; reject it if its cost is
automatic/unbounded (every write, every query) or if it makes the vault a
black box (content mutated or generated without a person or agent asking).
Everything in the "Adopted" rows below satisfies the first; everything in
"Rejected" fails the second.

### From `docs/packages/cognitiveBrain` (§2)

| Adopted | Rejected |
|---|---|
| `OramaIndex`'s hybrid BM25+vector engine → `memory-index.ts` (§2.1, §3.2) — real retrieval value, in-process, no server | `InProcessGraph` — automatic, traversed on every search call (§2.2) — the exact GBrain-style cost blowup |
| `core/audit/*`'s append-only change-log pattern → `audit-log.ts` (§2.1, §3.3) — direct, cheap answer to "is memory auditable" | The LLM enrichment pipeline (10 processor stages) and `SynthesisEngine`/`MkdfAdapter` auto-synthesis (§2.2) — background mutation without being asked |
| `ObsidianVaultProvider`'s local-fs + `.md`+frontmatter pattern → `vault-store.ts`/`frontmatter.ts` (§2.1) — matches "no database" directly, real YAML lib swapped in for its hand-rolled parser | The `core/wiki/*` subsystem (§2.2) — looked like a lean compiled-wiki fit by name, was actually the same graph+LLM-synthesis pattern in disguise |
| `transformerOutputNormalizer` → `embedding.ts` (§2.1) — small, dependency-free, ported near-verbatim | Everything outside `memory/` — a browser-extension product and an unrelated mobile app, zero import relationship to a knowledge-hub concern (§2.2) |
| `ConflictDetector`'s negation-pattern heuristic → `contradiction.ts` (§5.6) — LLM-free once its `entities[]` grouping was swapped for tag+similarity | — |

### From GBrain (§5, §5.9, §6.1)

| Adopted | Rejected |
|---|---|
| The **transport/security posture** for an outward MCP surface — bearer-token auth, IP/token rate limiting, loopback-vs-remote trust boundary — infrastructure, adopted directly for `dsh-plugins/mcp-server` (§6.1) | The **capability surface** GBrain's own MCP exposes beyond existing tools: auto-synthesis, query-time graph traversal, knowledge-gap analysis (§6.1) — the "Autonomous Cognition" tier, never scoped here |
| The *lesson* of GBrain's 80+-tool bloat complaint → inverted into a hard constraint: exactly five tools (six after §8), sized to what's built, not a config flag (§3.4, §5.1) | Postgres/pgvector as the storage/retrieval backend (§5.1) — real capability, but reintroduces the opacity/dependency tradeoff this design exists to avoid |
| — | A pluggable engine managing multiple simultaneous knowledge bases (§5.9) — not built; `knowledge-hub` is one vault, one engine |
| — | Skills continuously optimized against benchmarks (§5.9) — no equivalent exists anywhere in DSH |
| — | Advisory-recommendation generation, system-wide audit logging, backfill operations, self-update mechanisms (§5.9) — none exist in DSH; each would be new scope, not a gap being closed |

**What this design added that neither source system has an equivalent
for:** the concept graph's two-typed-edge (W1/W2) incremental, never-
backfilled, opt-in design (§4, adapted from Tolaria's ADR-0175 —
`docs/designKnowledgeGraph.md` §7 covers that adaptation the other
direction) is closer to GBrain's structured-graph ambition than to anything
in cognitiveBrain, but rebuilt from scratch with different cost guarantees
(bounded per-note LLM cost vs. GBrain's per-query traversal cost). The
opt-in per-query graph expansion (§4.4) and on-demand `memory_consolidate`
(§8) are DSH-original answers to gaps both reference systems' own
comparisons surfaced — a queryable graph and a redundancy-reduction
mechanism — solved with primitives already in this plugin rather than by
porting either system's actual mechanism (GBrain's `entity` verb,
cognitiveBrain's L0→L1→L2 pipeline).
