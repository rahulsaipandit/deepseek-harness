/**
 * Minimal in-memory mock of the Slack Web API calls `SlackAdapter` makes
 * (`chat.postMessage`, `chat.update`). Socket Mode's actual WebSocket
 * handshake is out of scope here by design — see `slack.ts`'s module doc —
 * so event delivery is exercised through `FakeSlackEventsClient` below, not
 * this HTTP mock.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SentSlackMessage {
  readonly channel: string
  readonly text: string
  readonly blocks?: unknown
}

export interface MockSlackServer {
  readonly baseUrl: string
  readonly sent: SentSlackMessage[]
  readonly updated: { channel: string, ts: string, text: string }[]
  close(): Promise<void>
}

export async function startMockSlackServer(): Promise<MockSlackServer> {
  const sent: SentSlackMessage[] = []
  const updated: { channel: string, ts: string, text: string }[] = []
  let nextTs = 1

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body: Record<string, unknown> = raw.length > 0 ? JSON.parse(raw) : {}
      const url = req.url ?? ''
      const respond = (result: Record<string, unknown>): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...result }))
      }
      if (url.endsWith('/chat.postMessage')) {
        const ts = String(nextTs)
        nextTs += 1
        sent.push({ channel: String(body.channel), text: String(body.text), blocks: body.blocks })
        respond({ ts, channel: body.channel })
        return
      }
      if (url.endsWith('/chat.update')) {
        updated.push({ channel: String(body.channel), ts: String(body.ts), text: String(body.text) })
        respond({ ts: body.ts, channel: body.channel })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: `unmocked method ${url}` }))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}/api`

  return {
    baseUrl,
    sent,
    updated,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

/** In-memory stand-in for a real Socket Mode client, for tests only. */
export class FakeSlackEventsClient {
  private messageHandler: ((event: { channel: string, user: string, text: string }) => void) | undefined
  private blockActionHandler: ((action: { channel: string, actionId: string }) => void) | undefined
  started = false

  async start(): Promise<void> {
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  onMessage(handler: (event: { channel: string, user: string, text: string }) => void): void {
    this.messageHandler = handler
  }

  onBlockAction(handler: (action: { channel: string, actionId: string }) => void): void {
    this.blockActionHandler = handler
  }

  /** Test helper: simulate an inbound Slack message event. */
  emitMessage(event: { channel: string, user: string, text: string }): void {
    this.messageHandler?.(event)
  }

  /** Test helper: simulate a user tapping a Block Kit button. */
  emitBlockAction(action: { channel: string, actionId: string }): void {
    this.blockActionHandler?.(action)
  }
}
