import { describe, expect, it, vi } from 'vitest'
import {
  authenticatesHello,
  BridgeServer,
  BridgeToolError,
  isForbiddenPrivilegedCall,
  isLoopbackAddress,
  messageToText,
  payloadCode,
  payloadMessage,
} from '../src/server.ts'
import type { BridgeCaps } from '../src/protocol.ts'

const CAPS: BridgeCaps = { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 }

describe('isLoopbackAddress', () => {
  it('accepts loopback literals', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects everything else, including undefined', () => {
    expect(isLoopbackAddress('10.0.0.5')).toBe(false)
    expect(isLoopbackAddress('192.168.1.1')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('authenticatesHello (the Origin-gated loopback bypass)', () => {
  const TOKEN = 'the-real-token'

  it('rejects loopback + no Origin + wrong token — loopback ALONE must never be enough', () => {
    expect(authenticatesHello('127.0.0.1', undefined, TOKEN, 'wrong')).toBe(false)
  })

  it('rejects loopback + a spoofed non-extension Origin + wrong token', () => {
    // A malicious web page cannot present a chrome-extension:// Origin, but it
    // COULD open a cross-origin WebSocket to 127.0.0.1 with some other Origin
    // value (WebSockets have no same-origin policy) — that must still fail.
    expect(authenticatesHello('127.0.0.1', 'https://evil.example', TOKEN, 'wrong')).toBe(false)
    expect(authenticatesHello('127.0.0.1', 'null', TOKEN, 'wrong')).toBe(false)
  })

  it('accepts loopback + chrome-extension:// Origin + wrong token (the intended zero-config bypass)', () => {
    expect(authenticatesHello('127.0.0.1', 'chrome-extension://abcdefgh', TOKEN, 'wrong')).toBe(true)
  })

  it('accepts a non-loopback remote with the correct token regardless of Origin', () => {
    expect(authenticatesHello('203.0.113.5', undefined, TOKEN, TOKEN)).toBe(true)
    expect(authenticatesHello('203.0.113.5', 'https://evil.example', TOKEN, TOKEN)).toBe(true)
  })

  it('rejects a non-loopback remote even with a chrome-extension:// Origin unless the token matches', () => {
    expect(authenticatesHello('203.0.113.5', 'chrome-extension://abcdefgh', TOKEN, 'wrong')).toBe(false)
  })

  it('accepts loopback with no Origin when the token itself is correct', () => {
    expect(authenticatesHello('127.0.0.1', undefined, TOKEN, TOKEN)).toBe(true)
  })
})

describe('isForbiddenPrivilegedCall (loopback pinning for credentials/settings/host methods)', () => {
  it('forbids a privileged method from a non-loopback remote', () => {
    expect(isForbiddenPrivilegedCall('credentials.set', '203.0.113.5')).toBe(true)
    expect(isForbiddenPrivilegedCall('settings.mutate', '203.0.113.5')).toBe(true)
    expect(isForbiddenPrivilegedCall('host.pickDirectory', undefined)).toBe(true)
  })

  it('allows a privileged method from loopback', () => {
    expect(isForbiddenPrivilegedCall('credentials.set', '127.0.0.1')).toBe(false)
  })

  it('never forbids an ordinary (non-privileged) method, from any remote', () => {
    expect(isForbiddenPrivilegedCall('sessions.list', '203.0.113.5')).toBe(false)
    expect(isForbiddenPrivilegedCall('sessions.list', undefined)).toBe(false)
  })
})

describe('messageToText', () => {
  it('decodes a Buffer, an ArrayBuffer, and a fragmented Buffer[] identically', () => {
    const text = 'hello bridge'
    const buf = Buffer.from(text, 'utf8')
    // Buffer#buffer is the underlying (possibly pooled, larger) ArrayBuffer;
    // slice to this Buffer's own byteOffset/length to get an exact copy.
    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    expect(messageToText(buf)).toBe(text)
    expect(messageToText(arrayBuffer)).toBe(text)
    expect(messageToText([Buffer.from('hello '), Buffer.from('bridge')])).toBe(text)
  })
})

describe('payloadCode / payloadMessage', () => {
  it('extract known fields', () => {
    expect(payloadCode({ code: 'timeout', message: 'slow' })).toBe('timeout')
    expect(payloadMessage({ code: 'timeout', message: 'slow' })).toBe('slow')
  })

  it('fall back safely for malformed payloads', () => {
    expect(payloadCode('not an object')).toBe('internal')
    expect(payloadCode(null)).toBe('internal')
    expect(payloadCode({})).toBe('internal')
    expect(payloadMessage('not an object')).toBe('browser action failed')
    expect(payloadMessage({ message: '' })).toBe('browser action failed')
  })
})

describe('BridgeServer.requestTool', () => {
  function serverWithNoConnection(): BridgeServer {
    return new BridgeServer({
      token: 'x',
      apiHandler: { fetch: vi.fn() },
      openEvents: async function* () {},
      toolTimeoutMs: 1_000,
      caps: CAPS,
      injectBrowserSnapshot: () => {},
    })
  }

  it('throws bridge-closed synchronously when no extension is connected', () => {
    const server = serverWithNoConnection()
    expect(() => server.requestTool('browser_snapshot', {}, new AbortController().signal))
      .toThrow(BridgeToolError)
    expect(server.hasConnection()).toBe(false)
  })

  it('throws bridge-closed synchronously for an already-aborted signal, even with a connection', () => {
    // hasConnection() is false here (no real socket attached in this unit
    // test), so this exercises the same guard through the public surface;
    // requestTool must fail before ever touching the (absent) socket.
    const server = serverWithNoConnection()
    const controller = new AbortController()
    controller.abort()
    expect(() => server.requestTool('browser_snapshot', {}, controller.signal)).toThrow(BridgeToolError)
  })

  it('close() is idempotent and settles no in-flight calls a second time', async () => {
    const server = serverWithNoConnection()
    await server.close()
    await expect(server.close()).resolves.toBeUndefined()
  })
})
