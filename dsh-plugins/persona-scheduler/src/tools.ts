/**
 * Model-facing admin tools for the persona roster, mirroring `dsh-schedule`'s
 * tool shape (`schedule_create`/`list`/`delete`) but for launching brand-new
 * persona sessions instead of same-session reminders. Registered per live
 * root agent — a preset opts into "admin" status simply by including this
 * plugin's row in its `agent.cordis.yml`, the same composition-based opt-in
 * every other DSH capability uses.
 * @module dsh-plugin-persona-scheduler/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { randomUUID } from 'node:crypto'
import { createWorker, validateCreateWorkerInput, type CreateWorkerInput } from './domain.ts'
import type { PersonaWorkerStore } from './store.ts'

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

const WORKER_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    presetId: { type: 'string', required: true },
    seedPrompt: { type: 'string', required: true },
    createdAt: { type: 'integer', required: true },
    nextFireAt: { type: 'integer', required: true },
    afterSeconds: { type: 'integer' },
    at: { type: 'integer' },
    everySeconds: { type: 'integer' },
  },
} as const

function basicErrorSchema<const C extends string>(code: C) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      code: { type: 'string', required: true, const: code },
      message: { type: 'string', required: true },
    },
  } as const
}

const ERROR_SCHEMAS = [
  basicErrorSchema('invalid_preset_id'),
  basicErrorSchema('invalid_seed_prompt'),
  basicErrorSchema('invalid_selector'),
  basicErrorSchema('invalid_rule'),
  basicErrorSchema('frequency_too_high'),
  basicErrorSchema('not_future'),
] as const

const CREATE_OUTPUT_SCHEMA = { oneOf: [WORKER_VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const LIST_OUTPUT_SCHEMA = { type: 'array', items: WORKER_VIEW_SCHEMA } as const
const REMOVE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    removed: { type: 'boolean', required: true },
  },
} as const

const CREATE_DESCRIPTION =
  'Launch a new standing persona worker: a preset id to mount, an opening seed prompt, and exactly one '
  + 'fire selector (afterSeconds, at as an epoch-ms target, or everySeconds for a fixed-rate worker). '
  + 'On fire, a genuinely new, independent agent session is created and mounted on the named preset — '
  + 'not a follow-up on the calling session.'

const LIST_DESCRIPTION = 'List every persona worker currently scheduled by this plugin instance.'

const REMOVE_DESCRIPTION = 'Remove one persona worker by id, returned by persona_worker_create or persona_worker_list.'

/** Register the three persona-worker admin tools in one exact agent scope. */
export function registerPersonaWorkerTools(
  toolCtx: Context,
  store: PersonaWorkerStore,
  onChange: () => void,
): () => void {
  const disposers: Array<() => void> = []

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'persona_worker_create',
      description: CREATE_DESCRIPTION,
      parameters: {
        preset_id: { type: 'string', required: true, description: 'Agent preset id to mount for the launched session.' },
        seed_prompt: { type: 'string', required: true, description: 'Opening user-role message delivered to the launched session.' },
        after_seconds: { type: 'number', description: 'Positive safe-integer delay in seconds; one-shot.' },
        at: { type: 'number', description: 'Absolute epoch-ms target in the future; one-shot.' },
        every_seconds: { type: 'number', description: 'Fixed-rate safe-integer interval in seconds (minimum 300).' },
      },
      output: { schema: CREATE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const input: CreateWorkerInput = {
          presetId: args.preset_id,
          seedPrompt: args.seed_prompt,
          ...args.after_seconds !== undefined ? { afterSeconds: args.after_seconds } : {},
          ...args.at !== undefined ? { at: args.at } : {},
          ...args.every_seconds !== undefined ? { everySeconds: args.every_seconds } : {},
        }
        const now = Date.now()
        const invalid = validateCreateWorkerInput(input, now)
        if (invalid !== undefined) return invalid
        const worker = createWorker(randomUUID(), input, now)
        await store.add(worker)
        onChange()
        return worker
      },
      presentCall: args => present('Create persona worker', 'other', args.preset_id),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'persona_worker_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute() {
        return [...await store.list()]
      },
      presentCall: () => present('List persona workers', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'persona_worker_remove',
      description: REMOVE_DESCRIPTION,
      parameters: {
        id: { type: 'string', required: true, description: 'Exact persona worker id.' },
      },
      output: { schema: REMOVE_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const removed = await store.remove(args.id)
        if (removed) onChange()
        return { id: args.id, removed }
      },
      presentCall: args => present('Remove persona worker', 'other', args.id),
    })))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  let active = true
  return () => {
    if (!active) return
    active = false
    for (const dispose of disposers.reverse()) dispose()
  }
}
