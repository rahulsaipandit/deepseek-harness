# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
pnpm install
pnpm run build
pnpm dsh web

There's also a published-package path — npx @deepseek-ai/dsh web - but you're working in this checkout, so use the build above
npx @deepseek-ai/dsh web

Other modes (apps/cli/README.md)
pnpm dsh --profile <name>              # run a named profile
pnpm dsh --profile headless "some job" # non-interactive
pnpm dsh web                           # shorthand for --profile web

To enable dsh-plugins/knowledge-hub in a running profile, since these plugins live deliberately outside the pnpm workspace (meant to be installed the way an external plugin would be, per dsh-plugins/README.md):
pnpm dsh plugin --profile <name> add ../dsh-plugins/knowledge-hub
pnpm dsh --profile <name>

dsh plugin --profile <name> add <path> installs it into that profile and reconciles its declared plugin manifest into the profile's composed Cordis config; then a normal dsh --profile <name> run picks it up.

One thing to flag: our plugin's Config requires vaultPath with no default (by design — see docs/designCognitiveBrainForDSH.md), so you'll need to set that via the profile's cordis.patch.yml overlay (the same mechanism examples/web-schedule/cordis.yml uses to insert plugin config) — something like:
- insert:
    - id: knowledge-hub
      name: dsh-plugin-knowledge-hub
      config:
        vaultPath: /absolute/path/to/your/notes


check the exact cordis.patch.yml your target profile already has and draft that insertion for it, or verify the dsh plugin add flow actually works end-to-end against our new plugin before you rely on it.
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

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

Findings
(a) Does local model support exist?
Yes, but generically — there's no provider named "Ollama"/"LM Studio"/"llama.cpp" specifically. Instead there's a generic custom provider mechanism (openai-compatible protocol) that any self-hosted OpenAI-compatible server (Ollama's /v1, LM Studio, vLLM, llama.cpp server, text-generation-webui, etc.) can use as-is, since these all expose an OpenAI-compatible /v1/chat/completions API.

(b) UI steps (docs/user/guide/providers.md:21-30, apps/web Models settings page = packages/client/ui-settings-models):

Settings → Models → Add a custom provider.
Fill in: Provider ID (lowercase, permanent — used in requests/sessions/credential refs), Display name, Base URL (e.g. http://localhost:11434/v1 for Ollama, or your LM Studio/llama.cpp server URL), API protocol, API key (optional — local servers often don't need one, but the credential field can be left blank or set to a placeholder if the server ignores it), and at least one model id.
Under Model catalog, click Fetch available models to query GET /models on that base URL with the given credential — this works for Ollama/LM Studio/vLLM since they implement that OpenAI-compatible endpoint. Otherwise enter model ids manually.
Save. The Models page writes credentials write-only through the credentials service into $DSH_HOME/.credentials.yaml; settings.yaml only keeps a credential reference (e.g. apiKeyEnv).
Optionally, for vision-capable local models, add input: [text, image] per-model since the UI form has no field for it (must hand-edit $DSH_HOME/settings.yaml).
(c) Package/plugin and config shape: Plugin is dsh-llm-pi-ai (packages/llm/llm-pi-ai). Config lives under llm-pi-ai.providers.<id> in settings.yaml:


llm-pi-ai:
  providers:
    my-lmstudio:
      apiKeyEnv: LMSTUDIO_API_KEY   # optional; credential ref, not the literal secret
      api: openai-completions     # protocol enum: openai-completions | openai-responses | anthropic-messages
      baseURL: http://192.168.1.51:1234/v1
      models:
        - id: llama3.1
        - id: llava
          input: [text, image]
Supported protocol identifiers are defined in packages/llm/llm-pi-ai/src/provider.ts:47-51 (PROTOCOLS table: openai-completions, openai-responses, anthropic-messages) — openai-completions (the default/first) is what Ollama-style local servers use. Native-auth protocols (Bedrock/Vertex/Azure/Codex) are deliberately excluded from the hand-declared route surface (comment at provider.ts:35-45).

(d) Config-file (cordis.patch.yml) example: packages/bundle/base/cordis.patch.yml:412 shows the DeepSeek built-in provider pattern (apiKeyEnv: DEEPSEEK_API_KEY under the llm-deepseek plugin id entry) — same shape as a hand-declared provider, just with a fixed provider id. The docs/user/guide/providers.md:37-65 doc has the canonical example for a custom/local settings.yaml provider (shown above, called my-gateway there).

Docs: docs/user/guide/providers.md ("Add a custom provider" section, lines 21-30) is the authoritative doc; no README mentions Ollama/LM Studio by name anywhere in packages/* or root docs — the "Ollama"/"llama.cpp" hits found were unrelated research notes in docs/adr/rp_dshPlugins.md, docs/agenticHarness.md, docs/CompareTools.md.

Configuring a local LLM in Settings → Models
DSH doesn't have a named "Ollama"/"LM Studio" option — instead it has a generic custom provider mechanism that works with any self-hosted OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp server, text-generation-webui, etc.), since they all expose an OpenAI-compatible /v1/chat/completions API.

Steps in the web UI
Settings → Models → Add a custom provider
Fill in:
Provider ID — lowercase, permanent (used in requests/sessions/credential refs), e.g. my-ollama
Display name — whatever you want shown in the picker
Base URL — e.g. http://localhost:11434/v1 for Ollama, or http://192.168.1.51:1234/v1 your LM Studio/vLLM/llama.cpp server's URL
API protocol — openai-completions (the one local servers use)
API key — optional; local servers usually don't need one, leave blank or put a placeholder if the server ignores it
Model catalog — click Fetch available models to auto-query the server's /models endpoint (works with Ollama/LM Studio/vLLM), or type model ids manually (e.g. llama3.1)
Save. Any API key you entered is written write-only into $DSH_HOME/.credentials.yaml via the credentials service — settings.yaml only keeps a reference to it, never the literal secret.
What this produces under the hood
The plugin backing this is dsh-llm-pi-ai (packages/llm/llm-pi-ai), and it writes into settings.yaml:


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
If you'd rather hand-edit config instead of using the UI, that block above is exactly what to add. The canonical doc for this is docs/user/guide/providers.md ("Add a custom provider" section).

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
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
