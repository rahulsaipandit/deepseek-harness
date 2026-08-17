/**
 * Platform-agnostic vocabulary shared by every adapter and the core relay
 * modules. An adapter never sees a DSH session or a Cordis context directly —
 * it only speaks this vocabulary, so `session-router` and `approval-relay`
 * work identically against Telegram, WhatsApp, or Slack.
 * @module dsh-plugin-imchat/core/types
 */

/** The platforms this plugin bridges. */
export type Platform = 'telegram' | 'whatsapp' | 'slack'

/** One inbound chat message, already resolved to a platform-native chat/sender pair. */
export interface InboundMessage {
  readonly chatId: string
  readonly senderId: string
  readonly text: string
}

/** One option a pending prompt offers; `id` is the opaque decision token echoed back on reply. */
export interface PendingPromptOption {
  readonly id: string
  readonly label: string
}

/**
 * A pending approval or question, adapter-rendered as native buttons.
 * `kind` distinguishes an approval (single allow/reject decision) from a
 * question (one of N labeled options) only for presentation — both resolve
 * through the same `(chatId, promptId, optionId)` reply path.
 */
export interface PendingPrompt {
  readonly id: string
  readonly kind: 'approval' | 'question'
  readonly text: string
  readonly options: readonly PendingPromptOption[]
}

/** A resolved pending-prompt reply, however the adapter obtained it (button tap or free text). */
export interface PromptReply {
  readonly chatId: string
  readonly promptId: string
  readonly optionId: string
}

/**
 * One platform adapter. Adapters own transport (long polling, Socket Mode,
 * multi-device pairing) and rendering; they hold no session-routing or
 * approval logic themselves — that's `session-router`/`approval-relay`'s job.
 */
export interface ChatAdapter {
  readonly platform: Platform
  start(): Promise<void>
  stop(): Promise<void>
  /** Send plain assistant text to a chat, returning an adapter-native message id for later edits. */
  sendText(chatId: string, text: string): Promise<string>
  /** Edit a previously sent message in place (streaming updates); a no-op fallback is acceptable. */
  editText(chatId: string, messageId: string, text: string): Promise<void>
  /** Render a pending prompt as native buttons (or the platform's best fallback). */
  sendPrompt(chatId: string, prompt: PendingPrompt): Promise<void>
  onMessage(handler: (message: InboundMessage) => void): void
  onPromptReply(handler: (reply: PromptReply) => void): void
}
