# Social capture for DSH: browser-side capture instead of harness-driven login

Status: **implemented** as `dsh-plugins/social-capture/` — a receiver
endpoint plus a generated bookmarklet/console-script per configured
platform, 57 passing tests, clean typecheck and build. This document
records the design decision behind the plugin; see
[`dsh-plugins/social-capture/README.md`](../dsh-plugins/social-capture/README.md)
for the as-built config surface and activation steps, and
[`investigateContentIngestionPlugin.md`](./investigateContentIngestionPlugin.md)
for the broader survey (superbrain, Siftly) this decision came out of.

## 1. The problem this plugin answers

The investigation doc's original framing of "ingest Instagram posts" raised
an implicit implementation choice: how does the harness get past a social
platform's login wall at all? The naive answer — a Playwright-style bot
that drives the login form itself, holding the user's credentials or
session — was considered and rejected, for reasons independent of the
AGPL/licensing questions raised elsewhere in that doc:

- DSH has **no browser-automation capability at all** (confirmed: no
  Playwright/Puppeteer/similar anywhere in `packages/`). Building one would
  be a larger net-new subsystem than the ingestion logic it would serve.
- Holding a platform login credential or session cookie inside the harness
  is real credential custody with a real blast radius — what happens if a
  prompt-injected note tries to trigger a login-driven fetch of something
  unintended? A tool surface that can replay a login is a meaningfully
  larger attack surface than one that can only make an authenticated-caller
  request through a token this plugin itself issues.
- Most platforms' terms of service explicitly prohibit *automated* login,
  a sharper problem than scraping content a person is already looking at.

## 2. The alternative: copy Siftly's actual pattern

[Siftly](https://github.com/viperrcrypto/Siftly) (a self-hosted Twitter/X
bookmark manager, surveyed in
`investigateContentIngestionPlugin.md` §3) solves the identical problem —
getting data out from behind a login wall — without ever touching a
credential: a bookmarklet or DevTools console script runs **inside the
user's own, already-authenticated browser tab**, reads the current page,
and sends the result to a local receiver. The browser's existing session
does all the authentication; the receiving application never sees a
password or session token for the platform being captured.

`dsh-plugin-social-capture` ports this pattern directly:

```text
User's browser (already logged into instagram.com)
    │  clicks bookmarklet / pastes console script
    ▼
Script reads the current page's og:title / og:description / og:image / og:url
    │  fetch() POST, X-Capture-Token header
    ▼
dsh-plugin-social-capture's receiver (loopback HTTP, token + rate-limit gated)
    │  validate → free entity extraction → optional one-shot LLM summary
    ▼
<vaultPath>/<id>.md  (dsh-plugin-knowledge-hub-compatible markdown note)
```

## 3. Why Open Graph meta tags, not platform-specific DOM/data structures

The capture script reads `og:title`/`og:description`/`og:image`/`og:url` —
fields most social platforms, including Instagram's own post pages, already
populate for their own link-preview rendering (iMessage, Slack, etc.) —
rather than parsing a platform's private React/DOM internals or an
undocumented embedded JSON blob (the kind of thing superbrain's
`Instaloader` dependency and various community Instagram scrapers depend
on, and which breaks silently whenever a platform ships an unrelated
front-end change). This is a deliberate fidelity-for-robustness trade:
lower-fidelity capture (no comment threads, no private-post support, no
raw media download) in exchange for a capture mechanism with a much longer
half-life. Higher-fidelity capture is always addable later as a
platform-specific script variant without touching the receiver at all —
`bookmarklet.ts` already separates "which platform" from "what the script
does" through its `CapturePlatform` parameter.

## 4. Why this plugin, and not a change to `knowledge-hub`

Per the investigation doc's approach C (a separate ingestion plugin writing
into the existing vault, not a second store), `social-capture` is its own
package: auth/token/rate-limit/CORS handling for an externally-reachable
receiver has nothing to do with `knowledge-hub`'s search/audit/graph scope,
and keeping them separate means `knowledge-hub` stays usable standalone.
The two share a **file-format contract** (the `MemoryFrontmatter` shape,
the `.audit-log.jsonl` shape), not code — a few small modules (`id.ts`,
`audit-log.ts`) are deliberately duplicated rather than imported across the
package boundary, the same posture `knowledge-hub` itself takes toward
`docs/packages/cognitiveBrain` (see `designCognitiveBrainForDSH.md` §2):
mine the shape, not the code, across a package boundary that's meant to
stay independently installable.

## 5. LLM provider neutrality

Nothing in this plugin selects, assumes, or hardcodes a specific LLM
vendor. The optional AI-summary step (`enableAiSummary`) calls
`ctx.llm.stream()` — the same provider-neutral seam `knowledge-hub`'s
concept extractor uses — with `llmProvider`/`llmModel` set to whichever
`ctx.llm`-registered adapter the deployment uses (this harness's native
DeepSeek adapter, or any other). Left off entirely, captures are still
stored with the free, LLM-less entity-extraction tags from
`entity-extract.ts` (hashtags, mentions) — the same "mine cheap structure
before spending any tokens" idea Siftly's own `rawjson-extractor.ts` uses,
adopted here regardless of which LLM (if any) is configured.

## 6. What's deliberately out of scope for v1

- **YouTube and web-page ingestion.** Neither sits behind a login wall the
  way Instagram does, so neither needs this plugin's capture pattern —
  `investigateContentIngestionPlugin.md` §6 already covers where those
  belong (`ctx.web` for pages; a separate transcript/video pipeline for
  YouTube).
- **A social-specific concept-graph view.** `knowledge-hub`'s existing
  opt-in concept graph already covers any vault it's pointed at; captures
  land tagged `social` + the platform name, so a filtered view (e.g. by
  tag) is a small addition to `knowledge-hub`'s existing graph viewer if
  wanted later, not a second graph engine.
- **Full-fidelity media capture.** No image/video download, no comment
  threads, no story/reel-specific handling — the Open-Graph-only strategy
  in §3 is a deliberate fidelity ceiling for v1.
