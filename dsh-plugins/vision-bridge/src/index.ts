/**
 * `describe_image`: a model-facing DSH tool that gives a text-only main
 * model a way to "see" an image — the same gap both community plugins
 * reviewed in `docs/adr/rp_dshPlugins.md` (visionDS, dsh-plugin-mm-vision)
 * addressed, combined here to keep each one's strength and drop each one's
 * weakness:
 *
 * - From dsh-plugin-mm-vision: register as a schema-scoped `ctx.tools` tool,
 *   not a shell-invoked skill — the model can never supply a destination URL
 *   or credential, only an image and an optional prompt/mode. That was the
 *   design-level fix its review called out as the harder gap in visionDS.
 * - From visionDS: a configurable multi-provider catalog with priority
 *   fallback, plus offline OCR (Windows/macOS) when no API succeeds.
 * - Fixed relative to both: the image argument is never an arbitrary local
 *   path read via raw `node:fs`. A local path resolves through `ctx.fs`
 *   (sandboxed/policy-aware, the same seam `read_image` uses) and a remote
 *   source must be `https`; either way the bytes are magic-byte sniffed and
 *   rejected outright if they don't look like a real raster image, rather
 *   than proceeding under a best-guess/`application/octet-stream` label.
 * - Fixed relative to dsh-plugin-mm-vision specifically: no silent
 *   first-key-found fallback across another tool's credential file — every
 *   provider's key resolves through exactly one named `ctx.credentials` ref.
 *
 * @module dsh-plugin-vision-bridge
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { cacheKeyFor, VisionResponseCache } from './cache.ts'
import { resolveImageFromPath, resolveImageFromUrl, toDataUrl, type ImageBytes } from './image-source.ts'
import { runLocalOcr } from './local-ocr.ts'
import { buildPrompt, resolveMode, type PromptMode } from './prompt.ts'
import { DEFAULT_PROVIDERS, orderedProviders, type ProviderConfig } from './providers.ts'
import { callVisionProvider, VisionApiFetchError, VisionApiParseError } from './vision-api.ts'

/** Services required before this plugin can register its tool and resolve images/credentials. */
export const inject = ['tools', 'fs', 'credentials']

const providerConfigSchema = z.object({
  id: z.string(),
  label: z.string().default(''),
  baseUrl: z.string(),
  model: z.string(),
  credentialRef: z.string(),
  /** Header name for a non-bearer key, e.g. MiMo's `api-key`. Empty means `Authorization: Bearer <key>`. */
  authHeaderName: z.string().default(''),
  /** Request field carrying the output-token cap. Empty means `max_tokens`. */
  maxTokensField: z.string().default(''),
})

type ProviderConfigInput = Schemastery.TypeT<typeof providerConfigSchema>

const DEFAULT_PROVIDER_INPUTS: ProviderConfigInput[] = DEFAULT_PROVIDERS.map(provider => ({
  id: provider.id,
  label: provider.label,
  baseUrl: provider.baseUrl,
  model: provider.model,
  credentialRef: provider.credentialRef,
  authHeaderName: provider.authHeaderName ?? '',
  maxTokensField: provider.maxTokensField ?? '',
}))

function toProviderConfig(input: ProviderConfigInput): ProviderConfig {
  return {
    id: input.id,
    label: input.label.length > 0 ? input.label : input.id,
    baseUrl: input.baseUrl,
    model: input.model,
    credentialRef: input.credentialRef,
    ...input.authHeaderName.length > 0 ? { authHeaderName: input.authHeaderName } : {},
    ...input.maxTokensField.length > 0 ? { maxTokensField: input.maxTokensField } : {},
  }
}

export const Config = z.object({
  /** OpenAI-compatible vision routes to try, in `providerOrder`. Defaults to the visionDS-derived catalog (`providers.ts`). */
  providers: z.array(providerConfigSchema).default(DEFAULT_PROVIDER_INPUTS),
  /** Provider ids to try, in order; any catalog entry not listed is tried after, in catalog order. Empty means catalog order. */
  providerOrder: z.array(z.string()).default([]),
  /** Fall back to offline Windows/macOS OCR when no provider succeeds (or none has a configured key). */
  localOcrFallback: z.boolean().default(true),
  /** Per-image byte cap, for both a local read and a remote fetch. */
  maxImageBytes: z.number().default(20 * 1024 * 1024),
  /** Per-provider-attempt fetch timeout. */
  requestTimeoutMs: z.number().default(30_000),
  /** Local OCR subprocess timeout. */
  localOcrTimeoutMs: z.number().default(120_000),
  /** Output-token cap sent to the vision provider. */
  maxOutputTokens: z.number().default(1024),
  /** How long a cached description stays valid for the same image bytes + prompt. Zero disables caching. */
  cacheTtlMs: z.number().default(10 * 60 * 1000),
  cacheMaxEntries: z.number().default(100),
})

export type Config = Schemastery.TypeT<typeof Config>

interface DescribeImageArgs {
  file_path?: string
  url?: string
  prompt?: string
  mode?: string
}

interface DescribeImageValue {
  text: string
  source: 'provider' | 'local-ocr' | 'cache'
  provider?: string
}

