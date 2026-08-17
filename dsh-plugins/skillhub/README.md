# dsh-plugin-skillhub

A DeepSeek Harness (DSH) plugin that registers four model-facing tools —
`skillhub_search`, `skillhub_install`, `skillhub_list`, `skillhub_uninstall`
— so an agent can discover and manage skills (`docs/subsystems/skills.md`)
from a configured registry, without a human manually dropping `SKILL.md`
files into `.dsh/skills/`.

This is our own hardened take on the community
[`cocofhu/skillhub`](https://github.com/cocofhu/skillhub) project, reviewed
in [`docs/adr/rp_dshPlugins.md`](../../docs/adr/rp_dshPlugins.md) ("skillhub
(cocofhu)" section, "New plugin: skillhub" section) — see that doc for the
full design rationale. The short version:

| Concern | Upstream (`cocofhu/skillhub`) | This plugin |
|---|---|---|
| Package format | Downloads and extracts a ZIP archive (`src/unzip.ts`, `src/install.ts`) | No archive at all — the registry contract is an itemized JSON list of `{ path, content }` text files. Closes off the zip-slip/decompression-bomb class by construction, not by hardening a ZIP path after the fact. |
| Outbound HTTP | `src/http.ts` does no URL validation — no protocol allowlist, no origin pinning on redirects | Every request URL is assembled from the configured `registryUrl` plus a fixed path and query parameters, never from a response field — same-origin by construction. `registryUrl` must be `https:` (checked at plugin load); redirects are refused outright. |
| Path safety | `safeRelPath()`/`skillDir()` reject `..`/absolute paths reasonably, but with no file-count or byte-size bound noted | Same rejection rules (`install-path.ts`), plus a hardcoded extension allowlist, and file-count/per-file/total-bundle byte caps enforced by the registry client before anything is written. |
| Uninstall | Removes a directory after checking `SKILL.md` exists in it | Removes only files this plugin's own install ledger (`state.ts`) recorded writing, re-validated for containment immediately before every delete — never a raw name-derived path alone. |
| Self-update | `src/self-update.ts` runs `npx --yes @deepseek-ai/dsh plugin ... add [spec]` from an unverified GitHub release, no signature/checksum check | No self-update mechanism. This plugin is versioned and updated the same way any other `dsh-plugins/` package is. |

## The tools

| Tool | What it does |
|---|---|
| `skillhub_search` | Read-only keyword/category search against the registry. |
| `skillhub_install` | Fetches a skill's manifest and writes it to `.dsh/skills/<name>/`, so it's immediately discoverable by the existing `@deepseek-ai/dsh-skill-filesystem` provider — no new discovery code needed. |
| `skillhub_list` | Lists skills this plugin has installed in the current project, cross-checked against what's still actually on disk. |
| `skillhub_uninstall` | Removes a skill this plugin installed. Refuses to touch anything it didn't install itself. |

## Registry contract

This plugin defines its own registry contract (documented here, not a
reverse-engineered real API) — point `registryUrl` at a deployment that
implements:

```
GET {registryUrl}/api/v1/skills/search?q=<query>&category=<category>&limit=<n>
  -> { "results": [{ "name", "version", "category", "description", "downloads" }] }

GET {registryUrl}/api/v1/skills/manifest?name=<name>&version=<version>
  -> { "name", "version", "description", "category",
       "files": [{ "path": "SKILL.md", "content": "..." }, ...] }
```

`files[].content` is always UTF-8 text — there is no binary/archive payload
in this contract, which is what lets the path/size validation in
`install-path.ts` and `registry-client.ts` be exhaustive rather than
best-effort.

## Config

```ts
interface Config {
  /** Base URL of the registry. Must be https:; validated at plugin load. No default. */
  registryUrl: string
  /** Where installed skills land, relative to the session cwd. Defaults to ".dsh/skills". */
  installDir?: string
  /** Cooperative timeout for every registry request (ms). Defaults to 15000. */
  requestTimeoutMs?: number
  /** Byte cap on one registry HTTP response. Defaults to 256KB. */
  maxResponseBytes?: number
  /** Upper bound on files a single skill manifest may contain. Defaults to 30. */
  maxFilesPerSkill?: number
  /** Byte cap on one file's content. Defaults to 200KB. */
  maxFileBytes?: number
  /** Byte cap on a manifest's total file content. Defaults to 1MB. */
  maxTotalBytes?: number
  /** Upper bound on results from one skillhub_search call. Defaults to 20. */
  maxSearchResults?: number
  /** A ctx.credentials reference resolved to a bearer token, sent only to registryUrl's own origin. Empty (default) means an unauthenticated registry. */
  registryCredentialRef?: string
}
```

## Trust and limitations

- `skillhub_install` overwrites a prior install of the same name outright —
  it does not diff or ask before replacing files.
- The local install ledger (`.dsh/skills/.skillhub-state.json`) is this
  plugin's own advisory record, not the filesystem's source of truth: if it's
  deleted or edited out-of-band, `skillhub_list`/`skillhub_uninstall` only
  know what the ledger currently says, though `skillhub_uninstall`'s
  per-file containment check still applies regardless.
- No credential is required for a public registry; `registryCredentialRef`
  exists only for a registry that needs one, resolved host-side, never
  visible to the model.

## Development

```sh
npm install
npm test    # vitest — name/path validation, registry-client (https-only,
            # no-redirect, size/count caps, same-origin-by-construction
            # URL building), state ledger round-trip, install/uninstall
            # lifecycle against a real temp directory, and tool wiring —
            # all against an injected fetch; no live network call in tests
npm run build
```
