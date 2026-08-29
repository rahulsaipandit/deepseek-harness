# Investigating a content-ingestion plugin: Instagram / YouTube / web pages → searchable knowledge base

Status: **investigation only** — no plugin exists yet. This document surveys
two external references (`sidinsearch/superbrain`, `viperrcrypto/Siftly`)
and this repo's own prior art, then lays out candidate approaches for a DSH
plugin. It stops short of picking one; see §7 for the open questions that
decide it.

## 1. The ask

Ingest Instagram posts, YouTube videos, and web pages; analyze them with an
LLM (summarize, tag, categorize, transcribe); store the result in a
self-hosted, searchable knowledge base. The natural DSH shape is a plugin
that exposes this as tools the agent (or a human via the tool surface) can
call.

**This is not greenfield.** DSH already has an implemented, tested knowledge
base plugin — `dsh-plugins/knowledge-hub/` (`dsh-plugin-knowledge-hub`,
documented in [`designCognitiveBrainForDSH.md`](./designCognitiveBrainForDSH.md))
— markdown-file vault, hybrid BM25+vector search (`@orama/orama` +
`@xenova/transformers`), append-only audit log, opt-in LLM-extracted concept
graph, and heading-based chunking, exposed as six tools
(`memory_remember`, `memory_recall`, `memory_list`, `memory_audit`,
`memory_related`, `memory_consolidate`). Any ingestion plugin's real question
is **whether it feeds this existing hub or builds a second, parallel store.**

## 2. What superbrain actually is

