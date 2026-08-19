# dsh-plugin-persona-scheduler

Launches brand-new, independently-scheduled persona agent sessions —
Cabinet-style standing personas (Chief of Staff, CFO, Marketing, ...) that
run on their own timer — for one DeepSeek Harness user's own data. Part of
the plan in `docs/CompareCabinet.md` to close DSH's gaps against
[cabinetai/cabinet](https://github.com/cabinetai/cabinet) without touching
`packages/` or `apps/`.

## Why this exists, and why it isn't `dsh-schedule`

`@deepseek-ai/dsh-schedule` already gives an agent durable reminders, but it
is deliberately **same-session-only**: a due reminder calls `Agent.followup()`
on the exact agent that created it — it can never start a new session. That's
the right contract for "remind me later in this conversation," but it's not
what Cabinet's cron daemon does: Cabinet's personas each get a genuinely new
run when their schedule fires.

This plugin closes that specific gap using only public seams:

- `ctx.agents.create({ sessionId, setup(agentCtx) { ... } })` — the public
  primitive for a brand-new, independent agent session
  (`packages/core/agent/src/index.ts`).
- `ctx.agentPresets.mount(agentCtx, presetId)` inside that `setup` hook —
  attaches the persona (`packages/preset/agent-presets`).
- `handle.agent.followup(message)` — delivers the worker's seed prompt as
  the new session's opening turn, the same primitive `dsh-schedule` itself
  uses internally, just invoked on a session we just created rather than an
  existing one.

No core package is modified. This plugin is a standalone npm package with
its own tests, reviewed the way any third-party DSH plugin would be — same
convention as `dsh-plugins/imchat`.

## What it is not

Not a multi-tenant scheduler. DSH stays single-user by design (see
`docs/CompareCabinet.md`'s scope note); every persona this plugin launches
acts as a virtual role for the *one* DSH user, over that same user's own
data — not a separate company employee needing isolation from anyone else.
There is no accounts/ownership layer here, deliberately.

Not full cron syntax. v1 supports the same three selectors
`dsh-schedule` proves out: a one-shot relative delay (`afterSeconds`), a
one-shot absolute epoch-ms target (`at`), or a fixed-rate interval
(`everySeconds`, minimum 300s). A fixed-rate worker is creation-anchored and
skips missed occurrences rather than enumerating them if the process was
down — the same durability lesson `dsh-schedule`'s README documents.

## Composition

```yaml
- id: persona-scheduler
  name: dsh-plugin-persona-scheduler
  config:
    stateFile: .dsh-persona-scheduler/workers.json
```

Load after `ctx.agents`, `ctx.agentPresets`, and `ctx.tools`. Include this
plugin's row only in the preset(s) that should have admin control over the
roster (`persona_worker_create`/`list`/`remove`) — the plugin's presence in
a preset's `agent.cordis.yml` **is** the opt-in, the same composition-based
mechanism every other DSH capability uses. A launched persona's own preset
does not need this row at all.

## Authoring new personas without touching `apps/cli/config`

`agent-presets` discovers presets over "trusted and user-authored roots,"
not only the shipped roster. Author a new persona (e.g. `cfo`, `marketing`,
`chief-of-staff`) as a new preset directory under the writable user root
(`<dshHome>/.agent-presets` by default — see
`packages/preset/agent-presets/README.md`), or create one at runtime via
`ctx.agentPresets.copy(from, id, name)`. Either path keeps every change
outside `packages/` and `apps/cli/config/agent-presets`.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `persona_worker_create` | Schedule a new worker: `preset_id`, `seed_prompt`, and exactly one of `after_seconds`, `at`, `every_seconds`. |
| `persona_worker_list` | List every worker currently scheduled by this plugin instance. |
| `persona_worker_remove` | Remove a worker by id. |

## Durable state

One JSON file (`config.stateFile`), atomic temp-file-then-rename writes,
`0o600`/`0o700` permissions, a serialized write queue so concurrent tool
calls can't interleave two writes — the same shape as `dsh-plugin-imchat`'s
`StateStore`. Restart-safe: on load, the runtime re-arms its timer against
whatever the roster already holds on disk; a worker's `nextFireAt` is
recomputed from the wall clock on every wake, so a system-clock rollback
can't fire early and a forward jump can't replay missed ticks.

## Testing

```sh
cd dsh-plugins/persona-scheduler
pnpm install
pnpm test
```

`tests/domain.test.ts` and `tests/store.test.ts` cover the pure validation
logic and the durable store in isolation. `tests/runtime.test.ts` uses a
narrow structural fake for `ctx.agents`/`ctx.agentPresets` (fake timers via
`vitest`) to assert: a one-shot worker launches exactly one new agent
session and is then removed; a fixed-rate worker reschedules rather than
being removed, and does not double-fire; and a fresh runtime instance
re-arms correctly against an already-persisted roster (the restart case).
