import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '../src/providers.ts'
import { callVisionProvider, VisionApiFetchError, VisionApiParseError } from '../src/vision-api.ts'

const PROVIDER: ProviderConfig = {
  id: 'mimo', label: 'MiMo', baseUrl: 'https://api.example.com/v1', model: 'mimo-v2.5', credentialRef: 'MIMO_API_KEY',
  authHeaderName: 'api-key', maxTokensField: 'max_completion_tokens',
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

describe('callVisionProvider', () => {
  it('sends the image and prompt with the provider-specific auth header and max-tokens field', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return jsonResponse({ choices: [{ message: { content: 'a red circle' } }] })
    }) as unknown as typeof fetch

    const result = await callVisionProvider(PROVIDER, 'sekret', 'data:image/png;base64,AA==', 'describe it', {
      timeoutMs: 1000, maxTokens: 256, maxResponseBytes: 1024 * 1024, fetchImpl,
    })

    expect(result.text).toBe('a red circle')
    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['api-key']).toBe('sekret')
    expect(headers.Authorization).toBeUndefined()
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(256)
    expect(body.max_tokens).toBeUndefined()
  })

  it('joins array-of-parts content the way some OpenAI-compatible providers reply', async () => {
    const fetchImpl = (async () => jsonResponse({
      choices: [{ message: { content: [{ type: 'text', text: 'left half. ' }, { type: 'text', text: 'right half.' }] } }],
    })) as unknown as typeof fetch
    const result = await callVisionProvider(PROVIDER, 'k', 'data:image/png;base64,AA==', 'p', {
      timeoutMs: 1000, maxTokens: 10, maxResponseBytes: 1024, fetchImpl,
    })
    expect(result.text).toBe('left half. right half.')
  })

  it('refuses a non-https provider URL before ever calling fetch', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; return jsonResponse({}) }) as unknown as typeof fetch
    const httpProvider: ProviderConfig = { ...PROVIDER, baseUrl: 'http://api.example.com/v1' }
    await expect(callVisionProvider(httpProvider, 'k', 'data:image/png;base64,AA==', 'p', {
      timeoutMs: 1000, maxTokens: 10, maxResponseBytes: 1024, fetchImpl,
    })).rejects.toThrow(VisionApiFetchError)
    expect(called).toBe(false)
  })

  it('throws VisionApiFetchError on a non-2xx response, including the body detail', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch
    await expect(callVisionProvider(PROVIDER, 'k', 'data:image/png;base64,AA==', 'p', {
      timeoutMs: 1000, maxTokens: 10, maxResponseBytes: 1024, fetchImpl,
    })).rejects.toThrow(/HTTP 429/)
  })

  it('throws VisionApiParseError when the response has no message content', async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [] })) as unknown as typeof fetch
    await expect(callVisionProvider(PROVIDER, 'k', 'data:image/png;base64,AA==', 'p', {
      timeoutMs: 1000, maxTokens: 10, maxResponseBytes: 1024, fetchImpl,
    })).rejects.toThrow(VisionApiParseError)
  })

  it('throws VisionApiParseError on invalid JSON', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    await expect(callVisionProvider(PROVIDER, 'k', 'data:image/png;base64,AA==', 'p', {
      timeoutMs: 1000, maxTokens: 10, maxResponseBytes: 1024, fetchImpl,
    })).rejects.toThrow(VisionApiParseError)
  })
})
