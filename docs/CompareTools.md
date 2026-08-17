# Competitive Evaluation: Comparable Note-Taking / Knowledge Tools

This document records an informal competitive scan of three open-source
note-taking tools that overlap with Tolaria's design space — a file-based,
Git-backed (or Git-adjacent) markdown vault with AI features — done to sanity
check Tolaria's positioning and surface features worth scouting for the
roadmap. Each entry: what the tool is, how its architecture compares to
Tolaria's, and the single biggest takeaway.

## Summary table

| Tool | Core metaphor | AI model | Editor | Sync/versioning | Platform |
|---|---|---|---|---|---|
| **Tolaria** | Personal knowledge graph (typed notes, explicit relationships) | Multi-agent CLI orchestration (Claude Code, Codex, Copilot, OpenCode, Pi, Antigravity, Kiro, Hermes) + MCP-exposed vault | BlockNote rich editor + CodeMirror raw mode | Native Git (Pulse activity feed, commit/diff/discard, conflicts) | Tauri desktop (macOS/Windows/Linux) |
| **[NoteGen](https://github.com/codexu/note-gen)** | Capture inbox → AI-structured notes | Per-task provider/model config (chat, writing, embeddings, OCR, audio); own MCP *server* | Dual source/WYSIWYG + canvas (mind maps, flowcharts) | Git/GitLab/Gitea/S3/WebDAV (multiple backends) | Tauri desktop + mobile (Android/iOS alpha) |
| **[Cabinet](https://github.com/cabinetai/cabinet)** | Virtual company — standing AI agent team with scheduled jobs | Claude Code / Codex CLI adapters, cron-scheduled autonomous runs, web terminal | Tiptap WYSIWYG + markdown | Git-backed auto-commit history | Electron via `npx create-cabinet`, self-hostable |
| **[Yank Note](https://github.com/purocean/yn)** | VSCode-style editor with a notebook streak | Editor-embedded assistant (completion/generation/image-gen), multi-provider | Monaco kernel, dual-pane edit/preview | Own document-history + `.c.md` encryption (no Git dependency) | Electron desktop |

## NoteGen — capture-first AI structuring

NoteGen's unit of value is the **inbox → AI-structuring transformation**, not
the note itself: you capture raw material (voice memo, screenshot, clipped
text) whenever, and AI turns it into a finished note, summary, or report on
demand. Notes are an *output* of AI processing — structure is imposed after
the fact, per note.

This is the sharpest contrast with Tolaria, where the graph itself is the
product: structure (types, relations, wikilinks) is meant to exist
independent of any AI pass, so both a human and an autonomous coding agent
can navigate it. Tolaria's AI acts *on* an already-structured vault (via MCP +
CLI agents with tool access); NoteGen's AI *produces* the structure from
unstructured input.

**Takeaway worth scouting:** a capture-inbox feature (voice/screenshot → AI-
drafted note) as a front-door onboarding flow — Tolaria currently assumes the
user already thinks in notes/types rather than in loose fragments.

## Cabinet — nearest architectural cousin, different operating model

Cabinet is the closest cousin of the three: markdown + Git + CLI-agent AI,
same family as Tolaria. The difference is *who* runs the agents and *when*:

- **Tolaria**: agents are ephemeral, user-invoked subprocesses (AiPanel/
  AiWorkspace), Safe/Power-User permission modes, MCP-exposed vault. No agent
  runs unless a human opens a chat.
- **Cabinet**: agents are standing, scheduled entities — a Node.js daemon
  runs `node-cron` jobs so 20 pre-built agent personas (CEO, PM, Content
  Marketer, etc.) act on their own timeline, post to internal team channels,
  and persist transcripts. It also ships a web terminal (xterm.js/PTY) for
  raw CLI sessions, and models *work* (missions, Kanban tasks) as much as
  notes.

Cabinet targets small teams running a roster of semi-autonomous AI workers
against shared company knowledge; Tolaria targets one person's structured
knowledge graph with agents invoked interactively. Cabinet is also a
Next.js/Node-daemon app packaged via Electron (`npx create-cabinet@latest`,
prebuilt bundles to `~/.cabinet/app/`), heavier at runtime than Tolaria's
Tauri/Rust shell, but easier to self-host as a shared server instance —
something Tolaria (pure desktop) doesn't target. Cabinet also has built-in
password protection (PBKDF2), reflecting its multi-user deployment model.

**Takeaway worth scouting:** scheduled/cron-driven agent runs — Tolaria has
nothing like a standing background agent that acts on the vault unprompted.

## Yank Note — editor-first power tool, not a graph

Yank Note sits at the opposite end of the spectrum from Tolaria: it's a
document-centric "VSCode for Markdown," not a graph-centric PKM system.

- **Editor**: Monaco (the real VSCode editor component), giving genuine
  code-editor ergonomics (multi-cursor, VSCode keybindings) rather than
  Tolaria's BlockNote block/WYSIWYG model.
- **Runnable code blocks** — its standout feature. A Koa2 backend can
  *execute* JS/PHP/Node/Python/bash code blocks inline, turning notes into
  lightweight literate-programming notebooks. Tolaria has no code execution;
  sandboxed HTML blocks explicitly forbid scripts unless opted in, and even
  then run in an isolated iframe, not a general script runner.
- **Broader embed catalog**: PlantUML, drawio, ECharts, Luckysheet, mind
  maps, HTML applets — an "everything-in-one-doc" philosophy versus Tolaria's
  narrower, curated block set (Mermaid, IronCalc, tldraw).
- **AI**: lighter-weight editor-embedded assistant (completion, generation,
  image-gen, OpenCode-based coding help) across multiple providers — no
  MCP server, no multi-agent orchestration, no vault-wide tool access.
- **History/security**: its own built-in document-history backtracking
  independent of Git, plus per-file encryption via `.c.md` — Yank Note works
  fully without a Git dependency, unlike Tolaria where Git *is* the
  versioning mechanism.
- **Runtime**: Electron + Vue + Koa2 Node backend (heavier footprint than
  Tauri/Rust, but the Node backend is exactly what enables runnable code
  blocks — a deliberate trade-off).

**Takeaway worth scouting:** runnable code blocks — the closest Tolaria gets
today is non-executing sandboxed HTML.

## SuperBrain — capture-first AI archive, not a knowledge-graph competitor

**[SuperBrain](https://github.com/sidinsearch/superbrain)** is a self-hosted
Android app + FastAPI backend that acts as a "save-it-later" AI content
archive: share a URL from Instagram, YouTube, Reddit, or Chrome into it, and
it auto-analyzes the content (summary, category, tags, music ID via Shazam,
audio transcription via Groq/local Whisper, vision analysis) and stores the
result in a local SQLite database (WAL mode).

It resembles NoteGen on the surface — both are "capture-first, AI-structures-
it" tools — but the resemblance is shallow once the capture target and
storage format are compared:

| | NoteGen | SuperBrain |
|---|---|---|
| **What gets captured** | Voice memo, screenshot, clipped text — general personal capture | Specifically social/web media URLs |
| **AI enrichment** | Chat/writing/OCR/audio per-task provider config | Music ID (Shazam), audio transcription (Whisper), vision analysis, auto category/tags |
| **Output format** | Markdown notes, Git/GitLab/Gitea/S3/WebDAV-syncable | Rows in an app-owned SQLite database — not markdown, not portable plain text |
| **Platform** | Tauri desktop + mobile | Android-only, no desktop target |
| **AI routing** | Per-task provider/model config | Multi-provider router (Groq/Gemini/OpenRouter/Ollama) with EMA-based performance ranking and automatic error/rate-limit cooldown fallback |
| **License** | — | AGPL-3.0 |

The point that actually matters for Tolaria's positioning: SuperBrain's
content lives in an app-owned SQLite database, not portable markdown files —
the opposite of the filesystem-as-truth, no-lock-in posture every other tool
in this document shares with Tolaria (even Yank Note, which skips Git
entirely, still keeps plain markdown files on disk). SuperBrain has no
notes, types, relationships, or wikilinks — it's closer to a
Pocket/Instapaper-with-AI-enrichment tool than a PKM/knowledge-graph
competitor, and it doesn't fit the "Adjacent AI-infrastructure concepts"
section below either, since it's a full vertical consumer product for one
narrow domain (social-media save-it-later) rather than a memory/agent
infrastructure layer. Logged here for completeness, not as a competitor.

**Takeaway worth scouting anyway, despite the poor category fit:**
automatic multi-provider AI routing with health-based fallback (EMA
performance ranking, timed cooldowns on errors/rate limits, periodic
free-model rediscovery) — Tolaria's AI system has no equivalent today. If a
CLI agent errors, nothing automatically retries with a different
agent/model; the user picks one manually per conversation.

## Adjacent AI-infrastructure concepts — not note tools, but relevant to
`docs/adr/0175-ai-derived-concept-graph.md`

Three more items came up in scouting, none of which are note-taking apps —
they're agent-infrastructure and knowledge-compilation concepts worth
positioning against Tolaria's in-progress AI-derived concept graph
(`docs/designKnowledgeGraph.md`, ADR 0175).

- **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** is
  an agent *framework*, not a knowledge/memory system, so it isn't a direct
  competitor — it's the "everything is a plugin" layer (models, tools,
  sandboxes, scheduling, UI) built on the Cordis plugin architecture that
  would *run* an agent using something like GBrain or a Karpathy-style wiki
  as its memory. Tolaria already occupies a narrower slice of this same
  layer (multi-agent CLI orchestration + MCP-exposed vault) without
  generalizing to arbitrary plugin composition — deliberately, since Tolaria
  orchestrates existing CLI agents rather than hosting its own agent runtime.

- **[GBrain](https://gbrain.homes/)** is a Postgres-native personal-memory
  engine: it indexes markdown into Postgres + pgvector and answers queries
  with hybrid vector+keyword search (RRF fusion) — classic **retrieve-then-
  synthesize** RAG. Every query re-searches raw fragments and re-derives
  structure at read time. This is close to what a naive "AI over the vault"
  feature would look like without a concept graph.

- **[Karpathy's LLM Wiki](https://github.com/lucasastorian/llmwiki)** is the
  opposite bet: **synthesize-then-retrieve**. An LLM reads sources once and
  writes durable, cross-linked wiki pages and entity profiles; new sources
  trigger an update pass (merge, flag contradictions) rather than a fresh
  read-time search. Karpathy's own instance grew to ~100 pages / 400k words
  compiled from raw sources he never wrote directly.

**Relevance to Tolaria:** ADR 0175's AI-derived concept graph is
architecturally much closer to Karpathy's compile-once wiki than to GBrain's
query-time retrieval — the goal is a persistent, linked structure derived
from vault notes once and incrementally maintained, not a search index
re-queried on every question. The risk flagged in Karpathy's approach
(merge/contradiction logic drifting if the update pass is weak) is the same
risk ADR 0175's incremental-update design needs to guard against. GBrain's
model is worth keeping in mind as the cheaper fallback if compile-once
maintenance costs turn out to dominate — hybrid vector+keyword retrieval over
raw notes, with no compaction step to get wrong.

## Positioning takeaway

Across all three note-taking tools, Tolaria's clearest differentiators are
(1) the explicit, AI-navigable knowledge graph as the core abstraction — not
a bag of documents NoteGen/Yank Note structure or process case-by-case — and
(2) multi-agent CLI orchestration with MCP-exposed vault access, which none
of the three other tools combine with a graph model the way Tolaria does
(Cabinet comes closest, but trades the graph for a scheduled-worker model).
The features most worth tracking from this scan: NoteGen's capture inbox,
Cabinet's scheduled agent runs, and Yank Note's runnable code blocks — none
of which conflict with Tolaria's core positioning, and each could be
evaluated independently as a roadmap candidate.

Against the adjacent AI-infrastructure concepts, Tolaria's in-progress
concept graph (ADR 0175) is a compile-once, Karpathy-wiki-shaped bet rather
than a GBrain-style query-time RAG layer — worth naming explicitly in the ADR
if it doesn't already, since it's the single biggest design fork the graph
work will face.

## Local OCR tools — scouted for a separate (non-Tolaria) project

Not related to Tolaria's positioning — logged here as a running scratchpad
for a different project's document-extraction pipeline. Covers a review of
four local/open-source OCR tools plus a downstream structured-extraction
library.

### Summary table

| Tool | Type | Params | Strength | Speed | Best for |
|---|---|---|---|---|---|
| **[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)** (incl. PaddleOCR-VL) | Pipeline (+ VLM variant) | PaddleOCR-VL-1.6: ~1B | Mature, lightweight, good bounding boxes; PP-StructureV3 handles tables/math | PP-StructureV3 lightweight: ~26s/page (fastest); PaddleOCR-VL 1.5: ~7min (slow, painful setup) | General-purpose local default; fast bounding-box/redaction use cases |
| **[OvisOCR2](https://huggingface.co/ATH-MaaS/OvisOCR2)** | End-to-end VLM | ~0.9B | Outputs structured Markdown directly (text, tables, formulas, reading order); simpler to deploy than Paddle | Fast for its size; fits ~16GB VRAM | Balanced structured Markdown output with a small footprint — reported best real-world results of the four |
| **[Surya OCR](https://github.com/VikParuchuri/surya) (v2)** | Pipeline/research project | ~0.7B | Competitive layout+OCR, improving speed; some layout-fidelity rough edges | Moderate | Fallback stage in a two-pass pipeline for low-confidence regions |
| **[dots.mocr](https://github.com/rednote-hilab/dots.mocr)** | End-to-end (heavy) | ~3B | Best-in-class on handwriting and complex table parsing | Very slow | Highest-fidelity extraction where correctness matters more than latency |
| **[Tesseract](https://github.com/tesseract-ocr/tesseract)** | Classic pipeline (no VLM) | n/a | Fast, mature, no GPU needed | Fastest | Simple/clean text where structure (tables/formulas) doesn't matter — still worth trying before reaching for a VLM |

All four VLM-based tools (Surya OCR 2, OvisOCR2, PaddleOCR-VL-1.6, dots.mocr)
run on consumer hardware via **llama.cpp** or **MLX** (Apple Silicon), which
is what makes them practical as a local stack rather than requiring a
dedicated GPU server — a meaningful shift from earlier Paddle installs that
needed careful CUDA/paddlepaddle version pinning. Reported first-hand
experience across this review favors **OvisOCR2** for real-world result
quality despite being the second-smallest of the four (~0.9B, between
Surya's ~0.7B and PaddleOCR-VL's ~1B) — smaller than dots.mocr's ~3B by a
wide margin while still beating it on general-purpose reliability; dots.mocr
remains the pick specifically for handwriting/complex tables where its
extra size and latency pay off.

### Notes from the review

- **Model tradeoffs**: small VLMs and end-to-end models (OvisOCR2, dots.mocr)
  give strong structure — tables, math, reading order — while pipelines
  (PaddleOCR) are reliable, fast, and easier to run locally. "PaddleOCR is
  probably your best bet as a local alternative. It's surprisingly
  lightweight, handles bounding boxes well..."
- **Speed vs fidelity**: pipeline/lightweight variants are much faster;
  VLM/end-to-end systems are slower but richer in structured output.
  "PP-StructureV3 lightweight: 26s (fastest...); PaddleOCR-VL 1.5: 7 min
  (slow, painful setup)."
- **Practical deploy pattern**: hybrid flows — fast engine for easy text,
  escalate low-confidence regions to a stronger model — balance latency and
  accuracy for real apps like redaction. "Tesseract is fast... letting it do
  the first pass and then handing off only low-confidence regions to
  something like PaddleOCR or Surya feels like a good balance."
- **Installation complexity**: Paddle/VLM stacks can require careful
  CUDA/paddlepaddle version pinning; Windows GPU installs are a reported
  pain point. Now available in llama.cpp GGUFs for easier local inference.
- **Benchmarks vs reality**: small benchmark deltas (e.g. 96.6 vs 96.3) may
  not be practically meaningful — "the inaccuracy of the benchmark is
  probably bigger" than the gap. Recommendation across the review: build a
  small ground-truth eval set from your own documents and run tools
  side-by-side rather than trusting generic benchmarks.

### Unlimited OCR (Baidu) — one-shot long-horizon parsing, VLM

**[Unlimited-OCR](https://github.com/baidu/Unlimited-OCR)** (23.9k★, MIT,
created 2026-06) is a newer Baidu vision-language OCR system, distinct from
the PaddleOCR line, explicitly inspired by DeepSeek-OCR/DeepSeek-OCR-2 and
PaddleOCR rather than being part of the Paddle family itself.

- **Architecture**: VLM-based, two inference modes — **Gundam** (640px,
  with cropping) for single images, and **Base** (1024px, no cropping) for
  multi-page documents. Parameter count isn't published in the repo.
- **Notable features**: 32,768-token context (long documents/many pages in
  one pass — the "long-horizon" framing), a custom n-gram logit processor
  to suppress repetitive-output failure modes common in VLM-based OCR,
  streaming inference.
- **Deployment**: heavier stack than the four tools above — Python 3.12.3+,
  CUDA 12.9, PyTorch 2.10.0, Transformers 4.57.1, with vLLM/SGLang serving
  and Docker images. This is squarely a GPU-server deployment, not a
  laptop-friendly llama.cpp/MLX target like Surya OCR 2/OvisOCR2/
  PaddleOCR-VL-1.6/dots.mocr.
- **Where it fits vs. the rest of this scan**: no published head-to-head
  numbers against Surya/OvisOCR2/PaddleOCR/dots.mocr yet, so treat as
  unverified until benchmarked on your own eval set (per the "benchmarks vs
  reality" note above). Its repeat-suppression logic and long-context single
  pass are relevant if your project processes long multi-page PDFs where
  the smaller local VLMs' context/cropping limits become the bottleneck —
  at the cost of needing real GPU serving infra rather than a local
  llama.cpp/MLX-runnable model.

### React app vs Python app — practical takeaway

None of the four OCR tools have a JS-native runtime — they're all
Python/PyTorch-based.

- **React (frontend-only, no Python backend)**: use **Tesseract.js**
  (runs in-browser/Node via WASM) if accuracy is sufficient; otherwise stand
  up a small Python service running one of the four and call it over HTTP.
- **Python app / Python-capable backend**: **PaddleOCR** is the default
  pick (fast, lightweight, reliable). **OvisOCR2** if you want end-to-end
  Markdown output with simpler serving than Paddle. **Surya** as the
  escalation stage in a two-pass pipeline. **dots.mocr** only when
  handwriting/table correctness matters more than latency.

### LangExtract — downstream structured extraction, not OCR

**[LangExtract](https://github.com/google/langextract)** (Google) is a
Python library that uses LLMs (Gemini primarily, with OpenAI/Ollama support)
to extract structured information from *unstructured text* — it does not
digitize images. It sits downstream of OCR, not in competition with it.

- **What it does**: chunks long documents, processes chunks in parallel via
  LLM queries, and grounds every extraction to exact character positions in
  the source text. Users supply a task description plus few-shot examples;
  no fine-tuning required.
- **Key features**: source grounding (extraction → exact source span),
  parallel processing for long documents, interactive HTML visualization of
  results, multiple extraction passes to improve recall, schema enforcement
  for consistent structured output.
- **Where it fits**: a scan-to-structured-data pipeline composes as OCR
  (PaddleOCR/Surya/etc.) → raw text → LangExtract → structured JSON/fields,
  with an HTML view to audit extractions. Like the OCR tools, it's
  Python-only — a React frontend would call it via an API layer rather than
  running it client-side.

### OmniTools — fully client-side media/PDF/text utility suite

**[OmniTools](https://github.com/iib0011/omni-tools)** (10k★, MIT) is a
self-hosted collection of everyday file/data utilities — image conversion
and editing, video trimming/reversing, PDF split/merge/edit, text
case/formatting tools, JSON/CSV/XML manipulation, date/timezone/electrical
calculators — that runs **entirely client-side**: "no ads, no tracking,
just fast, accessible utilities," data never leaves the user's device.

- **Stack**: React + TypeScript, Material UI, Vite, Vitest/Playwright for
  tests, Locize for i18n. Shipped as a ~28MB Docker image
  (`docker run -d --name omni-tools -p 8080:80 iib0011/omni-tools:latest`)
  for self-hosting, but the processing itself happens in the browser, not on
  the container's server — the Docker image is just a static-file host.
- **Relevance to the OCR/LangExtract scouting above**: it's the opposite
  architectural bet from PaddleOCR/Surya/OvisOCR2/dots.mocr/LangExtract —
  those are all Python/ML-backend tools requiring a server process, while
  OmniTools proves a fully browser-side pipeline is viable for file
  transforms as long as the operation doesn't need a heavy model (image
  resize/convert, PDF merge/split, text/data reshaping are all tractable
  with in-browser libraries; OCR/LLM-based extraction is not — no OCR or
  text-extraction tool is included in OmniTools itself).
- **Not a note-taking competitor** — logged here as the same
  running-scratchpad as the OCR section above, for the same separate
  (non-Tolaria) project: if that project needs image/PDF pre-processing
  around its OCR step (crop, convert, split pages) and wants to keep it
  client-side/serverless, OmniTools' individual tool implementations (or
  the libraries they wrap) are a reasonable reference, versus building a
  Python backend for what's mechanically just format conversion.

### Mobile on-device multimodal OCR — detailed analysis

Context for this section: the project's React app also needs a **mobile**
target (React Native and/or mobile browser), where none of the desktop-tier
tools above (Surya OCR 2, OvisOCR2, PaddleOCR-VL-1.6, dots.mocr,
Unlimited-OCR, GLM-OCR) are deployable on-device — they're all sized for a
discrete GPU (the desktop dev box here has 11GB VRAM), not phone silicon.
The question is which multimodal/VLM models *are* small and efficient
enough to run directly on a phone, versus which just get marketed as
"small" while still needing 4GB+ VRAM.

#### Option-by-option

**[Gemma 3n](https://ai.google.dev/gemma/docs/gemma-3n/model_card) (E2B / E4B)** — Google's on-device-targeted multimodal model
(text/image/audio/video → text). Raw parameter count is ~5B, but it uses
*selective parameter activation* (per-token/per-modality sparsity), so its
effective memory footprint at inference is closer to a 2B dense model.
This is the detail that makes it credible as a genuine phone target rather
than a "small" model that's still desktop-class. Multimodal (not an
OCR specialist), so expect general visual-QA-level text reading rather
than document-structure fidelity (no native table/formula output like
OvisOCR2 or GLM-OCR). Available via MediaPipe LLM Inference / Google AI
Edge for direct Android/iOS integration.
- *Risk*: general-purpose multimodal models under-perform document-OCR
  specialists on dense/small text and structured layouts — validate against
  your own eval set before committing, per the "benchmarks vs reality" note
  earlier in this doc.

**[SmolVLM2](https://github.com/huggingface/smollm/tree/main/vision/smolvlm2) (250M / 500M)** — HuggingFace's small VLM line, using pixel
mixing for efficiency. Reported 3.3-4.5x faster prefill and 7.5-16x faster
generation than Qwen2-VL at comparable small-model accuracy tiers. Genuinely
phone-feasible at these sizes (250-500M is well within phone RAM/compute
budgets), Apache-2.0-family licensing, active HuggingFace ecosystem support
(transformers, ONNX export paths for mobile runtimes).
- *Risk*: at 250-500M, treat it as "can read text in an image," not
  "can parse a document" — no evidence of table/formula structure output
  comparable to the desktop-tier document-OCR models in this doc.

**[Moondream](https://github.com/vikhyat/moondream)** — small VLM (sub-2B class) with recent OCR-quality
improvements plus gaze detection and structured-output support. Positioned
similarly to SmolVLM2 as edge/phone-appropriate, with a specific push toward
structured output (closer to what a document-extraction use case needs than
a bare visual-QA model).
- *Risk*: less mainstream mobile-runtime tooling/documentation than
  SmolVLM2 or Apple's own stack at time of writing — worth a quick spike to
  confirm a clean mobile inference path (ONNX/llama.cpp/MLX export) before
  committing engineering time.

**[Apple FastVLM](https://github.com/apple/ml-fastvlm)** — Apple's hybrid vision-encoder architecture (CVPR 2025),
purpose-built for real-time on-device visual queries on Apple Silicon/iOS.
Reports 85x faster time-to-first-token than comparable ~0.5B VLMs (e.g.
LLaVA-OneVision-0.5B) and a 3.4x smaller visual encoder — the efficiency
gain comes specifically from the encoder design (handles high-res images
without the usual token-count blowup), which matters for OCR since document
images are typically higher-resolution than natural photos.
- *Risk*: iOS/Apple-Silicon-specific — no direct Android equivalent, so this
  is a platform-conditional pick, not a cross-platform default. If the
  mobile target is iOS-heavy, this is the strongest efficiency story of the
  group; if Android parity matters equally, it doesn't solve that half.
- **Not built into the OS — requires a manual download/convert/bundle
  step.** Unlike ML Kit/Vision's `VNRecognizeTextRequest` (already in the
  OS SDK, zero download), FastVLM is a separately open-sourced research
  model ([apple/ml-fastvlm](https://github.com/apple/ml-fastvlm)), not
  shipped inside Vision framework. To use it: fetch checkpoints via
  `bash get_models.sh` in that repo (0.5B/1.5B/7B) or from
  [Hugging Face](https://huggingface.co/apple/FastVLM-0.5B-fp16/tree/main),
  then export the PyTorch checkpoint to Core ML (`model_export` subfolder)
  before it can run on-device — not a drop-in API call. The community
  project [fast-vlm-ondevice-kit](https://github.com/danieleschmidt/fast-vlm-ondevice-kit)
  does PyTorch→Core ML conversion with INT4 quantization for mobile and
  claims <250ms on-device inference on iPhone, likely a faster starting
  point than a from-scratch export. This integration cost only pays off if
  the app actually needs FastVLM's multimodal capability beyond what
  Vision's plain text recognizer already provides for free.

**[GLM-OCR](https://github.com/zai-org/GLM-OCR) (0.9B)** — included for contrast, not as a mobile candidate: tops
OmniDocBench (94.62) among small document-OCR specialists, similar size
class to OvisOCR2, but built and evaluated as a desktop/server document-OCR
model, not for phone deployment. Relevant as the escalation target your
mobile app's backend call should hit when on-device confidence is low —
same role PaddleOCR/Surya/OvisOCR2 already play for the desktop app.

**Baseline comparison — [ML Kit](https://developers.google.com/ml-kit) (Android) / [Vision](https://developer.apple.com/documentation/vision) `VNRecognizeTextRequest`
(iOS)**: not multimodal LLMs at all — narrow, purpose-built OCR engines
already free and built into both platforms' SDKs. For clean/simple text
recognition (the common case), these remain faster, more battery-efficient,
and lower-integration-risk than any multimodal VLM above, on-device or not.

#### Recommendation

1. **Default path**: ML Kit (Android) + Vision framework (iOS) for
   fast/simple text recognition — no multimodal model needed for the common
   case, matches the earlier mobile-solution guidance in this doc.
2. **On-device multimodal fallback** (when the task needs loose visual
   understanding alongside text — captions, mixed image+text reasoning, or
   platforms where a heavier local model is acceptable): **Gemma 3n**
   for cross-platform (Android + iOS via MediaPipe/AI Edge), or **Apple
   FastVLM** specifically if the app is iOS-first and the efficiency
   ceiling matters more than Android parity. Treat **SmolVLM2** and
   **Moondream** as smaller/cheaper alternatives worth benchmarking
   alongside Gemma 3n, particularly if Gemma 3n's footprint still proves
   too heavy on lower-end Android devices.
3. **Escalation path**: when on-device confidence is low or the document
   needs real structure (tables/formulas/handwriting), call the same
   backend service already planned for the desktop app (OvisOCR2/
   GLM-OCR-class models on the 11GB-VRAM box, or dots.mocr for the hardest
   cases) — do not try to reproduce desktop-tier document fidelity
   on-device.
4. **Before committing**: build the small ground-truth eval set recommended
   earlier in this doc and run it against ML Kit/Vision, Gemma 3n, and at
   least one of SmolVLM2/Moondream — the marketing gap between "small model"
   and "actually phone-feasible" is wide enough in this space that the
   comparison numbers here should be treated as a starting shortlist, not a
   final ranking.
