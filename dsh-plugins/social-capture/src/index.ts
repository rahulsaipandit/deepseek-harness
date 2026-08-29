/**
 * Receives social-media posts captured by a per-user browser bookmarklet
 * (see `bookmarklet.ts`) and writes them as `dsh-plugin-knowledge-hub`
 * -compatible markdown notes. The harness never drives a login, holds a
 * platform credential, or automates a browser — the person's own
 * already-authenticated browser tab does the reading; this plugin only
 * receives, validates, optionally summarizes, and stores the result. See
 * `docs/investigateContentIngestionPlugin.md` for the design rationale
 * (why this replaces a Playwright-driven login flow) and
 * `docs/designSocialCaptureForDSH.md` for the full design writeup.
 * @module dsh-plugin-social-capture
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createAuditLog } from './audit-log.ts'
import type { CapturePlatform } from './bookmarklet.ts'
import { createLlmSocialSummarizer } from './summarize.ts'
import type { SocialSummarizer } from './summarize.ts'
import { writeSocialNote } from './note-writer.ts'
import { RateLimiter } from './rate-limit.ts'
import { resolveToken } from './token.ts'
import { registerSocialCaptureServer } from './web/receiver-server.ts'
import type { CaptureOutcome } from './web/receiver-server.ts'
import type { CapturePayload } from './capture-payload.ts'

export const name = 'social-capture'
export const inject = ['webServer']

export const Config = z.object({
  /** Absolute path to the markdown vault this plugin writes into — point it at the same vaultPath as dsh-plugin-knowledge-hub to make captures searchable there. */
  vaultPath: z.string(),
  /** Base path the install page and capture receiver are served under. */
  webPath: z.string().default('/social-capture'),
  /** Platforms to generate a capture script for. Each gets its own bookmarklet/console-script section on the install page. */
  platforms: z.array(z.string()).default(['instagram']),
  /** Bearer-style capture token. Explicit config wins; otherwise persisted/generated under $DSH_HOME and baked into the generated scripts automatically. */
  token: z.string().default(''),
  /** Origins allowed to POST cross-origin to the capture receiver (the social site's own origin, e.g. "https://www.instagram.com"). Required for the bookmarklet to work — a browser blocks the cross-origin fetch otherwise. */
  corsOrigins: z.array(z.string()).default([]),
  /** Hard cap on one capture request body, in bytes. */
  maxBodyBytes: z.number().default(262_144),
  /** Capture requests allowed per window, per client (IP or token). */
  rateLimit: z.number().default(30),
  /** Rate-limit window, in milliseconds. */
  rateLimitWindowMs: z.number().default(60_000),
  /** LLM-generated summary + topic tags per capture. Off by default — captures still get free, LLM-less hashtag/mention tags either way (see entity-extract.ts). Puts a real LLM call in the capture path when enabled. */
  enableAiSummary: z.boolean().default(false),
  /** Provider route passed to ctx.llm.stream() when enableAiSummary is true. Never hardcoded to a specific vendor — point this at whichever ctx.llm-registered provider you use. Omitted defaults to the first registered provider. */
  llmProvider: z.string().default(''),
  /** Model id passed to ctx.llm.stream(). Required when enableAiSummary is true. */
  llmModel: z.string().default(''),
})

export type Config = Schemastery.TypeT<typeof Config>

/** Register the social-capture receiver. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.vaultPath.trim().length === 0) {
    throw new Error('social-capture: vaultPath must be a non-empty absolute path')
  }
  if (config.platforms.length === 0) {
    throw new Error('social-capture: platforms must not be empty')
  }
  const vaultPath = resolve(config.vaultPath)
  const auditLog = createAuditLog(vaultPath)

  let summarizer: SocialSummarizer | undefined
  if (config.enableAiSummary) {
    const llm = ctx.get('llm')
    if (!llm) throw new Error('social-capture: enableAiSummary is true but no ctx.llm service is mounted')
    if (config.llmModel.trim().length === 0) {
      throw new Error('social-capture: enableAiSummary is true but llmModel is not configured')
    }
    const provider = config.llmProvider.trim().length > 0
      ? config.llmProvider
      : llm.listProviders()[0]?.id
    if (!provider) throw new Error('social-capture: enableAiSummary is true but no LLM provider is registered and llmProvider was not set')
    summarizer = createLlmSocialSummarizer(
      llm,
      { provider, model: config.llmModel },
      error => ctx.logger?.warn?.(`social-capture: AI summarization failed for a capture; it was stored without a summary: ${String(error)}`),
    )
  }

  async function onCapture(payload: CapturePayload): Promise<CaptureOutcome> {
    const summary = await summarizer?.(payload)
    const note = await writeSocialNote(vaultPath, payload, {
      ...(summary === undefined ? {} : { aiSummary: summary.summary, aiTags: summary.tags }),
    })
    await auditLog.log({
      operation: 'create',
      entryId: note.id,
      entryType: 'note',
      summary: `captured ${payload.platform} post from ${payload.url}`,
    })
    return { ok: true, id: note.id }
  }

  const resolved = await resolveToken(config.token.length > 0 ? config.token : undefined)
  if (resolved.generated) {
    ctx.logger?.info?.(`social-capture: generated a new capture token, persisted at ${resolved.file}`)
  }

  const captureEndpoint = `http://${ctx.webServer.host}:${ctx.webServer.port}${config.webPath}/capture`
  const rateLimiter = new RateLimiter({ limit: config.rateLimit, windowMs: config.rateLimitWindowMs })
  ctx.effect(() => {
    const pruneTimer = setInterval(() => rateLimiter.prune(), config.rateLimitWindowMs)
    pruneTimer.unref?.()
    return () => clearInterval(pruneTimer)
  }, 'social-capture: rate-limit prune timer')

  const installUrl = registerSocialCaptureServer(ctx, ctx.webServer, {
    webPath: config.webPath,
    captureEndpoint,
    platforms: config.platforms as CapturePlatform[],
    token: resolved.token,
    corsOrigins: config.corsOrigins,
    maxBodyBytes: config.maxBodyBytes,
    rateLimiter,
    onCapture,
  })
  ctx.logger?.info?.(`social-capture: install page at ${installUrl}`)
}
