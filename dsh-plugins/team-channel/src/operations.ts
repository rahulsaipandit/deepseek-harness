/**
 * Business logic behind each team-channel tool, factored out of `tools.ts`
 * so it's testable without constructing a real Cordis `ToolRunContext` —
 * same separation `domain.ts` already draws for pure validation.
 * @module dsh-plugin-team-channel/operations
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ChannelInputError, ChannelMessage, InvalidChannelError } from './domain.ts'
import { validateBody, validateChannelName } from './domain.ts'
import type { TeamChannelStore } from './store.ts'
import type { WatcherRegistry } from './watchers.ts'

/** Render one message as the push framing delivered to a watching agent. */
function renderPushFraming(message: Pick<ChannelMessage, 'channel' | 'postedBy' | 'body'>): string {
  return `[TEAM CHANNEL: ${message.channel}]\nFrom ${message.postedBy}: ${message.body}`
}

/** Post a message, then push it to every live watcher of that channel except the poster. */
export function postMessage(
  store: TeamChannelStore,
  watchers: WatcherRegistry,
  agent: Agent,
  channel: string,
  body: string,
  now: number,
): ChannelMessage | ChannelInputError {
  const channelError = validateChannelName(channel)
  if (channelError !== undefined) return channelError
  const bodyError = validateBody(body)
  if (bodyError !== undefined) return bodyError
  const message = store.post(channel, agent.id, body, now)
  for (const watcher of watchers.watchersOf(channel, agent)) {
    watcher.followup(createUserMessage({
      content: [{ type: 'text', text: renderPushFraming(message) }],
      source: { kind: 'user' },
    }))
  }
  return message
}

export function readMessages(
  store: TeamChannelStore,
  channel: string,
  sinceId?: number,
): readonly ChannelMessage[] | InvalidChannelError {
  const channelError = validateChannelName(channel)
  if (channelError !== undefined) return channelError
  return store.read(channel, sinceId)
}

export function listChannels(store: TeamChannelStore): readonly string[] {
  return store.listChannels()
}

export interface WatchResult {
  readonly channel: string
  readonly watching: boolean
}

export function watchChannel(watchers: WatcherRegistry, agent: Agent, channel: string): WatchResult | InvalidChannelError {
  const channelError = validateChannelName(channel)
  if (channelError !== undefined) return channelError
  watchers.watch(channel, agent)
  return { channel, watching: true }
}

export function unwatchChannel(watchers: WatcherRegistry, agent: Agent, channel: string): WatchResult | InvalidChannelError {
  const channelError = validateChannelName(channel)
  if (channelError !== undefined) return channelError
  watchers.unwatch(channel, agent)
  return { channel, watching: false }
}
