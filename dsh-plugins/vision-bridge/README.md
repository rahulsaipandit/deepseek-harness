# dsh-plugin-vision-bridge

A DeepSeek Harness (DSH) plugin that registers one model-facing tool,
`describe_image`, so a text-only main model can "see" an image: a local
file or an `https` URL goes in, a structured spatial description (or, as a
fallback, offline-OCR text) comes back.

This is a deliberate hybrid of two community plugins reviewed in
[`docs/adr/rp_dshPlugins.md`](../../docs/adr/rp_dshPlugins.md) — visionDS
and dsh-plugin-mm-vision — built to keep what each one got right and drop
what each one got wrong. See that doc's "New plugin: vision-bridge" section
for the full design rationale; the short version:

| Kept from | What | Why |
|---|---|---|
| dsh-plugin-mm-vision | Register as a schema-scoped `ctx.tools` tool, not a shell-invoked skill | The model can only ever supply an image and an optional prompt/mode — never a destination URL or credential. visionDS's `SKILL.md` + free-argument Python script let the model pass `--base-url`/`--api-key` overrides, which is an attacker-choosable exfiltration path the moment the agent is prompt-injected into using them. |
| visionDS | A configurable multi-provider catalog (MiMo/GLM/Ark/DashScope/Moonshot/OpenAI-compatible) tried in priority order, plus offline Windows/macOS OCR as a last resort | dsh-plugin-mm-vision only ever calls one fixed provider; visionDS's fallback chain means the tool still gives *some* answer with zero API keys configured. |
| dsh-plugin-mm-vision | The structured, coordinate-annotated description format ("canvas/elements/percentage-coordinates/relationships") | Meaningfully more useful to a text-only model than visionDS's plain "describe this image" prompt. |
| Neither (fixed here) | The image argument never reads an arbitrary local path via raw `node:fs`/`path.resolve`, and never proceeds on bytes that don't sniff as a real image | Both reviewed plugins would happily base64 *any* file (or fetch any URL) and forward it, mislabeled, to a vision endpoint — visionDS to a model-influenceable one. Here, a local path resolves through `ctx.fs` (the same sandboxed/policy-aware seam `read_image` uses) and every source is magic-byte sniffed; anything that doesn't match PNG/JPEG/GIF/WebP/BMP is rejected outright, never shipped as `application/octet-stream`. |
| Neither (fixed here) | Every provider key resolves through exactly one named `ctx.credentials` ref | dsh-plugin-mm-vision's fallback silently reused *any* first key found in `~/.pi/auth.json`, regardless of which tool declared it. No implicit cross-tool credential reuse here. |

## The `describe_image` tool

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `file_path` | string | one of `file_path`/`url` | Local image path, resolved through `ctx.fs`. |
| `url` | string | one of `file_path`/`url` | Must be `https://`; any other scheme is refused before a fetch is attempted. |
| `prompt` | string | no | What to focus on, beyond a general description. |
| `mode` | `auto` \| `chart` \| `photo` | no | `auto` (default) infers chart-vs-photo emphasis from `prompt`. |

Output is one text block: the structured description from whichever
provider answered first, or offline OCR text if every provider failed (or
none had a configured credential) and `localOcrFallback` is enabled.

## Config

```ts
interface Config {
  /** OpenAI-compatible vision routes to try, in providerOrder. Defaults to the visionDS-derived catalog (src/providers.ts). */
  providers?: ProviderConfig[]
  /** Provider ids to try, in order; unlisted catalog entries are tried after, in catalog order. */
  providerOrder?: string[]
  /** Fall back to offline Windows/macOS OCR when no provider succeeds. Defaults to true. */
  localOcrFallback?: boolean
  /** Per-image byte cap, for both a local read and a remote fetch. Defaults to 20MB. */
  maxImageBytes?: number
  /** Per-provider-attempt fetch timeout (ms). Defaults to 30000. */
  requestTimeoutMs?: number
  /** Local OCR subprocess timeout (ms). Defaults to 120000. */
  localOcrTimeoutMs?: number
  /** Output-token cap sent to the vision provider. Defaults to 1024. */
  maxOutputTokens?: number
  /** How long a cached description stays valid for the same image bytes + prompt. Zero disables caching. Defaults to 10 minutes. */
  cacheTtlMs?: number
  cacheMaxEntries?: number
}
```

Each default catalog entry's `credentialRef` names a `ctx.credentials`
reference — point it at the same environment variable visionDS's
`.env.example` documents (`MIMO_API_KEY`, `GLM_API_KEY`, `ARK_API_KEY`,
`DASHSCOPE_API_KEY`, `MOONSHOT_API_KEY`, `OPENAI_API_KEY`) to reuse an
existing deployment's keys unchanged; DSH's credential store resolves the
reference to a value, never the browser/client. A provider with no
resolvable credential is silently skipped in favor of the next one in
`providerOrder`.

## Offline OCR fallback

Implemented for Windows (`scripts/ocr-windows.ps1`, the built-in WinRT
`OcrEngine`) and macOS (`scripts/ocr-macos.swift`, the Vision framework) —
both free, offline, and require no API key. There is no Linux backend.
Every invocation runs through `child_process.execFile` with a fixed
argument array; the image path is always one array element, never
concatenated into a shell string, so it cannot break out into another
command regardless of its content.

Text extraction only — OCR reads words, not layout/color/chart semantics,
so it's a fallback of last resort, not a substitute for a real vision model.

## Trust and limitations

- The default provider catalog's endpoints/models mirror visionDS's list at
  time of writing; a provider may change its API shape without notice. A
  provider response that doesn't parse as an OpenAI-style
  `choices[0].message.content` is treated as that provider failing (falls
  through to the next one, or to OCR), never as a silent empty success.
- `maxImageBytes` bounds both a local read and a remote fetch, checked
  against the declared `content-length` before buffering and again against
  the actual bytes read — a misreporting server can't force an unbounded
  buffer.
- A remote `url` is only ever fetched over `https`; the fetch itself carries
  no credential, cookie, or session context from the calling agent.

## Development

```sh
npm install
npm test    # vitest — providers, image-source sniffing/fetch, vision-api
            # parsing, cache, prompt, and local-ocr command construction all
            # run against injected fetch/execFile stubs; no live network
            # call or real OCR subprocess runs in tests
npm run build
```
