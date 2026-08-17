import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvalidTelegramTokenError, TelegramAdapter } from '../../src/adapters/telegram.ts'
import type { InboundMessage, PromptReply } from '../../src/core/types.ts'
import { startMockTelegramServer, type MockTelegramServer } from '../mocks/telegram-mock-server.ts'

describe('TelegramAdapter', () => {
  it('rejects a bot token that does not match the Bot API format', () => {
    expect(() => new TelegramAdapter({ token: 'not-a-token' })).toThrow(InvalidTelegramTokenError)
  })

  describe('against the mock Bot API', () => {
    let server: MockTelegramServer
    let adapter: TelegramAdapter

    beforeEach(async () => {
      server = await startMockTelegramServer()
      adapter = new TelegramAdapter({
        token: '123456:TESTTOKENTESTTOKENTEST',
        baseUrl: server.baseUrl,
        pollIntervalMs: 10,
      })
    })

    afterEach(async () => {
      await adapter.stop()
      await server.close()
    })

    it('sendText posts to the mock sendMessage endpoint and returns a message id', async () => {
      const messageId = await adapter.sendText('42', 'hello there')
      expect(server.sent).toEqual([{ chatId: '42', text: 'hello there', replyMarkup: undefined }])
      expect(messageId).toBe('1')
    })

    it('editText posts to the mock editMessageText endpoint', async () => {
      await adapter.editText('42', '7', 'edited text')
      expect(server.edited).toEqual([{ chatId: '42', messageId: '7', text: 'edited text' }])
    })

    it('sendPrompt renders an inline keyboard with callback_data `<promptId>:<optionId>`', async () => {
      await adapter.sendPrompt('42', {
        id: 'p1',
        kind: 'approval',
        text: 'Allow bash?',
        options: [{ id: 'allow', label: 'Allow' }, { id: 'reject', label: 'Reject' }],
      })
      expect(server.sent).toHaveLength(1)
      expect(server.sent[0]!.replyMarkup).toEqual({
        inline_keyboard: [
          [{ text: 'Allow', callback_data: 'p1:allow' }],
          [{ text: 'Reject', callback_data: 'p1:reject' }],
        ],
      })
    })

    it('delivers an inbound text message from getUpdates to the message handler', async () => {
      const received: InboundMessage[] = []
      adapter.onMessage(message => received.push(message))
      await adapter.start()

      server.enqueueUpdate({
        update_id: 100,
        message: { message_id: 5, chat: { id: 42 }, from: { id: 99 }, text: 'hi bot' },
      })

      await vi.waitFor(() => expect(received).toHaveLength(1))
      expect(received[0]).toEqual({ chatId: '42', senderId: '99', text: 'hi bot' })
    })

    it('delivers a callback_query as a prompt reply and acknowledges it via answerCallbackQuery', async () => {
      const replies: PromptReply[] = []
      adapter.onPromptReply(reply => replies.push(reply))
      await adapter.start()

      server.enqueueUpdate({
        update_id: 101,
        callback_query: { id: 'cbq1', data: 'p1:allow', message: { chat: { id: 42 } } },
      })

      await vi.waitFor(() => expect(replies).toHaveLength(1))
      expect(replies[0]).toEqual({ chatId: '42', promptId: 'p1', optionId: 'allow' })
      await vi.waitFor(() => expect(server.answeredCallbacks).toEqual(['cbq1']))
    })

    it('advances the update offset so a processed update is never redelivered', async () => {
      const received: InboundMessage[] = []
      adapter.onMessage(message => received.push(message))
      await adapter.start()

      server.enqueueUpdate({ update_id: 200, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: 'first' } })
      await vi.waitFor(() => expect(received).toHaveLength(1))

      // A stale re-delivery of the same update (as a real Bot API would never do once offset advances)
      // must not reach the handler again — this only holds if the adapter sent the new offset.
      server.enqueueUpdate({ update_id: 200, message: { message_id: 1, chat: { id: 1 }, from: { id: 1 }, text: 'first' } })
      server.enqueueUpdate({ update_id: 201, message: { message_id: 2, chat: { id: 1 }, from: { id: 1 }, text: 'second' } })
      await vi.waitFor(() => expect(received).toHaveLength(2))
      expect(received.map(m => m.text)).toEqual(['first', 'second'])
    })
  })
})
