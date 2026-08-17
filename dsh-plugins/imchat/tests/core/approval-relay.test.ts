import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalRelay } from '../../src/core/approval-relay.ts'
import type { ChatAdapter, InboundMessage, PendingPrompt, PromptReply } from '../../src/core/types.ts'
import type { ChatLocation } from '../../src/core/session-router.ts'

class FakeAdapter implements ChatAdapter {
  readonly platform = 'telegram' as const
  readonly sentPrompts: { chatId: string, prompt: PendingPrompt }[] = []
  private promptReplyHandler: ((reply: PromptReply) => void) | undefined
  /** When set, `sendPrompt` rejects instead of recording — simulates an adapter disconnect. */
  failSend = false

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendText(): Promise<string> { return '1' }
  async editText(): Promise<void> {}

  async sendPrompt(chatId: string, prompt: PendingPrompt): Promise<void> {
    if (this.failSend) throw new Error('adapter disconnected')
    this.sentPrompts.push({ chatId, prompt })
  }

  onMessage(_handler: (message: InboundMessage) => void): void {}

  onPromptReply(handler: (reply: PromptReply) => void): void {
    this.promptReplyHandler = handler
  }

  /** Test helper: simulate the user tapping a button. */
  reply(reply: PromptReply): void {
    this.promptReplyHandler?.(reply)
  }
}

const SESSION_A = SessionId('session-a')
const LOCATION_A: ChatLocation = { platform: 'telegram', chatId: 'chat-a' }

function makeRelay(adapter: FakeAdapter, timeoutMs = 50) {
  const adapters = new Map([['telegram', adapter] as const])
  const locate = (sessionId: ReturnType<typeof SessionId>): ChatLocation | undefined =>
    sessionId === SESSION_A ? LOCATION_A : undefined
  return new ApprovalRelay(adapters, locate, timeoutMs)
}

describe('ApprovalRelay approvals', () => {
  it('resolves allowed-once when the adapter reports the allow option', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter)
    const next = vi.fn()

    const pending = relay.handleApprovalRequest({ agent: { id: SESSION_A }, toolName: 'bash' }, next)
    await vi.waitFor(() => expect(adapter.sentPrompts).toHaveLength(1))
    adapter.reply({ chatId: 'chat-a', promptId: adapter.sentPrompts[0]!.prompt.id, optionId: 'allow' })

    await expect(pending).resolves.toBe('allowed-once')
    expect(next).not.toHaveBeenCalled()
  })

  it('resolves rejected when the adapter reports the reject option', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter)

    const pending = relay.handleApprovalRequest({ agent: { id: SESSION_A }, toolName: 'bash' }, vi.fn())
    await vi.waitFor(() => expect(adapter.sentPrompts).toHaveLength(1))
    adapter.reply({ chatId: 'chat-a', promptId: adapter.sentPrompts[0]!.prompt.id, optionId: 'reject' })

    await expect(pending).resolves.toBe('rejected')
  })

  it('fails closed (rejected) on timeout when nobody replies', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter, 20)
    const outcome = await relay.handleApprovalRequest({ agent: { id: SESSION_A }, toolName: 'bash' }, vi.fn())
    expect(outcome).toBe('rejected')
  })

  it('fails closed (rejected) when the adapter is disconnected and sendPrompt throws', async () => {
    const adapter = new FakeAdapter()
    adapter.failSend = true
    const relay = makeRelay(adapter, 20)
    const outcome = await relay.handleApprovalRequest({ agent: { id: SESSION_A }, toolName: 'bash' }, vi.fn())
    expect(outcome).toBe('rejected')
  })

  it('defers via next() for a session this plugin did not bind to a chat', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter)
    const next = vi.fn().mockResolvedValue('allowed-once')
    const outcome = await relay.handleApprovalRequest({ agent: { id: SessionId('unbound-session') }, toolName: 'bash' }, next)
    expect(next).toHaveBeenCalledOnce()
    expect(outcome).toBe('allowed-once')
    expect(adapter.sentPrompts).toHaveLength(0)
  })
})

describe('ApprovalRelay questions', () => {
  it('answers with the selected option label', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter)

    const pending = relay.ask({
      questions: [{ id: 'q1', question: 'Which env?', options: [{ label: 'staging' }, { label: 'prod' }] }],
      agent: { id: SESSION_A },
    })
    await vi.waitFor(() => expect(adapter.sentPrompts).toHaveLength(1))
    adapter.reply({ chatId: 'chat-a', promptId: adapter.sentPrompts[0]!.prompt.id, optionId: '1' })

    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['prod'] }] })
  })

  it('rejects when the request has no agent-owned session', async () => {
    const adapter = new FakeAdapter()
    const relay = makeRelay(adapter)
    await expect(relay.ask({ questions: [{ id: 'q1', question: 'x' }] })).rejects.toThrow()
  })
})
