designCabinetButForSingleUser.md

## Is Cabinet meant for a whole company vs. DSH for one person? 
Yes, that's the right read. Cabinet explicitly targets a self-hosted shared instance ("AI workspace your company owns," create-cabinet spins up a daemon meant to run continuously for a team). DSH has no equivalent positioning — no session-owner concept, no shared-server story, packages/identity is single-machine anonymous telemetry only.

## How does Cabinet handle data isolation (HR/salary, CEO-confidential)? 
It doesn't, really. Cabinet's own docs describe a single shared password gate for the whole instance — KB_PASSWORD turns on one password (PBKDF2-HMAC-SHA256, per-install salt, rate-limited login) protecting the entire UI/API, or no auth at all. There is no mention anywhere in its docs of:
    - individual user accounts or logins
    - roles/permissions
    - per-agent or per-document access scoping

Every authenticated person or agent sees the same knowledge base and the same missions. So a "HR persona sees salary data, other personas don't" scenario is **not actually enforced by Cabinet today** — at best it's a social/prompt-level convention (an agent's persona instructions tell it not to look at certain folders), not a real security boundary. Cabinet's stated design philosophy is explicitly "simple, stupid" / "understandable, hackable" over building real multi-tenant permissions — so this looks like a deliberate scope cut on their part, not something I'm missing in their docs.

That means for the DSH plan that the personas (Chief of Staff, CFO, Marketing) are just different hats one user's own agent wears over their own data, not separate company employees who need to be kept out of each other's information. There's no isolation problem to solve because there's only ever one principal. 

This matters for the plan: the dsh-plugins/multi-user-auth design I drafted (real per-user accounts + a sessionId → userId ownership table) is already more rigorous than Cabinet's own model. Given that, we will drop the multi-user-auth plugin from the plan entirely and simplify the web-terminal's auth story to a single optional shared-secret (matching a single-operator deployment, not accounts).

Report: Web-terminal and Multi-user Auth Plugin Feasibility (dsh-plugins/)
1. dsh-plugins/imchat integration pattern
It runs in-process as a Cordis plugin, with no listener of its own. dsh-plugins/imchat/README.md:

"Runs in-process as a Cordis plugin — not an external client talking to the host over RPC — so it drives sessions directly via ctx.agents and answers approval/question prompts via ctx.approval/ctx.userQuestions."
"A public inbound webhook/HTTPS endpoint — all three v1 adapters use pull-based transports … specifically so this plugin needs no exposed port or reverse proxy." (README "Non-goals")

docs/adr/rp_dshPlugin_imChat.md:113-128 (Decision 1) is explicit about the two available integration shapes:

"DSH plugins are Cordis plugins loaded into the host … A chat bridge is a 'surface' … it listens to ctx.on('session/event', ...) and drives sessions via ctx.agents. This means dsh-imchat never spawns or manages a dsh process … and never goes through the external HTTP/WebSocket RPC surface (session.create/session.prompt … approvals over POST /api/respond) that exists for genuinely external clients like a web UI or VS Code extension."

dsh-plugins/imchat/src/index.ts:71,144-153 shows the actual seams used: apply(ctx, config), ctx.credentials.resolve(...), ctx.agents, ctx.userQuestions.registerProvider(...), ctx.on('approval/request', ...). imchat deliberately avoids opening its own socket by using pull-based adapters (long polling, Socket Mode). It does not prove that a plugin can't open its own listener — it just didn't need one.

2. packages/terminal PTY seam
ctx.terminals (TerminalSessionService, packages/terminal/terminal/src/index.ts:105) is a generic, owner-scoped registry — not tool-only — but every method takes an explicit owner: Agent argument, and access is fenced to the exact live agent:

spawn(owner: Agent, request, signal?) (types.ts:154, "exact registered Agent that owns access and cleanup")
startSend(owner, id, request), read(owner, id, request), signal(owner, id, signal), kill(owner, id, reason), list(owner) — all take owner: Agent first (index.ts:243-308)
ensureOwnerCleanup throws OWNER_NOT_LIVE unless ctx.get('agents')?.get(owner.id) === owner (index.ts:318-326)
README (packages/terminal/terminal/README.md): "fences every operation to the exact live Agent" and explicitly: "Cross-agent sharing is intentionally absent; a future shared-session design needs a separate authority contract."

