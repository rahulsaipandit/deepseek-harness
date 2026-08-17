# dsh-plugin-imchat

A DeepSeek Harness (DSH) plugin that bridges Telegram, WhatsApp, and Slack
chat to DSH agent sessions: message a bot from your phone or Slack workspace,
get the agent's replies back in the same chat, and answer its approval/choice
prompts as native buttons instead of switching to a terminal or browser.

Runs in-process as a Cordis plugin — not an external client talking to the
host over RPC — so it drives sessions directly via `ctx.agents` and answers
approval/question prompts via `ctx.approval`/`ctx.userQuestions`. See
[`docs/adr/rp_dshPlugin_imChat.md`](../../docs/adr/rp_dshPlugin_imChat.md) in
the parent repo for the full design, what was learned reviewing three
community plugins (`dsh-im`, `dsh-overdrive`, `dsh-telegram-duty`) that
attempt something similar, and why this plugin's design differs from each of
them.

## Adapter status

| Platform | Status | Transport |
|---|---|---|
| Telegram | Implemented | Bot API long polling (`getUpdates`) — no public port |
| Slack | Implemented, needs a Socket Mode client | Web API (`chat.postMessage`/`chat.update`) for sending; receiving is injected via `SlackEventsClient` (see below) |
| WhatsApp | Not implemented (stub only) | Deferred — see Trust and limitations |

Every test in this package runs against a mock HTTP server standing in for
the Telegram Bot API and the Slack Web API (`tests/mocks/`), never a real
bot token or live network call.

## Trust and limitations (read before enabling)

- **Slack requires a real Socket Mode client, which this plugin does not
  bundle.** `SlackAdapter` takes a `SlackEventsClient` (`start`/`stop`/`onMessage`/`onBlockAction`)
  as a constructor dependency rather than owning a WebSocket connection
  itself — wiring a genuine Socket Mode client (e.g. `@slack/socket-mode`) is
  left to the deployment composing this plugin. This is a deliberate seam,
  not an oversight: it keeps the adapter's own logic (message/action
  dispatch, Block Kit rendering) testable without a live Slack connection.
- **WhatsApp is not implemented.** The design specifies Baileys
  (`@whiskeysockets/baileys`) multi-device pairing with a permissioned local
  auth-state directory, but mocking Baileys' QR-pairing protocol credibly is
  a materially different effort than Telegram/Slack's HTTP-shaped APIs.
  `WhatsAppAdapter` satisfies the shared `ChatAdapter` interface so the
  plugin's wiring doesn't special-case a missing platform, but every method
  throws `WhatsAppNotImplementedError` until this is built.
- **Every platform allowlist defaults to deny.** An adapter refuses to start
  (`EmptyAllowlistError`) unless at least one sender identity is explicitly
  configured for it — an empty list means "allow nobody," never "allow
  everyone." This is a deliberate rejection of a fail-open default found in
  one of the community plugins reviewed for this design (see the ADR).
- **v1 assumes this plugin owns its host's question seam
  (`ctx.userQuestions`) exclusively.** That seam allows exactly one
  registered provider per context; running alongside another already-running
  UI (a browser tab, VS Code) on the same host is out of scope — see the
  ADR's Non-goals. Approvals have no such constraint and compose with
  another UI's own answerer regardless.
- Secrets (bot tokens) resolve through `ctx.credentials` by reference
  (`telegramTokenRef`/`slackBotTokenRef` name a credential, never the value
  itself) — never written to this plugin's own config or state files.

## Config

```ts
interface Config {
  /** Per-platform allow-listed sender identities. A platform with no entries here is not started. */
  identities?: {
    telegram?: { senderId: string, approvalPolicy?: 'ask' | 'never' }[]
    whatsapp?: { senderId: string, approvalPolicy?: 'ask' | 'never' }[]
    slack?: { senderId: string, approvalPolicy?: 'ask' | 'never' }[]
  }
  /** `ctx.credentials` reference naming the Telegram bot token; required to enable Telegram. */
  telegramTokenRef?: string
  /** `ctx.credentials` reference naming the Slack bot token; required to enable Slack. */
  slackBotTokenRef?: string
  /** Idle eviction TTL (ms) for in-memory session bindings. Defaults to 24h. */
  sessionIdleTtlMs?: number
  /** How long a rendered approval/question prompt waits for a reply before failing closed. Defaults to 5 minutes. */
  promptTimeoutMs?: number
  /** Directory for this plugin's local state files (session-id map, poll cursor). Defaults to `.dsh-imchat`. */
  stateDir?: string
}
```

## Architecture

- `core/identity-registry.ts` — default-deny per-platform allowlist.
- `core/state-store.ts` — atomic, permissioned (`0o600`/`0o700`), serialized-write
  JSON persistence for the session-id map and adapter cursors.
- `core/session-router.ts` — one DSH session per `(platform, externalChatId)`,
  created on first contact and reused via `Agent.followup()`.
- `core/approval-relay.ts` — renders approval/question prompts as native chat
  buttons and resolves them by opaque id, fail-closed on timeout or adapter
  disconnect.
- `adapters/telegram.ts`, `adapters/slack.ts`, `adapters/whatsapp.ts` — one
  `ChatAdapter` implementation per platform; adapters own transport and
  rendering only, no session or approval logic.

## Development

```sh
npm install
npm test    # vitest — core logic against fakes, Telegram/Slack adapters against
            # mock HTTP servers (tests/mocks/); no live network call is made
npm run build
```
