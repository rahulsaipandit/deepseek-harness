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

- **[browser-bridge](./browser-bridge/)** — token-authenticated WebSocket
  bridge plus a `browser_*` tool set for a companion Chrome MV3 extension
  (`./browser-bridge/extension/`), a hardened port of the community
  [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser) project. See
  its README and `docs/adr/rp_dshPlugins.md` for what was reviewed; the
  security architecture (token auth with `timingSafeEqual`, the Origin-gated
  loopback exception, privileged-method loopback pinning, per-action
  approval, and the untrusted-content wrapper) was kept exactly as reviewed,
  while multi-frame/iframe support, tab-affinity continuity, session
  grouping/deferral, and i18n were simplified or dropped (disclosed in both
  packages' "Trust and limitations" sections).
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
- **[skillhub](./skillhub/)** — `skillhub_search`/`install`/`list`/`uninstall`
  tools that discover and manage skills from a configured registry, a
  hardened take on the community
  [`cocofhu/skillhub`](https://github.com/cocofhu/skillhub) project. See its
  README and `docs/adr/rp_dshPlugins.md` for what was reviewed and what was
  deliberately redesigned (no archive download/extraction; a same-origin
  HTTP client by construction; an install ledger scoping what uninstall may
  delete).
- **[vision-bridge](./vision-bridge/)** — gives a text-only main model a way
  to describe images (`describe_image` tool): a configurable multi-provider
  vision-API catalog with offline OCR fallback. A deliberate hybrid of two
  community plugins reviewed in `docs/adr/rp_dshPlugins.md` (visionDS,
  dsh-plugin-mm-vision) — see its README and that doc's design section for
  what was kept from each and what was fixed.

## Live-boot verification findings (2026-08-18)

Every plugin here had unit-test coverage against a fake Cordis context, but
none had been verified against a real, fully-booted DSH host until this
pass — wiring all nine into a live `web` profile's `cordis.patch.yml`
surfaced defects that unit tests, by construction, cannot: a fake test `ctx`
already carries whatever services a test author stubs in, regardless of
what the plugin actually declares in `inject`.

- **browser-bridge**: had never had `npm install` run against it (its own
  `node_modules` was empty), and `src/tools.ts` had several `execute`
  callbacks missing a type annotation on their second (`exec`) parameter,
  which only surfaces as a build error once real dependencies are
  installed. Fixed: ran `npm install`, added the missing `ToolExecution`
  annotations.
- **flight-search**: accessed `ctx.tools` directly without declaring
  `export const inject = ['tools']`. Cordis only resolves a service on
  `ctx.<name>` for services a plugin's own `inject` list names; without it,
  a real boot throws `cannot get property "tools" without inject`. Fixed.
- **vision-bridge**: same class of bug — used `ctx.tools`, `ctx.fs`, and
  `ctx.credentials` directly with no `inject` declaration at all. Fixed by
  adding `export const inject = ['tools', 'fs', 'credentials']`.
- **imchat**: same class of bug — used `ctx.agents`, `ctx.credentials`, and
  `ctx.userQuestions` with no `inject` declaration. Fixed by adding
  `export const inject = ['agents', 'credentials', 'userQuestions']`. This
  also surfaced a separate, real architectural constraint, not a bug: the
  plugin unconditionally registers itself as *the* `ctx.userQuestions`
  provider in `apply()` (regardless of whether any chat platform identity
  is even configured), which fatally collides
  (`UserQuestionError: a user-questions provider is already registered`)
  with `@deepseek-ai/dsh-host-apiproxy`'s own provider that the `web` UI
  depends on. **imchat cannot run alongside `dsh-web-app`** — it's designed
  for a profile with no other UI answering questions (e.g. a headless-only
  deployment). This isn't something to fix in the plugin; it's a deployment
  constraint worth knowing before wiring it into any profile.
- **web-terminal**: its declared `inject` was already correct
  (`['webServer', 'agents', 'terminals']`), but no built-in bundle
  (`dsh-base`, `dsh-web-app`, `dsh-headless`) actually mounts
  `@deepseek-ai/dsh-terminal` (the `ctx.terminals` provider) — it's an
  opt-in package a profile must add explicitly alongside this plugin.

None of the other five plugins (knowledge-hub, persona-scheduler, skillhub,
team-channel, and browser-bridge past its build fix) needed any inject
corrections — their `export const inject` lists already matched every
direct `ctx.<service>` access.

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
