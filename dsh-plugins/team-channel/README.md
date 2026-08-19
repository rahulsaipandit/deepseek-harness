# dsh-plugin-team-channel

Shared post/read channels between independently-launched persona agents —
Cabinet-style team channels (a Marketing persona posting where a CFO
persona can read it, and vice versa) — for DeepSeek Harness. Part of the
plan in `docs/CompareCabinet.md` / `docs/designCabinetButForSingleUser.md`
to close DSH's gaps against [cabinetai/cabinet](https://github.com/cabinetai/cabinet)
without touching `packages/` or `apps/`.

## Why this exists

`ctx.subagents` (`@deepseek-ai/dsh-subagent`) only has two channels:
parent→child (`followup`) and child→direct-parent (`reportFrom`). Its own
"Known Limitations" confirm there is no durable report mailbox and no
channel between siblings or otherwise-unrelated agents. That's fine for
delegation, but Cabinet's personas aren't parent/child of each other — each
one is its own independent standing session (see
`dsh-plugin-persona-scheduler`), and they still need to post where a
teammate can read it.

This plugin is that shared board, composed purely through public seams:

- `ctx.tools` — `team_channel_post`/`read`/`list`/`watch`/`unwatch`,
  registered per live root agent.
- `Agent.followup(message)` — the optional push path: a watching agent gets
  a follow-up turn on a new post, the same public primitive `dsh-schedule`
  itself uses internally, just invoked from outside their package.

No core package is modified.

## What it is not

Not a security boundary. Per the single-user scope decision in
`docs/designCabinetButForSingleUser.md`, every persona reading or posting to
a channel acts on behalf of the *same* one DSH user — there's no "HR
channel CFO can't read" isolation to enforce here, matching (not falling
short of) Cabinet's own model, which has no per-channel access control
either.

Not a message queue with delivery guarantees. `watch`/`unwatch` are
in-memory and live-agent-only — they reset on restart, same as
`ctx.terminals`' owner fencing. Every message is still durably readable via
`team_channel_read` regardless of watch state; watching only adds the
push-on-post convenience.

## Composition

```yaml
- id: team-channel
  name: dsh-plugin-team-channel
  config:
    dbFile: .dsh-team-channel/messages.sqlite
```

Load after `ctx.agents` and `ctx.tools`. Include this plugin's row in every
preset whose persona should be able to talk to teammates — the plugin's
presence in a preset's `agent.cordis.yml` **is** the opt-in.

## Durable state

One SQLite database (`config.dbFile`, `node:sqlite`'s `DatabaseSync` — the
same library `@deepseek-ai/dsh-session-persistence-sqlite` already uses),
WAL journal mode plus a 5s busy timeout so concurrent writers across
independent agent processes don't collide. `DatabaseSync` is synchronous
end to end, so there is no JS-side write queue to get wrong, unlike the
JSONL pattern `dsh-plugin-persona-scheduler` and `dsh-plugin-imchat` use for
their own single-writer state.

## Model-facing tools

| Tool | Purpose |
|---|---|
| `team_channel_post` | Post a message to a channel; pushes to any live watcher via `followup`. |
| `team_channel_read` | Read a channel's messages in post order, optionally only those after `since_id`. |
| `team_channel_list` | List every channel with at least one message. |
| `team_channel_watch` | Start receiving a follow-up turn on new posts to a channel (live-only). |
| `team_channel_unwatch` | Stop receiving those follow-ups. |

## Testing

```sh
cd dsh-plugins/team-channel
pnpm install
pnpm test
```

`tests/domain.test.ts` covers channel-name/body validation.
`tests/store.test.ts` exercises the SQLite store directly, including two
separate `TeamChannelStore` instances (one process would use one, but the
schema/WAL setup is what matters) posting concurrently to the same channel
without corruption. `tests/tools.test.ts` and `tests/watchers.test.ts` cover
the tool layer and the in-memory watch registry, including that two
agents with **no** parent/child relationship can post/read the same
channel, and that disposing an agent drops its watches.
