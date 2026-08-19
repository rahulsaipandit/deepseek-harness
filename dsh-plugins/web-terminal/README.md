# dsh-plugin-web-terminal

A browser-facing PTY console over `ctx.terminals`, mirroring
[`dsh-plugin-browser-bridge`](../browser-bridge/)'s `ctx.webServer` pattern —
its own upgrade route, its own bearer-token auth, zero changes to
`packages/`/`apps/`. Closes the "human-facing terminal tab" gap named in
`docs/CompareCabinet.md`: `packages/terminal` already provides persistent
PTY sessions as a *model*-facing tool capability; nothing exposes one to a
*human* in a browser tab the way Cabinet's xterm.js terminal does.

## What it is not

**Not a raw byte-streaming PTY.** `ctx.terminals`' `TerminalBackendSession`
contract is line-oriented: `startSend({text, submit})` starts one exclusive
operation per session, polled via `readOutput()` until it settles
(idle/timeout/exit) — a command/response seam, not an open bidirectional
byte pipe. That means no per-keystroke echo and a poor `vim`/`less`/`top`
experience. What this plugin *does* deliver, honestly: a solid
single-command-at-a-time remote shell console — type a line, see its output
stream in as it's produced, send Ctrl+C, read scrollback. The frontend is a
plain output pane and a line input, not an xterm.js terminal emulator,
because a full terminal-emulator library would be over-engineering for what
the underlying capability actually offers (and the `dsh-plugins` convention
already prefers small, auditable code over pulling in a library for a small
job).

**Not multi-user.** Per the single-user scope decision in
`docs/designCabinetButForSingleUser.md`, auth here is one shared bearer
token (`web-terminal-token` under the dsh home, or an explicit `config.token`),
not accounts — matching a single-operator deployment. `ctx.webServer`'s own
README states auth is "deliberately out of scope" for the seam this plugin
registers on; this plugin brings its own, same shape as `browser-bridge`'s
token (`timingSafeEqual`, `hello`-frame handshake, 0600-permissioned
persisted file).

## Composition

**This plugin needs `ctx.terminals` to actually have a backend
registered** — reachable from the SAME context tree it loads into. Unlike
most `dsh-plugins/` packages, it can't compose with just its own row; the
deployment's `cordis.yml` also needs `@deepseek-ai/dsh-terminal` and a
backend (`@deepseek-ai/dsh-terminal-bash`) mounted, which in turn needs
`sandboxPolicy`/`subprocess`. This is a normal, already-used pattern —
`examples/acp-agent/pty.cordis.yml` mounts `dsh-terminal` +
`dsh-terminal-bash` at the host level, independent of any per-preset
isolated terminal realm (the `isolate: { terminals: true }` realms seen in
`apps/cli/config/agent-presets/minimal/agent.cordis.yml` are that preset's
own choice to scope a chat session's terminal, not a requirement):

```yaml
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  # config as your deployment already uses for other terminal/shell tools
- id: pty
  name: '@deepseek-ai/dsh-terminal'
- id: terminal-bash
  name: '@deepseek-ai/dsh-terminal-bash'
- id: web-terminal
  name: dsh-plugin-web-terminal
  config:
    path: /ext/web-terminal
```

Load after `ctx.webServer`, `ctx.agents`, and `ctx.terminals`. A real
deployment already has `sandboxPolicy`/`subprocess` mounted for its normal
chat-agent shell tools, so usually only the `pty`/`terminal-bash`/
`web-terminal` rows above are new.

## How it works

- `ctx.webServer.registerUpgrade` (WebSocket) and `.register` (the page)
  add this plugin's own routes — the exact seam `dsh-plugin-browser-bridge`
  already proves out, zero core edits.
- Each browser connection authenticates with a `hello` frame carrying the
  token (10s timeout), then gets a dedicated owner `Agent`
  (`ctx.agents.create`, since `ctx.terminals.spawn` requires a live owner —
  there's no ownerless "give me a shell") and a fresh PTY session on it.
- `team_channel`-style separation of concerns: `domain.ts` (pure frame
  parsing), `session-bridge.ts` (owner/PTY lifecycle over small structural
  ports — testable without a real Cordis context), `dispatch.ts` (frame →
  bridge-call → response frame, testable without a real socket), `server.ts`
  (thin `ws`-specific wiring), `page.ts` (the static frontend), `index.ts`
  (Cordis plugin glue).
- On socket close: kill the PTY session, then dispose the owner agent —
  no leaked `AgentRegistry` entries.

## Testing

```sh
cd dsh-plugins/web-terminal
pnpm install
pnpm test
```

`tests/domain.test.ts` covers frame parsing/validation. `tests/token.test.ts`
covers the token lifecycle. `tests/session-bridge.test.ts` exercises the
owner/PTY lifecycle against structural fakes for `ctx.agents`/`ctx.terminals`
(fake timers for the output-polling loop) — including that `close()` kills
the PTY session and disposes the owner agent, and is a safe no-op if `open()`
never resolved. `tests/dispatch.test.ts` covers every frame → response
translation, including the error path when a bridge call throws. `server.ts`
itself (the real `ws`/socket wiring) is intentionally thin and not unit
tested — a manual check is the practical way to verify it end-to-end: load
the served page, connect with the token printed in the server log, confirm a
command's output streams in and `ctx.terminals.list(owner)` empties after
the tab closes.
