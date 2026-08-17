/**
 * Calls one OpenAI-compatible chat-completions vision endpoint with an
 * image + text prompt. Deliberately mirrors flight-search's `provider.ts`
 * fetch discipline (https-only, bounded timeout via `AbortController`,
 * bounded response size, defensive response-shape parsing) rather than
 * visionDS's `urllib`-based script, since that discipline is this repo's own
 * established pattern for an outbound fetch from a plugin.
 * @module dsh-plugin-vision-bridge/vision-api
 */

import { authHeaders, chatCompletionsUrl, type ProviderConfig } from './providers.ts'

/** Raised when the provider could not be reached at all, or replied with a non-2xx status. */
export class VisionApiFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VisionApiFetchError'
  }
}

/** Raised when the provider replied 2xx but the body didn't contain the expected message content. */
export class VisionApiParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'VisionApiParseError'
  }
}

export interface VisionCallOptions {
  timeoutMs: number
  maxTokens: number
  /** Refuse to buffer a response larger than this. */
  maxResponseBytes: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export interface VisionCallResult {
  text: string
  usage?: Record<string, unknown>
}

/**
 * Post one image (as a `data:` URL) plus a text prompt to `provider` and
 * return the model's text reply.
 * @param provider - the resolved route to call.
 * @param apiKey - the credential already resolved via `ctx.credentials` — never sourced or overridden here.
 * @param imageDataUrl - the image, already read/validated by `image-source.ts` and base64-encoded.
 * @param prompt - the fully-assembled text prompt (see `prompt.ts`).
 */
export async function callVisionProvider(
  provider: ProviderConfig,
  apiKey: string,
  imageDataUrl: string,
  prompt: string,
  options: VisionCallOptions,
): Promise<VisionCallResult> {
  const url = new URL(chatCompletionsUrl(provider.baseUrl))
  if (url.protocol !== 'https:') {
    throw new VisionApiFetchError(`refusing a non-https vision provider URL for "${provider.id}": ${url.protocol}`)
  }

  const maxTokensField = provider.maxTokensField ?? 'max_tokens'
  const body = JSON.stringify({
    model: provider.model,
    messages: [
      {
        role: 'system',
        content: 'You are an accurate image understanding assistant. Base every statement only on the provided image content.',
      },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    [maxTokensField]: options.maxTokens,
  })

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, options.timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(provider, apiKey) },
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new VisionApiFetchError(`"${provider.id}" responded with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > options.maxResponseBytes) {
      throw new VisionApiFetchError(`"${provider.id}" response exceeds the maximum of ${options.maxResponseBytes} bytes`)
    }
    const raw = await response.text()
    if (raw.length > options.maxResponseBytes) {
      throw new VisionApiFetchError(`"${provider.id}" response exceeds the maximum of ${options.maxResponseBytes} bytes`)
    }
    return parseChatCompletion(provider.id, raw)
  } catch (error: unknown) {
    if (error instanceof VisionApiFetchError || error instanceof VisionApiParseError) throw error
    if (controller.signal.aborted) throw new VisionApiFetchError(`"${provider.id}" request timed out after ${options.timeoutMs}ms`, { cause: error })
    throw new VisionApiFetchError(`"${provider.id}" request failed: ${String(error)}`, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Defensively extract `choices[0].message.content` from an OpenAI-shaped chat-completion body. */
function parseChatCompletion(providerId: string, raw: string): VisionCallResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new VisionApiParseError(`"${providerId}" response was not valid JSON`, { cause: error })
  }
  const root = asRecord(parsed)
  const choices = root?.choices
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined
  const message = asRecord(first?.message)
  const content = message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (typeof asRecord(part)?.text === 'string' ? asRecord(part)?.text as string : '')).join('')
      : undefined
  if (text === undefined || text.trim().length === 0) {
    throw new VisionApiParseError(`"${providerId}" returned no message content`)
  }
  const usage = asRecord(root?.usage)
  return { text: text.trim(), ...usage !== undefined ? { usage } : {} }
}
