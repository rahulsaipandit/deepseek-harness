/**
 * Model-facing team-channel tools: post/read/list, plus an optional
 * watch/unwatch pair for the push path. Registered per live root agent — a
 * preset opts in simply by including this plugin's row in its
 * `agent.cordis.yml`, the same composition-based opt-in every other DSH
 * capability uses. The actual business logic lives in `operations.ts`, kept
 * separate so it's testable without a real Cordis `ToolRunContext`.
 * @module dsh-plugin-team-channel/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { listChannels, postMessage, readMessages, unwatchChannel, watchChannel } from './operations.ts'
import type { TeamChannelStore } from './store.ts'
import type { WatcherRegistry } from './watchers.ts'

function renderValue(_args: unknown, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

const MESSAGE_VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', required: true },
    channel: { type: 'string', required: true },
    postedBy: { type: 'string', required: true },
    body: { type: 'string', required: true },
    postedAt: { type: 'integer', required: true },
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

const ERROR_SCHEMAS = [basicErrorSchema('invalid_channel'), basicErrorSchema('invalid_body')] as const

const POST_OUTPUT_SCHEMA = { oneOf: [MESSAGE_VIEW_SCHEMA, ...ERROR_SCHEMAS] } as const
const READ_OUTPUT_SCHEMA = { oneOf: [{ type: 'array', items: MESSAGE_VIEW_SCHEMA }, basicErrorSchema('invalid_channel')] } as const
const LIST_OUTPUT_SCHEMA = { type: 'array', items: { type: 'string' } } as const
const WATCH_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', required: true },
        watching: { type: 'boolean', required: true },
      },
    },
    basicErrorSchema('invalid_channel'),
  ],
} as const

const POST_DESCRIPTION =
  'Post one message to a shared team channel. Any other live agent watching this channel '
  + '(via team_channel_watch) receives it as a follow-up turn; every agent can also read the '
  + 'channel on demand with team_channel_read regardless of watch state.'

const READ_DESCRIPTION = 'Read messages posted to one team channel, in post order, optionally only those after since_id.'

const LIST_DESCRIPTION = 'List every team channel that has at least one message.'

const WATCH_DESCRIPTION = 'Start receiving a follow-up turn when another agent posts to this channel. Watches are live-only and do not survive a restart.'

const UNWATCH_DESCRIPTION = 'Stop receiving follow-ups for this channel.'

/** Register the team-channel tools in one exact agent scope. */
export function registerTeamChannelTools(
  toolCtx: Context,
  agent: Agent,
  store: TeamChannelStore,
  watchers: WatcherRegistry,
): () => void {
  const disposers: Array<() => void> = []

  try {
    disposers.push(toolCtx.tools.register(defineTool({
      name: 'team_channel_post',
      description: POST_DESCRIPTION,
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel name, [a-z0-9][a-z0-9-]*.' },
        body: { type: 'string', required: true, description: 'Message content.' },
      },
      output: { schema: POST_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        return postMessage(store, watchers, agent, args.channel, args.body, Date.now())
      },
      presentCall: args => present('Post to team channel', 'other', args.channel),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'team_channel_read',
      description: READ_DESCRIPTION,
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel name to read.' },
        since_id: { type: 'number', description: 'Only messages with id greater than this.' },
      },
      output: { schema: READ_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        const result = readMessages(store, args.channel, args.since_id)
        return 'code' in result ? result : [...result]
      },
      presentCall: args => present('Read team channel', 'read', args.channel),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'team_channel_list',
      description: LIST_DESCRIPTION,
      parameters: {},
      output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
      async execute() {
        return [...listChannels(store)]
      },
      presentCall: () => present('List team channels', 'read'),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'team_channel_watch',
      description: WATCH_DESCRIPTION,
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel name to watch.' },
      },
      output: { schema: WATCH_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        return watchChannel(watchers, agent, args.channel)
      },
      presentCall: args => present('Watch team channel', 'other', args.channel),
    })))

    disposers.push(toolCtx.tools.register(defineTool({
      name: 'team_channel_unwatch',
      description: UNWATCH_DESCRIPTION,
      parameters: {
        channel: { type: 'string', required: true, description: 'Channel name to stop watching.' },
      },
      output: { schema: WATCH_OUTPUT_SCHEMA, render: renderValue },
      async execute(args) {
        return unwatchChannel(watchers, agent, args.channel)
      },
      presentCall: args => present('Unwatch team channel', 'other', args.channel),
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
