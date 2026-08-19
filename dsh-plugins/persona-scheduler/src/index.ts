/**
 * `dsh-plugin-persona-scheduler`: launches brand-new, independently-scheduled
 * persona agent sessions (Cabinet-style standing personas — Chief of Staff,
 * CFO, Marketing, ...) on a cron-like fixed-rate/one-shot timer. Closes the
 * gap `dsh-schedule` deliberately leaves open: that package only wakes its
 * own already-running session (`Agent.followup()`), never a new one. This
 * plugin composes purely through public `ctx` seams (`ctx.agents.create`,
 * `ctx.agentPresets.mount`) — no changes to `packages/` or `apps/`.
 * @module dsh-plugin-persona-scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import '@deepseek-ai/dsh-agent'
import '@deepseek-ai/dsh-agent-presets'
import '@deepseek-ai/dsh-tools'
import { PersonaWorkerStore } from './store.ts'
import { PersonaSchedulerRuntime } from './runtime.ts'
import { registerPersonaWorkerTools } from './tools.ts'

export type * from './domain.ts'
export { PersonaWorkerStore } from './store.ts'
export { PersonaSchedulerRuntime } from './runtime.ts'

export const Config = z.object({
  /** Path to this plugin's own durable worker-roster JSON file. */
  stateFile: z.string().default('.dsh-persona-scheduler/workers.json'),
})

export type Config = Schemastery.TypeT<typeof Config>

/** Cordis function-plugin name. */
export const name = 'persona-scheduler'
/** Services required before this plugin can compose. */
export const inject = ['agents', 'agentPresets', 'tools']

/** Register `dsh-plugin-persona-scheduler`. */
export function apply(ctx: Context, config: Config): void {
  const store = new PersonaWorkerStore(config.stateFile)
  const runtime = new PersonaSchedulerRuntime(ctx, store)

  ctx.effect(() => {
    // Restart-safe: arm the timer against whatever the roster already holds on disk.
    runtime.requestDrive()

    const stopCreated = ctx.on('agent/created', ({ agent }) => {
      if (!ctx.agents.roots().includes(agent)) return
      agent.ctx.effect(
        () => registerPersonaWorkerTools(agent.ctx, store, () => runtime.requestDrive()),
        'persona-scheduler.tools()',
      )
    })

    return async () => {
      stopCreated()
      await runtime.dispose()
    }
  }, 'persona-scheduler.lifecycle()')
}