[`sidinsearch/superbrain`](https://github.com/sidinsearch/superbrain) is a
self-hosted **Android app + Python backend**, not a library:

- **Backend**: Python/FastAPI + SQLite (WAL mode), a multi-provider LLM
  router (Groq, Gemini, OpenRouter, Ollama) picked by an exponential-moving-average
  performance score, async processing queue.
- **Ingestion pipeline**:
  - *Instagram*: `Instaloader` (optionally authenticated) downloads the post.
  - *YouTube*: native video understanding via the **Gemini API** (not
    transcript extraction — Gemini ingests the video directly).
  - *Web*: `newspaper4k` + `trafilatura`, with Wayback Machine fallback.
  - Shared post-processing: frame extraction/vision analysis, audio
    transcription (Groq Whisper API, local `openai-whisper` fallback), music
    ID via `Shazamio`, LLM categorization/summarization/tagging.
- **Storage/search**: SQLite full-text search over titles/summaries/tags/
  transcriptions; manual "collections"; no vector search, no embeddings, no
  graph.
- **Mobile app**: React Native/Expo, offline-first queue, share-sheet intake.
- **License: AGPL-3.0.** This matters directly for reuse — see §5.

There's no MCP surface, no plugin/extension API, no agent-facing tool
protocol. It's a consumer app, architected for a phone user tapping "share,"
not for an agent harness calling structured tools.

## 3. What Siftly actually is

[`viperrcrypto/Siftly`](https://github.com/viperrcrypto/Siftly) is a
self-hosted **Twitter/X bookmark manager** with an AI categorization
pipeline and a visual mindmap explorer — a narrower, single-source cousin
of superbrain, not a general content-ingestion tool:

- **Ingestion**: exclusively Twitter/X bookmarks, imported via a
  bookmarklet or a DevTools console script that auto-scrolls the user's own
  bookmarks page and captures the tweet JSON. No Instagram, YouTube, or
  arbitrary web-page ingestion, and no server-side fetching at all — the
  browser (already logged into X) does the capture, sidestepping the
  auth/ToS problem superbrain's Instaloader path runs into (see §7).
- **4-stage AI pipeline**, resumable/interruptible: (1) free entity mining
  from the raw tweet JSON (hashtags, URLs, mentions, ~100 known tool names —
  zero API calls), (2) vision analysis of images/GIFs/video thumbnails (OCR
  + object tags), (3) semantic tagging (25–35 tags/bookmark, text+image
  combined), (4) categorization into 1–3 user-defined categories with
  confidence scores. AI calls route through a configurable provider
  (Anthropic Claude, OpenAI, or MiniMax) — notably it also auto-detects a
  local Claude Code/keychain session so a user with Claude Code installed
  needs no separate API key.
- **Storage/search**: SQLite + Prisma ORM, entirely local; **SQLite FTS5**
  full-text index over tweet text, OCR text, tags, and categories; its
  natural-language "AI search" layers Claude-based semantic reranking on
  top of FTS5 hits rather than using embeddings/vector search at all.
- **Stack**: Next.js 16 full-stack app (API routes + UI in one process,
  no separate backend), `@xyflow/react` for the mindmap visualization.
- **License: MIT.** No copyleft obstacle to reading or adapting its actual
  code, unlike superbrain.

Like superbrain, Siftly has no MCP surface or agent-facing tool protocol —
it's a browser-driven, human-facing web app, not something DSH would call
as a service. Its interest here is architectural: the **capture-in-browser,
no-server-fetch pattern** and the **FTS + LLM-rerank search** design are
both directly relevant, more so than superbrain's back-end shape.

## 4. What's directly reusable in DSH vs. what superbrain/Siftly would add

| Need | Already in DSH | superbrain | Siftly |
|---|---|---|---|
| Safe URL fetch (SSRF-guarded, redirect-limited, size/time-capped) | `ctx.web.fetch()` (`packages/web/web/src/index.ts:157-163`), backed by `dsh-web-fetch-http`'s `HttpFetchProvider` (`packages/web/web-fetch-http/src/provider.ts`), consumed by `dsh-tool-web`'s `web_fetch` | Raw `requests`/`newspaper4k`, no SSRF policy | N/A — no server-side fetch; browser captures via bookmarklet |
| Web-page text extraction | Not present — `web_fetch` returns fetched content, not article-extraction-quality text | `newspaper4k` + `trafilatura`, Wayback fallback | N/A |
| LLM calls | `ctx.llm` (`LlmRuntime`, provider-neutral, already used by `knowledge-hub`'s concept extractor) | Custom multi-provider router (Groq/Gemini/OpenRouter/Ollama) with EMA-based selection | Configurable single provider (Claude/OpenAI/MiniMax), Claude Code session auto-detect |
| Durable, searchable storage | `knowledge-hub`'s markdown vault + hybrid BM25/vector index + audit log | SQLite + FTS, no vector search | SQLite + Prisma + FTS5, no vector search |
| Semantic/NL search over non-vector index | Hybrid BM25+vector already covers this | Not described | FTS5 hits + Claude semantic **reranking** — a cheap alternative worth noting for a BM25-only deployment (`enableEmbeddings: false` in `knowledge-hub`) |
| Chunking long content | `knowledge-hub/src/chunking.ts` (heading-based) | None described (whole-post storage) | N/A (tweets are short) |
| Instagram download | Nothing | `Instaloader` | N/A |
| YouTube ingestion | Nothing | Gemini native video understanding | N/A |
| Audio transcription | Nothing | Groq Whisper API / local `openai-whisper` | N/A |
| Image/vision analysis (OCR, object tags) | Nothing | Frame extraction + vision analysis | Per-image vision analysis, 30-40 tags/image |
| Browser-side capture (no server fetch/auth needed) | Nothing | Mobile share-sheet (app-side, not browser) | Bookmarklet/console script — directly portable idea for any source gated behind a login wall |
| Free, LLM-less entity extraction pass before any AI call | Nothing | Not described | `rawjson-extractor.ts` — mines hashtags/URLs/mentions/known tool names for free before spending any tokens |

The overlap is small and one-directional from both references: neither has
storage/search DSH is missing (DSH's hybrid BM25+vector is stronger than
either's FTS-only approach), but between them they cover four capabilities
DSH has none of — Instagram scraping, YouTube video understanding, audio
transcription, and image/vision tagging — plus two *design patterns* worth
lifting regardless of source (browser-side capture for login-gated content,
a free entity-mining pass before any LLM call).

## 5. How DSH plugins are actually shaped (relevant to every option below)

DSH's capability packages (`packages/web/web`, `packages/storage/storage`,
etc.) follow a three-layer **Service Definition / Provider / Consumer**
split, cleanest in `packages/web/web`:

- **Service Definition** (`dsh-web`): a Cordis `Service` subclass registered
  as `ctx.web`, owning provider registries (`registerFetchProvider`/
  `registerSearchProvider`, keyed by id, effect-scoped disposal —
  `packages/web/web/src/index.ts:103-129`) and the execution methods
  (`fetch()`/`search()`, `:140-163`) that resolve one usable provider per
  call (`resolveProvider`, `:172-194`).
- **Provider** packages (`dsh-web-fetch-http`) are plain plugins:
  `name`, `inject = ['web']`, a schemastery `Config`, and an `apply(ctx,
  config)` that calls `ctx.web.registerFetchProvider(new
  HttpFetchProvider(...))`.
- **Consumer** packages (`dsh-tool-web`) turn the seam into model-facing
  tools via `ctx.tools.register(defineTool({...}))`, `inject = ['tools',
  'web', ...]`.

A new ingest capability that needs its own provider registry (Instagram
fetcher, YouTube fetcher, ...) fits this shape directly: a small seam
package owning the registry, separate provider packages per source,
separate from whichever package registers the model-facing tools.

**Packaging convention.** Installable, non-core capabilities like this live
under `dsh-plugins/<name>/` (standalone npm package, own tests, no
workspace:^ dependency on the monorepo — see `dsh-plugins/README.md` and
`docs/adr/rp_dshPlugins.md`), not `packages/`. `dsh-plugins/knowledge-hub/`
is the concrete template: `package.json` with `peerDependencies` on
`@deepseek-ai/cordis`/`dsh-tools`/etc., `src/index.ts` exporting `name`,
`inject`, a schemastery `Config`, and `apply(ctx, config)` that registers
tools via `defineTool`. It's installed with `dsh plugin add <path>` and
activated by inserting it into a profile's `cordis.patch.yml` (see
`dsh-plugins/knowledge-hub/README.md`'s activation section). `docs/subsystems/tools.md`
and `docs/capability-seams.md` document the general tool/seam conventions
this all instantiates.

## 6. Candidate approaches

### A. Vendor/adapt superbrain's Python backend directly

Copy or `pip install`-vendor its ingestion code into a DSH-adjacent Python
process, called from a plugin over HTTP or a subprocess bridge.

- **Blocked by license.** AGPL-3.0 requires that any network-reachable
  service built on this code publish its own source. If DSH (or a
  proprietary fork of it) embeds superbrain's backend and exposes it as a
  tool, that likely triggers AGPL's network-use clause. This is a legal
  question for whoever owns the DSH repo's licensing, not a technical one —
  flag it before writing any code that imports superbrain's modules.
- Even absent licensing, it means running and operating a second stack
  (Python/FastAPI/SQLite) alongside the Node/Cordis harness, duplicating
  storage (SQLite vs. the markdown vault) with no shared search index.

### B. Treat superbrain as inspiration only; build ingestion natively as new `knowledge-hub` tools

Add `memory_ingest_url` (and source-specific variants) directly inside
`dsh-plugins/knowledge-hub/`, reusing its existing vault/index/chunking/
audit-log machinery. Ingestion becomes: fetch → extract → LLM-summarize/tag
→ write as a `MemoryFile` (markdown + frontmatter, `resource` field already
supported for a canonical source URL per `designCognitiveBrainForDSH.md`
§5.6) → the existing `memory_remember` write path (or a shared internal
helper) indexes and audits it for free.

- Web pages: `ctx.web`'s `WebFetchProvider` for the safe fetch, plus a new
  readability/markdown-extraction step (nothing in DSH does this today —
  `trafilatura`-equivalent logic, or a Node port such as
  `@mozilla/readability` + a DOM parser, would be new).
- YouTube: needs a new capability DSH doesn't have — either caption/transcript
  extraction (e.g. `yt-dlp` for metadata + subtitles, cheap and text-only) or
  native video understanding via a Gemini-class multimodal model through
  `ctx.llm` (heavier, higher-fidelity, requires a provider that accepts
  video/image input — recall AGENTS.md: `dsh-llm-deepseek` is text-only,
  `dsh-llm-pi-ai` sends images when the model declares that modality; video
  input support would need checking per-provider).
- Instagram: needs a new capability too — `Instaloader`-equivalent (Python,
  would need a subprocess bridge — DSH has `packages/subprocess` for this)
  or an authenticated Graph API integration. Either way, carries real
  Instagram ToS risk for the unauthenticated-scrape path (see §8) — Siftly's
  browser-capture pattern (§3) is one way to sidestep it.
- Advantage: one vault, one search index, one audit trail, one concept
  graph — ingested content becomes indistinguishable from hand-written notes
  once it lands, and `memory_recall`/`memory_related`/`memory_consolidate`
  all apply to it automatically.

### C. New, separate ingestion plugin that produces `MemoryFile`-shaped output and hands off to `knowledge-hub`

Same technical approach as B, but as its own package
(`dsh-plugin-content-ingest` or similar) with its own tools
(`ingest_youtube`, `ingest_instagram`, `ingest_webpage`), depending on
`knowledge-hub` only for the write path (either calling its tool via
`ctx.tools` the way any agent would, or importing a small shared write
helper if one gets factored out).

- Matches DSH's existing package-per-concern convention (`packages/<group>/<pkg>`,
  `dsh-plugins/<name>`) — ingestion-specific config (API keys, per-source
  toggles, rate limits) doesn't bloat `knowledge-hub`'s config surface, and
  `knowledge-hub` stays usable standalone for hand-written notes.
  Composed together via `packages/preset` (cordis.yml) same as any two
  plugins today.
- Slightly more indirection than B for the write path, but keeps
  `knowledge-hub`'s existing 118 tests and lean scope untouched by
  ingestion-specific surface area (auth flows, per-source rate limiting,
  subprocess bridges) that has nothing to do with search/audit/graph.

### D. MCP bridge to an external ingestion service

Per the hub-and-spoke framing in `designCognitiveBrainForDSH.md` §1 (DSH as
hub, external tools as spokes), a completely separate ingestion service
(could even be a from-scratch Python/FastAPI service, *not* superbrain's
AGPL code) exposes an MCP server; DSH's `packages/mcp/mcp-client` consumes
it as a spoke, and a thin plugin normalizes its output into
`knowledge-hub` writes.

- Only worth it if the ingestion logic genuinely needs to live outside
  Node (e.g., heavy Python ML deps for local Whisper/vision that don't have
  good Node equivalents) — otherwise it's an extra process and transport
  hop for no benefit over C.

## 7. Licensing flag (do this first, before any implementation choice)

superbrain is **AGPL-3.0**; Siftly is **MIT**. Reading either's
architecture for ideas (as this document does) is fine regardless of
license. Copying or closely adapting superbrain's actual source (prompts,
pipeline code, the provider-routing logic) into a DSH plugin that gets
distributed or run as a network service is the thing that needs a
license-compatibility check first — the same posture
`designCognitiveBrainForDSH.md` §2 already took toward `docs/packages/
cognitiveBrain`: architecture and interface *shapes* were mined, concrete
graph/synthesis/LLM-pipeline *code* was deliberately not adopted. The same
discipline applies here, doubly so because of the copyleft license: **ideas
and pipeline shape, not code, from superbrain.** Siftly's MIT license carries
no such restriction — its actual code (e.g. `lib/rawjson-extractor.ts`'s
entity-mining approach, or the bookmarklet capture script pattern) could be
adapted more directly if useful, subject to normal MIT attribution.

## 8. Open questions (need a decision before picking A–D)

- **Instagram access method.** Unauthenticated scraping (Instaloader-style)
  risks ToS violation and is fragile against Instagram's anti-scraping
  changes. An authenticated approach (user's own session cookie, or the
  official Graph API for content the user owns/manages) is more defensible
  but narrower in what it can fetch. Which is acceptable depends on whose
  Instagram content this ingests — the user's own posts/saves, or arbitrary
  public posts.
- **YouTube: transcript-only vs. native video understanding.** Transcript
  extraction (via `yt-dlp` captions) is cheap, text-only, and works with
  DSH's existing text-only default provider. Native video ingestion (frames,
  visual content, no-caption videos) needs a vision/video-capable `ctx.llm`
  provider and costs meaningfully more per item — worth confirming which
  fidelity level is actually needed before building the heavier path.
