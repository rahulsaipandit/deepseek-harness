import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorker } from '../src/domain.ts'
import { PersonaSchedulerRuntime } from '../src/runtime.ts'
import { PersonaWorkerStore } from '../src/store.ts'

interface FakeAgent {
  readonly id: string
  followup: (message: unknown) => void
}

function makeFakeCtx() {
  const created: { sessionId: string; presetId: string }[] = []
  const followups: unknown[] = []
  const mounted: string[] = []

  const ctx = {
    agents: {
      async create(options: { sessionId: string; setup: (agentCtx: unknown) => Promise<void> }) {
        created.push({ sessionId: options.sessionId, presetId: '' })
        await options.setup({})
        const agent: FakeAgent = {
          id: options.sessionId,
          followup: (message: unknown) => followups.push(message),
        }
        return { agent, dispose: async () => {} }
      },
    },
    agentPresets: {
      async mount(_agentCtx: unknown, id: string) {
        mounted.push(id)
        return { id }
      },
    },
    logger: { warn: vi.fn() },
  }

  return { ctx, created, followups, mounted }
}

describe('PersonaSchedulerRuntime', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    vi.useFakeTimers()
    dir = await mkdtemp(join(tmpdir(), 'persona-scheduler-runtime-'))
    path = join(dir, 'workers.json')
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('launches a new agent session (not a followup on an existing one) when a one-shot worker fires', async () => {
    const { ctx, created, followups, mounted } = makeFakeCtx()
    const store = new PersonaWorkerStore(path)
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'Draft the weekly cash-flow summary.', afterSeconds: 300 }, Date.now())
    await store.add(worker)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake ctx is intentionally a narrow structural stub
    const runtime = new PersonaSchedulerRuntime(ctx as any, store)
    await runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(300_000 + 10)

    expect(created).toHaveLength(1)
    expect(mounted).toEqual(['cfo'])
    expect(followups).toHaveLength(1)
    expect(await store.list()).toEqual([]) // one-shot worker removed after firing
    await runtime.dispose()
  })

  it('reschedules rather than removes a fixed-rate worker, and does not double-fire', async () => {
    const { ctx, created } = makeFakeCtx()
    const store = new PersonaWorkerStore(path)
    const worker = createWorker('w1', { presetId: 'marketing', seedPrompt: 'Scout for new leads.', everySeconds: 300 }, Date.now())
    await store.add(worker)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake ctx is intentionally a narrow structural stub
    const runtime = new PersonaSchedulerRuntime(ctx as any, store)
    await runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(300_000 + 10)
    expect(created).toHaveLength(1)

    const remaining = await store.list()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.nextFireAt).toBeGreaterThan(worker.nextFireAt)

    await vi.advanceTimersByTimeAsync(300_000 + 10)
    expect(created).toHaveLength(2)
    await runtime.dispose()
  })

  it('re-arms against an already-persisted roster on construction (restart-safe)', async () => {
    const { ctx, created } = makeFakeCtx()
    const store = new PersonaWorkerStore(path)
    const worker = createWorker('w1', { presetId: 'cos', seedPrompt: 'Summarize overnight email.', afterSeconds: 60 }, Date.now())
    await store.add(worker)

    // Simulate a process restart: fresh runtime instance over the same on-disk roster.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake ctx is intentionally a narrow structural stub
    const runtime = new PersonaSchedulerRuntime(ctx as any, new PersonaWorkerStore(path))
    // Await the arm itself (a real disk read on the fresh store instance) rather than racing
    // it against the fake clock — `requestDrive()` resolves once the timer is actually set.
    await runtime.requestDrive()
    await vi.advanceTimersByTimeAsync(60_000 + 10)
    expect(created).toHaveLength(1)
    await runtime.dispose()
  })
})
