/**
 * Restart-safe timer loop that launches a brand-new, independent agent
 * session per due persona worker — the piece `dsh-schedule` deliberately
 * doesn't have (it only wakes its own already-running session). Modeled on
 * `dsh-schedule`'s durability lessons: recompute the next target from the
 * wall clock on every wake so a system-clock rollback can't fire early and a
 * forward jump can't replay missed ticks, and never enumerate missed
 * occurrences for a fixed-rate worker.
 * @module dsh-plugin-persona-scheduler/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { advanceEveryWorker, isOneShot, type PersonaWorker } from './domain.ts'
import type { PersonaWorkerStore } from './store.ts'

/** Node's `setTimeout` silently truncates delays beyond ~24.8 days; re-check on every wake instead of trusting one long timer. */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000

export class PersonaSchedulerRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly store: PersonaWorkerStore,
  ) {}

  /**
   * (Re)arm the timer for the earliest due worker; safe to call repeatedly (e.g. after a
   * create/remove). Callers don't need the returned promise — it exists so tests can await
   * exactly the arming step (a real disk read) without racing it against fake timers.
   */
  requestDrive(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.inFlight = this.inFlight.then(() => this.armNext()).catch((error: unknown) => {
      this.ctx.logger.warn(`persona-scheduler: drive failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.inFlight
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await this.inFlight
  }

  private async armNext(): Promise<void> {
    if (this.disposed) return
    const workers = await this.store.list()
    if (workers.length === 0) return
    const now = Date.now()
    const earliest = workers.reduce((min, worker) => worker.nextFireAt < min.nextFireAt ? worker : min)
    const delay = Math.max(0, earliest.nextFireAt - now)
    if (delay > MAX_TIMER_MS) {
      this.timer = setTimeout(() => this.requestDrive(), MAX_TIMER_MS)
      return
    }
    this.timer = setTimeout(() => {
      // Chained into `inFlight`, not fire-and-forget: `dispose()` awaits exactly this
      // promise, so a fire already in progress finishes (and persists) before teardown.
      this.inFlight = this.inFlight.then(() => this.fireDue()).catch((error: unknown) => {
        this.ctx.logger.warn(`persona-scheduler: fire failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    }, delay)
  }

  private async fireDue(): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const workers = await this.store.list()
    const due = workers.filter(worker => worker.nextFireAt <= now)
    for (const worker of due) {
      await this.launch(worker, now)
      if (isOneShot(worker)) {
        await this.store.remove(worker.id)
      } else {
        await this.store.reschedule(worker.id, advanceEveryWorker(worker, now))
      }
    }
    this.requestDrive()
  }

  /** Start a genuinely new, independent agent session for one due worker. */
  private async launch(worker: PersonaWorker, now: number): Promise<void> {
    try {
      const sessionId = SessionId(randomUUID())
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: { agentPreset: worker.presetId },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, worker.presetId)
        },
      })
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: worker.seedPrompt }],
        source: { kind: 'user' },
      }))
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `persona-scheduler: worker ${worker.id} (preset ${worker.presetId}) failed to launch at ${new Date(now).toISOString()}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
