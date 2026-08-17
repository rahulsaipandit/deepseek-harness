# dsh-plugins

Our own DeepSeek Harness (DSH) plugins, kept in a folder isolated from
`packages/` on purpose: these are not part of the core harness's own
build/release graph, they're written and reviewed the way we'd review any
third-party community plugin — see
[`docs/adr/rp_dshPlugins.md`](../docs/adr/rp_dshPlugins.md) for the review
that motivated this folder and the design notes for each plugin here.

Each subdirectory is a standalone, independently-installable npm package
(own `package.json`, own tests, no reliance on this repo's pnpm workspace or
`workspace:^` protocol) — structured the way an external community plugin
would be, so it can be published, forked, or installed via `dsh plugin add`
without depending on this monorepo's internal build.

## Plugins

- **[flight-search](./flight-search/)** — natural-language flight-price
  lookup tool, ported from
  [AWeirdDev/flights](https://github.com/AWeirdDev/flights) into a native
  TypeScript DSH plugin. See its README and the design section in
  `docs/adr/rp_dshPlugins.md` for what changed in the port and its
  disclosed trust/limitations.
- **[imchat](./imchat/)** — bridges Telegram/WhatsApp/Slack chat to DSH agent
  sessions, in-house design (not a port). See its README and
  `docs/adr/rp_dshPlugin_imChat.md` for the design, the community plugins it
  learned from without adopting wholesale, and current adapter status
  (Telegram and Slack implemented against mock APIs, WhatsApp deferred).
- **[vision-bridge](./vision-bridge/)** — gives a text-only main model a way
  to describe images (`describe_image` tool): a configurable multi-provider
  vision-API catalog with offline OCR fallback. A deliberate hybrid of two
  community plugins reviewed in `docs/adr/rp_dshPlugins.md` (visionDS,
  dsh-plugin-mm-vision) — see its README and that doc's design section for
  what was kept from each and what was fixed.

## Conventions these plugins follow

- No hardcoded secrets; credentials (when a plugin needs any) resolve
  through DSH's own credential store, never the browser/client.
- No dependency beyond what's genuinely needed — prefer a small, auditable,
  hand-written implementation over pulling in a heavy library for a small
  job (the standard we held third-party plugins to in the review doc).
- Defensive parsing of any external/undocumented response shape: fail
  closed with a clear error rather than throw unhandled or return corrupted
  data.
- A plugin that scrapes or reverse-engineers an unofficial endpoint says so
  plainly in its README, including the ToS/stability risk that implies —
  never presented as a sanctioned integration.