/** Persist bytes to a throwaway temp file so offline OCR (which needs a real path) can run against a URL-sourced image too. */
async function withTempImageFile<T>(image: ImageBytes, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-bridge-'))
  const extension = image.mediaType === 'image/png' ? 'png'
    : image.mediaType === 'image/jpeg' ? 'jpg'
      : image.mediaType === 'image/gif' ? 'gif'
        : image.mediaType === 'image/webp' ? 'webp' : 'bmp'
  const path = join(dir, `${randomUUID()}.${extension}`)
  await writeFile(path, image.bytes)
  try {
    return await fn(path)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Register the `describe_image` tool. */
export function apply(ctx: Context, config: Config): void {
  const catalog = config.providers.map(toProviderConfig)
  const providers = orderedProviders(catalog, config.providerOrder)
  const cache = new VisionResponseCache(config.cacheTtlMs, config.cacheMaxEntries)

  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: 'Describe an image for a text-only model: reads a local image file or an https image URL, sends it to a '
      + 'configured vision-capable model, and returns a structured spatial description (layout, elements, coordinates, '
      + 'colors, key text/values). Falls back to offline OCR (text extraction only) when no vision provider succeeds. '
      + 'Provide exactly one of file_path or url.',
    parameters: {
      file_path: { type: 'string', description: 'Path to a local PNG/JPEG/GIF/WebP/BMP image. Provide this or url, not both.' },
      url: { type: 'string', description: 'An https:// URL to a PNG/JPEG/GIF/WebP/BMP image. Provide this or file_path, not both.' },
      prompt: { type: 'string', description: 'What to focus on, if anything beyond a general description (optional).' },
      mode: { type: 'string', enum: ['auto', 'chart', 'photo'], description: 'Description emphasis. auto (default) infers chart-vs-photo from context.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          source: { type: 'string', enum: ['provider', 'local-ocr', 'cache'], required: true },
          provider: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: config.requestTimeoutMs * Math.max(providers.length, 1) + config.localOcrTimeoutMs,
    // A read-only description of one already-existing image; safe alongside sibling tool calls.
    isConcurrencySafe: () => true,
    async execute(args: DescribeImageArgs, exec): Promise<DescribeImageValue> {
      const hasPath = typeof args.file_path === 'string' && args.file_path.trim().length > 0
      const hasUrl = typeof args.url === 'string' && args.url.trim().length > 0
      if (hasPath === hasUrl) {
        throw new Error('describe_image: provide exactly one of file_path or url')
      }

      const image = hasPath
        ? await resolveImageFromPath(ctx, exec, args.file_path as string, config.maxImageBytes)
        : await resolveImageFromUrl(args.url as string, config.maxImageBytes, config.requestTimeoutMs)

      const userText = args.prompt ?? ''
      const requestedMode = (args.mode as PromptMode | undefined) ?? 'auto'
      const mode = resolveMode(requestedMode, userText)
      const prompt = buildPrompt(userText, mode)

      const key = cacheKeyFor(image.bytes, prompt)
      const cached = cache.get(key)
      if (cached !== undefined) {
        return { text: cached, source: 'cache' }
      }

      const dataUrl = toDataUrl(image)
      let lastError: unknown
      for (const provider of providers) {
        const resolved = await ctx.credentials.resolve(credentialRef(provider.credentialRef))
        if (resolved === undefined) continue
        try {
          const result = await callVisionProvider(provider, resolved.value, dataUrl, prompt, {
            timeoutMs: config.requestTimeoutMs,
            maxTokens: config.maxOutputTokens,
            maxResponseBytes: 4 * 1024 * 1024,
          })
          cache.set(key, result.text)
          return { text: result.text, source: 'provider', provider: provider.id }
        } catch (error: unknown) {
          if (!(error instanceof VisionApiFetchError) && !(error instanceof VisionApiParseError)) throw error
          lastError = error
        }
      }

      if (config.localOcrFallback) {
        try {
          const text = await withTempImageFile(image, path => runLocalOcr(path, { timeoutMs: config.localOcrTimeoutMs }))
          cache.set(key, text)
          return { text, source: 'local-ocr' }
        } catch (ocrError: unknown) {
          throw new Error(
            `describe_image: no vision provider succeeded${lastError !== undefined ? ` (last error: ${String(lastError instanceof Error ? lastError.message : lastError)})` : ' (no provider had a configured credential)'}, `
            + `and offline OCR fallback also failed: ${String(ocrError instanceof Error ? ocrError.message : ocrError)}`,
            { cause: ocrError },
          )
        }
      }

      throw new Error(
        lastError !== undefined
          ? `describe_image: every configured vision provider failed; last error: ${String(lastError instanceof Error ? lastError.message : lastError)}`
          : 'describe_image: no vision provider has a configured credential, and localOcrFallback is disabled',
      )
    },
    presentCall(args: DescribeImageArgs): GenericCallView {
      const target = args.file_path ?? args.url ?? ''
      return {
        card: 'generic',
        title: `Describe image ${target}`,
        kind: 'read',
        ...args.file_path !== undefined ? { locations: [{ path: args.file_path }] } : {},
      }
    },
  }))
}
