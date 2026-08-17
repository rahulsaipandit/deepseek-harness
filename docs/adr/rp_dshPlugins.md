# Community DSH Plugin Review

Status: Research notes (not a decision record)
Date: 2026-08-16
Context: Ahead of building our own hardened plugins in an isolated folder, this
document reviews the community plugins shared in
[deepseek-harness discussion #1797](https://github.com/deepseek-ai/deepseek-harness/discussions/1797)
for what they do, code quality, and security. Each plugin was cloned locally
and read in full (not just its README) by an independent review pass. Verdicts
use three tiers: **good/useful** (usable as-is), **usable with caution**
(fine to adopt or copy from, with a specific caveat to manage), and **avoid**
(a concrete vulnerability or unacceptable risk, not just a caution).

## Summary table

| Plugin | Category | Verdict |
|---|---|---|
| [dsh-usage-chart](#dsh-usage-chart) | Web UI usage/cost dashboard | Good/useful |
| [DSH_plugins_4U — wallpaper](#dsh_plugins_4u) | Web UI cosmetic | Good/useful |
| [dsh-plugin (loongsuite)](#dsh-plugin-loongsuite-observability) | Observability (OTel) | Usable with caution |
| [dsh-browser](#dsh-browser) | Browser automation (Chrome ext.) | Usable with caution |
| [DSH_plugins_4U — vision](#dsh_plugins_4u) | Image-to-text bridge (scoped route) | Usable with caution |
| [visionDS](#visionds) | Image-to-text bridge (skill scripts) | Usable with caution |
| [dsh-plugin-mm-vision](#dsh-plugin-mm-vision) | Image-to-text bridge (scoped tool) | Usable with caution |
| [dsh-logistics-tracker](#dsh-logistics-tracker) | Courier tracking tool | Usable with caution |
| [dsh-vscode](#dsh-vscode) | VS Code chat client | Usable with caution |
| [deepseek-harness-vsc-extension](#deepseek-harness-vsc-extension) | VS Code chat client | Usable with caution |
| [dsh-desktop](#dsh-desktop) | Electron desktop wrapper | Usable with caution |
| [dsh-desktop-zero](#dsh-desktop-zero) | Electron desktop wrapper | Usable with caution |
| [DSH_plugins_4U — wechat](#dsh_plugins_4u) | WeChat bridge | Usable with caution / lean avoid |
| [dsh-workbench](#dsh-workbench) | File explorer/diff panel | **Avoid as-is (real vulnerability)** |
| [skillhub (cocofhu)](#skillhub-cocofhu) | Skill marketplace search/install | Usable with caution |
| [flight-search](#new-plugin-flight-search) (ours, new) | Flight-price lookup tool | Our own hardened port — see design + implementation |
| [vision-bridge](#new-plugin-vision-bridge) (ours, new) | Image-to-text bridge | Our own hybrid of visionDS + dsh-plugin-mm-vision — see design + implementation |
| [skillhub](#new-plugin-skillhub) (ours, new) | Skill marketplace search/install | Our own hardened redesign of skillhub (cocofhu) — see design + implementation |

---

## dsh-vscode

Source: https://github.com/Lixxx1/dsh-vscode

**What it does:** A VS Code sidebar/webview chat client that spawns the
official `dsh` CLI as a local child process (`dsh web --host 127.0.0.1
--port 0`), talks to it over HTTP/WebSocket RPC, and renders the agent
conversation, tool calls, approvals, and permission prompts in a webview.

**Code quality:** Reasonably clean, modern TypeScript with small focused
modules (`runtime.ts`, `dsh-client.ts`, `launch.ts`, `webview.ts`,
`conversation.ts`, `credentials.ts`). Has unit tests (vitest) and CI. `webview.ts`
(527 lines) hand-rolls a markdown renderer/DOM builder as a giant inline
template — functional but hard to audit. The whole repo is a single commit —
a first alpha drop, not a project with a maintenance track record.

**Security:**
- `src/runtime.ts:90` spawns the configured `dsh` executable via `spawn()`
  with an argument array (no shell string-concatenation, so no injection from
  the array itself) — but this is full arbitrary-command execution by design
  once configured; `package.json:45-49` self-declares
  `untrustedWorkspaces.supported: false`.
- API key handling is correct: stored via VS Code `SecretStorage`
  (`src/extension.ts:821`), never written to disk/settings, only injected into
  the child's env (`runtime.ts:95`).
- DSH binds to `127.0.0.1` with an OS-assigned port; the client only connects
  to that loopback URL parsed from the child's own stdout — low SSRF risk.
- Webview XSS: strict CSP, DOM built via `textContent`/`createElement` (not
  `innerHTML`); markdown links restricted to `http`/`https` before
  `openExternal` (`src/extension.ts:693-695`).
- No hardcoded secrets found.

**Verdict: usable with caution.** No malicious code or injection/exfiltration
bugs; credentials handled correctly; network surface is loopback-only. Single-
commit/single-author alpha not yet vetted by a community. Good reference for
the runtime/launch/credentials module pattern.

---

## dsh-plugin (loongsuite observability)

Source: https://github.com/loongsuite/dsh-plugin

**What it does:** A Cordis plugin that hooks DSH's `sessions`/`llm` events to
build an in-memory span tree (turn → step → LLM/tool invocations) and exports
it as OTLP/HTTP traces (and optional metrics) to any configured endpoint
(Jaeger, Grafana Tempo, SigNoz, Langfuse, etc.).

**Code quality:** Good — clean separation (`config.ts`/`telemetry.ts`/
`coordinator.ts`/`mapping.ts`), strong typing, defensive try/catch around
every host callback so telemetry failures can't break the agent loop
(`coordinator.ts:230-288`, `297-309`), 580 lines of tests across 6 spec
files. Version `0.1.0-beta.2` — pre-1.0/early-stage.

**Security — the project's own privacy claims were independently verified,
not just trusted:**
- **Content capture off by default — confirmed.** `config.ts:48,71-78`: no
  schema default, only enabled if explicitly configured or via
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. Every capture site
  (`coordinator.ts:408-414, 494-499, 559-569, 602-607, 683-695`) is gated
  behind this flag.
- **Private, non-global provider — confirmed.** `telemetry.ts:164,180,183-188`
  constructs a private `BasicTracerProvider`/`MeterProvider`; no call to
  `trace.setGlobalTracerProvider`/`metrics.setGlobalMeterProvider` anywhere.
- No allowlist/restriction on the configured OTLP endpoint/host — but this is
  operator config (plugin config or `OTEL_EXPORTER_OTLP_*` env), not
  attacker-reachable input from within a session. Inherent to any OTLP
  exporter, not unique sloppiness.
- No hardcoded secrets; `headers`/`OTEL_EXPORTER_OTLP_HEADERS` are pass-through
  config for OTLP auth tokens.
- Minimal permissions: `inject = ['sessions', 'llm']` only.

**Verdict: usable with caution.** Well-engineered, and its two headline
privacy claims both check out against actual code — more trustworthy than
the average third-party observability plugin. Residual caution: pre-1.0,
pulls in `@opentelemetry/*` + `@loongsuite/otel-util-genai` deps you haven't
audited, and enabling `captureContent` (or leaving the env var set to
`SPAN_ONLY`/`SPAN_AND_EVENT`) ships full prompts/tool args/results to
whatever endpoint is configured — treat that toggle as the actual trust
boundary. The coordinator/mapping logic is a solid reference to reimplement.

---

## dsh-desktop

Source: https://github.com/zouzhe1/dsh-desktop

**What it does:** An unofficial Electron "green/portable" wrapper around the
`@deepseek-ai/dsh` CLI's web UI. On first run it detects region (via
timezone), downloads a Node.js runtime and npm-installs `dsh` if not
bundled, spawns `dsh web --port 0`, and points the BrowserWindow at the
resulting `http://127.0.0.1:<port>`.

**Code quality:** Single-file `app/main.js` (~400 lines) + 9-line
`preload.js`, readable with Chinese inline comments. No tests anywhere in
the repo; cloned copy has one commit. `spawnSync('tar', ...)` with a
PowerShell `Expand-Archive` fallback string-interpolates a filesystem path
into a `-Command` argument (`app/main.js:305`) — not attacker-controlled
today (path derives from a fixed version string), but a shell-injection-
shaped pattern that would matter if `NODE_VERSION` (read from
`process.env.DSH_DESKTOP_NODE_VERSION`) were ever attacker-influenced. No
log rotation on `bootstrap.log`.

**Security:**
- Electron hardening done correctly: `contextIsolation: true`,
  `nodeIntegration: false`, proper `contextBridge` preload exposing only
  three narrow IPC methods (`main.js:188-192`, `preload.js:5-9`).
- No `shell.openExternal` calls anywhere.
- Window only ever loads a static `data:` URI or the locally-spawned
  `http://127.0.0.1:<port>` — no arbitrary/remote URL navigation.
- **No checksum/signature verification** of downloaded Node.js zips or of
  the npm-installed `dsh` package (`main.js:226-341`) — the main
  supply-chain risk: a compromised/MITM'd mirror or registry could deliver a
  malicious Node binary or malicious `@deepseek-ai/dsh` package, run with
  full local-user privilege, no sandboxing of the child process.
- `killTree` shells out to `taskkill /pid ... /T /F` (`main.js:78`) with a
  PID sourced from the locally-spawned child — low risk.
- The "full" (offline-bundled) build mode avoids runtime downloads; the
  default "slim" mode is the one with unverified first-run fetches.

**Verdict: usable with caution.** Electron security basics are done right.
The gap is supply-chain trust: unverified first-run downloads, no tests,
single-maintainer/unaudited provenance. Good reference for the
bootstrap/wizard UX and correct `webPreferences`; add checksum verification
and pin the `dsh` version before adopting, and prefer the "full" build mode.

---

## dsh-desktop-zero

Source: https://github.com/LambProgrammer/dsh-desktop-zero

**What it does:** A thin unofficial Electron shell (Windows) that bundles the
official `@deepseek-ai/dsh` npm packages plus a standalone `node.exe`, spawns
`dsh web` on a random localhost port, and displays its web UI inside a
chromeless window (iframe embedding `http://127.0.0.1:<port>`).

**Code quality:** Small and readable (`src/main.js` ~289 lines, `preload.js`
15 lines, `renderer.js` 17 lines) with explanatory Chinese comments. No test
suite; single commit visible in this clone. `killDsh()` calls
`.kill()` then unconditionally also fires `taskkill /pid ... /T /F`
(`main.js:150-156`) even on graceful exit — harmless but redundant.

**Security:**
- Renderer hardening correct for both main and splash windows:
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (`main.js:210-215`, `180-182`). Preload exposes only three narrow IPC calls
  plus a port reader via `contextBridge`.
- Tight CSP: `default-src`/`frame-src` restricted to `'self'` and
  `http://127.0.0.1:*`, `script-src 'self'` (`index.html:5-6`, no
  inline/eval). Iframe only ever points at the locally-spawned server.
- **No auto-updater at all** — no `publish:` config in `electron-builder.yml`,
  build script uses `--publish never` — no auto-update RCE surface exists.
- No user-controlled input reaches `execFile`/`spawn` calls (hardcoded/derived
  paths, numeric PID for taskkill).
- No hardcoded secrets found.
- **Supply-chain note:** a prebuilt `resources/node.exe` (~92MB) is committed
  directly into the repo rather than fetched/verified via checksum from
  nodejs.org (`main.js:88-96`, `electron-builder.yml:31-32`) — anyone trusting
  this repo is trusting that binary blob's provenance, unverifiable from
  source alone. Builds are also unsigned (no code-signing config).

**Verdict: usable with caution.** The Electron wrapper code itself is a
genuinely good example to copy (`contextIsolation`/`sandbox`/CSP/minimal
preload/no remote content, no updater to abuse). Risk is supply-chain trust
(unsigned build, committed unverified `node.exe`, no tests, unclear
maintenance) rather than the wrapper's logic. If reimplementing: keep the
same hardening pattern, but build/fetch `node.exe` from an official verified
source and add code-signing plus tests.

---

## dsh-logistics-tracker

Source: https://github.com/tingyang266/dsh-logistics-tracker

**What it does:** A DSH plugin that lets the model (or a sidebar panel) query
Chinese courier tracking status via two aggregator APIs — KDNiao and
Kuaidi100 — given a tracking number, normalizing the result into a formatted
trace.

**Code quality:** Small, single upload commit, no tests/CI. Clean layering:
`index.js` (host registration + HTTP routes) → `service.js` (adapter
selection/formatting) → `providers/*.js` (per-vendor HTTP + signing). Minor
issue: remote API error messages are passed straight to the client
(`index.js:182`) — a minor info-leak, not severe.

**Security:**
- **No SSRF**: both providers use hardcoded endpoint constants
  (`kdniao.js:4`, `kuaidi100.js:4-6`). User-supplied `trackingNumber`/
  `companyCode`/`phoneTail` go into POST bodies or a query param via
  `encodeURIComponent` (`kuaidi100.js:46`), never into the URL host.
- No format validation on tracking number/company code, but since these only
  end up as opaque fields against fixed endpoints, that's a data-quality
  issue, not an injection vector.
- **API keys never hardcoded** — resolved host-side only via `resolveKey()`
  (`src/index.js:16-31`): config → `credentials.resolve(ref)` → env var. The
  browser client never sees the key, only calling the host's
  `/logistics/trace` route — the correct pattern. Vendor signing uses
  vendor-mandated MD5 (weak, but that's the vendors' API contract).
- Response rendering uses `react.createElement` with text children (not
  `dangerouslySetInnerHTML`); routes only accept GET/HEAD — no reflected-XSS
  surface found.

**Verdict: usable with caution.** No SSRF/XSS/key-leak issues; the
credential-handling pattern (host-only, HTTP proxy for the browser panel) is
genuinely well done. Zero tests, single unmaintained commit, relies on two
third-party aggregators whose reliability/ToS/data handling can't be verified
from code alone. Good reference for the key-resolution and host/client
split pattern; pin/vendor rather than track upstream if adopted.

---

## dsh-usage-chart

Source: https://github.com/Max-Samson/dsh-usage-chart

**What it does:** Registers a client-side dock widget under the DSH Web UI
composer showing live token usage, per-round cost breakdown, and DeepSeek
account balance (proxied via `/user/balance`), rendered as hand-drawn
SVG/HTML — no charting library. A host-side Node module exposes same-origin
routes (`/balance`, `/usage`, `/pricing`, `/meta`, `/rate`).

**Code quality:** Well above the typical community-plugin bar. Clean
host/client separation, heavy JSDoc, TypeScript throughout, `tsc --noEmit` +
`node --test` unit tests (5 files, ~950 lines) covering rounds folding,
pricing, anomaly detection, and a manifest test. CI runs typecheck + tests +
`npm pack --dry-run` on Node 20/22. Actively maintained (latest commit
2026-08-15). Defensive error handling throughout (try/catch around all
fetch/localStorage, structured `ok`/`reason` responses instead of throwing).

**Security:**
- **No XSS surface**: zero `innerHTML`/`dangerouslySetInnerHTML`/`eval`/
  `new Function` anywhere in `src/`. Rendering goes through JSX with
  React-escaped props/children; CSS is injected via `tag.textContent =
  PLUGIN_CSS` (`src/client/styles.ts:497-501`) — a static constant, not
  user-data-derived.
- FX endpoint hardcoded to `https://open.er-api.com/v6/latest/USD`
  (`src/index.ts:111`) with a fallback list. Host-configurable, but
  `normalizeFxUrl()` (`src/index.ts:117-133`) enforces HTTPS (except
  loopback), rejects embedded credentials, strips the hash. Fetch happens
  server-side; the FX request carries no usage/cost/session data.
- **No data exfiltration**: only outbound calls are to DeepSeek's own
  balance endpoint (API key stays server-side, never sent to the browser,
  `src/index.ts:220-276`) and the no-payload FX GET. All client-facing
  routes are same-origin, GET-only, and gated by `isTrustedRequest()`
  (`src/index.ts:178-193`), checking `Sec-Fetch-Site`/`Origin` vs `Host` to
  block cross-origin/CSRF-style reads.
- **Zero-dependency claim verified genuine** — no runtime `dependencies` in
  `package.json` at all, no CDN script tags, no dynamic `import()` of a
  charting library.

**Verdict: good/useful, usable as-is.** Unusually careful for a community
plugin — origin-checked routes, HTTPS-enforced/credential-stripped FX URL
config, no eval/innerHTML, real tests, active CI. It does proxy your
DeepSeek API key server-side to fetch balance, so install only from a
trusted/reviewed commit. `isTrustedRequest`/`normalizeFxUrl`/`normalizeBaseUrl`
are worth copying directly as reference patterns.

---

## dsh-workbench

Source: https://github.com/lee259/dsh-workbench

**What it does:** A DSH Web plugin adding a right-side "workbench" panel —
file tree/explorer, code/markdown preview (CodeMirror + marked + DOMPurify),
a diff/review view of session file writes, and an SSE-based live
file-change feed. Host side registers HTTP routes (`/files`, `/file`,
`/review`, `/workspace`, `/events`, a file-asset route) backed by direct
Node `fs` access.

**Code quality:** Reasonably well-organized (host/client/shared split, ~2600
lines of vitest tests covering path identity, workspace, diff, markdown, tab
model), TypeScript throughout, CI + dependabot. Single commit visible
(shallow/squashed release) — real history/maintenance cadence not
assessable from this checkout.

**Security — a real, concrete vulnerability, not just a caution:**
- **Arbitrary absolute-path file read/browse, unauthenticated, by design.**
  `src/host/path-identity.ts:20-36` (`identify()`) accepts any absolute path
  and returns `ok: true` even when it resolves *outside* the workspace root
  (only rejects empty/null-byte input) — and this is asserted as intended
  behavior in `tests/path-identity.test.ts:19-26` ("an absolute path outside
  the root keeps the absolute display path"). Combined with the
  `FILE_API_PATH`/`FILE_ASSET_API_PATH` handlers (`src/host/index.ts:108-119`,
  `185-208`), which take `path` straight from the query string with no
  origin/auth check, **any HTTP client that can reach the DSH web server's
  local port can read arbitrary files on the host filesystem** (subject to
  size limits and content-type sniffing on the asset route).
- **Arbitrary workspace-root pivot, unauthenticated.** The `WORKSPACE_API_PATH`
  POST handler (`src/host/index.ts:147-166`, `setRoot` at `76-91`) accepts
  any directory path from the request body and re-roots the entire
  workspace/file-tree/watcher to it, with only an `fs.stat().isDirectory()`
  check — no allowlist, no session-ownership confirmation, no CSRF token.
  Anything able to POST to this endpoint (SSRF, another local process, a
  misconfigured CORS/bind) can point the file explorer at `/etc`,
  `C:\Users\...`, etc., then use the read endpoints above to exfiltrate
  files.
- No outbound third-party network calls; no hardcoded secrets;
  `dangerouslySetInnerHTML` (`src/client/preview/code-view.tsx:92-96`) is
  properly wrapped in `DOMPurify.sanitize(...)` — the UI layer itself is
  fine.
- The plugin declares `inject = ["sessions", "webServer"]` — read access to
  all session data/events plus full HTTP route registration, which is what
  makes the above reachable.

**Verdict: usable with caution as a UI reference; not safe to install
as-is.** The CodeMirror/sanitized-markdown/diff-review UI is solid and worth
reusing. The host HTTP API's path handling is a real local-network
arbitrary-file-read and directory-pivot risk if the DSH web server's port is
reachable by anything untrusted (other local users, browser CSRF,
misconfigured binding). Before adopting: reimplement `path-identity.ts` to
hard-reject/clamp paths outside root, add auth/origin checks (or at minimum
a CSRF token) on `/workspace` and the file routes, and drop the
"absolute path outside root is fine" behavior entirely.

---

## deepseek-harness-vsc-extension

Source: https://github.com/weinibuliu/deepseek-harness-vsc-extension

**What it does:** A VS Code chat-panel frontend for DSH, architected
differently from `dsh-vscode`: a cross-window "Runtime Broker" — a detached
Node process (`src/dsh/runtime-broker-main.ts`) — owns one shared managed
`dsh web` child process over a fixed loopback port, while each VS Code
window is an IPC lease-holder talking to it via a Unix socket/named pipe.
The webview drives the session via HTTP RPC plus two WebSocket downlinks
defined in `src/dsh/wire.ts`.

**Code quality:** Notably more mature than a typical community extension —
TypeScript throughout, structured service layer, a real broker/lease
protocol with version negotiation, graceful shutdown with SIGTERM→SIGKILL
grace period (`server.ts:176-192`), CSP injection with nonces for the
webview (`webview/html.ts:18-37`), some unit tests (discovery, probe,
path-util, agent-preset, server). Entire history is a single squashed
commit. Test coverage is thin relative to the ~9k LOC surface (e.g.
`chat-view.ts` alone is 1729 untested lines).

**Security:**
- **Process spawning**: `src/dsh/server.ts:71` spawns the discovered `dsh`
  launcher; on Windows, `.cmd`/`.ps1` shims are spawned with `shell: true`
  (`server.ts:66-75`, `148-153`). Exploitable only if an attacker can plant a
  malicious `dsh.cmd` earlier in PATH than the real one — a real but narrow
  supply-chain risk from PATH-scan discovery order (`discovery.ts:94-107`),
  not direct user-input injection.
- `npx --no-install @deepseek-ai/dsh` fallback (`discovery.ts:131-138`) only
  resolves an already-installed package, never auto-installs — low risk.
- `probe.ts:25-43` (`normalizeDshBaseUrl`) validates a configurable
  `externalUrl` setting (http/https only, no creds/query/fragment, root
  path) — decent input validation for an intentional "connect to remote
  DSH" feature.
- `package.json:28-30` only declares `onStartupFinished` activation — not
  overly broad.
- No hardcoded secrets found in any reviewed file.
- `webview/open-file.ts:10-17` resolves relative paths against the workspace
  root with `path.resolve` and no traversal-prevention clamp — a compromised
  dsh host response could in principle point "open" at a path outside the
  workspace, though this only opens a file in the editor (no write/exec
  primitive).

**Verdict: usable with caution.** No arbitrary remote code fetch, no
hardcoded secrets, reasonable CSP/socket hygiene, defensive port/URL
validation. Concerns are single-commit/no-history provenance, thin test
coverage relative to size, and the ordinary "attacker plants an executable
earlier in PATH" risk inherent to any tool that shells out to a
user-configured CLI. Solid architectural reference (the broker/lease design
in particular); pin `dshPath` explicitly if adopting.

---

## dsh-browser

Source: https://github.com/Lum1104/dsh-browser

**What it does:** A Chrome MV3 sidebar extension where a background service
worker connects over `ws://127.0.0.1:*` to a locally-running DSH bridge
server, sitting alongside DSH's `/api` gateway as its own route. The model
issues browser tool calls (`browser_click`, `browser_navigate`, etc.) over
that socket; the content script executes them against the live page and
returns text-only structured snapshots — the model never sees raw
DOM/HTML.

**Code quality:** Notably high for a community extension — heavily
commented with rationale, ~2,200 lines of vitest specs across every module,
an explicit pure-function authorization layer (`background/authorization.ts`),
origin-trust normalization with tests (`security/trusted-origins.ts`), and
dedicated security-focused specs (`tests/actions-security.spec.ts`,
`tests/untrusted.spec.ts`). Single commit in this checkout — shallow
history, long-term maintenance cadence not independently assessable.

**Security — this was the highest a-priori risk category (live session/cookie
access), and it holds up well:**
- Manifest scope is broad: `host_permissions`/`content_scripts.matches` are
  `http://*/*` and `https://*/*` (`manifest.json:18-21, 38-41`), not opt-in
  per-site, with `all_frames: true` + `match_origin_as_fallback: true`
  (`manifest.json:46-47`) meaning it also runs in sandboxed/about:blank
  iframes — inherent to the product's purpose (operate whatever tab the
  user is on), not a bug.
- **No `window.postMessage`/`onMessageExternal` listener anywhere** (verified
  via grep across the whole extension) — the content script only listens on
  `chrome.runtime.onMessage` (`content/index.ts:72`), which arbitrary web
  pages cannot call. This is the single most important finding: the classic
  "unguarded message listener → full session hijack" vulnerability class
  this kind of extension is most at risk of is **not present**.
- **Bridge authentication is token-based, not naked localhost.** `token.ts`
  generates a 256-bit random hex token, persists it 0600, compares with
  `timingSafeEqual` (`token.ts:36-44`). `server.ts:290-304` documents and
  guards the one shortcut: loopback sockets can skip the token only if the
  WebSocket's `Origin` header starts with `chrome-extension://` — a web page
  cannot forge that header, so a malicious page opening a cross-origin
  socket to 127.0.0.1 cannot ride the loopback bypass. Privileged host
  methods (`host.pickDirectory`, `credentials.*`, `settings.*`) are
  additionally pinned to loopback-only regardless of token
  (`server.ts:45-56, 404-408`).
- **Per-action user approval required by default**
  (`background/authorization.ts`), with cross-origin navigation and history
  actions explicitly barred from silently expanding a trust allowlist
  (`authorization.ts:46-62`). Page content shown to the model is wrapped
  with an explicit untrusted-data boundary and a random nonce
  (`background/untrusted.ts`) — defense-in-depth against prompt injection
  via page content, not a hard boundary (the file's own comment admits
  this).
- No evidence of page content or cookies being sent anywhere except the
  local bridge connection.

**Verdict: usable with caution.** The architecture is unusually careful for
this risk category — token auth with `timingSafeEqual`, an Origin-gated
loopback exception that specifically closes off "any local process can hit
127.0.0.1," no page-reachable message listener, per-action approval, and an
untrusted-content wrapper. The main residual risk is the broad
`<all_urls>`-equivalent scope, inherent to the product's purpose. If
reimplementing, the Origin-gated loopback auth pattern and the pure
authorization/approval separation are worth copying wholesale — there isn't
an obvious flaw here a from-scratch rewrite would need to fix.

---

## DSH_plugins_4U

Source: https://github.com/honghudavy-star/DSH_plugins_4U — a bundle of
three independent plugins for macOS (WeChat bridge, wallpaper, vision).

**Code quality (all three):** Notably solid for a community bundle —
consistent Cordis plugin structure, input validation on every HTTP handler
(size limits, same-origin checks, content-type checks), `node --test` unit
tests (`tests/plugin-format.test.mjs`) covering config controllers,
port-busy detection, symlink/path-traversal rejection, and image-magic-byte
validation, plus a real CI workflow (syntax check, tests,
`npm pack --dry-run`, `npm audit`) on macOS/Node 22.

### wechat (`@dsh-plugins/wechat`)

Spawns a Node subprocess that logs into a personal WeChat account, relays
inbound texts/images/files into a dedicated DSH session, and forwards the
assistant's reply (plus files) back to WeChat; also exposes a local
`POST /send` endpoint for proactive notifications.

- **Main flag: depends on `wechat-ilink-client@0.1.0`**
  (`package.json:37`), an **unofficial personal-account WeChat automation
  library** (QR-login flow, `src/dsh-wechat-bridge.mjs:266-278`). WeChat has
  no public API for individual-account bidirectional bot access; such
  libraries reverse-engineer the mobile/web protocol and carry a real
  account-ban/ToS risk. The "官方 iLink" ("official iLink") code comment
  (`dsh-wechat-bridge.mjs:2`) is misleading marketing, not a genuine
  official channel.
- Credential handling itself is good: session/token/origin files written
  0600 in a 0700 dir (`security.mjs:8-16`), symlinks rejected for both the
  bridge token and outbound files (`security.mjs:21,32`), the local
  `/send` API requires a bearer token (`dsh-wechat-bridge.mjs:336`), only
  the bound "owner" WeChat user is processed (`:545-548`). No evidence of
  session data going to any third-party relay — only WeChat's own protocol
  and the local DSH instance.
- **Verdict: usable with caution / lean avoid.** Code quality and local
  credential hygiene are good, but it fundamentally relies on an unofficial
  WeChat automation library — a real account-ban/ToS risk regardless of
  surrounding code quality. Best used as a reference for the
  bridge/security-hygiene patterns, reimplemented against an official
  channel (e.g. WeChat Work API) or accepted knowingly.

### wallpaper (`@dsh-plugins/wallpaper`)

Injects a `background` CSS rule into the DSH Web UI's `<head>` via
`webServer.tapIndex`, sourced from a bundled preset or a user-uploaded/local
image, at configurable opacity.

- No remote image fetching (`index.mjs:46-53`); sources are either
  name-validated bundled presets (`/^[a-z0-9-]+$/`) or must be absolute
  paths (`validatePatch`, `:190-192`); uploaded bytes are magic-byte
  validated (`validateUploadedImage`, `:147-160`) and written via
  temp-file-then-rename. No path traversal found. A locally-authenticated
  user could point `source` at any absolute file readable by the process,
  but only same-origin/local requests are honored, and the impact (it just
  won't render as a valid image) is low.
- **Verdict: good/useful.** Low risk, clean validation, cosmetic only.

### vision (`@dsh-plugins/vision`)

Exposes `/plugins/dsh-vision/analyze`; takes base64 images from the
composer (paste/drop), forwards them to a SiliconFlow vision model
(`deepseek-ai/DeepSeek-OCR` by default) using a key from a DSH
credential/env var, returns a text description for the text model.

- No hardcoded API key or endpoint — key comes from the credential store or
  `SILICONFLOW_API_KEY` env var (`index.mjs:139-147`).
- Any analyzed image (including WeChat-forwarded photos, via
  `analyzeInboundImages`) is sent to SiliconFlow's API — a **disclosed,
  expected** exfiltration path, not a hidden backdoor, but worth flagging to
  a privacy-sensitive user.
- **Verdict: usable with caution.** Solid code; understand that any
  analyzed image leaves the machine to SiliconFlow.

### Install-claim check (all three)

The community post claimed installation doesn't rewrite the DSH install
directory, npm cache, or built client files. **Verified accurate**:
`install.sh` only does `npm pack` into a temp dir + `npm exec ... dsh
plugin add <tarball>` — never touches DSH's install directory or npm cache
directly; wallpaper injects CSS at runtime via `webServer.tapIndex` rather
than patching built client files (`index.mjs:229-233`); `README.md:191` and
`docs/DSH_PLUGIN_SPEC.md:117` explicitly state plugins extend only through
public Cordis services/routes/slots, never DSH build artifacts.

---

## visionDS

Source: https://github.com/deveuper/visionDS

**What it does:** A four-skill bundle (`vision-ds`, `vision-ds-local`,
`vision-ds-api`, `vision-setting`) that gives a text-only main model
(DeepSeek, etc.) a way to "see" an image, addressing a real gap in this
repo: the core `ctx.llm` seam is multimodal-ready (`ImageBlock`,
`inputModalities`, [docs/subsystems/llm-streaming.md](../subsystems/llm-streaming.md#content-blocks-and-messages))
but `dsh-llm-deepseek` rejects image content outright at the adapter level.
`index.js:40-44` registers the four `SKILL.md` files
through `ctx.skills` (`inject = ['skills']`); each is markdown instructing
the agent to invoke a shared Python script,
`skills/vision-ds/scripts/vision_hub.py` (574 lines), via its own shell
tools. The script posts the image to a configurable OpenAI-compatible
vision API (MiMo, GLM, 豆包/Ark, Qwen-VL/DashScope, Moonshot, OpenAI-compatible,
Ollama, LM Studio — `skills/vision-ds/config/providers.json:1-98`), and
falls back to local Windows (`ocr_windows.ps1`, WinRT OCR) or macOS
(`ocr_macos.swift`) OCR on failure or a ~2-minute timeout.

**Code quality:** Single upload commit, no tests/CI. The script itself is
clean, single-purpose, and defensive in the ways it tries to be: magic-byte
image sniffing (`vision_hub.py:61-77`), a 50MB size cap
(`vision_hub.py:27,217-223`), transient-failure retry-then-fallback logic
(`vision_hub.py:362-442`), and local-OCR `subprocess.run` calls that use
argument lists, never `shell=True` (`vision_hub.py:317-325`) — no shell-injection
surface in the OCR path. API keys are never hardcoded; resolution order is
CLI flag → env var → user config.json → `.env` file
(`vision_hub.py:162-179`), matching the credential-resolution pattern this
review has praised elsewhere. One gap relative to
[dsh-logistics-tracker](#dsh-logistics-tracker) and dsh-browser: the
persisted `config.json`/`.env` holding API keys is written with no
restrictive permissions (`vision_hub.py:94-99`, no `chmod`/0600).

**Security — the design-level concern, not a code bug:**
- **The skill is a shell script the model itself invokes with free-form
  CLI flags, not a schema-scoped `ctx.tools` tool.** `SKILL.md` only
  *suggests* the canonical invocation (`vision-ds/SKILL.md:14-16`:
  `python vision_hub.py "<image path>" --timeout 110 --no-retry`), but
  nothing constrains the agent to those flags. `vision_hub.py` also accepts
  `--base-url` and `--api-key` overrides that take precedence over every
  configured provider (`vision_hub.py:162-201`, `api_key_for`/`base_url_for`
  check `explicit` first), and the positional image argument accepts **any
  local path**, not just real images or attachment-store paths — a file
  that fails every magic-byte/extension check still gets read, size-checked,
  and base64-encoded, just tagged `application/octet-stream`
  (`vision_hub.py:211-224`). Put together: if the agent is ever induced
  (prompt injection from a fetched page, a file it was asked to summarize,
  etc.) to call this script with an attacker-chosen `--base-url`/`--api-key`
  and a locally-readable path already in its context (not necessarily one
  the user pasted as an image), the file's bytes leave the machine to that
  endpoint. This is the documented interface working as designed, not a
  parsing bug — the fix is scoping vision skills like this behind a
  `ctx.tools` schema that never exposes a destination URL or credential to
  the model (the pattern [dsh-plugin-mm-vision](#dsh-plugin-mm-vision) below
  actually uses).
- **The plugin's own companion doc proposes a core-harness patch that would
  make that path easier to reach.**
  `docs/dsh-image-warning-fix.md` documents a fork
  (`deveuper/deepseek-harness@fix/text-only-model-image-admission`, not
  merged into this project's `master`) that removes the admission-time
  rejection of images sent to text-only models in
  `packages/host/apiproxy/src/api-proxy.ts`, replacing the rejected image
  block with the durably-stored attachment's **local absolute file path**
  as ordinary visible text (via a proposed `AttachmentStore.imagePath()`),
  specifically so a skill like this one can pick it up. The doc frames this
  as preserving the "model-visible ⟺ logged" invariant ([architecture.md](../architecture.md#session-log))
  because the durable message stays text — which is true — but it does mean
  any image the user pastes becomes a filesystem path sitting in the
  model's own context, one step away from being handed to a script that
  accepts an attacker-choosable exfiltration target. Worth tracking if this
  fork is ever proposed against this repository directly; it is not part of
  this review's included plugin, only linked from it.

**Verdict: usable with caution.** No malicious code, no hardcoded secrets,
correct provider/credential resolution, and the local-OCR subprocess calls
are injection-safe. The real risk is architectural: implementing vision as
an unrestricted shell skill instead of a scoped tool hands the model both
an arbitrary local file read and an attacker-choosable upload destination
the moment it can be prompt-injected into using them, and the author's own
proposed harness patch would make that reachable from an ordinary pasted
image. Fine to study for the provider-config/fallback pattern; if adopting,
strip the `--base-url`/`--api-key` overrides and confine the image argument
to the attachment store before exposing it to a model that can act on
untrusted content.

---

## dsh-plugin-mm-vision

Source: https://github.com/Elohia/dsh-plugin-mm-vision (ported from the
multi-host [pi-mm-vision](https://github.com/Elohia/pi-mm-vision) project)

**What it does:** Registers one model-facing tool, `mm_vision` (the
"Synesthesia Encoder"), that converts an image into a compact,
coordinate-annotated text description (canvas aspect/color, per-element
`type | x%,y% | size% | color | text/value` rows, chart-vs-photo auto mode,
an optional pixel-grid "reconstruction" mode) so a text-only model can
reason about charts, screenshots, and photos. `lib/index.js:43-66` registers
it via `ctx.tools.register(...)` (`inject = ['tools']`) with a fixed JSON
schema — `{ image: string, prompt?: string }`, both required to be strings
(`lib/index.js:28-41,54-56`) — and delegates to the zero-dependency
`lib/core.js`, which posts to any OpenAI-compatible vision endpoint
(default `qwen-vl-max` via DashScope, `lib/core.js:24-37`).

**Code quality:** Single commit, no test suite (`verify.mjs` is a manual
smoke script, not CI), no CI workflow found. Otherwise clean: small,
well-commented, genuinely zero runtime dependencies
(`package.json:41` — `dependencies: {}`, matching the file's own "零依赖"
claim and the pattern [dsh-usage-chart](#dsh-usage-chart) was praised for),
in-memory response caching keyed by a SHA-256 of the image content
(`lib/core.js:200-223`), and a Python helper for an optional ASCII
dot-matrix mode invoked via `execFile('python', [...])` with the image
passed over **stdin**, not argv (`lib/core.js:234-253`) — the safer of the
two subprocess patterns seen across this review, and explicitly commented
as chosen to avoid command-line length limits.

**Security:**
- **Correct scoping, unlike visionDS above.** The model can only ever
  supply `image` and `prompt` — there is no tool parameter for base URL or
  API key, so a prompt-injected model cannot redirect where an analyzed
  image is sent; `baseUrl`/`apiKey` are fixed at plugin-configuration time
  only (`cordis.patch.yml` config fields or environment/`auth.json`,
  `lib/core.js:63-111`), never per-call. This is the pattern visionDS's
  skill-script design should have used.
- **Image path is still unconfined and untyped, but the destination is
  fixed.** `normalizeImage()` resolves any string that isn't a URL/data-URI
  as a local path via `path.resolve()` and reads it if it exists, defaulting
  to `image/png` for any unrecognized extension with no magic-byte check and
  no size cap (`lib/core.js:127-137`). A model that can be induced to call
  `mm_vision` with an arbitrary local path (an SSH key, a config file with
  secrets, anything readable) will have those bytes base64'd, mislabeled as
  a PNG, and POSTed to whatever vision endpoint is configured — but only to
  that host-fixed endpoint (default `dashscope.aliyuncs.com`), not an
  attacker-chosen one, which bounds the impact well below visionDS's
  equivalent gap.
- **Credential fallback can silently reuse an unrelated key.** Beyond its
  own env vars, `resolveApiKey()` also reads `~/.pi/auth.json` — another
  tool's credential file — and if no name-matched entry (`/vision|qwen|ali|dash|vl|token|gemini/i`)
  is found, falls back to **the first `{key: string}` value found anywhere
  in that file, regardless of name** (`lib/core.js:79-111`, specifically
  the unguarded loop at `:105-107`). On a machine that also has some other
  tool's `~/.pi/auth.json` present, this can silently send an unrelated
  stored credential to the configured vision endpoint as a bearer token,
  without the plugin ever declaring that it reads that file. Not an
  exfiltration path by itself (destination is still host-configured), but a
  credential-confusion foot-gun worth disabling by setting `apiKey`
  explicitly rather than relying on discovery.
- No hardcoded secrets; no outbound calls beyond the one configured vision
  endpoint and the local `python` invocation for the optional dot-matrix
  mode.

**Verdict: usable with caution.** The tool-scoping choice (fixed schema, no
model-controllable destination or credential) is the right reference
pattern for any future vision bridge in this repo — notably safer than
visionDS's shell-skill design reviewed above. Residual gaps: no
confinement of the `image` path to the attachment store (bounded by a fixed
destination, unlike visionDS), the silent `~/.pi/auth.json` first-key
fallback, and no tests/CI/maintenance history to lean on yet.

---

## skillhub (cocofhu)

Source: https://github.com/cocofhu/skillhub

**What it does:** A DSH plugin that registers tools/commands for browsing a
skill marketplace by category, installing a skill as a ZIP download
extracted into the local skill directory, listing installed skills (by
reading each `SKILL.md`'s frontmatter), uninstalling one, and a self-update
path that checks GitHub Releases for a newer version of the plugin itself
and reinstalls it via `npx --yes @deepseek-ai/dsh plugin ... add [spec]`.

**Review basis:** unlike the other entries in this document, this plugin was
not cloned and read in full; it was reviewed from its published source files
on GitHub (`src/api.ts`, `src/install.ts`, `src/unzip.ts`, `src/http.ts`,
`src/self-update.ts`, `src/config-store.ts`, `src/host.ts`,
`src/skill-detail.ts`) at the time of this review, without building or
running it. Findings below cite file/function names, not line numbers, and
should be treated as a first pass, not the same-depth audit the rest of this
document gives.

**Code quality:** A real test suite exists (`src/tests/*.test.ts`, one file
per module, plus `src/tests/helpers/zip.ts` and a fixture), CI
(`.github/workflows/ci.yml`, a pack-check script), and community-project
scaffolding (`SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`,
`CODE_OF_CONDUCT.md`) — better-maintained-looking than most single-commit
entries in this review. `src/unzip.ts` hand-rolls a ZIP central-directory
parser (magic numbers `0x04034b50`/`0x02014b50`/`0x06054b50`, `stored` and
`deflate` via `zlib.inflateRawSync`) rather than pulling in a ZIP dependency
— the same "small auditable hand-written implementation over a heavy
library" instinct this review has praised elsewhere
([dsh-usage-chart](#dsh-usage-chart), [dsh-plugin-mm-vision](#dsh-plugin-mm-vision)).

**Security:**
- **Zip-slip defense exists and looks reasonable.** `src/install.ts`'s
  `safeRelPath()` rejects entry paths starting with `/` or containing `..`;
  `skillDir()` additionally re-validates via `relative()` that the resolved
  directory doesn't escape the skills root — two independent checks, the
  same discipline this review's own hardened redesign below uses. No
  evidence of a decompression-bomb guard (a total-uncompressed-size or
  per-file-count cap) in what was reviewed, though the review did not
  confirm its absence by running a crafted archive against it.
- **`src/http.ts` performs no URL validation of any kind** — the reviewer's
  own reading found no protocol allowlist, no private-IP/loopback/metadata-
  address blocking, and no origin-pinning on redirects; `fetchJson`/
  `fetchBytes` pass a URL straight to `fetch()`. This matters because
  `src/install.ts`'s `downloadSkillFiles()` fetches a download URL that
  presumably comes from the registry API's own response — if that URL is
  ever attacker-influenced (a compromised registry, a malicious/typosquatted
  skill entry, a MITM'd registry response over an unpinned connection), this
  client has no destination policy to catch it, the same SSRF-shaped gap
  this repo's own `dsh-web-fetch-http` package explicitly fixed
  (`packages/web/web-fetch-http/src/policy.ts`).
- **Self-update has no signature/checksum verification.**
  `src/self-update.ts` fetches `https://api.github.com/repos/<PLUGIN_REPO>/releases/latest`,
  then runs `npx --yes @deepseek-ai/dsh plugin --profile web add <spec>` for
  the new release tag — no cryptographic signature check, no checksum
  comparison, full trust in GitHub's transport security and npm's own
  resolution. This is the same class of gap flagged for
  [dsh-desktop](#dsh-desktop)'s unverified Node/`dsh` downloads, here applied
  to the plugin auto-updating itself.
- No hardcoded secrets found in the reviewed files; `parseVersion()`
  constrains version strings to a narrow alphanumeric-plus-`._-+` charset
  (max 32 chars), a sensible input bound wherever a version string reaches a
  shell or path.

**Verdict: usable with caution.** Zip-slip handling and version-string
validation look sound from the source read; genuinely worse than this
review's usual bar on two points — the total absence of any URL/destination
validation in `http.ts`, and an unverified self-update path that executes an
install command from unauthenticated release metadata. Neither is a
demonstrated exploit (this review did not build/run the plugin or craft a
malicious registry response), but both are the kind of gap this document has
called out as a real risk elsewhere, not a hypothetical one. Our own
redesign below (`dsh-plugins/skillhub/`) exists specifically to close both:
no self-update at all, and every registry request URL assembled from the
configured origin plus fixed paths — never from a response field — so there
is no destination for a compromised response to redirect to in the first
place.

---

## New plugin: flight-search

Status: designed here, implemented at `dsh-plugins/flight-search/` (see
[Implementation](#implementation) below) — our own plugin, not a review of a
third party, but documented in this file per the same template since it's the
isolated folder's first resident.

**Source basis:** https://github.com/AWeirdDev/flights ("fast-flights",
Python, MIT). No official Google Flights API exists — Google retired the
public-facing Flights API in 2018 (enterprise QPX access only) — so
`fast-flights` reverse-engineers two things from `flights.google.com`'s own
web frontend: (1) the search request is a Base64-encoded **Protobuf** message
passed as the `tfs` query parameter (schema in `fast_flights/pb/flights.proto`
upstream — `Info`/`FlightData`/`Airport`/`Baggage` messages, `Seat`/`Trip`/
`Passenger`/`Emissions` enums), and (2) the response is scraped not from
rendered HTML but from a `<script class="ds:1">` tag containing Google's own
internal `AF_initDataCallback(...)` hydration payload — a deeply-nested,
positionally-indexed JSON array with no documented schema, which upstream's
`parser.py` walks by hardcoded array index (e.g. `payload[3][0]` is the flight
list, `single_flight[3]`/`[4]` are the departure airport code/name, etc.).

### How we adapt it into a DSH plugin

| Concern | Upstream (`fast-flights`, Python) | Our port (`dsh-plugins/flight-search`, TypeScript) |
|---|---|---|
| Runtime | Python package (`pip install fast-flights`) | Native TS/Cordis plugin — no Python runtime dependency, no subprocess, matching this repo's own plugins |
| Query encoding | Generated `flights_pb2.py` (real protobuf lib) | Hand-written minimal protobuf writer (`src/pb.ts`, varint/tag/string/nested-message/packed-repeated helpers) implementing exactly the same small schema — no `protobufjs` dependency, auditable in one file, same zero-dependency ethos [dsh-usage-chart](#dsh-usage-chart) was praised for |
| Fetching | `primp` HTTP client with Chrome TLS/HTTP fingerprint impersonation (`impersonate="chrome_145"`), to reduce the odds of being blocked as automated traffic | Plain `fetch()` over HTTPS with a realistic `User-Agent`/`Accept` header only — **we deliberately do not replicate the fingerprint-impersonation step** (see Trust/limitations) |
| Parsing | `selectolax` HTML parser + positional JSON-array indexing of the undocumented `AF_initDataCallback` payload | Same index mapping, ported 1:1 with the field meaning documented inline per index (not just copied blindly), but wrapped in try/catch and type guards at every indexed access, with a response-size cap and fetch timeout — fails closed with a clear tool error instead of throwing or silently returning garbage if Google's internal shape changes |
| Interface | A Python function (`get_flights(query)`) | A single model-facing DSH tool, `flight_search`, registered via `ctx.tools.register(defineTool(...))` — the same pattern this repo's own `packages/web/tool-web` uses. A natural-language ask ("cheapest one-way business class MYJ to TPE next Friday") is handled by the model itself extracting the structured arguments (origin/destination/date/trip type/seat/passengers) from free text via the tool's schema and description — we do not need a second NL-parsing layer of our own, mirroring how `web_search`/`read` already work in this codebase |
| Credentials | None (public search results) | None — same as upstream; there is no key-handling surface here at all, unlike [dsh-logistics-tracker](#dsh-logistics-tracker)'s KDNiao/Kuaidi100 keys |

### Trust and limitations (disclosed up front, same posture as the WeChat-bridge finding above)

- **This is unofficial scraping of an undocumented internal Google payload,
  not a sanctioned API**, in the same risk family flagged for the WeChat
  bridge's unofficial protocol library above: no ToS-sanctioned integration
  exists for this capability, so we accept and disclose that rather than
  implying otherwise. The array-index layout in `AF_initDataCallback` can
  change without notice and silently break parsing; we fail closed (a clear
  tool error) rather than return corrupted itineraries when the shape
  doesn't match what we expect.
- **We do not replicate upstream's TLS-fingerprint impersonation.**
  `fast-flights` uses `primp` specifically to make its requests look like a
  real Chrome browser at the TLS/HTTP level, to reduce the odds of being
  blocked as automated traffic — a mild anti-bot-detection-evasion
  technique. We use a plain `fetch()` with only a realistic `User-Agent`
  header. This is a deliberate line we're drawing, not an oversight: it
  means our version is more likely to get rate-limited or blocked by
  Google over time than upstream's, and we accept that honestly as a
  limitation rather than building active detection-evasion into the
  harness.
- **Respect Google's Terms of Service and rate limits.** This tool is for
  personal, low-volume, read-only flight-price lookups driven by a single
  user's request — not for bulk/automated scraping.
- Output shape mirrors upstream in spirit: a list of itineraries (price,
  operating airline(s), per-leg departure/arrival airport+time, duration,
  aircraft type) plus a carbon-emission estimate, formatted as tool output
  text for the model.

### Implementation

Lives at `dsh-plugins/flight-search/` — see `dsh-plugins/README.md` for why
this plugin folder is kept isolated from `packages/` (these are our own
plugins, reviewed and maintained on the same bar as the third-party review
above, not part of the core harness's own build/release graph).

## New plugin: vision-bridge

Status: designed here, implemented at `dsh-plugins/vision-bridge/` — our own
plugin, a deliberate hybrid of [visionDS](#visionds) and
[dsh-plugin-mm-vision](#dsh-plugin-mm-vision) above, built to keep what each
one got right and drop what each one got wrong.

**Source basis:** the two community reviews earlier in this doc, plus this
repo's own `read_image` tool (`packages/fs/tool-fs/src/read-image.ts`) as
the reference for how a model-facing image argument should resolve a local
path — through `ctx.fs`, not raw `node:fs`.

### What was kept, and from which plugin

| Concern | Kept from | Why |
|---|---|---|
| Tool shape | dsh-plugin-mm-vision | Register as a schema-scoped `ctx.tools` tool (`{ file_path?, url?, prompt?, mode? }`), never a shell-invoked skill. The model can never supply a destination URL or credential — closing exactly the gap visionDS's `--base-url`/`--api-key`-accepting skill script left open. |
| Provider strategy | visionDS | A configurable multi-provider catalog (MiMo/GLM/Ark/DashScope/Moonshot/OpenAI-compatible, `src/providers.ts`), tried in a configurable priority order, with the same credential-ref names visionDS's `.env.example` documents so an existing deployment's keys carry over unchanged. |
| Offline fallback | visionDS | Windows (WinRT `OcrEngine`) and macOS (Vision framework) OCR when no provider succeeds — free, no key required. Ported in spirit, not copied: reimplemented as fixed `execFile` argv (`src/local-ocr.ts`), never a shell string, and with no model-facing override of which script or arguments run. |
| Description format | dsh-plugin-mm-vision | The structured, coordinate-annotated prompt (canvas/elements/percentage-coordinates/relationships, `src/prompt.ts`) — a real quality win over visionDS's plain "describe this image," reimplemented rather than copied. |
| Response caching | dsh-plugin-mm-vision | An in-memory TTL cache (`src/cache.ts`), keyed by a hash of the actual image bytes + prompt rather than a raw input string, so a local path and a URL resolving to the same picture still share a cache entry. |

### What was fixed relative to both

- **The image source is never an arbitrary local path read via raw
  `node:fs`.** Both reviewed plugins read any string the model supplied as
  a filesystem path directly (`os.path`/Python `open()` in visionDS,
  `path.resolve()` + `fs.readFileSync` in dsh-plugin-mm-vision) with no
  sandboxing and no confinement. `src/image-source.ts`'s
  `resolveImageFromPath()` instead goes through `ctx.fs.resolve()` /
  `ctx.fs.stat()` / `ctx.fs.readBytes()` — the same sandboxed,
  policy-aware seam `read_image` uses — so filesystem policy (not this
  plugin) decides what's reachable.
- **Every source is magic-byte sniffed, and anything that doesn't match is
  refused outright.** visionDS fell back to labeling unrecognized bytes
  `application/octet-stream` and sent them anyway; dsh-plugin-mm-vision
  defaulted unrecognized extensions to `image/png` and did the same. Here,
  `sniffImageMediaType()` recognizes PNG/JPEG/GIF/WebP/BMP by header bytes
  only, and both `resolveImageFromPath()`/`resolveImageFromUrl()` throw
  `ImageSourceError` on anything else — failing closed rather than shipping
  an arbitrary file's bytes under a fake label.
- **A remote source must be `https`, checked before any fetch is
  attempted** (`resolveImageFromUrl()`), matching this repo's own
  `flight-search` fetch discipline (bounded timeout via `AbortController`,
  a declared-`content-length` check plus an actual-byte-count check against
  `maxImageBytes`, never an unbounded buffer).
- **No model-reachable destination or credential override, anywhere.** The
  tool schema (`src/index.ts`) exposes only `file_path`/`url`/`prompt`/`mode`
  — no `base_url`, no `api_key`, no arbitrary CLI-flag pass-through the way
  visionDS's skill script had. `providers`/`providerOrder` are
  plugin-config-only, resolved once at `apply()` time, never per-call
  arguments.
- **No implicit cross-tool credential fallback.** dsh-plugin-mm-vision's
  `resolveApiKey()` would silently reuse the first `{key: string}` found
  anywhere in `~/.pi/auth.json` if no name-matched entry existed. Here,
  every provider's key resolves through exactly one named
  `ctx.credentials` reference (`credentialRef(provider.credentialRef)`) —
  an unconfigured provider is skipped, never backed by a guess.
- **Fails loud, not silent, when nothing works.** If every provider fails
  (or none has a configured credential) and offline OCR also fails or is
  disabled, `execute()` throws a clear, specific error identifying what was
  tried and why it didn't work — never a corrupted or empty "success."

### Trust and limitations (disclosed up front, same posture as flight-search's)

- The default provider catalog's endpoints/models are a snapshot of what
  visionDS documented at review time; a provider may change its request/
  response shape without notice. A response that doesn't parse as an
  OpenAI-style `choices[0].message.content` is treated as that provider
  failing (falls through to the next provider, then to OCR), never as a
  silent empty success — the same fail-closed posture flight-search's
  `AF_initDataCallback` parsing uses for an equally undocumented shape.
  Unlike flight-search, though, every provider here is a documented,
  officially supported chat-completions API (MiMo/GLM/Ark/DashScope/
  Moonshot/OpenAI), not a reverse-engineered internal endpoint — there is
  no ToS/stability caveat comparable to flight-search's or the WeChat
  bridge's.
- Local OCR has no Linux backend (`detectOcrPlatform()` returns `undefined`
  there); on Linux, a deployment with no vision-provider credential
  configured gets a clear "no provider had a configured credential, and
  offline OCR fallback is disabled/unavailable" error rather than a silent
  no-op.
- See the plugin's own README (`dsh-plugins/vision-bridge/README.md`) for
  the full config surface and credential-ref mapping.

### Implementation

Lives at `dsh-plugins/vision-bridge/` — same isolated-folder rationale as
[flight-search](#new-plugin-flight-search) (`dsh-plugins/README.md`): a
standalone npm package, own tests, no reliance on this repo's pnpm
workspace, reviewed and maintained on the same bar as the third-party
plugins reviewed above.

## New plugin: skillhub

Status: designed here, implemented at `dsh-plugins/skillhub/` — our own
plugin, a hardened redesign of [skillhub (cocofhu)](#skillhub-cocofhu)
above, built to keep its useful surface (search/install/list/uninstall
skills from a registry) while closing the two gaps that review flagged and
adding defenses the original didn't have at all.

**Source basis:** the review above, plus this repo's own
`docs/subsystems/skills.md` (the existing `.dsh/skills` discovery
convention this plugin installs into, so nothing new has to discover an
installed skill) and `packages/web/web-fetch-http/src/policy.ts` (the
same-origin/no-redirect discipline this design generalizes from a single
fetch policy into "never treat a response field as a fetch destination" at
the client-construction level).

### What was kept

| Concern | Kept from cocofhu/skillhub | Notes |
|---|---|---|
| Tool surface | Search / install / list / uninstall, as four operations | Same shape, reimplemented as four schema-scoped `ctx.tools` (`skillhub_search`/`_install`/`_list`/`_uninstall`), matching this repo's own `defineTool` convention rather than the original's CLI/command-shaped interface. |
| Zip-slip discipline | Two independent path checks (lexical rejection of `..`/absolute paths, then a resolved-path containment re-check) | Reimplemented in `install-path.ts`'s `assertSafeSkillRelativePath()` + `resolveWithinSkillDir()`/`resolveSkillDir()` — the same two-layer idea, applied to both the file-relative-path level and the skill-directory level. |
| Version-string bound | A narrow charset + length cap on version strings | Reimplemented as `assertVersionString()` in `registry-client.ts`, same grammar. |
| Hand-written implementation over a dependency | `src/unzip.ts`'s own ZIP parser instead of a library | Taken further here: no archive parser at all is needed (see below), so there's no ZIP-parsing surface to hand-write or audit in the first place. |

### What was fixed, and why

- **No archive download/extraction, at all.** The reviewed original
  downloads a ZIP and extracts it (`src/unzip.ts`, `src/install.ts`); this
  plugin's registry contract (`registry-client.ts`) is instead an itemized
  JSON list of `{ path, content }` UTF-8 text files. This isn't a hardened
  ZIP path — it's the deliberate removal of an entire vulnerability class
  (zip-slip via crafted entry names, decompression bombs via a small file
  that inflates to gigabytes, binary payloads smuggled past a naive
  content-type check) rather than defending against each member of that
  class individually. The tradeoff is real and disclosed: a registry
  operator implementing this contract has to serve an itemized manifest, not
  just proxy a GitHub release ZIP unchanged.
- **Every registry request URL is assembled from the configured
  `registryUrl` plus a fixed path and query parameters — never from a field
  inside a JSON response.** This is the direct fix for the reviewed
  original's `http.ts` having no URL validation at all: rather than trying
  to validate a server-supplied download URL after the fact (protocol
  allowlist, private-IP blocking, redirect origin-pinning — the full
  `packages/web/web-fetch-http/src/policy.ts` treatment), this design makes
  a response-controlled fetch destination structurally impossible. The
  registry can return whatever it wants in a payload; nothing in that
  payload is ever treated as a place to send a request. `registryUrl` itself
  is validated `https:`-only once, at plugin load (an operator-config value,
  not attacker-reachable input), and every request refuses redirects
  outright (`redirect: 'error'`) rather than following them.
- **`skillhub_uninstall` only ever deletes files this plugin itself recorded
  installing.** `state.ts`'s install ledger
  (`.dsh/skills/.skillhub-state.json`) records exactly which bundle-relative
  paths were written for each install; uninstall reads that ledger, not the
  skill name alone, and re-validates every path for containment
  (`install-path.ts`) immediately before each delete — independent of
  whatever the ledger says, in case it were ever tampered with out-of-band.
  Attempting to uninstall a name the ledger has no record of is refused
  outright, even if a same-named directory happens to exist on disk (tested
  in `tests/install.test.ts`).
- **No self-update mechanism at all.** The reviewed original's
  `self-update.ts` runs an unverified `npx ... plugin add` from unauthenticated
  GitHub release metadata. This plugin has no equivalent: it's versioned and
  updated the same way any other `dsh-plugins/` package is (a normal code
  change, reviewed the same as this one was), so there's no runtime code
  path that installs new code based on external metadata.
- **File-count, per-file, and total-bundle byte caps are enforced by the
  registry client itself**, before a single byte is written to disk
  (`fetchSkillManifest()` in `registry-client.ts`) — the total-uncompressed-
  size bound the reviewed original's ZIP path did not visibly have, made
  simpler here since there's no compression step to bound around in the
  first place.
- **A hardcoded file-extension allowlist** (`.md`/`.yaml`/`.yml`/`.json`/
  `.txt`) rejects anything that isn't plausibly skill content — no script,
  binary, or executable extension can ever be written by an install,
  regardless of what a compromised registry response claims a file's path is.

### Trust and limitations (disclosed up front, same posture as flight-search's and vision-bridge's)

- `registryUrl` is a deployment-specific config value with no built-in
  default pointing at any real service — this plugin defines its own
  registry contract (documented in its README) rather than reverse-
  engineering `cocofhu/skillhub`'s actual (undocumented, from this review's
  vantage point) wire format. A real registry has to implement the two
  documented endpoints to be usable.
- `skillhub_install` overwrites a prior install of the same name
  unconditionally — there is no diff-and-confirm step, matching the
  reviewed original's behavior in this one respect.
- The install ledger is this plugin's own bookkeeping, not the filesystem's
  source of truth: deleting or hand-editing
  `.dsh/skills/.skillhub-state.json` out-of-band changes what
  `skillhub_list`/`skillhub_uninstall` believe is installed, though the
  per-file containment re-check at uninstall time still applies regardless
  of what the ledger contains.
- See the plugin's own README (`dsh-plugins/skillhub/README.md`) for the
  full config surface and the registry contract's exact request/response
  shapes.

### Implementation

Lives at `dsh-plugins/skillhub/` — same isolated-folder rationale as
[flight-search](#new-plugin-flight-search) and
[vision-bridge](#new-plugin-vision-bridge) (`dsh-plugins/README.md`): a
standalone npm package, own tests (`npm test` — 50 cases covering name/path
validation, the registry client's https-only/no-redirect/same-origin-by-
construction/size-and-count-cap behavior, the state ledger's round-trip and
corrupt-file handling, the full install/uninstall lifecycle against a real
temporary directory, and tool-registration wiring, all against an injected
`fetch` with no live network call), no reliance on this repo's pnpm
workspace, reviewed and maintained on the same bar as the third-party
plugins reviewed above.

## Recommendation for the isolated-folder reimplementation

Prioritize forking from, in order: **`dsh-usage-chart`**, **`dsh-browser`**,
and **`dsh-plugin` (loongsuite)** — the best-engineered of the batch, and the
richest source of reusable patterns (origin-guarded routes, token +
Origin-gated local auth, verified-claims telemetry). `dsh-workbench`'s UI
layer is worth salvaging, but its host routes need a rewrite, not a direct
port — do not install it as-is. The WeChat bridge's protocol dependency is a
risk no amount of surrounding code quality resolves; treat it as a "reference
the patterns, don't adopt the dependency" case.
