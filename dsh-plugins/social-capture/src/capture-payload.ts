/**
 * Validation for the JSON body the bookmarklet POSTs. Deliberately strict
 * and small: this is the one boundary where arbitrary browser-page content
 * enters the harness, so every field is bounded and unknown shapes are
 * rejected rather than coerced.
 * @module dsh-plugin-social-capture/capture-payload
 */

export const MAX_TEXT_CHARS = 20_000
export const MAX_MEDIA_URLS = 40
export const MAX_URL_CHARS = 2_000

export interface CapturePayload {
  /** Free-form source identifier, e.g. 'instagram'. Lowercased and used as a tag. */
  platform: string
  /** Canonical post URL — stored as the note's `resource` field. */
  url: string
  /** Client-reported capture time (ISO 8601); falls back to server time if invalid. */
  capturedAt?: string
  author?: string
  text?: string
  mediaUrls?: string[]
}

export type CaptureValidationError =
  | 'invalid_json'
  | 'missing_platform'
  | 'missing_or_invalid_url'
  | 'no_content'
  | 'text_too_long'
  | 'too_many_media_urls'

export type CaptureValidationResult =
  | { ok: true; payload: CapturePayload }
  | { ok: false; error: CaptureValidationError }

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Validate a raw parsed JSON body into a {@link CapturePayload}. Never throws. */
export function validateCapturePayload(data: unknown): CaptureValidationResult {
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'invalid_json' }
  const record = data as Record<string, unknown>

  if (!isNonEmptyString(record.platform)) return { ok: false, error: 'missing_platform' }
  if (!isHttpUrl(record.url)) return { ok: false, error: 'missing_or_invalid_url' }

  const text = typeof record.text === 'string' ? record.text : undefined
  const author = isNonEmptyString(record.author) ? record.author : undefined
  if (!text && !author) return { ok: false, error: 'no_content' }
  if (text !== undefined && text.length > MAX_TEXT_CHARS) return { ok: false, error: 'text_too_long' }

  let mediaUrls: string[] | undefined
  if (record.mediaUrls !== undefined) {
    if (!Array.isArray(record.mediaUrls)) return { ok: false, error: 'too_many_media_urls' }
    if (record.mediaUrls.length > MAX_MEDIA_URLS) return { ok: false, error: 'too_many_media_urls' }
    mediaUrls = record.mediaUrls.filter(isHttpUrl)
  }

  const capturedAt = isNonEmptyString(record.capturedAt) && !Number.isNaN(Date.parse(record.capturedAt))
    ? record.capturedAt
    : undefined

  return {
    ok: true,
    payload: {
      platform: record.platform.trim().toLowerCase(),
      url: record.url as string,
      ...(capturedAt === undefined ? {} : { capturedAt }),
      ...(author === undefined ? {} : { author }),
      ...(text === undefined ? {} : { text }),
      ...(mediaUrls === undefined ? {} : { mediaUrls }),
    },
  }
}
