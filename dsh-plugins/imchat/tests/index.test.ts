import { describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import { EmptyAllowlistError } from '../src/core/identity-registry.ts'
import type { ChatAdapter, InboundMessage, PendingPrompt, PromptReply } from '../src/core/types.ts'

class FakeAdapter implements ChatAdapter {
  readonly platform = 'telegram' as const
  started = false
  private messageHandler: ((message: InboundMessage) => void) | undefined

  async start(): Promise<void> { this.started = true }
  async stop(): Promise<void> { this.started = false }
  async sendText(): Promise<string> { return '1' }
  async editText(): Promise<void> {}
  async sendPrompt(_chatId: string, _prompt: PendingPrompt): Promise<void> {}
  onMessage(handler: (message: InboundMessage) => void): void { this.messageHandler = handler }
  onPromptReply(_handler: (reply: PromptReply) => void): void {}

  emit(message: InboundMessage): void {
    this.messageHandler?.(message)
  }
}

function fakeContext(): { ctx: any, agentsCreated: string[], followups: unknown[], questionsProvider: { current: any } } {
  const agentsCreated: string[] = []
  const followups: unknown[] = []
  const questionsProvider: { current: any } = { current: undefined }
  const live = new Map<string, { followup: (m: unknown) => void }>()

  const ctx = {
    credentials: {
      async resolve() { return { value: 'fake-token', source: 'test' } },
    },
    agents: {
      get: (id: string) => live.get(id),
      async create(options: { sessionId: string }) {
        agentsCreated.push(options.sessionId)
        const agent = { followup: (m: unknown) => followups.push(m) }
        live.set(options.sessionId, agent)
        return { agent, dispose: async () => { live.delete(options.sessionId) } }
      },
    },
    userQuestions: {
      registerProvider: (provider: unknown) => {
        questionsProvider.current = provider
        return () => { questionsProvider.current = undefined }
      },
    },
    on: () => () => {},
    effect: (fn: () => Generator<() => void, void, unknown>) => {
      const generator = fn()
      generator.next()
    },
  }
  return { ctx, agentsCreated, followups, questionsProvider }
}

describe('apply()', () => {
  it('refuses to start a platform with no configured identities', async () => {
    const { ctx } = fakeContext()
    const adapter = new FakeAdapter()
    const config = Config({ telegramTokenRef: 'DSH_IMCHAT_TELEGRAM_TOKEN' })
    await expect(apply(ctx as any, config, { telegramAdapter: adapter })).rejects.toThrow(EmptyAllowlistError)
  })

  it('routes an allow-listed sender\'s message into a newly created session', async () => {
    const { ctx, agentsCreated, followups } = fakeContext()
    const adapter = new FakeAdapter()
    const config = Config({
      telegramTokenRef: 'DSH_IMCHAT_TELEGRAM_TOKEN',
      identities: { telegram: [{ senderId: '99' }] },
    })
    await apply(ctx as any, config, { telegramAdapter: adapter })
    expect(adapter.started).toBe(true)

    adapter.emit({ chatId: '42', senderId: '99', text: 'hello' })
    await vi.waitFor(() => expect(agentsCreated).toHaveLength(1))
    expect(followups).toHaveLength(1)
  })

  it('silently drops a message from a sender not on the allowlist', async () => {
    const { ctx, agentsCreated } = fakeContext()
    const adapter = new FakeAdapter()
    const config = Config({
      telegramTokenRef: 'DSH_IMCHAT_TELEGRAM_TOKEN',
      identities: { telegram: [{ senderId: '99' }] },
    })
    await apply(ctx as any, config, { telegramAdapter: adapter })

    adapter.emit({ chatId: '42', senderId: 'not-allowed', text: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(agentsCreated).toHaveLength(0)
  })

  it('registers a userQuestions provider backed by the approval relay', async () => {
    const { ctx, questionsProvider } = fakeContext()
    const adapter = new FakeAdapter()
    const config = Config({
      telegramTokenRef: 'DSH_IMCHAT_TELEGRAM_TOKEN',
      identities: { telegram: [{ senderId: '99' }] },
    })
    await apply(ctx as any, config, { telegramAdapter: adapter })
    expect(questionsProvider.current).toBeDefined()
    expect(typeof questionsProvider.current.ask).toBe('function')
  })
})
