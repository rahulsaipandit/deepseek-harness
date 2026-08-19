# dsh-plugin-knowledge-hub

A lean, markdown-file personal knowledge hub for DeepSeek Harness. Design
rationale, the full file-by-file inventory of what was adapted from
`docs/packages/cognitiveBrain` and why, and the hub-and-spoke architecture
this plugin implements all live in
[`docs/designCognitiveBrainForDSH.md`](../../docs/designCognitiveBrainForDSH.md).

## What it does

- Stores memories as plain markdown files with YAML frontmatter at a
  user-configured `vaultPath` — no database, git-diffable, human-editable.
- Indexes them with hybrid BM25 + local-embedding vector search
  (`@orama/orama` + `@xenova/transformers`); the Orama index itself is
  rebuilt in memory on every plugin start (cheap — pure in-process
  tokenization, no model inference), but **embeddings are cached** by
  content hash (`embedding-cache.ts`, `.embedding-cache.json` in the vault)
  — a note is only re-embedded when its content actually changed since the
  last boot, including a hand-edit made outside `memory_remember`. See
  designCognitiveBrainForDSH.md §5.1/§5.4 for why this matters beyond boot
  cost: the same content hash is what makes a hand-edited note's stale
  embedding get refreshed at all. The BM25 side explicitly sets Orama's
  `threshold: 1` (its most lenient setting) — Orama's own default (`0`) is
  its *strictest*, requiring near-total query-term overlap, and was
  confirmed to return zero results for ordinary multi-word queries against
  short notes (designCognitiveBrainForDSH.md §3.5).
- Logs every create/update/delete to an append-only audit trail
  (`.audit-log.jsonl` in the vault).
- Exposes five tools: `memory_remember`, `memory_recall`, `memory_list`,
  `memory_audit`, `memory_related`.
- `memory_remember` optionally accepts a `resource` field (a canonical
  source URL, OKF-compatible — see designCognitiveBrainForDSH.md §5.6) and
  runs a cheap, LLM-free contradiction check (`contradiction.ts`): a
  candidate note sharing a tag and matching one of eight fixed
  negation-pattern pairs (`is`/`is not`, `enabled`/`disabled`, etc.,
  adapted from cognitiveBrain's `ConflictDetector.ts`) is surfaced back as
  an advisory `possibleContradiction` field — nothing is ever written to
  `contradictedBy` automatically.
- **Opt-in**: an LLM-extracted concept graph (nodes are concepts, not notes)
  built incrementally from new notes only — never backfilled over the
  existing vault — cached as disposable JSON (`.concept-graph.json`) and
  viewable as a force-directed graph on a served web page. See
  designCognitiveBrainForDSH.md §1.5/§4 for the full rationale, including why
  this is architecturally distinct from the automatic, per-query knowledge
  graph rejected elsewhere in that design.

## Config

```ts
{
  vaultPath: string                 // required, absolute path
  embeddingModel?: string           // default 'Xenova/all-MiniLM-L6-v2'
  embeddingDimensions?: number      // default 384
  enableEmbeddings?: boolean        // default true; false = BM25-only, no model load
  maxRecallResults?: number         // default 20

  // Concept graph — off by default; puts a real LLM call in the write path when enabled
  enableConceptGraph?: boolean      // default false
  conceptGraphProvider?: string     // default: first ctx.llm-registered provider
  conceptGraphModel?: string        // required when enableConceptGraph is true
  conceptGraphWebPath?: string      // default '/knowledge-hub/concept-graph'
}
```

When `enableConceptGraph` is on, the plugin requires `ctx.llm` and
`ctx.webServer` to be mounted (resolved via `ctx.get()`, not a static
`inject`, so the base plugin works without either service when the concept
graph is off) and throws a clear config error at load time if either is
missing, or if `conceptGraphModel` is unset.

`memory_remember`'s result includes `conceptGraphUrl` whenever the concept
graph is enabled, so the agent can hand the URL to the user directly.

## Enabling this plugin in a DSH profile

Verified end-to-end against a real profile. This plugin declares no
`dsh.bundle` (matching every other package under `dsh-plugins/` — none of
them do), so `dsh plugin add` installs it as a plain dependency but does
**not** activate it automatically; you also need one manual step to insert
it into the profile's own patch layer.

1. **Build the plugin first** — its `package.json` points `main`/`exports`
   at `lib/index.js`, which only exists after compiling:
   ```sh
   cd dsh-plugins/knowledge-hub
   npm install
   npm run build
   ```
2. **Install it into a profile**:
   ```sh
   pnpm dsh plugin --profile <name> add /absolute/path/to/dsh-plugins/knowledge-hub
   ```
   You'll see `dsh: warning: dsh-plugin-knowledge-hub declares no dsh.bundle
   — installed as a plain dependency, not a profile layer` — expected; step 3
   is what actually activates it.
3. **Insert it into that profile's `cordis.patch.yml`** (at
   `$DSH_HOME/profiles/<name>/cordis.patch.yml`), e.g.:
   ```yaml
   - insert:
       - id: knowledge-hub
         name: dsh-plugin-knowledge-hub
         config:
           vaultPath: /absolute/path/to/your/notes
   ```
4. Confirm it composed correctly with `pnpm dsh --profile <name> --dump-config`
   (it should appear as the last entry, under a `# == .../cordis.patch.yml`
   marker), then boot normally with `pnpm dsh --profile <name>`.
