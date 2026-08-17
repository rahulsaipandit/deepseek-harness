/**
 * Approval/question relay (design doc §3): renders a pending decision as
 * native chat buttons through whichever adapter owns the session's bound
 * chat, and resolves fail-closed on timeout, adapter disconnect, or a
 * malformed reply — the one behavior taken verbatim from `dsh-telegram-duty`,
 * because "ambiguous -> deny" is the only safe default for something that
 * gates tool execution.
 *
 * Approvals and questions use two different host seams (confirmed by reading
 * `@deepseek-ai/dsh-user-approval`/`@deepseek-ai/dsh-user-questions` source,
 * not assumed): `handleApprovalRequest` is a Cordis waterfall participant
 * that defers (`next()`) for any session this plugin didn't bind, so it
 * composes with another UI's own approval answerer on the same host.
 * `ImChatQuestionProvider.ask` implements the OTHER seam's single registered
 * provider, which this plugin's host is assumed to own exclusively (see
 * design doc, Non-goals) — registering it while another UI is attached would
 * throw `DUPLICATE_PROVIDER`.
 * @module dsh-plugin-imchat/core/approval-relay
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ChatAdapter, PendingPrompt, PendingPromptOption, Platform, PromptReply } from './types.ts'
import type { ChatLocation } from './session-router.ts'

/** Approval outcome vocabulary mirrored from `@deepseek-ai/dsh-user-approval` (kept dependency-free here). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** The slice of `ApprovalRequest` this relay reads. */
export interface RelayApprovalRequest {
  readonly agent: { readonly id: SessionId }
  readonly toolName: string
  readonly reason?: string
  readonly signal?: AbortSignal
}

/** The slice of `AskUserQuestionRequest`/`Answer` this relay reads and produces. */
export interface RelayQuestionItem {
  readonly id: string
  readonly question: string
  readonly options?: readonly { readonly label: string }[]
}
export interface RelayQuestionRequest {
  readonly questions: readonly RelayQuestionItem[]
  readonly agent?: { readonly id: SessionId }
  readonly signal?: AbortSignal
}
export interface RelayQuestionAnswerItem {
  readonly id: string
  readonly selected: string[]
}
export interface RelayQuestionAnswer {
  readonly answers: RelayQuestionAnswerItem[]
}

const APPROVE_OPTIONS: readonly PendingPromptOption[] = [
  { id: 'allow', label: 'Allow' },
  { id: 'reject', label: 'Reject' },
]

interface PendingEntry {
  readonly resolve: (optionId: string | undefined) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly onAbort: (() => void) | undefined
  readonly signal: AbortSignal | undefined
}

/** Renders prompts through adapters and resolves them by opaque id, fail-closed always. */
export class ApprovalRelay {
  private readonly pending = new Map<string, PendingEntry>()
  private nextId = 0

  constructor(
    private readonly adapters: ReadonlyMap<Platform, ChatAdapter>,
    private readonly locate: (sessionId: SessionId) => ChatLocation | undefined,
    private readonly timeoutMs: number,
  ) {
    for (const adapter of adapters.values()) {
      adapter.onPromptReply(reply => this.settle(reply))
    }
  }

  private mintPromptId(): string {
    this.nextId += 1
    return `p${this.nextId}`
  }

  private settle(reply: PromptReply): void {
    const entry = this.pending.get(reply.promptId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener('abort', entry.onAbort)
    }
    this.pending.delete(reply.promptId)
    entry.resolve(reply.optionId)
  }

  /**
   * Renders one prompt to `location`'s chat and waits for a reply.
   * @returns the chosen option id, or `undefined` on timeout, disconnect, or abort — always treat `undefined` as reject.
   */
  private async prompt(
    location: ChatLocation,
    kind: PendingPrompt['kind'],
    text: string,
    options: readonly PendingPromptOption[],
    signal: AbortSignal | undefined,
  ): Promise<string | undefined> {
    const adapter = this.adapters.get(location.platform)
    if (adapter === undefined) return undefined
    const promptId = this.mintPromptId()
    return new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(promptId)
        resolve(undefined)
      }, this.timeoutMs)
      const onAbort: (() => void) | undefined = signal === undefined ? undefined : () => {
        clearTimeout(timer)
        this.pending.delete(promptId)
        resolve(undefined)
      }
      if (signal !== undefined && onAbort !== undefined) signal.addEventListener('abort', onAbort)
      this.pending.set(promptId, { resolve, timer, signal, onAbort })
      adapter.sendPrompt(location.chatId, { id: promptId, kind, text, options }).catch(() => {
        this.settle({ chatId: location.chatId, promptId, optionId: '' })
      })
    })
  }

  /** `ctx.on('approval/request', handler)` participant: defers via `next()` for sessions this plugin didn't bind. */
  async handleApprovalRequest(
    req: RelayApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const location = this.locate(req.agent.id)
    if (location === undefined) return next()
    const text = req.reason !== undefined && req.reason.length > 0
      ? `${req.toolName}: ${req.reason}`
      : `Allow ${req.toolName}?`
    const optionId = await this.prompt(location, 'approval', text, APPROVE_OPTIONS, req.signal)
    return optionId === 'allow' ? 'allowed-once' : 'rejected'
  }

  /** `UserQuestionProvider.ask` implementation — see the class doc for the seam-ownership caveat. */
  async ask(request: RelayQuestionRequest): Promise<RelayQuestionAnswer> {
    const sessionId = request.agent?.id
    if (sessionId === undefined) {
      throw new Error('dsh-imchat: chat-relayed questions require an agent-owned session')
    }
    const location = this.locate(sessionId)
    if (location === undefined) {
      throw new Error(`dsh-imchat: session ${sessionId} is not bound to any chat this plugin manages`)
    }
    const answers: RelayQuestionAnswerItem[] = []
    for (const question of request.questions) {
      const options = (question.options ?? []).map((option, index) => ({ id: String(index), label: option.label }))
      const optionId = await this.prompt(location, 'question', question.question, options, request.signal)
      const chosen = options.find(option => option.id === optionId)
      answers.push({ id: question.id, selected: chosen === undefined ? [] : [chosen.label] })
    }
    return { answers }
  }
}
