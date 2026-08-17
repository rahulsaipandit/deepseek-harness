/**
 * WhatsApp adapter (design doc §6) — deferred. The design specifies Baileys
 * (`@whiskeysockets/baileys`) multi-device pairing with a permissioned local
 * auth-state directory, but that integration isn't built yet: mocking
 * Baileys' QR-pairing/multi-device protocol credibly is a materially
 * different effort than the Telegram/Slack HTTP-shaped APIs this pass
 * covers. This stub satisfies `ChatAdapter` so the plugin's wiring and tests
 * don't special-case a missing platform, and fails loud rather than
 * pretending to work.
 * @module dsh-plugin-imchat/adapters/whatsapp
 */

import type { ChatAdapter, InboundMessage, PendingPrompt, PromptReply } from '../core/types.ts'

/** Thrown by every `WhatsAppAdapter` operation until the Baileys integration is implemented. */
export class WhatsAppNotImplementedError extends Error {
  constructor() {
    super('dsh-imchat: the WhatsApp adapter is not implemented yet (deferred per design doc §6/Baileys integration)')
    this.name = 'WhatsAppNotImplementedError'
  }
}

/** `ChatAdapter` placeholder — every method rejects until Baileys pairing is implemented. */
export class WhatsAppAdapter implements ChatAdapter {
  readonly platform = 'whatsapp' as const

  async start(): Promise<void> {
    throw new WhatsAppNotImplementedError()
  }

  async stop(): Promise<void> {}

  async sendText(_chatId: string, _text: string): Promise<string> {
    throw new WhatsAppNotImplementedError()
  }

  async editText(_chatId: string, _messageId: string, _text: string): Promise<void> {
    throw new WhatsAppNotImplementedError()
  }

  async sendPrompt(_chatId: string, _prompt: PendingPrompt): Promise<void> {
    throw new WhatsAppNotImplementedError()
  }

  onMessage(_handler: (message: InboundMessage) => void): void {}

  onPromptReply(_handler: (reply: PromptReply) => void): void {}
}