5. **If the profile's `dsh.profile.bundles` is `["@deepseek-ai/dsh-base"]`
   alone** (the default for any freshly created profile — `dsh plugin add`
   never adds a second bundle), step 4's boot will appear to hang. This
   isn't a bug: `dsh-base` alone has no plugin that reads `--help` or a task
   argument at all (that's `headless-startup`/the web server's own arg
   parser, each shipped only in its overlay bundle) — the full plugin tree,
   including this one, activates fine and the process just sits idle with
   nothing telling it what to do. See
   [`docs/dsh-base-bundle-boot-hang.md`](../../docs/dsh-base-bundle-boot-hang.md)
   for the full investigation (an earlier version of that doc misattributed
   this to `@deepseek-ai/dsh-goal`; that's been corrected). Fix it by adding
   an overlay bundle to the profile's `package.json`, matching the built-in
   `web`/`headless` profiles:
   ```json
   {
     "dsh": {
       "profile": {
         "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
       }
     }
   }
   ```
   Do not try to work around the hang by disabling `@deepseek-ai/dsh-goal` in
   `cordis.patch.yml` instead — that path was tried and does not produce a
   working boot (see the doc above for what actually happens).

**Windows-specific gotcha, found while verifying this**: if the profile
directory (under `$DSH_HOME`, typically your user profile on `C:`) and the
plugin's checkout live on **different drives**, `pnpm dsh plugin add`'s
generated `node_modules` junction can come out malformed (it concatenates
the profile path with the plugin's absolute path instead of using the
absolute path directly), which surfaces as `Cannot find package
'dsh-plugin-knowledge-hub'` at boot. This is a pnpm/Windows cross-drive
junction issue, not specific to this plugin. Workaround: recreate the
junction by hand pointing straight at the plugin directory:
```powershell
Remove-Item "$DSH_HOME\profiles\<name>\node_modules\dsh-plugin-knowledge-hub" -Force
New-Item -ItemType Junction `
  -Path "$DSH_HOME\profiles\<name>\node_modules\dsh-plugin-knowledge-hub" `
  -Target "D:\path\to\dsh-plugins\knowledge-hub"
```
or simply keep `$DSH_HOME` and the plugin checkout on the same drive to
avoid it entirely.

## What's NOT built in v1

The automatic, per-query knowledge graph (as distinct from the opt-in
concept graph above); an LLM enrichment pipeline; auto-synthesis/a compiled
wiki; a file watcher for hand-edited notes (restart to pick up out-of-band
edits); `memory_forget`/`memory_reindex`/`memory_get` tools; multi-source
ingestion (PDF/URL/Slack/WhatsApp); chunking of note content for embeddings
(chunking exists only for concept-graph extraction); cross-device sync; a
persisted on-disk snapshot of the Orama search index itself (its BM25/vector
structures are still rebuilt in memory on every boot — cheap in-process
work; only the embedding *computation* that used to dominate that cost is
now cached, see above); an MCP server surface; any
bulk/backfill tool to pull pre-existing or hand-written notes into the
concept graph (a deliberate decision, not a gap — it only ever grows from
new `memory_remember` calls going forward).

## Testing

```
npm install
npm test
```

76 tests across 12 files, all hermetic — no live network calls, no real LLM
call, no model download. `enableEmbeddings: false` is the default test mode
for the base plugin (fast, no model download in CI); concept-graph tests use
a fake `ctx.llm`/`ctx.webServer` throughout, never a real call. The
embedding cache's own hit/miss and vector-passthrough logic is covered by
`embedding-cache.test.ts` and `memory-index.test.ts` with a fake
`embeddingFn`, so the caching mechanism is verified without a real model
download either.

Covers: frontmatter round-trip, vault-store CRUD + tag filtering + path
containment, hybrid search ranking (BM25-only and hybrid-with-embedding
paths), audit-log append/filter, the full plugin end-to-end (all five tools,
including the startup rescan picking up hand-written files), heading-based
chunking, wikilink extraction/resolution, concept-graph incremental merge
(idempotency, same-file vs. cross-file edge scope, degree/community
recomputation, cache round-trip), concept extraction's JSON-response parsing
and graceful degradation on malformed output, and the concept-graph web
server's route registration.

## Appendix: end-to-end verification session

A real `dsh plugin add` → profile boot attempt was run against this plugin
(not just unit tests) to confirm the "Enabling this plugin in a DSH profile"
steps above actually work. Findings, in the order they were hit:

1. **`pnpm dsh plugin --profile <name> add <path>` works as documented** —
   it links the plugin into the profile's `node_modules` and correctly warns
   `declares no dsh.bundle — installed as a plain dependency, not a profile
   layer`, since (like every other package under `dsh-plugins/`) this plugin
   has no `dsh.bundle` manifest field.
2. **The plugin must be built before it can be loaded.** `package.json`
   points `main`/`exports` at `lib/index.js`; without `npm run build` first,
   Node's ESM resolver fails with `Cannot find package
   'dsh-plugin-knowledge-hub'` even though the link itself is fine. Not a bug
   in the loader — just an easy step to forget, now called out explicitly
   above.
3. **Manually inserting the plugin into the profile's `cordis.patch.yml`
   is required and works.** After adding the `insert:` block from step 3
   above, `pnpm dsh --profile <name> --dump-config` showed the plugin
   correctly composed as the final layer, with our `vaultPath`/
   `enableEmbeddings` config intact.
4. **A genuine Windows cross-drive junction bug**, independent of this
   plugin: when `$DSH_HOME` (profile home, typically on `C:`) and the
   plugin's checkout (here, on `D:`) are on different drives, the
   `node_modules` junction `dsh plugin add` creates comes out malformed —
   `Get-Item` on it showed a target that concatenates the profile path with
   the plugin's own absolute path, rather than the absolute path alone. This
   reproduced consistently across three attempts (relative-slash, absolute
   Windows-style, and doubled-forward-slash path specs all produced the same
   malformed junction). The workaround is documented above; the real fix
   would need to land in pnpm or in `dsh plugin add` itself, not in this
   plugin.
5. **Two unrelated, pre-existing repository build failures were fixed** —
   not caused by this plugin, but blocking any profile boot until resolved:
   `packages/web/web-fetch-http/src/policy.ts` (`string | undefined` not
   assignable to `string` in `parseCidr()`) and a stale test fixture in
   `packages/web/tool-web/tests/integration.spec.ts` missing two required
   `HttpFetchLimits` fields. Both reproduce on unmodified `upstream/master`
   too, so they were genuine platform bugs, not introduced by this session's
   work.
6. **A profile that uses only the bare `@deepseek-ai/dsh-base` bundle**
   (which is exactly what `dsh plugin --profile <name> add <path>` produces
   for a fresh profile, since it never adds a `dsh.profile.bundles` overlay)
   appears to hang on boot. This is not a defect — `dsh-base` has no plugin
   that reads `--help`/task args at all (that lives only in the
   `dsh-headless`/`dsh-web-app` overlays), so the process boots successfully
   and just sits idle with nothing telling it what to do. Full investigation
   in [`docs/dsh-base-bundle-boot-hang.md`](../../docs/dsh-base-bundle-boot-hang.md)
   (an earlier version of that doc misattributed this to
   `@deepseek-ai/dsh-goal`; corrected after the "fix" it proposed was tested
   and found not to change anything). **The actual fix is adding an overlay
   bundle** (`@deepseek-ai/dsh-headless` or `@deepseek-ai/dsh-web-app`) to
   the profile's `dsh.profile.bundles` list, matching the built-in
   `headless`/`web` profiles.

Net result: everything specific to this plugin — packaging, build output,
profile installation, and Cordis config composition — is verified correct,
**and** a full end-to-end boot (with this plugin's tools actually mounted in
a running DSH process, `--profile <name> --help` exiting 0, and a real task
successfully reaching this plugin's tool registrations before failing only
on an unrelated missing LLM credential) was achieved using the overlay-bundle
workaround from `docs/dsh-base-bundle-boot-hang.md`.
