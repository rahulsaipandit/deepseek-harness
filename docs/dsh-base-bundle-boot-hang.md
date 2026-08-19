# Investigation: bare `dsh-base` bundle "hangs" on boot

Status: **root cause corrected.** An earlier version of this doc blamed
`@deepseek-ai/dsh-goal` and a missing `sessionProjections` service. That
diagnosis was wrong — see "Retraction" below. The real explanation is
architectural, not a bug: a profile whose only bundle is `dsh-base` has no
run-mode entrypoint plugin at all, so it boots successfully and then
legitimately sits idle. The fix (add an overlay bundle) is unchanged, but
why it works is different from what was previously written here.

## Symptom

A DSH profile created via the documented plugin-install workflow —

```sh
pnpm dsh plugin --profile <name> add <path-or-package>
pnpm dsh --profile <name> --help
```

— appears to hang indefinitely: no output, no error, no crash. `tasklist`/
`/proc/<pid>/stat` show the process alive with a stable, non-growing memory
footprint. `--dump-config` (composes the config tree without instantiating
any plugin) works fine and instantly; only a real boot instantiates the
Cordis `Fiber` tree and reaches this state.

## Root cause

**A profile whose `dsh.profile.bundles` is `["@deepseek-ai/dsh-base"]`
alone has no plugin that parses `--help` or a task argument, or does
anything else with them.** Confirmed directly:

```sh
$ grep -n "headless-startup" packages/bundle/headless/cordis.patch.yml
27:    - id: headless-startup
28:      name: '@deepseek-ai/dsh-headless/startup'

$ grep -n "startup\|entrypoint" packages/bundle/base/cordis.patch.yml
(no matches)
```

`packages/bundle/headless/src/startup.ts` is the plugin that owns `--help`:
it builds a Commander `Command`, calls `.helpOption('-h, --help', ...)`, and
only this plugin's `apply()` ever runs `parseCmdline(ctx, program)` against
the process's argv. It exists **only** in the `dsh-headless` bundle (and
`dsh-web-app` carries its own equivalent for the web server's args). `dsh-base`
carries neither. So when a profile boots with `dsh-base` alone, the full
plugin tree activates successfully — `--help` is simply never read by
anything — and the process falls through into whatever idle/listening state
`dsh-base`'s own components leave it in (confirmed via a live diagnostic:
the process holds open `FSWatcher`/`Socket` handles, not a stuck Promise —
see "How this was found" for the exact evidence). This is not a defect to
fix; it's the intended contract: `dsh-base` is a shared core meant to be run
under an overlay that supplies a concrete mode, and a fresh profile from
`dsh plugin add` never adds one.

## Retraction: `@deepseek-ai/dsh-goal` was never the cause

An earlier pass at this investigation used a binary search over
`cordis.patch.yml`'s `disabled: true` entries and concluded the culprit was
`@deepseek-ai/dsh-goal`'s `ctx.inject(['sessionProjections'], ...)` failing
to no-op gracefully when `sessionProjections` was supposedly absent from
`dsh-base`. Both the premise and the conclusion were wrong:

- **The premise was factually false.** `packages/bundle/base/cordis.patch.yml`
  unconditionally mounts `@deepseek-ai/dsh-session-projection` as
  `id: session-projection` (line ~126), which is exactly the plugin that
  provides `ctx.sessionProjections`. It is *never* absent in `dsh-base`,
  overlay or not. `GoalService`'s `ctx.inject(['sessionProjections'], ...)`
  resolves the same way in every profile.
- **The binary search's "fix" was actually just a different failure.**
  Disabling `goal` doesn't avoid a hang inside `goal` — it makes
  `goal-round-driver`/`command-goal`/`tool-goal` (which statically depend on
  the `goals` service `goal` provides) fail their own dependency check,
  which Cordis's loader detects immediately and reports as `"3 entries did
  not activate"` with `exit 1`. That's a **crash that happens quickly**, not
  a successful boot — but because it terminates the process fast, it was
  easy to mistake for "the hang is gone" when what actually happened is "we
  now crash before ever reaching the idle state that isn't a bug at all."
- A code fix was attempted in `packages/goal/goal/src/index.ts` (eagerly
  check `ctx.get('sessionProjections')` before falling back to the reactive
  `ctx.inject` form) based on this incorrect premise. It was built, and
  tested directly against a bare-`dsh-base` profile with nothing disabled —
  **the boot still did not exit within 60s, unchanged from before the
  "fix."** That empirical result is what triggered this re-investigation and
  is why the change was reverted (`git diff` on that file is now empty).

