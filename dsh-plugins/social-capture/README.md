# dsh-plugin-social-capture

Receives social-media posts captured by a **per-user browser bookmarklet or
console script** and writes them into a
[`dsh-plugin-knowledge-hub`](../knowledge-hub/) vault as searchable notes.
Design rationale lives in
[`docs/investigateContentIngestionPlugin.md`](../../docs/investigateContentIngestionPlugin.md)
and [`docs/designSocialCaptureForDSH.md`](../../docs/designSocialCaptureForDSH.md).

## The core design decision: the harness never logs in

The obvious way to ingest Instagram (or any login-walled platform) is a
Playwright-style bot that drives the login form itself. This plugin
deliberately does **not** do that — DSH has no browser-automation
capability at all today, having one hold platform credentials/session
cookies is real credential custody with a real blast radius, and most
platforms' terms of service specifically call out *automated* login as
prohibited.

Instead, following the pattern [Siftly](https://github.com/viperrcrypto/Siftly)
uses for Twitter/X bookmarks: a small script runs **inside the user's own,
already-authenticated browser tab** — as a bookmarklet (drag to the
bookmarks bar, click on a post) or pasted into DevTools — reads that page's
public Open Graph meta tags (`og:title`, `og:description`, `og:image`,
`og:url`), and POSTs the result to this plugin's receiver endpoint. The
harness never sees a password, a session cookie, or a login form; it only
ever receives a JSON payload of already-public page metadata the browser
itself was already looking at.

## What it does

1. Serves an install page (`GET <webPath>`) with a bookmarklet link and raw
   console-script for each configured platform, built by `bookmarklet.ts`.
2. Accepts captures on `POST <webPath>/capture`, authenticated by a
   per-instance token baked into the generated scripts (`token.ts`, same
   persist-or-generate-under-`$DSH_HOME` pattern as
   `dsh-plugins/mcp-server`) and rate-limited by IP and token
   (`rate-limit.ts`).
3. Validates the payload (`capture-payload.ts`): a non-empty `platform`, an
   `http(s)` `url`, and at least one of `text`/`author`, with hard size
   caps on text and media-url count.
4. Always extracts free, LLM-less tags from the captured text — hashtags
   and @mentions (`entity-extract.ts`, the same "mine cheap structure
   before spending any tokens" idea as Siftly's `rawjson-extractor.ts`) —
   so a capture is searchable even with no LLM configured at all.
5. Optionally (`enableAiSummary: true`) runs one bounded LLM call for a
   short summary + topic tags via the provider-neutral `ctx.llm` seam
   (`summarize.ts`) — **never hardcoded to any specific LLM vendor**; point
   `llmProvider`/`llmModel` at whichever `ctx.llm`-registered adapter you
   use (e.g. this harness's native DeepSeek adapter). Left off, captures are
   still stored with the free entity tags only.
6. Writes the result as `<vaultPath>/<id>.md` (`note-writer.ts`) in the same
   markdown + YAML frontmatter shape `dsh-plugin-knowledge-hub` parses —
   point `vaultPath` at the same directory as a `knowledge-hub` instance and
   captures become ordinary searchable notes there (`memory_recall`,
   `memory_list`, etc.) on its next boot, tagged `social` plus the platform
   name (e.g. `instagram`), with no code coupling between the two plugins.
7. Logs every capture to the same `.audit-log.jsonl` shape
   `dsh-plugin-knowledge-hub` uses, so `memory_audit` shows captures
   alongside hand-written notes when pointed at a shared vault.

This plugin and `knowledge-hub` are decoupled on purpose — each installable
independently, sharing a **file-format contract**, not code. A few small
modules (`id.ts`, `audit-log.ts`) are intentionally duplicated rather than
imported across the package boundary; see each file's header comment.

## Config

```ts
{
  vaultPath: string                 // required, absolute path
  webPath?: string                  // default '/social-capture'
  platforms?: string[]              // default ['instagram']
  token?: string                    // default '': persisted/generated under $DSH_HOME
  corsOrigins?: string[]            // default []: required for the bookmarklet to work cross-origin
  maxBodyBytes?: number             // default 262144 (256 KiB)
  rateLimit?: number                // default 30
  rateLimitWindowMs?: number        // default 60000

  enableAiSummary?: boolean         // default false
  llmProvider?: string              // default '': first registered ctx.llm provider
  llmModel?: string                 // required when enableAiSummary is true
}
```

`corsOrigins` needs the social site's own origin (e.g.
`https://www.instagram.com`) for the browser-side `fetch()` in the
bookmarklet to be allowed cross-origin at all — without it, the browser's
CORS policy blocks the request before it reaches this plugin, and the
console-script delivery form (same-page `fetch`, still cross-origin to
`127.0.0.1`) needs it too.

## Activation

Same pattern as every other `dsh-plugins/` package — see
[`../knowledge-hub/README.md`](../knowledge-hub/README.md#config)'s
activation section for the general `dsh plugin add` + `cordis.patch.yml`
steps. Point `vaultPath` at the same directory as your `knowledge-hub`
instance to make captures searchable there.

## Trust and limitations

- **Loopback-oriented by design.** The receiver is meant to be reached from
  a browser on the same machine as the DSH process. `corsOrigins` should
  list only the specific social-site origins you intend to capture from —
  never `'*'` in a real deployment, since that would let any web page the
  user visits attempt a capture (mitigated further by the required token,
  but defense in depth still applies).
- **Open Graph extraction is best-effort.** Reading `og:*` meta tags is
  intentionally the most stable, least-brittle capture strategy available
  (it doesn't depend on a platform's private DOM structure, which changes
  without notice), but it also means capture fidelity is bounded by what a
  page chooses to expose in its own link-preview metadata — no full-post
  media download, no comment threads, no private/non-public post support.
- **No YouTube/web-page ingestion here.** Those sources don't need the
  login-walled-capture pattern this plugin exists for; see
  `docs/investigateContentIngestionPlugin.md` for where that ingestion
  should live instead (`ctx.web` for pages; a separate path for YouTube).
- **The install page is unauthenticated.** Anyone who can reach it (i.e.
  anyone on `localhost`) can read the token baked into the bookmarklet
  links it renders. This is an accepted trust boundary matching this
  plugin's threat model (a single local user's own machine), not a general
  multi-tenant security posture.
