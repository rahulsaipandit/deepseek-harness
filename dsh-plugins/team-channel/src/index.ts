/**
 * `dsh-plugin-team-channel`: shared post/read channels independently-created
 * agents (no parent/child relationship) can use to talk to each other —
 * Cabinet-style team channels. Closes a gap confirmed in `ctx.subagents`:
 * the only channels there are parent→child (`followup`) and
 * child→direct-parent (`reportFrom`); nothing lets sibling or unrelated
 * agents post/read a shared board. Composes purely through public `ctx`
 * seams (`ctx.tools`, `Agent.followup`) — no changes to `packages/` or `apps/`.
 * @module dsh-plugin-team-channel
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-tools'
import { TeamChannelStore } from './store.ts'
import { registerTeamChannelTools } from './tools.ts'
import { WatcherRegistry } from './watchers.ts'

export type * from './domain.ts'
export { TeamChannelStore } from './store.ts'
export { WatcherRegistry } from './watchers.ts'

export const Config = z.object({
  /** Path to this plugin's own SQLite database file. */
  dbFile: z.string().default('.dsh-team-channel/messages.sqlite'),
})

export type Config = Schemastery.TypeT<typeof Config>

/** Cordis function-plugin name. */
export const name = 'team-channel'
/** Services required before this plugin can compose. */
export const inject = ['agents', 'tools']

/** Register `dsh-plugin-team-channel`. */
export function apply(ctx: Context, config: Config): void {
  const watchers = new WatcherRegistry()

  ctx.effect(() => {
    // `node:sqlite`'s DatabaseSync is synchronous end to end, so the store opens
    // eagerly here rather than lazily per agent — no "tools missing on the
    // first turn" race to worry about.
    const store = new TeamChannelStore(config.dbFile)

    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(() => {
        const disposeTools = registerTeamChannelTools(agent.ctx, agent, store, watchers)
        return () => {
          watchers.unwatchAll(agent)
          disposeTools()
        }
      }, 'team-channel.tools()')
    })

    return () => {
      stopCreated()
      store.close()
    }
  }, 'team-channel.lifecycle()')
}
