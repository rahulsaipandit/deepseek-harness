# Fork history: commits since diverging from upstream `deepseek-ai/deepseek-harness`

This documents every commit on `master` since the fork point from
`upstream/master`, in chronological order. Use it to understand *why* each
change exists before resolving merge/rebase conflicts against newer upstream
commits.

- **Fork point (merge-base):** `47f943859bef60e4160492346772ded9b24f765a`
- **Upstream remote:** `deepseek-ai/deepseek-harness` (`upstream`)
- **Origin remote (this fork):** `rahulsaipandit/deepseek-harness` (`origin`)
- Regenerate the commit list with: `git log --oneline --reverse $(git merge-base master upstream/master)..master`

## Quick map: what touches shared/upstream code vs. what's fork-local

Most of the fork's work lives in **new, fork-only directories** that upstream
does not have and therefore cannot conflict with:

- `dsh-plugins/*` — all first-party plugins added by this fork (imchat,
  vision-bridge, skillhub, browser-bridge, knowledge-hub, mcp-server,
  persona-scheduler)
- `docs/*` new files (`designCognitiveBrainForDSH.md`,
  `designCabinetButForSingleUser.md`, `dsh-base-bundle-boot-hang.md`,
  `CompareTools.md`, `adr/rp_dshPlugins.md`, this file)

A **small set of shared/core files** were modified in place and are the real
conflict surface against upstream changes:

| File | Changed by | Why |
|---|---|---|
| `packages/web/web-fetch-http/src/{index,policy,provider}.ts` | `9d9f947ba7` | SSRF hardening (see below) |
| `packages/web/web-fetch-http/tests/fetch-http.spec.ts` | `9d9f947ba7` | tests for the above |
| `packages/web/tool-web/tests/integration.spec.ts` | `a03caa4fc9` | fixed a pre-existing broken fixture blocking build |
| `apps/cli/src/plugin.ts` + `apps/cli/tests/plugin-junction-repair.spec.ts` | `a03caa4fc9` | plugin `inject` wiring fixes surfaced by live boot |
| `packages/client/connection/src/index.ts` + `tests/node-half.host.spec.ts` | `9d9f947ba7`, `a03caa4fc9` | related plumbing for the above two fixes |
| `packages/mcp/mcp-client/src/{connection,tools,resources}.ts` + tests | `d576f1ad6e` | added an on-demand MCP *resources* consumer, fixed zero-tools-server bug |
| `AGENTS.md`, `README.md` | `accded8c7f`, `a03caa4fc9`, `d576f1ad6e` | doc additions (plugin conventions, local-LLM FAQ, etc.) |
| `scripts/doc-budgets.manifest.json` | (incidental, bundled in the diff stat) | doc size budget bump |

When rebasing onto a newer upstream, watch these files first — everything
else under `dsh-plugins/` is additive and should apply cleanly as long as the
directory doesn't exist upstream.

## Commit-by-commit

### 1. `08eee4ef6b` — Add per-query graph expansion + memory consolidation; fix BM25-only score magnitude; document GBrain/cognitiveBrain adoption decisions
**Touches:** `dsh-plugins/knowledge-hub/*` only (fork-local), plus doc updates.

- **`memory_recall` graph expansion** (`graph-expansion.ts`, opt-in via
  `expandWithGraph`): walks one edge hop through the cached
  `concept-graph.json` from hybrid-search hits to surface notes connected by
  a shared concept/wikilink. No LLM call at query time — bounded in-memory
  walk, only paid when requested.
- **`memory_consolidate`** (`consolidation.ts`, new 6th knowledge-hub tool):
  on-demand redundancy reduction (supersede via existing contradiction
  check, merge via cosine similarity + union-find), dry-run by default,
  never deletes/rewrites — only adds a `supersededBy` frontmatter field.
  Deterministic conflict resolution added so a note can't be claimed by two
  proposals at once (contradiction wins over merge).
- **BM25-only scoring fix** in `memory-index.ts`: `applyRankedScores()` (used
  when embeddings are disabled) scored by rank only, making scores useless
  as a confidence signal; fixed with the same min-max normalization already
  used by `fuseHybrid()`.
