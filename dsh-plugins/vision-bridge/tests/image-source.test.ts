import { describe, expect, it } from 'vitest'
import { ImageSourceError, resolveImageFromUrl, sniffImageMediaType, toDataUrl } from '../src/image-source.ts'

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const GIF_HEADER = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
const WEBP_HEADER = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const BMP_HEADER = new Uint8Array([0x42, 0x4d, 0, 0])
const NOT_AN_IMAGE = new TextEncoder().encode('#!/bin/sh\nrm -rf /\n')

describe('sniffImageMediaType', () => {
  it.each([
    ['png', PNG_HEADER, 'image/png'],
    ['jpeg', JPEG_HEADER, 'image/jpeg'],
    ['gif', GIF_HEADER, 'image/gif'],
    ['webp', WEBP_HEADER, 'image/webp'],
    ['bmp', BMP_HEADER, 'image/bmp'],
  ] as const)('recognizes %s magic bytes', (_name, bytes, expected) => {
    expect(sniffImageMediaType(bytes)).toBe(expected)
  })

  it('fails closed (returns undefined) for arbitrary non-image bytes, unlike visionDS/mm-vision falling back to a guessed mime type', () => {
    expect(sniffImageMediaType(NOT_AN_IMAGE)).toBeUndefined()
  })

  it('fails closed for an empty buffer', () => {
    expect(sniffImageMediaType(new Uint8Array())).toBeUndefined()
  })
})

describe('toDataUrl', () => {
  it('base64-encodes the bytes under the sniffed media type', () => {
    const dataUrl = toDataUrl({ bytes: PNG_HEADER, mediaType: 'image/png' })
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    const decoded = Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')
    expect(new Uint8Array(decoded)).toEqual(PNG_HEADER)
  })
})

describe('resolveImageFromUrl', () => {
  it('refuses a non-https URL before ever calling fetch', async () => {
    let called = false
    const fetchImpl = (async () => { called = true; throw new Error('should not be called') }) as unknown as typeof fetch
    await expect(resolveImageFromUrl('http://example.com/pic.png', 1024, 1000, fetchImpl)).rejects.toThrow(ImageSourceError)
    expect(called).toBe(false)
  })

  it('rejects a non-image response body instead of guessing a mime type', async () => {
    const fetchImpl = (async () => new Response(NOT_AN_IMAGE, { status: 200 })) as unknown as typeof fetch
    await expect(resolveImageFromUrl('https://example.com/pic.png', 1024, 1000, fetchImpl)).rejects.toThrow(/did not return a recognizable/)
  })

  it('accepts a real image response and returns its sniffed bytes', async () => {
    const fetchImpl = (async () => new Response(PNG_HEADER, { status: 200 })) as unknown as typeof fetch
    const result = await resolveImageFromUrl('https://example.com/pic.png', 1024, 1000, fetchImpl)
    expect(result.mediaType).toBe('image/png')
    expect(new Uint8Array(result.bytes)).toEqual(PNG_HEADER)
  })

  it('rejects a response over the declared content-length cap without buffering the body', async () => {
    const fetchImpl = (async () => new Response(PNG_HEADER, { status: 200, headers: { 'content-length': '99999999' } })) as unknown as typeof fetch
    await expect(resolveImageFromUrl('https://example.com/pic.png', 1024, 1000, fetchImpl)).rejects.toThrow(/exceeds the maximum/)
  })

  it('rejects a non-2xx response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(resolveImageFromUrl('https://example.com/missing.png', 1024, 1000, fetchImpl)).rejects.toThrow(/HTTP 404/)
  })
})
