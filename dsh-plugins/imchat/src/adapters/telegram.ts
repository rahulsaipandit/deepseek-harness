/**
 * Telegram adapter (design doc §6): Bot API long polling (`getUpdates`), no
 * public port needed. Token format validated the same way `dsh-im` does
 * before use. Approval/question prompts render as an inline keyboard;
 * `callback_data` carries `<promptId>:<optionId>` and is acknowledged via
 * `answerCallbackQuery` so Telegram stops showing the tap as pending.
 * @module dsh-plugin-imchat/adapters/telegram
 */

import type { ChatAdapter, InboundMessage, PendingPrompt, PromptReply } from '../core/types.ts'

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/

/** Thrown when a configured Telegram bot token doesn't match the Bot API's token format. */
export class InvalidTelegramTokenError extends Error {
  constructor() {
    super('dsh-imchat: Telegram bot token does not match the expected `<digits>:<token>` format')
    this.name = 'InvalidTelegramTokenError'
  }
}

export interface TelegramAdapterOptions {
  readonly token: string
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly pollTimeoutSec?: number
  readonly pollIntervalMs?: number
}

interface TelegramUpdate {
  readonly update_id: number
  readonly message?: { readonly message_id: number, readonly chat: { readonly id: number }, readonly from?: { readonly id: number }, readonly text?: string }
  readonly callback_query?: { readonly id: string, readonly data?: string, readonly message?: { readonly chat: { readonly id: number } } }
}

function callbackData(promptId: string, optionId: string): string {
  return `${promptId}:${optionId}`
}

function parseCallbackData(data: string): { promptId: string, optionId: string } | undefined {
  const separatorIndex = data.indexOf(':')
  if (separatorIndex < 0) return undefined
  return { promptId: data.slice(0, separatorIndex), optionId: data.slice(separatorIndex + 1) }
}

/** `ChatAdapter` over the Telegram Bot API. */
export class TelegramAdapter implements ChatAdapter {
  readonly platform = 'telegram' as const

  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly pollTimeoutSec: number
  private readonly pollIntervalMs: number
  private stopped = true
  private pollLoop: Promise<void> | undefined
  private updateOffset = 0
  private messageHandler: ((message: InboundMessage) => void) | undefined
  private promptReplyHandler: ((reply: PromptReply) => void) | undefined

  constructor(options: TelegramAdapterOptions) {
    if (!TOKEN_PATTERN.test(options.token)) throw new InvalidTelegramTokenError()
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${options.token}`
    this.fetchImpl = options.fetchImpl ?? fetch
    this.pollTimeoutSec = options.pollTimeoutSec ?? 25
    this.pollIntervalMs = options.pollIntervalMs ?? 250
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json() as { ok: boolean, result?: T, description?: string }
    if (!payload.ok) throw new Error(`dsh-imchat: Telegram ${method} failed: ${payload.description ?? 'unknown error'}`)
    return payload.result as T
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    this.pollLoop = this.runPollLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.pollLoop
    this.pollLoop = undefined
  }

  private async runPollLoop(): Promise<void> {
    while (!this.stopped) {
      let updates: TelegramUpdate[] = []
      try {
        updates = await this.call<TelegramUpdate[]>('getUpdates', {
          offset: this.updateOffset,
          timeout: this.pollTimeoutSec,
        })
      } catch (error: unknown) {
        console.error('dsh-imchat: Telegram getUpdates failed', error)
      }
      for (const update of updates) {
        this.updateOffset = Math.max(this.updateOffset, update.update_id + 1)
        this.handleUpdate(update)
      }
      if (updates.length === 0 && !this.stopped) {
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
      }
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    if (update.message !== undefined && update.message.text !== undefined) {
      this.messageHandler?.({
        chatId: String(update.message.chat.id),
        senderId: String(update.message.from?.id ?? update.message.chat.id),
        text: update.message.text,
      })
      return
    }
    if (update.callback_query !== undefined) {
      const chatId = update.callback_query.message?.chat.id
      const data = update.callback_query.data
      this.call('answerCallbackQuery', { callback_query_id: update.callback_query.id }).catch(() => {})
      if (chatId === undefined || data === undefined) return
      const parsed = parseCallbackData(data)
      if (parsed === undefined) return
      this.promptReplyHandler?.({ chatId: String(chatId), promptId: parsed.promptId, optionId: parsed.optionId })
    }
  }

  async sendText(chatId: string, text: string): Promise<string> {
    const result = await this.call<{ message_id: number }>('sendMessage', { chat_id: chatId, text })
    return String(result.message_id)
  }

  async editText(chatId: string, messageId: string, text: string): Promise<void> {
    await this.call('editMessageText', { chat_id: chatId, message_id: Number(messageId), text })
  }

  async sendPrompt(chatId: string, prompt: PendingPrompt): Promise<void> {
    const inlineKeyboard = prompt.options.map(option => [{
      text: option.label,
      callback_data: callbackData(prompt.id, option.id),
    }])
    await this.call('sendMessage', {
      chat_id: chatId,
      text: prompt.text,
      reply_markup: { inline_keyboard: inlineKeyboard },
    })
  }

  onMessage(handler: (message: InboundMessage) => void): void {
    this.messageHandler = handler
  }

  onPromptReply(handler: (reply: PromptReply) => void): void {
    this.promptReplyHandler = handler
  }
}
