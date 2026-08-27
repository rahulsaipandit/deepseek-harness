# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

To add a plugin such as `dsh-plugins/knowledge-hub` to a running profile, see "Installing plugins" below.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

### Other run modes

```sh
pnpm dsh --profile <name>              # run a named profile
pnpm dsh --profile headless "some job" # run one job non-interactively, then exit
pnpm dsh web                           # shorthand for --profile web
```

`dsh --dump-config` prints a profile's fully composed plugin configuration, useful when debugging what a profile actually loads.

### Installing plugins

Plugins — including everything under [`dsh-plugins/`](dsh-plugins/), which is deliberately kept outside this repository's package workspace so each one is installed the same way an external community plugin would be — are added to a profile with:

```sh
pnpm dsh plugin --profile <name> add <path-or-package-or-git-spec>
pnpm dsh --profile <name>
```

For example, to add a local checkout of one of this repo's own `dsh-plugins/`:

```sh
pnpm dsh plugin --profile <name> add ../dsh-plugins/skillhub
```

`dsh plugin add` installs the package into the profile and reconciles its declared bundle manifest into the profile's composed Cordis configuration; a plugin's own required settings (e.g. a filesystem path it needs) are then set via that profile's `cordis.patch.yml` overlay. See [Web UI guide](docs/user/guide/index.md) and [architecture documentation](docs/architecture.md) for the full configuration-layering model.

### Configuring a local LLM in Settings → Models

DSH doesn't have a named "Ollama"/"LM Studio" option — instead it has a generic custom provider mechanism that works with any self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp server, text-generation-webui, etc.), since they all expose an OpenAI-compatible `/v1/chat/completions` API.

**Steps in the web UI:**

1. Settings → Models → Add a custom provider.
2. Fill in: Provider ID (lowercase, permanent — used in requests/sessions/credential refs, e.g. `my-ollama`), Display name, Base URL (e.g. `http://localhost:11434/v1` for Ollama, or your LM Studio/vLLM/llama.cpp server's URL), API protocol (`openai-completions` — the one local servers use), API key (optional; local servers usually don't need one, leave blank or put a placeholder if the server ignores it).
3. Under Model catalog, click Fetch available models to auto-query the server's `/models` endpoint (works with Ollama/LM Studio/vLLM), or type model ids manually (e.g. `llama3.1`).
4. Save. Any API key you entered is written write-only into `$DSH_HOME/.credentials.yaml` via the credentials service — `settings.yaml` only keeps a reference to it, never the literal secret.

**What this produces under the hood:** the plugin backing this is `dsh-llm-pi-ai` (`packages/llm/llm-pi-ai`), and it writes into `settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    my-lmstudio:
      apiKeyEnv: LMSTUDIO_API_KEY      # optional credential reference, not the literal key
      api: openai-completions        # openai-completions | openai-responses | anthropic-messages
      baseURL: http://192.168.1.51:1234/v1
      models:
        - id: llama3.1
        - id: llava
          input: [text, image]       # vision models: no UI field for this yet, edit settings.yaml by hand
```

If you'd rather hand-edit config instead of using the UI, that block above is exactly what to add. The canonical doc for this is [docs/user/guide/providers.md](docs/user/guide/providers.md) ("Add a custom provider" section).

## Appendix

### Session storage and resetting/deleting a session

There is no "delete session" action in the web UI today — only **Archive**,
which hides a session from list views via a client-side registry flag but
leaves its event log fully intact on disk (sessions are append-only event
logs by design, the same architecture used throughout DSH for
auditability). See `dsh-plugins/README.md`'s live-boot findings for related
context on how this project's storage layer works.

If you genuinely want a session gone (e.g. after test/throwaway usage),
you can delete its files directly, since the JSONL persistence backend
stores one directory per session:

```
$DSH_HOME/sessions/<sanitized-cwd>/session-<uuid>/session.jsonl[.zstd]
```

`$DSH_HOME` defaults to `~/.dsh`. The `<sanitized-cwd>` segment encodes the
working directory the profile was booted from (e.g.
`--D-Github-deepseek-harness--`). This location is **shared across every
profile** on the machine (`web`, `headless`, and any custom profile all
point at the same `dshHomePath('sessions')` root per
`packages/bundle/base/cordis.patch.yml`), so deleting here affects that
session regardless of which profile created it.

To reset:

1. Stop the running `dsh` process first — it holds file locks and
   in-memory state for active sessions; deleting live files underneath it
   can cause errors or a stale UI until restarted.
2. Delete the specific session's folder (surgical — only removes that one
   session), or the entire `sessions/` folder (full reset — removes every
   session across every profile).
3. Restart `dsh`. The session list reflects whatever remains on disk; no
   separate index needs clearing (session search/query state self-heals
   against the persistence backend's file listing on the next
   reconciliation pass).

There is currently no supported way to delete a session from within the UI
itself, and no CLI command for it either — this is a genuine gap, not a
hidden feature. Adding a real delete action would need a new storage-layer
primitive (none of the current backends expose delete/purge), a new
RPC/API endpoint (archive doesn't need one since it's purely a client-side
flag), and a safety guard against deleting a session that is currently
running or is the parent of live forked sub-sessions — none of which exist
today.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
