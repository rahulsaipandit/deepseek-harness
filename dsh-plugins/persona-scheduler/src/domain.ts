/**
 * Pure domain logic for persona workers: the selector union, validation, and
 * next-fire computation. No I/O, no ctx — kept separate so the runtime and
 * tools modules can both depend on one small, easily-tested surface.
 * @module dsh-plugin-persona-scheduler/domain
 */

/** Minimum fixed-rate interval, mirroring `dsh-schedule`'s own floor to discourage a runaway launch loop. */
export const MIN_EVERY_SECONDS = 300

/** One persona worker: a preset to mount, an opening prompt, and exactly one fire selector. */
export interface PersonaWorker {
  readonly id: string
  readonly presetId: string
  readonly seedPrompt: string
  readonly createdAt: number
  /** Selector: exactly one of `afterSeconds` (one-shot, relative), `at` (one-shot, absolute ms), or `everySeconds` (fixed-rate). */
  readonly afterSeconds?: number
  readonly at?: number
  readonly everySeconds?: number
  /** Next UTC-ms fire target; recomputed after every fire for `everySeconds` workers. */
  nextFireAt: number
}

export interface CreateWorkerInput {
  readonly presetId: string
  readonly seedPrompt: string
  readonly afterSeconds?: number
  readonly at?: number
  readonly everySeconds?: number
}

export type WorkerInputError =
  | { readonly code: 'invalid_preset_id'; readonly message: string }
  | { readonly code: 'invalid_seed_prompt'; readonly message: string }
  | { readonly code: 'invalid_selector'; readonly message: string }
  | { readonly code: 'invalid_rule'; readonly message: string }
  | { readonly code: 'frequency_too_high'; readonly message: string }
  | { readonly code: 'not_future'; readonly message: string }

/** Validate a create request; pure, no id/clock access beyond the supplied `now`. */
export function validateCreateWorkerInput(input: CreateWorkerInput, now: number): WorkerInputError | undefined {
  if (input.presetId.trim().length === 0) {
    return { code: 'invalid_preset_id', message: 'presetId must be non-empty.' }
  }
  if (input.seedPrompt.trim().length === 0) {
    return { code: 'invalid_seed_prompt', message: 'seedPrompt must be non-empty.' }
  }
  const selectorCount = Number(input.afterSeconds !== undefined)
    + Number(input.at !== undefined)
    + Number(input.everySeconds !== undefined)
  if (selectorCount !== 1) {
    return { code: 'invalid_selector', message: 'Exactly one of afterSeconds, at, or everySeconds is required.' }
  }
  if (input.afterSeconds !== undefined) {
    if (!Number.isSafeInteger(input.afterSeconds) || input.afterSeconds <= 0) {
      return { code: 'invalid_rule', message: 'afterSeconds must be a positive safe integer.' }
    }
  }
  if (input.at !== undefined) {
    if (!Number.isSafeInteger(input.at) || input.at <= now) {
      return { code: 'not_future', message: 'at must be a safe-integer epoch-ms target in the future.' }
    }
  }
  if (input.everySeconds !== undefined) {
    if (!Number.isSafeInteger(input.everySeconds)) {
      return { code: 'invalid_rule', message: 'everySeconds must be a safe integer.' }
    }
    if (input.everySeconds < MIN_EVERY_SECONDS) {
      return { code: 'frequency_too_high', message: `everySeconds must be at least ${MIN_EVERY_SECONDS}.` }
    }
  }
  return undefined
}

/** Build a worker record from a validated input. Caller must have already validated. */
export function createWorker(id: string, input: CreateWorkerInput, now: number): PersonaWorker {
  const nextFireAt = input.at ?? now + (input.afterSeconds ?? input.everySeconds ?? 0) * 1000
  return {
    id,
    presetId: input.presetId,
    seedPrompt: input.seedPrompt,
    createdAt: now,
    ...input.afterSeconds !== undefined ? { afterSeconds: input.afterSeconds } : {},
    ...input.at !== undefined ? { at: input.at } : {},
    ...input.everySeconds !== undefined ? { everySeconds: input.everySeconds } : {},
    nextFireAt,
  }
}

/**
 * Recompute a fixed-rate worker's next occurrence strictly after `firedAt`,
 * creation-anchored (never drifting off the original `nextFireAt`) and
 * never enumerating missed ticks — mirrors `dsh-schedule`'s "skip missed
 * occurrences, batch one latest" durability lesson.
 */
export function advanceEveryWorker(worker: PersonaWorker, firedAt: number): number {
  const interval = (worker.everySeconds ?? MIN_EVERY_SECONDS) * 1000
  let next = worker.nextFireAt + interval
  if (next <= firedAt) {
    const missedIntervals = Math.floor((firedAt - next) / interval) + 1
    next += missedIntervals * interval
  }
  return next
}

/** Whether a worker is one-shot (removed after firing) rather than fixed-rate. */
export function isOneShot(worker: PersonaWorker): boolean {
  return worker.everySeconds === undefined
}
