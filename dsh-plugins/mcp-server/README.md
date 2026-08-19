# dsh-plugin-mcp-server

Exposes a configurable allowlist of `ctx.tools` — by default,
[`dsh-plugin-knowledge-hub`](../knowledge-hub/)'s five memory tools — as an
authenticated MCP (Model Context Protocol) Streamable HTTP server, so an
external app (Pluely, or any other MCP client) can call into this DSH
instance's memory/recall surface. See
[`docs/designCognitiveBrainForDSH.md`](../../docs/designCognitiveBrainForDSH.md)'s
MCP server section for the full design rationale and scope decision.

## What it does — and deliberately does not do

This is the *outward* direction: DSH being called **into** by an external
app. (The companion, opposite direction — DSH **consuming** an external
MCP server's tools during its own chat sessions — already works today via
`packages/mcp/mcp-client` and needs no new code; see the design doc.)

**Scoped to existing tools only.** This server exposes whatever's already
in `allowedTools` (default: `memory_remember`, `memory_recall`,
`memory_list`, `memory_audit`, `memory_related`) — nothing more. It does
**not** add synthesis, query-time knowledge-graph traversal, or
knowledge-gap analysis. Those were explicitly considered and rejected for
this surface — see the design doc's retraction/scope-decision notes — since
they'd reintroduce exactly the token-cost and opacity problems GBrain was
rejected for in the first place. Only a tool name with a hand-written input
schema in `tool-bridge.ts` can actually be registered; an unknown name in
`allowedTools` is skipped with a warning, not exposed with a guessed schema.

## Transport and security

Modeled on GBrain's own documented MCP HTTP posture (the *infrastructure*
pattern, not its capabilities):

- **Streamable HTTP transport** (`@modelcontextprotocol/sdk`), stateful
  mode — one session per connected client, tracked via a server-issued
  `Mcp-Session-Id`. Stateless mode was tried first and found broken for
  this shape of server: it can't correlate a client's `initialize` request
  with its follow-up `notifications/initialized` on one long-lived
  transport instance, since stateless mode assumes a fresh transport per
  request (a serverless pattern), not a persistent process.
- **Bearer-token auth**, resolved/persisted the same way
  [`dsh-plugins/browser-bridge`](../browser-bridge/) does for its own
  external-facing surface (`token.ts`, ported with its own token file,
  `$DSH_HOME/mcp-server-token`).
- **Loopback trust boundary**: a request from `127.0.0.1`/`::1` is treated
  as trusted the same way DSH's own CLI-equivalent local surfaces are;
  every other caller must present the bearer token. This mirrors GBrain's
  documented local-vs-`remote` distinction.
- **IP- and token-based rate limiting** (`rate-limit.ts`), independent
  fixed windows keyed by client IP and by a hash of the presented token —
  a request is limited if *either* budget is exhausted, so a leaked token
  can't route around a per-IP cap by rotating source addresses, and a
  shared/NATed IP doesn't starve every distinct token behind it.
- **CORS**: only origins explicitly listed in `corsOrigins` get
  `Access-Control-Allow-*` headers; empty (the default) sends none.

## Config

```ts
{
  path?: string              // default '/mcp'
  token?: string             // default '': persisted/generated under $DSH_HOME
  allowedTools?: string[]    // default: the five knowledge-hub tools
  rateLimit?: number         // default 60 — requests per window, per client
  rateLimitWindowMs?: number // default 60000
  corsOrigins?: string[]     // default [] — no CORS headers sent
}
```

## Testing

```sh
npm install
npm test
```

37 tests: token lifecycle (round-trip, constant-time verification),
rate-limiter (window expiry, independent keys, pruning), the DSH-tool-result
→ MCP-content conversion, and a live-HTTP integration suite that runs a
real `@modelcontextprotocol/sdk` `Client` against a real
`StreamableHTTPServerTransport` end to end (connect, list tools, call a
tool, verify the forwarded `ctx.tools.execute()` call and its result) —
plus hand-built request/response fakes for the auth, rate-limit, and CORS
paths that a real loopback test client can't exercise (a local test client
always presents as loopback, which is trusted by design).
