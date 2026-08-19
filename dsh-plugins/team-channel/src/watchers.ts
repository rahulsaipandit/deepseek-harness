/**
 * In-memory registry of which live agents are "watching" which channel, for
 * the optional push path: on a new post, a watching agent gets
 * `Agent.followup()` called directly — the same public primitive
 * `dsh-schedule` itself uses internally, just invoked from outside their
 * package. Deliberately not persisted: a watch only means anything for a
 * currently-live agent, so it resets on restart exactly like every other
 * live-only registration in DSH (e.g. `ctx.terminals`' owner fencing).
 * @module dsh-plugin-team-channel/watchers
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

export class WatcherRegistry {
  private readonly byChannel = new Map<string, Set<Agent>>()

  watch(channel: string, agent: Agent): void {
    let watchers = this.byChannel.get(channel)
    if (watchers === undefined) {
      watchers = new Set()
      this.byChannel.set(channel, watchers)
    }
    watchers.add(agent)
  }

  unwatch(channel: string, agent: Agent): void {
    this.byChannel.get(channel)?.delete(agent)
  }

  /** Drop every watch this agent holds, across all channels — call on agent disposal. */
  unwatchAll(agent: Agent): void {
    for (const watchers of this.byChannel.values()) watchers.delete(agent)
  }

  /** Live agents currently watching `channel`, excluding `except` (typically the poster). */
  watchersOf(channel: string, except?: Agent): readonly Agent[] {
    const watchers = this.byChannel.get(channel)
    if (watchers === undefined) return []
    return [...watchers].filter(agent => agent !== except)
  }
}
