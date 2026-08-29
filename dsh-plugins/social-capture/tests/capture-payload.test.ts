import { describe, expect, it } from 'vitest'
import { validateCapturePayload } from '../src/capture-payload.ts'

describe('validateCapturePayload', () => {
  it('accepts a minimal valid payload', () => {
    const result = validateCapturePayload({ platform: 'instagram', url: 'https://instagram.com/p/abc', text: 'hello' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.platform).toBe('instagram')
      expect(result.payload.url).toBe('https://instagram.com/p/abc')
    }
  })

  it('lowercases and trims the platform', () => {
    const result = validateCapturePayload({ platform: '  Instagram  ', url: 'https://instagram.com/p/abc', text: 'hi' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.platform).toBe('instagram')
  })

  it('rejects a non-object body', () => {
    expect(validateCapturePayload(null)).toEqual({ ok: false, error: 'invalid_json' })
    expect(validateCapturePayload('a string')).toEqual({ ok: false, error: 'invalid_json' })
  })

  it('rejects a missing platform', () => {
    expect(validateCapturePayload({ url: 'https://example.com', text: 'hi' })).toEqual({ ok: false, error: 'missing_platform' })
  })

  it('rejects a missing or non-http url', () => {
    expect(validateCapturePayload({ platform: 'instagram', text: 'hi' })).toEqual({ ok: false, error: 'missing_or_invalid_url' })
    expect(validateCapturePayload({ platform: 'instagram', url: 'javascript:alert(1)', text: 'hi' })).toEqual({ ok: false, error: 'missing_or_invalid_url' })
    expect(validateCapturePayload({ platform: 'instagram', url: 'not a url', text: 'hi' })).toEqual({ ok: false, error: 'missing_or_invalid_url' })
  })

  it('rejects a payload with neither text nor author', () => {
    expect(validateCapturePayload({ platform: 'instagram', url: 'https://example.com' })).toEqual({ ok: false, error: 'no_content' })
  })

  it('accepts author-only content', () => {
    const result = validateCapturePayload({ platform: 'instagram', url: 'https://example.com', author: 'jane' })
    expect(result.ok).toBe(true)
  })

  it('rejects text over the length cap', () => {
    const result = validateCapturePayload({ platform: 'instagram', url: 'https://example.com', text: 'x'.repeat(20_001) })
    expect(result).toEqual({ ok: false, error: 'text_too_long' })
  })

  it('rejects too many media urls', () => {
    const mediaUrls = Array.from({ length: 41 }, (_, i) => `https://example.com/${i}.jpg`)
    const result = validateCapturePayload({ platform: 'instagram', url: 'https://example.com', text: 'hi', mediaUrls })
    expect(result).toEqual({ ok: false, error: 'too_many_media_urls' })
  })

  it('filters out non-http entries from mediaUrls rather than rejecting the whole payload', () => {
    const result = validateCapturePayload({
      platform: 'instagram',
      url: 'https://example.com',
      text: 'hi',
      mediaUrls: ['https://example.com/a.jpg', 'not-a-url', 42],
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.mediaUrls).toEqual(['https://example.com/a.jpg'])
  })

  it('drops an invalid capturedAt rather than rejecting the payload', () => {
    const result = validateCapturePayload({ platform: 'instagram', url: 'https://example.com', text: 'hi', capturedAt: 'not-a-date' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payload.capturedAt).toBeUndefined()
  })
})
