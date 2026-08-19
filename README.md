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
