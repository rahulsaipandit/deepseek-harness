import { describe, expect, it } from 'vitest'
import {
  advanceEveryWorker,
  createWorker,
  isOneShot,
  MIN_EVERY_SECONDS,
  validateCreateWorkerInput,
} from '../src/domain.ts'

describe('validateCreateWorkerInput', () => {
  const now = 1_000_000

  it('rejects an empty presetId', () => {
    const error = validateCreateWorkerInput({ presetId: '', seedPrompt: 'hi', afterSeconds: 60 }, now)
    expect(error?.code).toBe('invalid_preset_id')
  })

  it('rejects an empty seedPrompt', () => {
    const error = validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: '   ', afterSeconds: 60 }, now)
    expect(error?.code).toBe('invalid_seed_prompt')
  })

  it('rejects zero or multiple selectors', () => {
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi' }, now)?.code).toBe('invalid_selector')
    expect(validateCreateWorkerInput(
      { presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60, at: now + 1000 },
      now,
    )?.code).toBe('invalid_selector')
  })

  it('rejects a non-positive afterSeconds', () => {
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 0 }, now)?.code).toBe('invalid_rule')
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', afterSeconds: -5 }, now)?.code).toBe('invalid_rule')
  })

  it('rejects a non-future at', () => {
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', at: now }, now)?.code).toBe('not_future')
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', at: now - 1 }, now)?.code).toBe('not_future')
  })

  it('rejects everySeconds below the floor', () => {
    const error = validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', everySeconds: MIN_EVERY_SECONDS - 1 }, now)
    expect(error?.code).toBe('frequency_too_high')
  })

  it('accepts one valid selector of each kind', () => {
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60 }, now)).toBeUndefined()
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', at: now + 60_000 }, now)).toBeUndefined()
    expect(validateCreateWorkerInput({ presetId: 'cfo', seedPrompt: 'hi', everySeconds: MIN_EVERY_SECONDS }, now)).toBeUndefined()
  })
})

describe('createWorker', () => {
  it('computes nextFireAt from afterSeconds', () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60 }, 1_000_000)
    expect(worker.nextFireAt).toBe(1_000_000 + 60_000)
    expect(isOneShot(worker)).toBe(true)
  })

  it('uses at directly as nextFireAt', () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', at: 5_000_000 }, 1_000_000)
    expect(worker.nextFireAt).toBe(5_000_000)
  })

  it('marks an everySeconds worker as recurring', () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', everySeconds: MIN_EVERY_SECONDS }, 1_000_000)
    expect(isOneShot(worker)).toBe(false)
  })
})

describe('advanceEveryWorker', () => {
  it('advances by exactly one interval when fired on time', () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', everySeconds: 300 }, 0)
    const next = advanceEveryWorker(worker, worker.nextFireAt)
    expect(next).toBe(worker.nextFireAt + 300_000)
  })

  it('skips missed ticks instead of enumerating them when fired late', () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', everySeconds: 300 }, 0)
    // Fired 10 intervals late (e.g. process was down).
    const firedAt = worker.nextFireAt + 10 * 300_000 + 50
    const next = advanceEveryWorker(worker, firedAt)
    expect(next).toBeGreaterThan(firedAt)
    expect((next - worker.nextFireAt) % 300_000).toBe(0)
  })
})
