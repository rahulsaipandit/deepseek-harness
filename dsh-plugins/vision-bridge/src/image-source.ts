/**
 * Resolves the tool's `image` input into validated bytes, from exactly one
 * of a local path or an `https` URL.
 *
 * This is the fix for the concrete gap both community vision plugins had
 * (`docs/adr/rp_dshPlugins.md`'s visionDS/dsh-plugin-mm-vision reviews):
 * visionDS read any local path via `node:fs`/`os.path` directly and
 * proceeded even when the bytes didn't look like an image; dsh-plugin-mm-vision
 * did the same via `path.resolve()`. Here, a local path is resolved and read
 * through `ctx.fs` — the same sandboxed/policy-aware seam `read_image`
 * (`packages/fs/tool-fs/src/read-image.ts`) uses — and bytes that don't pass
 * magic-byte sniffing are rejected outright rather than shipped anyway under
 * a best-guess `application/octet-stream` label.
 * @module dsh-plugin-vision-bridge/image-source
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp'

export class ImageSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ImageSourceError'
  }
}

export interface ImageBytes {
  bytes: Uint8Array
  mediaType: ImageMediaType
}

/** Sniff a raster image's media type from its leading bytes. Returns `undefined` for anything else — callers must fail closed on that, never guess. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  return undefined
}

export function toDataUrl(image: ImageBytes): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}`
}

/**
 * Read a local path through `ctx.fs` (sandboxed/policy-aware, same as
 * `read_image`), then fail closed if the bytes aren't a recognized raster
 * image — never proceed with an unlabeled/mislabeled read the way both
 * reviewed community plugins did.
 */
export async function resolveImageFromPath(
  ctx: Context,
  exec: ToolExecution,
  filePath: string,
  maxBytes: number,
): Promise<ImageBytes> {
  const cwd = exec.agent?.session.header.cwd
  const target = await ctx.fs.resolve(filePath, {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    throw new ImageSourceError(`cannot read "${target.displayPath}": not found`)
  }
  if (info.type !== 'file') {
    throw new ImageSourceError(`cannot read "${target.displayPath}": not a regular file`)
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, maxBytes)
  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === undefined) {
    throw new ImageSourceError(`"${target.displayPath}" does not look like a PNG/JPEG/GIF/WebP/BMP image (rejected by content, not just by extension)`)
  }
  return { bytes, mediaType }
}

/**
 * Fetch an `https` image URL directly (never `http`, `file:`, or any other
 * scheme — that would reopen the SSRF-adjacent surface visionDS's `--base-url`
 * override had, just from the other direction), bounded by size and time,
 * and fail closed on anything that doesn't sniff as a raster image.
 */
export async function resolveImageFromUrl(
  url: string,
  maxBytes: number,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageBytes> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error: unknown) {
    throw new ImageSourceError(`"${url}" is not a valid URL`, { cause: error })
  }
  if (parsed.protocol !== 'https:') {
    throw new ImageSourceError(`refusing a non-https image URL: ${parsed.protocol}`)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetchImpl(parsed, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) {
      throw new ImageSourceError(`image fetch responded with HTTP ${response.status}`)
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > maxBytes) {
      throw new ImageSourceError(`image exceeds the maximum of ${maxBytes} bytes`)
    }
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new ImageSourceError(`image exceeds the maximum of ${maxBytes} bytes`)
    }
    const mediaType = sniffImageMediaType(buffer)
    if (mediaType === undefined) {
      throw new ImageSourceError(`"${url}" did not return a recognizable PNG/JPEG/GIF/WebP/BMP image`)
    }
    return { bytes: buffer, mediaType }
  } catch (error: unknown) {
    if (error instanceof ImageSourceError) throw error
    if (controller.signal.aborted) throw new ImageSourceError(`image fetch timed out after ${timeoutMs}ms`, { cause: error })
    throw new ImageSourceError(`image fetch failed: ${String(error)}`, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}