- **Docs:** `designCognitiveBrainForDSH.md` §5.9/§10 and
  `designKnowledgeGraph.md` §7 record the adoption/rejection decisions made
  against the `cognitiveBrain` and `GBrain` reference projects. Adoption
  rule used throughout: keep a capability if its cost is zero/local/bounded
  and opt-in; reject if cost is automatic/unbounded or turns the vault into
  a black box (silent mutation/generation).

### 2. `d576f1ad6e` — Add MCP server + resources bridge, fix hybrid search ranking, adapt Playwright-style memory/RAG tests
**Touches:** new `dsh-plugins/mcp-server/*` (fork-local); shared
`packages/mcp/mcp-client/*` (conflict surface).

- **New plugin `dsh-plugins/mcp-server`**: exposes an allowlisted set of
  `ctx.tools` (default: knowledge-hub's 5 memory tools) as an authenticated
  MCP Streamable HTTP server — bearer-token auth, IP/token rate limiting,
  CORS, loopback trust bypass. 38 tests.
- **`packages/mcp/mcp-client`**: added an on-demand MCP *resources* consumer
  (`resources.ts` — synthetic `list_resources`/`read_resource` tools per
  server that advertises a resources capability) and fixed a bug where a
  server exposing zero tools (a legitimate resource-only server) failed the
  whole connection instead of being treated as an empty tool list.
- **`dsh-plugins/knowledge-hub`**: fixed two compounding hybrid-search bugs
  in `memory-index.ts` — `vectorSearch()` never passed Orama's `mode:
  'vector'`, so it silently ran a no-op fulltext search; and
  `fuseHybrid()`'s rank-only reciprocal-rank fusion discarded real
  similarity magnitude, making 3+-note ranking noise-dominated. Added a
  real-`ctx.tools.execute()` integration test suite adapted from
  `docs/packages/tests/testMemoryGoals.md`'s behavioral test plan.

### 3. `a03caa4fc9` — Fix plugin inject declarations found via live-boot verification
**Touches:** `apps/cli/src/plugin.ts`, `packages/client/connection/src/index.ts`,
`packages/web/tool-web/tests/integration.spec.ts`, `packages/web/web-fetch-http/src/policy.ts`
(type-error fix), various `dsh-plugins/*` README/src fixes.

- Live-booted a real web profile (not just unit tests against a stubbed
  Cordis context) and fixed what only fails at real boot:
  - `flight-search`, `vision-bridge`, `imchat` used `ctx.tools`/`ctx.fs`/
    `ctx.credentials`/`ctx.agents`/`ctx.userQuestions` without declaring
    them in `export const inject` — added the missing entries.
  - `browser-bridge`: `npm install` had never been run; several `execute`
    callbacks were missing the `ToolExecution` type annotation on `exec` —
    a build error only visible with real deps installed.
  - `imchat`: documented (not fixed) that it unconditionally registers
    itself as the `ctx.userQuestions` provider, which collides with
    `dsh-host-apiproxy`'s provider that `dsh-web-app` depends on — it can't
    run alongside the web UI, by design.
  - `web-terminal`: `inject` was correct, but no built-in bundle mounts
    `dsh-terminal`'s `ctx.terminals` provider — noted as an opt-in
    dependency profiles must add explicitly.
- Fixed two pre-existing repo build failures blocking any boot:
  `web-fetch-http/src/policy.ts` type error, a stale test fixture in
  `tool-web/tests/integration.spec.ts`.
- **`docs/dsh-base-bundle-boot-hang.md`** — see [Fork-local incident
  doc](#fork-local-incident-doc-dsh-base-bundle-boot-hangmd) below; this
  commit contains a **corrected root cause** (a prior draft wrongly blamed
  `@deepseek-ai/dsh-goal`; the speculative fix in
  `packages/goal/goal/src/index.ts` was reverted — confirmed clean diff).
  Real cause: `dsh-base` alone has no plugin that reads `--help`/task args
  (only the `dsh-headless`/`dsh-web-app` overlays do); a bare-`dsh-base`
  profile boots cleanly and then correctly idles waiting for input that
  never comes. Fix is an overlay bundle in the profile's bundle list, not a
  code change.
- **README.md** — added a "Configuring a local LLM in Settings → Models"
  FAQ (generic OpenAI-compatible custom-provider flow for Ollama/LM
  Studio/vLLM/llama.cpp).

### 4. `accded8c7f` — Part 1 - memory plugin
**Touches:** new `dsh-plugins/knowledge-hub/*`, `dsh-plugins/persona-scheduler/README.md`
(fork-local); `AGENTS.md`, `README.md`, `dsh-plugins/README.md` doc additions.

- First implementation of the **knowledge-hub** memory plugin: vault store,
  chunking, embedding, concept extraction/graph, wikilinks, frontmatter
  parsing, audit log, hybrid memory index, and a web concept-graph
  viewer/server. Full test suite alongside each module.
- `persona-scheduler/README.md` added as a design placeholder (see commit 6
  below for the reasoning that led here).

### 5. `88b80c296b` — Design custom cabinet
**Touches:** `docs/designCabinetButForSingleUser.md` only (new, fork-local doc).

- Analysis of the third-party "Cabinet" project (self-hosted, multi-tenant
  team AI workspace) vs. this harness's single-user, single-machine model.
  Finding: Cabinet has no real per-user data isolation (one shared
  password gate, no accounts/roles/per-document scoping) — by Cabinet's own
  "simple, stupid" design philosophy, not an oversight.
- **Decision:** dropped a planned multi-user-auth plugin from the fork's
  plan entirely; personas (Chief of Staff, CFO, Marketing, etc.) are
  treated as different hats one user's own agent wears over their own
  data, not separate principals needing isolation. Web-terminal auth
  simplified to a single optional shared secret.

### 6. `918fb3c870` — Built: dsh-plugins/browser-bridge/
**Touches:** new `dsh-plugins/browser-bridge/*` (host plugin + Chrome MV3
extension), `docs/CompareTools.md`, `dsh-plugins/README.md`,
`docs/adr/rp_dshPlugins.md` (fork-local).

- Hardened port of a third-party project (`Lum1104/dsh-browser`) into this
  repo's real plugin conventions — registered as a genuine Cordis plugin
  against `@deepseek-ai/dsh-host-webserver`/`dsh-host-apiproxy`, not a
  standalone service. 69/70 host tests pass (1 skipped, POSIX-only chmod
  assertion), 32/32 extension tests pass.
- Security posture independently verified by reading the source (not just
  trusting the sub-agent that built it): `verifyToken` uses UTF-8 byte
  comparison + `timingSafeEqual`, fails closed on length mismatch; the
  loopback-without-token shortcut requires *both* a loopback remote address
  *and* an `Origin: chrome-extension://` header (unforgeable by a web
  page); privileged methods (`credentials.*`, `settings.*`,
  `host.pickDirectory`) are pinned to loopback regardless of token
  validity; no reachable `postMessage`/`onMessageExternal` listener in the
  extension; token persisted via atomic temp-file+rename at `0600`, never
  accepted as a model tool argument; no tool builds a request URL from a
  field inside a response.
- Deliberately dropped vs. the original: iframe/multi-frame support,
  tab-affinity continuity, i18n — disclosed in both packages' READMEs.

### 7. `a4be5c5b73` — implemented skillhub as a first-party plugin at dsh-plugins/skillhub/
**Touches:** new `dsh-plugins/skillhub/*`, `docs/adr/rp_dshPlugins.md`,
`dsh-plugins/README.md` (fork-local).

- Confirms and documents DSH's skill-discovery architecture (filesystem
  `SkillRegistry` scan + two discovery surfaces: model-facing
  `<available_skills>` catalog via `dsh-tool-skill`, human-facing
  `SkillsApi.list()`/slash-trigger menu) before building on top of it.
- Confirms all plugins (including this fork's own) run in-process via
  Cordis — no per-plugin server/process boundary; a "skillhub" needing to
  talk to an external registry is just an outbound HTTPS call from the
  shared process, not new infrastructure.
- Built `dsh-plugins/skillhub` registering `skillhub_search/_install/_list/
  _uninstall` tools. Closes real gaps found in a third-party review of
  `cocofhu/skillhub` (no URL validation in `http.ts`; unverified install
  command run from unauthenticated GitHub release metadata in
  `self-update.ts`):
  - **No ZIP download/extraction at all** — registry contract is an
    itemized JSON list of `{path, content}` text files, eliminating
    zip-slip/decompression-bomb classes by construction.
  - **Same-origin by construction** — every request URL is built from the
    configured `registryUrl` + fixed paths, never from a response field;
    `registryUrl` must be `https:`; redirects refused outright.

### 8. `22610a10c4` — Built a new plugin at dsh-plugins/vision-bridge
**Touches:** new `dsh-plugins/vision-bridge/*`, `docs/adr/rp_dshPlugins.md`,
`dsh-plugins/README.md` (fork-local).

- Hybrid plugin combining reviewed strengths of two third-party projects
  (`dsh-plugin-mm-vision`, `visionDS`): a schema-scoped `describe_image`
  tool with no model-reachable destination URL/credential (closes
  visionDS's `--base-url`/`--api-key` gap), a configurable multi-provider
  catalog (MiMo/GLM/Ark/DashScope/Moonshot/OpenAI-compatible) tried in
  priority order, offline Windows/macOS OCR fallback, structured
  coordinate-annotated description prompt, content-hash response cache.
- Fixes relative to both source projects: local paths resolve through
  `ctx.fs` (same sandboxed seam as `read_image`) instead of raw
  `node:fs`; every image source is magic-byte sniffed and rejected if it
  doesn't match a real raster format; remote sources must be `https`;
  every provider key resolves through one named `ctx.credentials` ref (no
  silent first-key-found reuse across another tool's credential file).
- 59 vitest tests, `tsc --noEmit` and build clean.

### 9. `898b1f15e4` — How does it call LLM?
**Touches:** no code changes — a chat/research session (question about DSH's
LLM-calling architecture) recorded as a commit for history; no diff stat
beyond commit message.

- Documents (in the commit message, for future reference) DSH's LLM
  seam: everything routes through `ctx.llm` (`LlmRuntime`, Cordis
  service), provider adapters register via `registerAdapter()` and
  implement `stream(options): AsyncIterable<StreamChunk>`. Two ship in
  this repo: `dsh-llm-deepseek` (direct fetch+SSE, text-only — rejects
  image content) and `dsh-llm-pi-ai` (library-backed, supports images when
  the resolved model is vision-capable). Confirms the message format is
  multimodal-ready (`ImageBlock` in `ContentBlockMap`) even though the
  DeepSeek adapter itself doesn't send images.

### 10. `8259751704` — Add Slack plugin
**Touches:** new `dsh-plugins/imchat/*` (fork-local).

- Built `dsh-plugins/imchat/` per an ADR, with mock Telegram and Slack APIs
  for tests. Core: `identity-registry` (default-deny allowlist),
  `state-store` (atomic JSON persistence — fixed a real read-modify-write
  race under concurrent writes), `session-router` (one DSH session per
  chat, idle eviction, restart-safe), `approval-relay` (renders
  approval/question prompts as chat buttons, fail-closed on
  timeout/disconnect). Adapters: `telegram.ts` and `slack.ts` fully
  implemented (real HTTP client / Web API + injectable Socket Mode seam);
  `whatsapp.ts` is an honest stub (throws `WhatsAppNotImplementedError`
  rather than faking Baileys' pairing protocol). 41 tests, all against real
  code paths (only transports are mocked, not the adapters).
- **Design correction during this commit:** discovered
  `@deepseek-ai/dsh-user-approval`'s real API is a Cordis waterfall event
  (`ctx.on('approval/request', ...)`), not a `registerProvider()`
  singleton like `ctx.userQuestions` — so approval answerers compose, but
  question providers don't. `registerProvider()` allows exactly one
  provider per context, and `ApiProxy` already holds that slot whenever a
  normal web/VS Code client is attached, with no in-process way to
  piggyback on its broadcast. **Scoped v1 explicitly to a dedicated
  chat-only host** (added as a named non-goal, not silently assumed to
  coexist with the web UI) — this is the same constraint documented again,
  and confirmed as a real deployment limitation, in commit `a03caa4fc9`
  above.

### 11. `9d9f947ba7` — Fix security issues in harness
**Touches:** `packages/web/web-fetch-http/src/{index,policy,provider}.ts`
and its tests (shared/core — conflict surface); `packages/client/connection/src/index.ts`.

Fixes two issues from a security review of `packages/web/web-fetch-http`:

- **Constructor crash (critical)**, `provider.ts:52-58`: `destinationAllowlist`
  was assigned in a field initializer that ran *before* the parameter
  property `limits` was set, crashing the constructor. Moved the
  assignment into the constructor body after `limits` exists.
- **IPv4-mapped IPv6 SSRF bypass**, `policy.ts:51-65`: the denylist was
  checked per address-family only, so an attacker-controlled DNS answer of
  `::ffff:169.254.169.254` (family `6`) skipped all IPv4 metadata/private
  rules. Added `expandForPolicyCheck` so such an address is checked both as
  the IPv6 literal and as its embedded IPv4 form.
- Also: wrapped `dns.lookup` failures in `WebError('WEB_BLOCKED_URL', ...)`
  for consistent error handling; updated a stale doc comment claiming SSRF
  blocking was deferred.
- **What was already solid before this commit** (from the original
  staged diff this commit builds on): default `destinationPolicyMode:
  'block-private'`; every resolved address checked against a denylist
  (RFC1918, loopback, link-local, CGNAT `100.64.0.0/10`, multicast, `::1`,
  ULA, AWS/GCP/Azure + Alibaba metadata IPs); the chosen IP pinned into the
  actual `http(s).request` via a custom `lookup()` callback (closes the
  DNS-rebinding gap between check-time and connect-time); redirects re-run
  the full validate+resolve+same-origin check on every hop.
- **Explicitly out of scope / still open** (flagged, not fixed, in this
  commit): non-loopback auth model, the dynamic-code-execution trust
  boundary, and the unsandboxed shell — three other findings from the same
  review, unrelated to this diff.

## Fork-local incident doc: `dsh-base-bundle-boot-hang.md`

Not a commit in its own right, but worth calling out because it was
**revised with a retraction** across two commits (`a03caa4fc9` and
`d576f1ad6e` touch it): an earlier draft blamed `@deepseek-ai/dsh-goal` for
a boot hang on a bare `dsh-base` profile. That diagnosis was wrong. The
real cause is that `dsh-base` alone has no plugin that reads CLI
task/`--help` args — only the `dsh-headless`/`dsh-web-app` overlay bundles
do — so a bare profile boots cleanly and then correctly idles forever
waiting for input that will never arrive. The fix is adding an overlay
bundle to the profile, not a code change; the speculative fix in
`packages/goal/goal/src/index.ts` was reverted. If upstream ever touches
`packages/goal/goal/src/index.ts` in a way that looks related to this,
check this doc first — the fork's current state there should match
upstream exactly (no lingering fork-specific change).

## Conflict-resolution guidance

1. **Merging/rebasing `dsh-plugins/*` or new `docs/*` files:** should be
   conflict-free — these paths don't exist upstream. Just re-apply.
2. **`packages/mcp/mcp-client/*`:** the fork added a whole new
   `resources.ts` capability and a zero-tools-server fix in
   `connection.ts`/`tools.ts`. If upstream refactors this package, the
   resources consumer needs to be re-ported onto the new shape, not just
   diffed in.
3. **`AGENTS.md`, `README.md`:** fork additions are appended sections (local
   LLM FAQ, plugin conventions bullet). Should merge line-wise without
   semantic conflict in most cases.
4. **`packages/web/web-fetch-http/*` and `packages/client/connection/*`:**
   as of the 2026-08-27 sync (below), these now match upstream exactly —
   the fork's parallel implementations were retired in favor of upstream's.
   Future upstream changes here should apply cleanly; if this fork adds new
   security-hardening work in these packages again, prefer opening it as a
   PR against upstream rather than carrying it fork-side, to avoid
   recreating this conflict.

## 2026-08-27 sync with upstream: two independently-rewritten security layers

Merging `upstream/master` (1933 commits ahead of the fork point) into this
fork's `master` (11 fork commits) surfaced two files/clusters where **both
sides had independently rewritten the same security-critical subsystem**
after apparently similar internal reviews, with genuinely different designs
— not a textual conflict that line-merges, an architectural one. Both
were resolved by **adopting upstream's implementation outright** and
retiring the fork's parallel version. Documented here so future syncs don't
need to re-litigate this.

### Cluster 1: SSRF / destination-policy layer

Files: `packages/web/web-fetch-http/src/{index,policy,provider}.ts`,
`packages/web/web-fetch-http/tests/fetch-http.spec.ts`,
`packages/web/tool-web/tests/integration.spec.ts`.

| | Fork's approach (`9d9f947ba7`) | Upstream's approach (adopted) |
|---|---|---|
| Model | **Denylist**: block known-private/metadata ranges (`BlockList` of RFC1918, loopback, link-local, CGNAT, cloud metadata IPs, `::1`, ULA) | **Allowlist**: `isPublicIpAddress()` via `ipaddr.js` — only admit addresses that are globally-unicast-public |
| IPv4-mapped IPv6 (`::ffff:169.254.169.254`) | Explicit `expandForPolicyCheck()` fix, checks both representations | Handled natively — `isPublicIpAddress` unwraps `isIPv4MappedAddress()` before range-checking |
| NAT64/DNS64 (an IPv6-only resolver silently routing to a private IPv4 via a `64:ff9b::/96`-style prefix) | **Not handled** | Full RFC 6052/7050 handling: discovers the active NAT64 prefix via `ipv4only.arpa`, and rejects a translated destination that resolves to a private IPv4 |
| Config surface | `destinationPolicyMode: 'block-private' \| 'allowlist'` + `destinationAllowCidrs` (operator can widen access to a private CIDR range) | No config knob — always public-only, no allowlist escape hatch |
| Transport | Raw `node:http`/`node:https` + custom `lookup()` to pin the resolved IP | `undici` + a `network.ts` module (`publicHttpNetwork`) that resolves once and pins per-request |

**Pros of the fork's denylist approach:** simpler mental model (deny the
known-bad list); supports an explicit CIDR allowlist escape hatch for
operators who deliberately want to reach an internal service.
**Cons:** denylists are inherently incomplete — this session's own dependency
check confirmed it has no NAT64 handling, so an IPv6-only DNS64 resolver
could route the provider to a private IPv4 destination undetected; the
allowlist escape hatch is also a foot-gun (a misconfigured
`destinationAllowCidrs` silently reopens SSRF).

**Pros of upstream's allowlist approach:** an allowlist of "known-public"
is safer by construction than a denylist of "known-private" (fails closed
on anything unrecognized, including future private-range allocations);
closes a real gap (NAT64) the fork's review never surfaced.
**Cons:** no operator escape hatch if a deployment genuinely needs to reach
a private/internal HTTP target — that use case is simply unsupported now.

**Decision: adopted upstream's approach wholesale.** Both models fully
solve the IPv4-mapped-IPv6 bypass the fork's review found, so on security
terms they're equivalent for that specific gap; upstream is measurably
more thorough (NAT64). Per the standing instruction to minimize future
merge friction, the fork's parallel implementation (`resolveDestination`,
`compileDestinationAllowlist`, `expandForPolicyCheck`, the
`destinationPolicyMode`/`destinationAllowCidrs` config fields) was dropped
entirely rather than reconciled line-by-line. Verified via repo-wide grep
that nothing outside `web-fetch-http` itself depended on the dropped
identifiers except one test call site
(`packages/web/tool-web/tests/integration.spec.ts`), which was updated to
drop the now-nonexistent config fields (matching upstream's own version of
that same test).

### Cluster 2: Remote-RPC authentication layer

Files: `packages/client/connection/src/index.ts`,
`packages/client/connection/tests/node-half.host.spec.ts`.

| | Fork's approach (`9d9f947ba7`) | Upstream's approach (adopted) |
|---|---|---|
| Auth model | Bearer token (`remoteAuthMode: 'none' \| 'bearer'`, `remoteAuthTokens`, configurable header) | Browser session cookie, exchanged via `BrowserAuth` (`cookieMaxAgeDays`, default 30-day lifetime) |
| Loopback trust | Loopback requests bypass auth entirely (no token required) | **Uniform** — even a loopback request must present a valid session cookie; a request whose Host claims `localhost` still gets 401 without one |
| Rate limiting | Fork's own `FixedWindowRateLimiter` gating non-loopback requests | None visible in the merged file — likely superseded by cookie-exchange being the gate itself |
| Privileged-method pinning | Explicit `PRIVILEGED_METHODS` set (settings/credentials/native-dialog methods) re-checked against the real socket peer, independent of bearer-token validity | Not present as a separate concept — folded into the uniform `requestRejection()` check |
| WebSocket downlinks | Fork registered `MUX_EVENTS_PATH`/`HOST_EVENTS_PATH` upgrade routes gated by the same auth+rate-limit checks, under `ctx.inject(['apiProxy'], ...)` | Not present in `index.ts`; `ctx.inject(['attachments'], ...)` only asserts image body capacity — mux/host event delivery is evidently handled elsewhere upstream (not investigated further) |

**Pros of the fork's bearer-token approach:** works for non-browser callers
(CLI scripts, service-to-service) without a cookie exchange step; explicit
privileged-method pinning is a defense-in-depth layer independent of the
main auth check; loopback-without-auth is convenient for local dev/curl.
**Cons:** loopback-without-auth is also the weaker security posture — the
merged upstream test (`requires authentication uniformly over a real HTTP
request`) demonstrates exactly the class of bug this trades away, a
client-controlled `Host: localhost` header reaching a privileged method
without ever proving who's asking; a bespoke rate limiter and bespoke
privileged-method list are more surface to keep in sync as the method list
grows.

**Pros of upstream's cookie approach:** uniform enforcement — no
loopback special-case to get wrong; a session-token exchange (backed by
`@deepseek-ai/dsh-credentials`) is the same primitive the rest of the host
already uses, rather than a second auth mechanism.
**Cons:** browser-cookie auth doesn't obviously serve a non-browser bearer
caller (e.g. a script hitting the API directly with a static token) — if
the fork's imchat/browser-bridge plugins or any headless automation assumed
bearer-token access, they'd need to be re-checked against the cookie model
(none currently do, per this session's dependency check).

**Decision: adopted upstream's approach wholesale**, for the same
future-merge-friction reason. Confirmed via repo-wide grep that no
`dsh-plugins/*` code, doc, or config references `remoteAuthMode`,
`remoteAuthTokens`, `remoteAuthHeader`, `remoteRateLimitWindowMs`,
`remoteRateLimitMaxRequests`, `MUX_EVENTS_PATH`, or `HOST_EVENTS_PATH` — the
fork's own test suite (`node-half.host.spec.ts`) was the only consumer, and
it was replaced with upstream's version of the same file. **Verified:** the WebSocket mux/host-event downlink functionality the
fork's `ctx.inject(['apiProxy'], ...)` block provided does have a current
upstream equivalent — it was not dropped, just relocated. Upstream split
this out of `packages/client/connection` entirely into a new
`packages/api/gateway` package (part of a larger upstream refactor visible
in the commit log: "refactor(api): remove ApiProxy package",
"refactor(connection): own RPC transport contracts", etc.). See
`packages/api/gateway/src/index.ts`, which registers its own
`REMOTE_STREAM_MUX_PATH` WebSocket upgrade route via a
`RemoteStreamMuxServer`, gated through the same Gateway auth path. No
functionality gap from adopting upstream's `connection/index.ts` wholesale.

### Pre-existing i18n pairing gate gap (unrelated to the merge, surfaced by it)

Committing the merge hit `verify-translation-pairing` (a pre-commit hook):
~50 fork-added files (`dsh-plugins/*/README.md`, `docs/designCognitiveBrainForDSH.md`,
`docs/CompareTools.md`, `docs/adr/rp_dshPlugins.md`, the vendored
`docs/packages/cognitiveBrain/**` reference tree, etc.) have never had a
paired `.zh.md` Chinese translation, violating this repo's bilingual-docs
contract (`docs/i18n/README.md`). This gate already existed at the fork
point — it's pre-existing fork debt, not something this merge introduced;
it only surfaced now because this was the first commit to actually run the
hook against these files. **Decision (explicit user instruction): added
these paths to `scripts/translation-pairing.manifest.json`'s `excluded`
list** (`dsh-plugins/`, `docs/packages/`, plus each individual fork-only
`docs/*.md`) rather than writing ~50 Chinese translations, to unblock the
commit. This is a pragmatic deferral, not a permanent policy decision —
revisit if these docs are meant to be user-facing outside the fork.

Two files were genuinely fixed rather than excluded, since they already had
real `.zh.md`/`.i18n.yaml` pairs the gate wants kept: `README.md` and
`packages/mcp/mcp-client/README.md`. Both needed their Chinese counterparts
patched to cover content this session's own conflict-resolution edits
introduced, then re-recorded with `verify-translation-pairing --write`.
Fixing `README.md`'s pairing also surfaced a **pre-existing, unrelated
defect**: the "Run from `npm`" section's code fence contained an unclosed,
scrambled dump of raw agent notes (duplicate/contradictory install
instructions, a `docs/designCognitiveBrainForDSH.md` reference, etc.) that
predates this merge entirely (confirmed present in the fork's pre-merge
commit `08eee4ef6b`) — fixed as part of this pass since the gate wouldn't
pass otherwise; see the `README.md` diff in this merge commit.

### Post-merge test verification (Cognitive Brain / Knowledge Graph integration)

Before committing, the packages implementing the fork's memory/knowledge-graph
feature set (`dsh-plugins/knowledge-hub`, `dsh-plugins/mcp-server`) and the
shared packages this merge actually rewrote (`packages/mcp/mcp-client`,
`packages/web/web-fetch-http`, `packages/client/connection`,
`packages/web/tool-web`) were built and tested directly (`tsc`/`vitest`),
scoped to what the merge could plausibly have broken — not a full
monorepo-wide test run (265 workspace packages), which was out of scope for
a merge-conflict verification pass.

| Package | Build | Tests |
|---|---|---|
| `dsh-plugins/knowledge-hub` | clean | 118/118 passed (15 files) |
| `dsh-plugins/mcp-server` | clean | 37/37 passed, 1 pre-existing skip (4 files) |
| `packages/mcp/mcp-client` | — | 110/110 passed after one fix (below) |
| `packages/web/web-fetch-http` + `packages/client/connection` + `packages/web/tool-web` | — | 261/261 passed |

**One real regression found and fixed:** `packages/mcp/mcp-client/tests/resources.spec.ts`
(the fork's own test file for the resources-bridge feature added in
`d576f1ad6e`) imported a symbol `CallId` from `@deepseek-ai/dsh-llm` that
upstream renamed to `ToolCallId` somewhere in the 1933 merged commits.
Every *other* test file in the same package already used `ToolCallId` —
confirming this was upstream's rename, not a naming choice this session
introduced — so `resources.spec.ts` alone had gone stale. Fixed by renaming
the import and local helper to `ToolCallId` in that one file.

**A near-miss, deliberately reverted:** `dsh-plugins/mcp-server/src/index.ts`
and `dsh-plugins/knowledge-hub/tests/agent-chat-integration.test.ts` also
reference `CallId` from `@deepseek-ai/dsh-llm`. Applying the same rename
there first *looked* like the same fix — but these `dsh-plugins/*` packages
are standalone npm packages with their own pinned `node_modules`
(`dsh-plugins/README.md`'s live-boot notes: kept outside the pnpm workspace
on purpose, installed the way an external community plugin would be), and
their installed `@deepseek-ai/dsh-llm` copy is an older published version
that still exports `CallId`, not `ToolCallId`. Renaming would have broken
a currently-working build against a dependency that doesn't exist yet in
what they actually have installed. Reverted both files back to `CallId`.
**This is a real latent risk to flag, not a bug to silently fix**: the day
either plugin's `@deepseek-ai/dsh-llm` dependency gets bumped to a version
built from current upstream source, both will break with the same
`TypeError: CallId is not a function` `resources.spec.ts` hit here — worth
a `CallId` → `ToolCallId` grep across `dsh-plugins/*` at that time.
