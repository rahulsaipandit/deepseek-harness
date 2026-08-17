# DSH Browser Bridge (extension)

Chrome MV3 side-panel extension: text-only read/operate of a user-controlled
browser tab through the [`dsh-plugin-browser-bridge`](../README.md) host
plugin.

This is a hardened port of the browser-extension half of the community
project [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser)
(`extensions/dsh-browser/`), reviewed in
[`docs/adr/rp_dshPlugins.md`](../../../docs/adr/rp_dshPlugins.md) ("## dsh-browser"
section — see its "### New plugin: browser-bridge" subsection for the full
port rationale). That review found this extension's architecture "unusually
careful" for its risk category, so the security-critical modules below were
kept **byte-for-byte equivalent** in intent to upstream rather than
"improved" or rewritten.

## What it does

The background service worker connects to the host plugin's bridge
(`ws://127.0.0.1:*/ext/bridge`, auto-discovered via `/ext/bridge-config`) and
answers `tool.call` frames by: resolving the currently active tab, asking the
authorization policy whether the call needs a user prompt, presenting that
prompt in the side panel (or falling back to an OS notification), and — once
approved — sending the action to the content script running in that tab. The
content script executes the action against the real page and returns a
text-only result; page text is wrapped in an explicit untrusted-content
boundary before it goes back over the bridge.

## Install (load unpacked)

```sh
npm install
npm run build      # produces dist/
```

Then in Chrome: `chrome://extensions` → enable Developer mode → "Load
unpacked" → select `dist/`. Open the side panel (click the extension's
toolbar icon) to configure the bridge address/token and the page-read
approval policy.

## Development

```sh
npm install
npm run typecheck   # tsc -p tsconfig.json --noEmit
npm test            # vitest run (jsdom environment)
npm run build        # scripts/build.mjs: three vite targets -> dist/
```

## Trust and limitations

This is a port of [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser)'s
browser extension. Read this section before installing it.

- **Broad host-permission scope is inherent to the product's purpose.**
  `manifest.json` declares `http://*/*`/`https://*/*` host permissions and
  content-script matches so the extension can operate whatever tab the user
  is on — this is not opt-in per site, by design (the alternative is a
  browser extension that can't automate arbitrary pages, which is not this
  product).
- **Live session/cookie access is inherent to the product**, for the same
  reason — see the host plugin's README "Trust and limitations" section.
- **Simplified relative to upstream** (all disclosed here rather than silently
  dropped; see `docs/adr/rp_dshPlugins.md`'s "### New plugin: browser-bridge"
  subsection for the full rationale):
  - **Single top-level frame only — no iframe-scoped snapshot/action
    support.** Upstream's `frames.ts` (via `chrome.webNavigation`) discovers
    every accessible frame in a tab, gives each its own snapshot budget, and
    scopes approval/trust to the exact frame origin a call targets. This port
    drops that entirely: `content/index.ts`'s content script only ever
    operates on its own document, and `background/authorization.ts` resolves
    a single page URL rather than a `TabFrame[]`. Net effect: this port's
    attack surface and functional scope are both narrower than upstream's,
    not broader — the manifest here also drops `all_frames: true` and
    `match_origin_as_fallback: true` (both present upstream) for the same
    reason.
  - **No tab-affinity/handoff continuity, no focused-window tracking, no
    session continuity, no transient-event replay.** Upstream's
    `tab-affinity.ts`, `focused-window.ts`, `session-continuity.ts`, and
    `transient-events.ts` implement "keep operating on tab A while the user
    looks at tab B, then ask before switching" continuity plus event replay
    across panel reconnects. This port always resolves
    `chrome.tabs.query({active:true,lastFocusedWindow:true})` fresh at
    dispatch time — simpler, with no persisted cross-restart tab binding, but
    also no silent "keep acting on a backgrounded tab" behavior to reason
    about.
  - **No i18n.** Upstream ships `en`/`zh_CN`/`zh_TW` locale strings
    throughout the background/panel/approval-summary text
    (`src/i18n.ts` and `_locales/`); this port is English-only.
  - **Minimal plain-DOM side panel, not the upstream React panel.** The task
    scope explicitly allows this trade-off in exchange for porting the
    security-critical background/content/security modules faithfully. The
    panel (`src/panel/main.ts`, `panel/index.html`) is a small, functional
    settings + status + approval UI — no chat/session view, no markdown
    rendering, no React.
  - **No bundled icon assets** — `manifest.json` does not declare an `icons`
    block (cosmetic only; add icon files and an `icons` entry before a real
    Chrome Web Store submission).
- **Security-critical modules kept faithful, not simplified:**
  `src/security/trusted-origins.ts`, `src/security/approval.ts`,
  `src/background/authorization.ts` (adapted only for the single-frame model
  above — the policy itself, including which actions ever prompt and which
  can never become persistently trusted, is unchanged),
  `src/background/untrusted.ts`, `src/background/bridge.ts`, and
  `src/background/approval-coordinator.ts` are all present.

## Security

- **No `window.postMessage`/`onMessageExternal` listener anywhere** — the
  content script (`src/content/index.ts`) only listens on
  `chrome.runtime.onMessage`, which is reachable only from this extension's
  own background service worker, never from an arbitrary web page. Verified
  by inspection of every file under `src/`; this is the single most
  important property for this category of extension (see the host plugin's
  ADR review), and it is unmodified from upstream.
- **Per-action user approval by default.** `src/background/authorization.ts`
  decides whether a call needs a prompt (state-changing actions always do
  unless the origin is already trusted; page reads prompt only under the
  `ask` policy); `src/background/approval-coordinator.ts` owns the pending
  request independently of whether a side panel is currently open, with a
  60-second timeout and an OS-notification fallback.
  `src/security/trusted-origins.ts` normalizes and matches the persistent and
  per-session trust allowlists; cross-origin/invalid navigation and browser
  history can never expand that allowlist (`canTrust` stays `false` for
  exactly those cases, both upstream and here).
- **Untrusted-content wrapper.** `src/background/untrusted.ts` wraps every
  page-text result (`browser_snapshot`, `browser_get_text`) in an explicit
  `<UNTRUSTED_PAGE_CONTENT nonce="...">` boundary with a fresh random nonce
  before it reaches the model — defense in depth against prompt injection
  from page content, not a hard boundary (user approval remains the real
  enforcement point for actions).
- **Sensitive form fields are never echoed.** `src/content/privacy.ts` masks
  password/credit-card-pattern field values to a fixed placeholder in every
  snapshot; the real value never leaves the page.
- **Token authentication and the Origin-gated loopback exception live in the
  host plugin** — see [`../README.md`](../README.md)'s "Security" section.
