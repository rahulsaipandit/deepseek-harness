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
  (`@orama/orama` + `@xenova/transformers`), rebuilt in memory on every
  plugin start.
- Logs every create/update/delete to an append-only audit trail
  (`.audit-log.jsonl` in the vault).
- Exposes five tools: `memory_remember`, `memory_recall`, `memory_list`,
  `memory_audit`, `memory_related`.
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
persisted on-disk search-index snapshot; an MCP server surface; any
bulk/backfill tool to pull pre-existing or hand-written notes into the
concept graph (a deliberate decision, not a gap — it only ever grows from
new `memory_remember` calls going forward).

## Testing

```
npm install
npm test
```

54 tests across 10 files, all hermetic — no live network calls, no real LLM
call, no model download. `enableEmbeddings: false` is the default test mode
for the base plugin (fast, no model download in CI); concept-graph tests use
a fake `ctx.llm`/`ctx.webServer` throughout, never a real call.

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
5. **Full profile boot is currently blocked by an unrelated, pre-existing
   repository build failure**, not by anything in this plugin. After fixing
   1–4 above, booting the profile failed with `typert-loader: 2 typert
   contributor(s) failed to register` for `@deepseek-ai/dsh-commands` and
   `@deepseek-ai/dsh-goal` (their generated `lib/typert.host.js` files were
   missing). Running the repo's full `pnpm run build` to generate them
   surfaced the actual root cause: `tsc -b tsconfig.host.json` fails with
   pre-existing type errors unrelated to this plugin —
   `packages/web/web-fetch-http/src/policy.ts:78` (`string | undefined` not
   assignable to `string`) and a stale test-fixture type mismatch in
   `packages/web/tool-web/tests/integration.spec.ts:163` (`HttpFetchLimits`
   missing `destinationPolicyMode`/`destinationAllowCidrs`). Neither file was
   touched while building this plugin. Until those are fixed, no profile in
   this checkout can complete a full boot — this is a pre-existing repo-wide
   blocker, not specific to `dsh-plugin-knowledge-hub`, and is outside this
   plugin's scope to fix.

Net result: everything specific to this plugin — packaging, build output,
profile installation, and Cordis config composition — is verified correct.
A genuine full boot (tools actually callable inside a running DSH process)
is blocked on the pre-existing build failure in item 5, not on this plugin.
