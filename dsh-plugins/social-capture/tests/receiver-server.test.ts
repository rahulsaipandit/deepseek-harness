import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { registerSocialCaptureServer } from '../src/web/receiver-server.ts'
import { RateLimiter } from '../src/rate-limit.ts'

function fakeCtx() {
  return { effect: (execute: () => unknown) => { execute() }, logger: { warn: vi.fn() } } as unknown as Context
}

function fakeWebServer() {
  const registered: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[] = []
  const webServer = {
    host: '127.0.0.1',
    port: 4123,
    register: vi.fn((route: typeof registered[number]) => {
      registered.push(route)
      return () => {}
    }),
  } as unknown as WebServer
  return { webServer, registered }
}

interface FakeReq {
  method: string
  headers: Record<string, string>
  socket: { remoteAddress: string }
  body: string
}

function fakeReqRes(req: FakeReq) {
  const dataHandlers: ((chunk: Buffer) => void)[] = []
  let endHandler: (() => void) | undefined
  const incoming = {
    method: req.method,
    headers: req.headers,
    socket: req.socket,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'data') dataHandlers.push(handler as (chunk: Buffer) => void)
      if (event === 'end') endHandler = handler as () => void
      return incoming
    },
    destroy: vi.fn(),
  } as unknown as IncomingMessage

  // Body delivery is triggered explicitly by the test after registering handlers,
  // via the returned `deliver()` — mirroring how node:http actually emits events.
  const deliver = () => {
    dataHandlers.forEach(h => h(Buffer.from(req.body, 'utf8')))
    endHandler?.()
  }

  let statusCode = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string>) => {
      statusCode = code
      if (hdrs) headers = hdrs
      return res
    }),
    setHeader: vi.fn(),
    end: vi.fn((text?: string) => { if (text) body = text }),
  } as unknown as ServerResponse

  return { incoming, res, deliver, result: () => ({ statusCode, headers, body }) }
}

const TOKEN = 'test-token-value'

async function setup(onCapture: (payload: unknown) => Promise<{ ok: true; id: string } | { ok: false; error: string }>) {
  const ctx = fakeCtx()
  const { webServer, registered } = fakeWebServer()
  const rateLimiter = new RateLimiter({ limit: 10, windowMs: 60_000 })
  const url = registerSocialCaptureServer(ctx, webServer, {
    webPath: '/social-capture',
    captureEndpoint: 'http://127.0.0.1:4123/social-capture/capture',
    platforms: ['instagram'],
    token: TOKEN,
    corsOrigins: ['https://www.instagram.com'],
    maxBodyBytes: 1024,
    rateLimiter,
    onCapture: onCapture as never,
  })
  const captureRoute = registered.find(r => r.path.endsWith('/capture'))!
  const installRoute = registered.find(r => r.path === '/social-capture')!
  return { url, captureRoute, installRoute }
}

describe('registerSocialCaptureServer', () => {
  it('serves the install page at the base path', async () => {
    const { installRoute } = await setup(async () => ({ ok: true, id: 'x' }))
    const { incoming, res, result } = fakeReqRes({ method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: '' })
    await installRoute.handler(incoming, res)
    expect(result().statusCode).toBe(200)
    expect(result().body).toContain('instagram')
  })

  it('rejects a capture request with no token', async () => {
    const { captureRoute } = await setup(async () => ({ ok: true, id: 'x' }))
    const { incoming, res, deliver, result } = fakeReqRes({ method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, body: '{}' })
    const p = captureRoute.handler(incoming, res)
    deliver()
    await p
    expect(result().statusCode).toBe(401)
  })

  it('rejects a capture request with the wrong token', async () => {
    const { captureRoute } = await setup(async () => ({ ok: true, id: 'x' }))
    const { incoming, res, deliver, result } = fakeReqRes({
      method: 'POST',
      headers: { 'x-capture-token': 'wrong' },
      socket: { remoteAddress: '127.0.0.1' },
      body: '{}',
    })
    const p = captureRoute.handler(incoming, res)
    deliver()
    await p
    expect(result().statusCode).toBe(401)
  })

  it('accepts a valid capture and calls onCapture with the parsed payload', async () => {
    const onCapture = vi.fn(async () => ({ ok: true as const, id: 'social_123' }))
    const { captureRoute } = await setup(onCapture)
    const payload = { platform: 'instagram', url: 'https://instagram.com/p/x', text: 'hello' }
    const { incoming, res, deliver, result } = fakeReqRes({
      method: 'POST',
      headers: { 'x-capture-token': TOKEN },
      socket: { remoteAddress: '127.0.0.1' },
      body: JSON.stringify(payload),
    })
    const p = captureRoute.handler(incoming, res)
    deliver()
    await p
    expect(result().statusCode).toBe(200)
    expect(JSON.parse(result().body)).toEqual({ id: 'social_123' })
    expect(onCapture).toHaveBeenCalledWith(expect.objectContaining({ platform: 'instagram', url: payload.url }))
  })

  it('rejects a malformed capture payload with 400 before calling onCapture', async () => {
    const onCapture = vi.fn(async () => ({ ok: true as const, id: 'x' }))
    const { captureRoute } = await setup(onCapture)
    const { incoming, res, deliver, result } = fakeReqRes({
      method: 'POST',
      headers: { 'x-capture-token': TOKEN },
      socket: { remoteAddress: '127.0.0.1' },
      body: JSON.stringify({ platform: 'instagram' }),
    })
    const p = captureRoute.handler(incoming, res)
    deliver()
    await p
    expect(result().statusCode).toBe(400)
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('rejects a request body larger than maxBodyBytes with 413', async () => {
    const { captureRoute } = await setup(async () => ({ ok: true, id: 'x' }))
    const bigBody = JSON.stringify({ platform: 'instagram', url: 'https://x', text: 'y'.repeat(2000) })
    const { incoming, res, deliver, result } = fakeReqRes({
      method: 'POST',
      headers: { 'x-capture-token': TOKEN },
      socket: { remoteAddress: '127.0.0.1' },
      body: bigBody,
    })
    const p = captureRoute.handler(incoming, res)
    deliver()
    await p
    expect(result().statusCode).toBe(413)
  })

  it('rejects requests once the rate limit is exhausted', async () => {
    const ctx = fakeCtx()
    const { webServer, registered } = fakeWebServer()
    const rateLimiter = new RateLimiter({ limit: 1, windowMs: 60_000 })
    registerSocialCaptureServer(ctx, webServer, {
      webPath: '/social-capture',
      captureEndpoint: 'http://x/capture',
      platforms: ['instagram'],
      token: TOKEN,
      corsOrigins: [],
      maxBodyBytes: 1024,
      rateLimiter,
      onCapture: async () => ({ ok: true, id: 'x' }),
    })
    const captureRoute = registered.find(r => r.path.endsWith('/capture'))!
    const payload = JSON.stringify({ platform: 'instagram', url: 'https://x', text: 'hi' })

    const first = fakeReqRes({ method: 'POST', headers: { 'x-capture-token': TOKEN }, socket: { remoteAddress: '1.2.3.4' }, body: payload })
    const p1 = captureRoute.handler(first.incoming, first.res)
    first.deliver()
    await p1
    expect(first.result().statusCode).toBe(200)

    const second = fakeReqRes({ method: 'POST', headers: { 'x-capture-token': TOKEN }, socket: { remoteAddress: '1.2.3.4' }, body: payload })
    const p2 = captureRoute.handler(second.incoming, second.res)
    second.deliver()
    await p2
    expect(second.result().statusCode).toBe(429)
  })
})
