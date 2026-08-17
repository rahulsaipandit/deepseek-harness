/**
 * Minimal in-memory mock of the Telegram Bot API surface `TelegramAdapter`
 * uses: `getUpdates`, `sendMessage`, `editMessageText`, `answerCallbackQuery`.
 * Not a protocol-faithful reimplementation — just enough to drive and assert
 * against the adapter without a real bot token or network access.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SentMessage {
  readonly chatId: string
  readonly text: string
  readonly replyMarkup?: unknown
}

export interface MockTelegramServer {
  readonly baseUrl: string
  readonly sent: SentMessage[]
  readonly edited: { chatId: string, messageId: string, text: string }[]
  readonly answeredCallbacks: string[]
  enqueueUpdate(update: Record<string, unknown>): void
  close(): Promise<void>
}

export async function startMockTelegramServer(token = '123456:TESTTOKENTESTTOKENTEST'): Promise<MockTelegramServer> {
  const updateQueue: Record<string, unknown>[] = []
  const sent: SentMessage[] = []
  const edited: { chatId: string, messageId: string, text: string }[] = []
  const answeredCallbacks: string[] = []
  let nextMessageId = 1

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: Record<string, unknown> = raw.length > 0 ? JSON.parse(raw) : {}
      const url = req.url ?? ''
      const respond = (result: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (url.endsWith('/getMe')) {
        respond({ id: 1, is_bot: true, first_name: 'MockBot', username: 'mock_bot' })
        return
      }
      if (url.endsWith('/getUpdates')) {
        // Real Bot API semantics: requesting `offset` acknowledges every update below it,
        // which the server then never redelivers — the adapter relies on this to advance
        // past processed updates. `getUpdates()` itself is idempotent (`offset` is a read
        // param, not a mutation), so this only drops what falls below the requested offset.
        const offset = typeof body.offset === 'number' ? body.offset : 0
        const deliverable = updateQueue.filter(update => Number(update.update_id) >= offset)
        for (const update of deliverable) {
          const index = updateQueue.indexOf(update)
          if (index >= 0) updateQueue.splice(index, 1)
        }
        respond(deliverable)
        return
      }
      if (url.endsWith('/sendMessage')) {
        const messageId = nextMessageId
        nextMessageId += 1
        sent.push({ chatId: String(body.chat_id), text: String(body.text), replyMarkup: body.reply_markup })
        respond({ message_id: messageId, chat: { id: body.chat_id }, text: body.text })
        return
      }
      if (url.endsWith('/editMessageText')) {
        edited.push({ chatId: String(body.chat_id), messageId: String(body.message_id), text: String(body.text) })
        respond(true)
        return
      }
      if (url.endsWith('/answerCallbackQuery')) {
        answeredCallbacks.push(String(body.callback_query_id))
        respond(true)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, description: `unmocked method ${url}` }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/bot${token}`

  return {
    baseUrl,
    sent,
    edited,
    answeredCallbacks,
    enqueueUpdate(update) {
      updateQueue.push(update)
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}
