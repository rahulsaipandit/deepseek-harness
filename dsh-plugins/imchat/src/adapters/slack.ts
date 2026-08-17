/**
 * Slack adapter (design doc §6): Web API (HTTP, `chat.postMessage`/`chat.update`)
 * for sending, Socket Mode for receiving — bot token + app-level token, no
 * public HTTPS endpoint. Approval/question prompts render as a Block Kit
 * actions block; each button's `action_id` carries `<promptId>:<optionId>`.
 *
 * Socket Mode itself (the persistent WebSocket handshake to Slack's
 * `apps.connections.open` endpoint) is a transport concern this module
 * deliberately doesn't own: `SlackEventsClient` is the seam an actual Socket
 * Mode client plugs into, injected rather than hardwired, so this adapter
 * (and its tests) never depend on a live Slack connection — only the Web API
 * HTTP calls are this module's own responsibility, and those are genuinely
 * exercised against a mock HTTP server in tests.
 * @module dsh-plugin-imchat/adapters/slack
 */

import type { ChatAdapter, InboundMessage, PendingPrompt, PromptReply } from '../core/types.ts'

/** One incoming Slack event this adapter understands, decoupled from Socket Mode's own envelope. */
export interface SlackMessageEvent {
  readonly channel: string
  readonly user: string
  readonly text: string
}

/** One incoming Block Kit `block_actions` interaction. */
export interface SlackBlockAction {
  readonly channel: string
  readonly actionId: string
}

/** The event-delivery seam a real Socket Mode client (or a test double) implements. */
export interface SlackEventsClient {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (event: SlackMessageEvent) => void): void
  onBlockAction(handler: (action: SlackBlockAction) => void): void
}

export interface SlackAdapterOptions {
  readonly botToken: string
  readonly events: SlackEventsClient
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
}

function actionId(promptId: string, optionId: string): string {
  return `${promptId}:${optionId}`
}

function parseActionId(id: string): { promptId: string, optionId: string } | undefined {
  const separatorIndex = id.indexOf(':')
  if (separatorIndex < 0) return undefined
  return { promptId: id.slice(0, separatorIndex), optionId: id.slice(separatorIndex + 1) }
}

/** `ChatAdapter` over the Slack Web API plus an injected Socket Mode event source. */
export class SlackAdapter implements ChatAdapter {
  readonly platform = 'slack' as const

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly events: SlackEventsClient
  private readonly botToken: string
  private messageHandler: ((message: InboundMessage) => void) | undefined
  private promptReplyHandler: ((reply: PromptReply) => void) | undefined

  constructor(options: SlackAdapterOptions) {
    this.botToken = options.botToken
    this.events = options.events
    this.baseUrl = options.baseUrl ?? 'https://slack.com/api'
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${this.botToken}`,
      },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as { ok: boolean, error?: string } & T
    if (!payload.ok) throw new Error(`dsh-imchat: Slack ${method} failed: ${payload.error ?? 'unknown error'}`)
    return payload
  }

  async start(): Promise<void> {
    this.events.onMessage((event) => {
      this.messageHandler?.({ chatId: event.channel, senderId: event.user, text: event.text })
    })
    this.events.onBlockAction((action) => {
      const parsed = parseActionId(action.actionId)
      if (parsed === undefined) return
      this.promptReplyHandler?.({ chatId: action.channel, promptId: parsed.promptId, optionId: parsed.optionId })
    })
    await this.events.start()
  }

  async stop(): Promise<void> {
    await this.events.stop()
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const result = await this.call<{ ts: string }>('chat.postMessage', { channel: chatId, text })
    return result.ts
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call('chat.update', { channel: chatId, ts: messageId, text })
  }

  async sendPrompt(chatId: string, prompt: PendingPrompt): Promise<void> {
    const actionsBlock = {
      type: 'actions',
      elements: prompt.options.map(option => ({
        type: 'button',
        text: { type: 'plain_text', text: option.label },
        action_id: actionId(prompt.id, option.id),
      })),
    }
    await this.call('chat.postMessage', {
      channel: chatId,
      text: prompt.text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: prompt.text } },
        actionsBlock,
      ],
    })
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler
  }

  onPromptReply(handler: (reply: PromptReply) => void): void {
    this.promptReplyHandler = handler
  }
}