- **Where do audio/vision models run?** Whisper-class transcription and any
  vision analysis are either (a) calls to a hosted API through `ctx.llm` /
  a new provider, or (b) a local model needing a Python subprocess bridge
  (`packages/subprocess`) or a Node-native equivalent. This is a real
  build-vs-buy fork in scope.
- **B vs. C**: does ingestion stay small enough to live inside
  `knowledge-hub` directly, or does per-source complexity (auth, rate
  limits, subprocess bridges) warrant a separate package? Lean C once more
  than one source needs non-trivial fetch logic — pending confirmation of
  the actual scope.
- **Rate limiting / abuse surface.** Any of these tools would let an agent
  fetch arbitrary external content on the user's behalf — same trust
  boundary `ctx.web`'s SSRF guarding already exists for. An ingestion
  plugin needs equivalent discipline for its non-web sources (Instagram
  session credentials, YouTube API keys) — where do those credentials live,
  and what's the blast radius if a prompt-injected note tries to trigger an
  ingest of something unintended?

## 9. Where this leaves us

**Update: the Instagram/login-walled half of approach C has been
implemented** as `dsh-plugins/social-capture/` — a receiver plugin that
takes the browser-side-capture idea from §8 literally: a per-user
bookmarklet/console script reads a page's own Open Graph meta tags in the
user's already-logged-in tab and POSTs the result to a token-gated local
endpoint, which writes it into a `knowledge-hub`-compatible vault. The
harness never drives a login, holds a credential, or automates a browser.
Full design rationale: [`designSocialCaptureForDSH.md`](./designSocialCaptureForDSH.md).

**Still open**, per §8: YouTube ingestion (transcript-only vs. native video
understanding) and general web-page ingestion (readability-quality
extraction on top of `ctx.web`) — neither needs the login-walled capture
pattern `social-capture` exists for, and remain unimplemented. The original
recommendation for those — a separate, narrowly-scoped plugin per source
that writes into the existing `knowledge-hub` vault rather than a second
store, reusing `ctx.web` for fetch and `ctx.llm` for summarization/tagging
— still stands.