The two "workarounds" from the earlier version of this doc (disabling
`goal` alone, or `goal` plus its three dependents) are retracted as
misleading — they were never fixes, just two different ways of crashing
before the underlying non-bug ever mattered. The four-way-disable's genuine
deadlock (confirmed via idle `utime`/`stime` sampling) is a real, separate
observation about Cordis's scheduler under multiple simultaneous
`disabled: true` entries, but it's incidental to this investigation, not a
consequence of anything `goal`-specific.

## How this was found (corrected)

1. A live diagnostic (`--require` a script that polls
   `process._getActiveHandles()`/`_getActiveRequests()` every 3s) was run
   against the "hanging" process. It reported a **stable, non-growing** set
   of handles — `2 Sockets, 6 FSWatchers` — not zero handles (which would
   indicate a stuck Promise chain with the event loop otherwise empty) and
   not a growing/spinning count (which would indicate a runaway loop). This
   is the signature of a process that finished starting up and is now
   legitimately waiting on I/O, not one stuck mid-activation.
2. `vendor/cordis/src/config/tree.ts`'s `EntryTree.await()` (the function
   `boot()` awaits before declaring the tree settled) only waits on
   `entry._initTask || entry.fiber?.inertia` for each **top-level loader
   entry** (i.e., bundle-declared plugin ids). A `Fiber` in the `PENDING`
   state (waiting on an unmet `ctx.inject` dependency) has `inertia ===
   undefined` — contributing nothing to that wait — for both top-level
   entries and any nested fiber a plugin's own constructor creates via
   `ctx.inject()`. This directly contradicts the idea that a permanently
   pending internal `sessionProjections` subscription could block the whole
   tree from settling; structurally, it can't.
3. Grepping `packages/bundle/base/cordis.patch.yml` and
   `packages/bundle/headless/cordis.patch.yml` side by side surfaced the
   actual asymmetry: `session-projection` is mounted by `dsh-base` itself
   (so `sessionProjections` is never missing), while `headless-startup` (the
   only thing that reads `--help`/task args) exists exclusively in the
   `dsh-headless` overlay. Reading `packages/bundle/headless/src/startup.ts`
   confirmed it's a self-contained Commander program wired to
   `parseCmdline`, entirely separate from anything `dsh-base` provides.

This also still explains why the project's own tests never caught it,
unchanged from the earlier version of this doc: the only full-boot smoke
test in CI (`apps/cli/tests/built-bin.e2e.ts`) always boots `--profile web`
or `--profile headless`, both of which carry an overlay. Nobody boots bare
`dsh-base` anywhere in the test suite — but that's exactly what
`dsh plugin --profile <name> add <path>` (the documented workflow for
installing any third-party plugin) produces for a fresh profile.

## Fix

Add an overlay bundle (`dsh-headless` or `dsh-web-app`) to the profile's
`package.json` `dsh.profile.bundles` list, matching the built-in `web`/
`headless` profiles:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]
    }
  }
}
```

This isn't working around a defect — it's supplying the run-mode driver
that `dsh-base` deliberately doesn't include. Verified end-to-end with
`dsh-plugin-knowledge-hub`'s own test profile (`kb-test`): after switching
its bundle list from `["@deepseek-ai/dsh-base"]` to
`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]`, both
`--dump-config` and a real `--help` boot succeeded (exit 0, clean output,
`knowledge-hub` composed as the final `cordis.patch.yml` layer). A follow-up
functional check (asking the profile to run a task that calls
`memory_remember`/`memory_recall`) confirmed the full plugin tree — agent
loop, tools registry, and `knowledge-hub` — activates and starts executing;
it only failed afterward on an unrelated missing `DEEPSEEK_API_KEY`
credential, outside the scope of this investigation.

**Do not** try to "fix" this by disabling `@deepseek-ai/dsh-goal` in
`cordis.patch.yml` — per the retraction above, that plugin was never
involved, and disabling it only produces a different, faster crash instead
of a working profile.

## Next step

No code change is warranted in this repo or upstream for the original
symptom — it's expected behavior, now correctly documented, not a bug. The
one still-open, genuinely unexplained observation is the four-way-disable
deadlock noted above (Cordis's scheduler under multiple simultaneous
`disabled: true` entries) — low priority, since nobody needs that
configuration once the real fix (an overlay bundle) is applied, but worth a
second look if Option-A-style disables are ever revisited for something
else.