So: any plugin can call ctx.terminals directly (it's an ordinary injected service, e.g. terminal-bash/src/index.ts:25 does inject = ['terminals', 'sandboxPolicy', 'subprocess']), but it must supply a live Agent it owns as the session's principal — there is no bare "give me a shell" call independent of an Agent. A web-terminal plugin would need to mint/hold its own Agent (e.g., via ctx.agents.create(...)) to act as PTY owner, then stream that session's send/read/signal over its own transport. Backend registration itself (terminal-bash/src/index.ts:150-153, ctx.terminals.registerBackend(...)) is the pattern for adding a new backend type, not needed here since terminal-bash already provides shell.

3. Network extension point: ctx.webServer — found, and it's plugin-usable
packages/host/webserver/README.md describes WebServer (default export, ctx.webServer): register(route) (HTTP exact/prefix), registerUpgrade(route) (WS upgrade by exact pathname), registerFallback(handler). This is a generic, composition-level extension point, independent of apps/web's own code.

Proof it's already used by a dsh-plugin exactly the way you'd need: dsh-plugins/browser-bridge/src/index.ts:61,169,184:


export const inject = ['webServer', 'apiProxy', 'tools']
...
ctx.effect(() => ctx.webServer.registerUpgrade(route), 'browser-bridge: /ext/bridge upgrade route')
...
ctx.effect(() => ctx.webServer.register(configRoute), 'browser-bridge: /ext/bridge-config route')
This is the pattern for a web-terminal plugin's own websocket surface, added purely via cordis.yml composition — no edits to apps/web/apps/cli/packages/.

Regarding packages/api/gateway and packages/sdk: these are not generic plugin-registration points. dsh-api-gateway's ctx.typertGateway dispatches strictly to pre-declared, code-generated @Remote-decorated business Services (README: "generated invocation descriptors," "strict generation"); it's for extending in-repo RPC methods, not a third-party plugin registering arbitrary endpoints. dsh-sdk-jsonrpc-server is a stdio JSON-RPC transport for out-of-process SDK clients, unrelated to an in-browser terminal UI. Neither offers a "register my own route/method" seam for external plugins — ctx.webServer is that seam.

No explicit doc says "plugins may/may not start their own http.Server" — but given ctx.webServer exists and is used exactly this way by browser-bridge, a new plugin should reuse it rather than binding a second port (matches host/webserver's own note: "Socket options are fixed … until a deployment needs them" — implying one canonical server per host process is the intended shape). Note the webserver README's explicit gap: "No TLS, auth, or origin policy … is deliberately out of scope." — any auth-gating for a web-terminal plugin's route must be implemented by the plugin itself.

4. packages/identity / packages/credentials — no multi-user concept
packages/identity/README.md: "Identity values shared across product domains. These values do not represent an authenticated account." The only package (anonymous-user-id) is a single per-$DSH_HOME random UUID for telemetry (getOrCreateAnonymousUserId()), "is never derived from... another identifying source," and is "not a Cordis plugin" — just a shared library function.

packages/credentials/credentials/README.md: ctx.credentials is reference→secret resolution (resolve/describe/set/unset) with providers layering env vars and $DSH_HOME/.credentials.yaml — no notion of "which user" owns a credential or a session.

SessionHeader (packages/core/session/src/types.ts:61-81) has version, id, createdAt, cwd, parentSession, seedLength — no owner/principal/account field. Session is fully unauthenticated today.

Conclusion: no existing "session owner"/"principal" field anywhere. A multi-user auth plugin needs entirely new state: user accounts, session-ownership mapping (e.g., its own sessionId → userId store, à la imchat's StateStore pattern in dsh-plugins/imchat/src/core/state-store.ts), and enforcement hooked at whatever boundary requests enter — most naturally at the plugin's own ctx.webServer.register/registerUpgrade route/middleware (since that's the one point unauthenticated requests cross into the process) plus gating ctx.agents.create/ctx.terminals.spawn calls it makes on a caller's behalf. No core package currently enforces or even records who owns a Session or an Agent.


DSH Capability Families — ctx Contract Report
1. packages/schedule/schedule — ctx key: none (no ctx.schedule)
Schedule registers no public service. It's a self-contained function plugin (packages/schedule/schedule/src/index.ts:33-77) that, on each agent/created event for a root agent, builds a private ScheduleRuntime and registers three model-facing tools (schedule_create/list/delete) directly onto that agent's own agent.ctx (registerScheduleTools, tools.ts). There is no exported registry, listener hook, or "create a reminder programmatically" API for another plugin to call.

Composable surface for another plugin: only the durable session event log. Schedule declares 'schedule/change': ScheduleChange in the merge-extensible SessionEventMap (types.ts:213-221). A downstream plugin can listen to the generic session/event firehose (ctx.on('session/event', (session, event) => ...), defined in packages/core/session/src/index.ts:76) and filter event.type === 'schedule/change' to observe create/delete/dispatch — read-only observation, not an API to invoke.
To create a reminder programmatically you would have to append a schedule/change "create" event to agent.session yourself using the exported pure helpers (createAfterScheduleRecord, createAtScheduleRecord, createEveryScheduleRecord, allocateScheduleId — all exported from index.ts:14-29) — but Schedule's own ScheduleRuntime (armed via registerScheduleTools's runtime.requestDrive() callback) is the only thing watching for it on that exact agent instance, and it's not exposed for reuse.
Delivery is strictly same-session wake, never a new agent/session. runtime.ts:271-275: on due reminder it calls this.agent.followup(message) — i.e. Agent.followup(), which opens a later turn on the same agent's inbox. Nothing in this package calls ctx.agents.create()/resume(). README explicitly states: "The follow-up opens a normal later turn after the Agent becomes fully idle; it never steers or interrupts the current conversation" and "Session-local delivery only — a reminder runs on time only while its original Session is live" (README.md:43,111).
Guardrail-ish note: "Load-order boundary — the plugin does not scan or adopt Agents that were already live when it loaded" and reminders never leave the owning session (deliveryMode: 'session-local', fixed).
Implication for a plugin author: you cannot compose with Schedule via a ctx service. You can only (a) observe schedule/change events on sessions you already have a handle to, or (b) reimplement your own timer logic against ctx.sessions/ctx.agents/Agent.followup() directly, following the same pattern (own tools, own event type, own runtime timer) rather than calling into dsh-schedule.

2. packages/preset — ctx key: ctx.agentPresets (AgentPresets, packages/preset/agent-presets/src/index.ts:82)
Key methods (all on ctx.agentPresets, README.md:13-26 + index.ts):


defaultId: string
list(): Promise<AgentPreset[]>
resolve(id?): Promise<AgentPreset>
mount(agentCtx: Context, id?): Promise<AgentPreset>          // index.ts:275
composeFrom(agentCtx: Context, parentCtx: Context): string | undefined  // index.ts:316
composedPreset(agentCtx: Context): string | undefined        // index.ts:336
recompose(agentCtx: Context, id: string): Promise<AgentPreset> // index.ts:458
standingKeyFor(id?): Promise<ScopeKey>                        // index.ts:485
roots, authorable, read(id), copy(from, id, name?), remove(id)
mount(agentCtx, id?) is the "mount a preset onto a new session" call, but with a hard guardrail: "The agent factory's setup(agentCtx) hook is the one supported call site" (README.md:29-31). It must run while the agent is still unpublished (before agent/created/session/created), because a rejected mount must roll the whole agent creation back. It's not meant to be called against an already-running/published agent.
composeFrom(agentCtx, parentCtx) is the synchronous bind used for child agents (subagents) to inherit a parent's already-mounted composition — this is what dsh-subagent's in-process drivers use inside their own synchronous child-creation setup().
recompose(agentCtx, id) re-links a blank (nothing-produced-yet) agent to a different standing composition — explicitly caller-must-verify-blank ("the caller owns that check").
Guardrail: "Mounting into a context that carries no agent scope would register the preset's tools globally, for every agent in the process" — mount()/composeFrom() throw on an unscoped agentCtx (mount.ts:333-339).
Guardrail: a preset that publishes a process-global (non-isolate) service is rejected at mount (mount.ts:361-367, README "What a mount rejects").
Roster directory (apps/cli/config/agent-presets/): entries are code/, cordis/, minimal/, standard/ — each a directory containing agent.cordis.yml (the plugin-row composition) and an optional preset.yml (display name/description only). Example, minimal/agent.cordis.yml (18 lines): a top-level YAML list of Cordis plugin rows — persona (fixed system prompt, complete: true), then two cordis:group rows with isolate: { terminals: true } / { fs: true } realms wrapping dsh-terminal, dsh-tool-bash-persistent, dsh-fs-local, dsh-tool-str-replace-editor.

For a new plugin composing with presets: since you must not touch apps/, you cannot add a new roster entry there, but you can author a new preset under the writable user root via ctx.agentPresets.copy(from, id, name) (the only authoring write) from a dsh-plugins/ package, or reference presets purely by id when calling mount()/composeFrom() if your plugin itself is an agent factory / subagent provider.

3. packages/subagent — ctx key: ctx.subagents (SubagentRuntime, packages/subagent/subagent/README.md)
Key operations (README.md:14-26):


registerProvider(provider) / getProvider(name) / list()
start(name, request): Promise<SubagentRun>              // one-shot, foreground, caller-owned after fulfillment
startContinuable(spec): Promise<{ childId, messageId }>  // durable, background, standing child
followup(parent, childId, content, opts): Promise<MessageId>  // parent -> child, FIFO next turn
interrupt(targetSessionId, authority): Promise<void>     // stop current turn only, keepInbox
reportFrom(child, content, opts): Promise<MessageId>     // child -> parent
registerContinuableSetup(contribution)
drainContinuableDescendants(parents)
listChildren(parentSessionId, signal?)
listDescendants(rootSessionId, signal?)
Yes, it can start a genuinely new agent session — startContinuable() creates a durable, independently-addressable child Agent/Session via the continuation manager, which internally calls ctx.agents.create()/ctx.agents.resume() (README.md:77). This is the mechanism for "start new agent sessions (personas) on a timer" — a scheduling plugin in dsh-plugins/ would call ctx.subagents.startContinuable(spec) from its own timer, not ctx.agents.create() directly (subagent already fixes up preset composition, delegation depth, sandbox policy inheritance for you).
followup()/interrupt() are parent-only authority-gated: "Follow-up authority comes from the exact live direct parent recorded in the child's durable header" (README.md:30). interrupt() accepts a wider "any live ancestor" authority. Neither is usable by an unrelated third-party agent — this is the gap your "team channel" plugin would need to bridge.
Cross-agent (non-parent/child) messaging does not exist in this family. The only channels are parent→child (followup) and child→direct-parent (reportFrom/report tool). Nothing lets sibling or unrelated agents post/read a shared channel — confirmed by "Known Limitations": "No durable report mailbox — reports require a live direct parent" and "No host-user continuation — followup() requires the exact live direct parent." This is exactly why your "team channel" plugin (independent agents posting to a board others can read) is a genuinely new capability, not composable purely from ctx.subagents — you'd build it as a separate dsh-plugins/ service (e.g. a shared in-memory/durable board keyed by agent id, with its own tools) that agents opt into via their own preset's tool list, using ctx.subagents.listDescendants()/listChildren() only for discovery/enumeration, not delivery.
Guardrail: "Continuable creation is the optional SubagentProvider.prepareContinuable?() method... the continuation manager owns identity reservation, composition, Agent creation, prompt delivery, cold resume, ownership, and disposal after preparation" — i.e. do not try to drive continuable children by any path except ctx.subagents.
packages/subagent/tool-subagent-control (README.md) wraps send_message/interrupt_agent/list_agents as model-facing tools over the exact same ctx.subagents calls — useful as a reference implementation pattern for your own control tools, but it is tool-layer, not a separate service contract.
4. packages/core/session (ctx.sessions) / packages/core/agent (ctx.agents)
ctx.sessions = SessionStore (packages/core/session/src/index.ts:792):


create(id?, options?: CreateSessionOptions): Session       // :830
prepare(id?, options?): Session                            // low-level, not yet in store — :863
enter(session): () => void                                 // :913
announce(session): void                                    // :968
fork(source, boundary?, childSessionId?): Session           // :1081
get(id) / list() / flush(session): Promise<boolean>
ctx.agents = AgentRegistry (packages/core/agent/src/index.ts:256):


create(options: CreateAgentOptions): Promise<AgentHandle>   // :405
resume(options: ResumeAgentOptions): Promise<AgentHandle>    // :424
register(agent): () => void
get(id) / list() / roots() / isOwnedBy(id, owner)
withInitiator(agent, op) / withoutInitiator(op) / currentInitiator()
ctx.agents.create() is the actual "start an independent standing agent" primitive — it requires an AgentFactory registered (by dsh-agent-loop), takes sessionId, optional meta (cwd, parentSession, seedLength, origin, delegationDepth, agentPreset), optional seed, agentOptions, and a setup(agentCtx) hook to compose the agent's scoped world (tools, presets) before publication. This is documented and public — not internal-only.
Guardrail on ctx.sessions.create(): doc comment explicitly warns: "For an agent whose session must be torn down IN ORDER with its loop... do NOT use this — fold the session lifecycle into the agent's own effect via prepare + enter + announce" (index.ts:817-821). So a plugin wanting a fresh agent, not just a bare session record, should go through ctx.agents.create() (which internally handles session lifecycle ordering), not call ctx.sessions.create() directly and separately try to attach a driver.
ctx.agents.create() has no notion of "which persona/preset" by itself — that's supplied via the setup(agentCtx) callback calling ctx.agentPresets.mount(agentCtx, presetId), exactly the seam dsh-subagent's providers use. This is the composable path for your standalone "start standing agents on a timer" plugin: call ctx.agents.create({ sessionId, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) } }) directly (skipping ctx.subagents entirely if you don't need parent/child delegation semantics — e.g. for independent standing personas with no parent authority relationship), or go through ctx.subagents.startContinuable() if you do want the parent-child authority/messaging/settlement machinery for free.
No explicit "plugin authors should not call this directly" language on ctx.agents.create/resume themselves — they're the intended public factory surface. The strongest warning is the ctx.sessions.create() ordering caveat above, and the setup contract note: "Setup composes, it never drives: the callback is trusted same-process code... Drive the agent only after creation resolves."


# Plan: Mimic Cabinet's remaining features via new dsh-plugins/ packages + MCP config — zero core changes

## Context

`docs/CompareCabinet.md` mapped Cabinet's feature set onto DSH and sorted the
gaps into two buckets: things needing deep `ctx.sessions`/`ctx.agents`
access (new plugins) and things that are really external-service problems
(MCP config, no new plugin code). The user wants a concrete build plan for
both buckets, under one hard constraint: **do not modify anything under
`packages/` or `apps/`** — every new capability must be a standalone package
under `dsh-plugins/`, composed purely through the public `ctx` contracts
those packages already export, following the existing convention there
(`imchat`, `flight-search`, `skillhub`, `vision-bridge` — independent
npm packages, no `workspace:^`, reviewed like third-party plugins).

**Scope clarified during planning:** DSH remains single-user by design —
unlike Cabinet, which targets a self-hosted instance for a whole company.
The Cabinet-style personas this plan enables (Chief of Staff, CFO,
Marketing, ...) are virtual roles the *one* DSH user's own agents wear over
that same user's own data, not separate company employees who need to be
kept isolated from each other's information. Notably, Cabinet itself has no
real per-user data isolation either — its docs describe a single shared
`KB_PASSWORD` gate for the whole instance, no accounts, no roles, no
per-document scoping — so this plan isn't giving up a security property
Cabinet actually has. A multi-user-accounts plugin was considered and is
explicitly descoped (see the note under the plugin bucket below).

Two research passes (`Explore` agents) confirmed the exact seams available:

- `ctx.agents.create({ sessionId, setup(agentCtx) { ... } })` is the public
  primitive for spinning up a genuinely new, independent agent session —
  `setup` is where `ctx.agentPresets.mount(agentCtx, presetId)` attaches a
  persona (`packages/core/agent/src/index.ts:405`, `packages/preset`).
- `ctx.subagents.startContinuable(spec)` wraps that same primitive with
  parent/child authority, messaging, and disposal machinery for free —
  useful when a launched persona should be delegation-tracked; skippable for
  fully independent standing personas.
- `dsh-schedule` (`packages/schedule/schedule`) registers **no service** —
  it's a private, same-session-only reminder engine (`Agent.followup()` on
  its own agent, never a new session). Its durability *pattern* (event-log
  replay, restart-safe timers) is worth copying; its code is not reusable.
- `ctx.webServer` (`packages/host/webserver`, exposed as `WebServer`) is a
  real, already-used-by-a-plugin extension point:
  `dsh-plugins/browser-bridge` registers its own HTTP route and its own
  WebSocket upgrade route this way with zero core edits. This is the seam
  for any new plugin that needs its own network surface.
- `ctx.terminals` (`packages/terminal/terminal`) is a generic PTY registry
  any plugin can call — but every method requires a live `Agent` as
  `owner`; there is no ownerless "give me a shell."
- There is **no session-owner/principal concept anywhere in core** —
  `SessionHeader` has no owner field, `packages/identity` is anonymous
  telemetry only, `packages/credentials` is secret-reference resolution
  only.
- **Scope decision (confirmed with user):** DSH stays single-user by
  design. The Cabinet-style personas (Chief of Staff, CFO, Marketing, ...)
  are virtual roles the one DSH user's own agents wear over that same
  user's own data — not separate company employees who need to be kept out
  of each other's information. Cabinet's own docs confirm it has no real
  per-user data isolation either (a single shared `KB_PASSWORD` gate for
  the whole instance, no accounts, no roles, no per-document scoping — see
  the "Multi-user auth — descoped" note below). So there is no
  confidential-data-isolation problem to solve here, and no multi-user
  accounts plugin to build.
- `packages/mcp/mcp-client` is a first-class, already-shipping plugin:
  point it at any MCP server via `cordis.yml`, tools appear as
  `mcp__<serverName>__<tool>`. This is the entire mechanism for the two
  MCP-bucket gaps — no new plugin code, just configuration.

## Plugin bucket

### 1. `dsh-plugins/persona-scheduler` — cron → new persona runs

**Problem it closes:** Cabinet's cron daemon launches distinct, independently-scheduled persona runs. `dsh-schedule` only wakes its own already-running session; it cannot start a new one.

**Design:**
- Own durable roster store (JSONL or SQLite under the plugin's own state dir, same shape as `imchat`'s `StateStore` pattern) of workers: `{ workerId, presetId, schedule (cron | every_seconds), seedPrompt, nextFireAt }`.
- Own timer runtime modeled on `dsh-schedule`'s durability lessons (recompute `nextFireAt` from wall clock on every wake so a rollback can't fire early and a forward jump doesn't replay missed ticks; never enumerate missed occurrences).
- On fire: `ctx.agents.create({ sessionId: newId, meta: { origin: 'persona-scheduler', agentPreset: presetId }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, presetId) } })`, then send `seedPrompt` as the agent's opening turn. This is a **brand-new, independent session per fire** — the Cabinet-shaped behavior — not a followup.
- If a launched persona should report results anywhere discoverable, register it through `ctx.subagents` as a continuable child of a lightweight "scheduler root" agent instead of a bare `ctx.agents.create()` — gives free listing (`listDescendants`) and disposal; still no core changes, `ctx.subagents` is a public service.
- Optional admin tools (`persona_worker_create/list/remove`), mirroring `dsh-schedule/src/tools.ts`'s shape, registered only on whichever preset is designated "admin" (e.g. the interactive CLI persona) via that preset's own `agent.cordis.yml` — not the shipped roster in `apps/cli/config` (see MCP-bucket note on preset authoring below for how to add presets without touching that directory).
- `inject = ['agents', 'agentPresets', 'subagents']` — all public, all outside `packages/`'s private surfaces.

### 2. `dsh-plugins/team-channel` — shared board independent agents post to

**Problem it closes:** `ctx.subagents` only has parent→child (`followup`) and child→direct-parent (`reportFrom`) channels — confirmed no sibling/unrelated-agent channel exists ("Known Limitations: no durable report mailbox … requires a live direct parent"). Cabinet's personas post to shared channels any teammate can read.

**Design:**
- New durable store, SQLite-backed (not JSONL) — the Schedule/Session JSONL-append model assumes one writer per session; team-channel needs **concurrent writers across independent agent processes**, so SQLite (same DB library `session-persistence-sqlite` already uses, for licensing/API consistency) is the safer default.
- Tools: `team_channel_post(channel, message)`, `team_channel_read(channel, sinceId?)`, `team_channel_list()` — registered on `ctx.tools` per-preset (opt-in via each persona's `agent.cordis.yml`, matching DSH's per-session tool composition philosophy).
- Optional push: if a live agent has a channel "watched," on new post call `ctx.agents.get(agentId)?.followup(message)` directly — this is the same public primitive `dsh-schedule` itself uses internally, just invoked from our own plugin rather than through their package.
- No dependency on `ctx.subagents` for delivery; only use `listChildren`/`listDescendants` for optional discovery UI (e.g. "which known agents exist").

### 3. `dsh-plugins/web-terminal` — browser-facing raw PTY

**Problem it closes:** `packages/terminal` already provides persistent PTY sessions as a capability, but only to the model as a tool; there's no human-facing terminal tab like Cabinet's xterm.js/PTY UI, and `apps/web` is off-limits to edit.

**Design (proven pattern — `dsh-plugins/browser-bridge` does exactly this already):**
- `inject = ['webServer', 'terminals', 'agents']`.
- `ctx.effect(() => ctx.webServer.registerUpgrade({ pathname: '/ext/terminal', ... }), ...)` for the WS transport, plus `ctx.webServer.register(...)` to serve a small static xterm.js bundle — both zero-core-edit, same seam `browser-bridge` uses for `/ext/bridge`.
- Per browser session: mint a dedicated owner `Agent` via `ctx.agents.create(...)` (needed because `ctx.terminals.spawn(owner, request)` requires a live `Agent` owner — no ownerless PTY exists), spawn the PTY through `ctx.terminals.spawn`, bridge `startSend`/`read`/`signal` over the socket.
- Teardown on socket close: `ctx.terminals.kill(owner, id, reason)` then dispose the owner agent — avoid leaking `AgentRegistry` entries.
- Auth: single-operator only, matching the confirmed single-user scope — an optional static shared-secret token (env var, checked inline at the upgrade route) if this is ever exposed off `localhost`. No accounts, no per-user gating — there is exactly one principal (the DSH user), same as the rest of the harness.

### Multi-user auth — descoped

Originally scoped as a fourth plugin (accounts + `sessionId → userId` ownership mapping), this is now explicitly **out of scope**. Confirmed with the user: DSH stays single-user by design; Cabinet-style personas are virtual roles one user's agents wear over that same user's own data, not separate company employees needing isolation from each other. Worth noting Cabinet itself has no real per-user data isolation either — its docs describe a single shared `KB_PASSWORD` gate for the whole instance (PBKDF2-HMAC-SHA256, per-install salt, rate-limited login), with no accounts, roles, or per-document scoping anywhere in its documentation. So a "HR persona can see salary data, CFO persona can't see it" boundary isn't something Cabinet enforces today either — it would be a persona-prompt convention at best in either system, not a security boundary this plan needs to build.

## MCP bucket — no new plugin code, only configuration

### 5. Markdown+Git knowledge base

Use `packages/mcp/mcp-client` (already ships in DSH) pointed at an existing
open-source markdown-vault MCP server rather than building a vault into
DSH:

- **[library-mcp](https://github.com/lethain/library-mcp)** — MCP server operating directly on a markdown knowledge base; closest fit, minimal, git-friendly (just a directory of `.md` files you `git commit` yourself).
- **[NoteDiscovery](https://www.notediscovery.com/)** — richer option if wikilinks/graph view matter (closer to the Tolaria-style vault named in `docs/CompareTools.md`).

Config shape (per existing `mcp-client` README): a `cordis.yml` row with
`transport: stdio`, `command` pointing at the chosen server, working
directory = the git repo of notes. Attach it to whichever persona(s) should
have vault access.

### 6. Kanban / mission board

Same mechanism, pointed at an existing self-hosted board:

- **[Doska](https://doska.sh/)** — best fit: every card is a Markdown file, self-hosted, boards sync through a server you host, and it already exposes an MCP surface for agents to create/edit/move cards. Closest match to Cabinet's mission/Kanban metaphor and to the git-backed-markdown ethos this repo already favors.
- **[Kanban MCP](https://github.com/multidimensionalcats/kanban-mcp)** — alternative if richer PM semantics (epics, relationships, semantic search, 40+ tools) matter more than the markdown-card format.
- Already-available-but-unauthenticated fallback: this environment lists `claude.ai` Linear/Asana/monday.com MCP connectors — if the team already lives in one of those, authorizing the existing connector is strictly less work than deploying Doska/Kanban MCP.

### Preset-authoring note (applies to both MCP rows and to #1/#2's admin tools)

`packages/preset`'s `agent-presets` README describes discovery over "trusted
and user-authored roots," not just the shipped roster at
`apps/cli/config/agent-presets/` (which is off-limits to edit). New
MCP-enabled or plugin-tool-enabled personas should be authored as **new
preset directories under that user-authored root** (exact path to confirm
from the `agent-presets` README at build time — do not add or edit anything
under `apps/cli/config`), or created at runtime via `ctx.agentPresets.copy(from, id, name)`
into the writable root. Either path keeps every change outside `packages/`
and `apps/`.

## Build order

1. `persona-scheduler` and `team-channel` are independent of each other and of #3 — build in parallel.
2. `web-terminal` next (straightforward given the `browser-bridge` precedent to copy from); ships with the optional shared-secret gate, no accounts.
3. MCP rows (#5, #6) are configuration, not code — can happen anytime, independently, including before the plugins above exist.

## Verification

- Each new plugin: standalone `package.json`, own `pnpm test` (vitest, matching `dsh-plugins/imchat`'s existing test setup) — no `workspace:^`, no changes to root `pnpm-workspace.yaml`.
- `persona-scheduler`: integration test that creates a worker with a short interval, asserts a **new** `Session`/`Agent` id appears in `ctx.agents.list()` on fire (not a followup on an existing one) and that a process restart doesn't double-fire or drop the next occurrence.
- `team-channel`: two independently-created agents (no parent/child relation) can post/read the same channel; confirm SQLite handles concurrent writers without corruption under a small concurrent-post test.
- `web-terminal`: manual check — load the served page, confirm a live shell prompt over the WS route, confirm `ctx.terminals.list(owner)` empties and the owner agent disposes after socket close; confirm the optional shared-secret gate rejects a request with no/wrong token when configured.
- MCP rows: `pnpm dsh --profile headless "list notes in the vault"` / "create a card on the mission board" against a preset with the new `mcp-client` row mounted, confirm `mcp__<serverName>__*` tools appear and round-trip.
