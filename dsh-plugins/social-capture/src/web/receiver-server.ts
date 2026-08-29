/**
 * HTTP surface for social-capture: serves the install page (bookmarklet +
 * console script per configured platform) and the capture receiver the
 * scripts POST to. Modeled directly on
 * `dsh-plugin-knowledge-hub/src/web/concept-graph-server.ts`'s
 * route-registration pattern, with the token/CORS/rate-limit handling
 * ported from `dsh-plugins/mcp-server/src/index.ts` since this route is
 * reachable from a real (if same-machine) browser origin, not just
 * loopback CLI callers.
 * @module dsh-plugin-social-capture/web/receiver-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { validateCapturePayload } from '../capture-payload.ts'
import type { CapturePayload } from '../capture-payload.ts'
import { renderInstallPage } from '../bookmarklet.ts'
import type { CapturePlatform } from '../bookmarklet.ts'
import { ipKey, RateLimiter, tokenKey } from '../rate-limit.ts'
import { verifyToken } from '../token.ts'

export type CaptureOutcome =
  | { ok: true; id: string }
  | { ok: false; error: string }

export interface ReceiverServerOptions {
  /** Base path the install page is served under, e.g. `/social-capture`. */
  webPath: string
  /** Full externally-reachable capture endpoint, e.g. `http://127.0.0.1:PORT/social-capture/capture` — baked into generated scripts. */
  captureEndpoint: string
  platforms: CapturePlatform[]
  token: string
  /** Origins allowed to POST cross-origin (the social site's own origin, e.g. `https://www.instagram.com`). */
  corsOrigins: string[]
  /** Hard cap on request body size in bytes; larger bodies are rejected with 413 before JSON parsing. */
  maxBodyBytes: number
  rateLimiter: RateLimiter
  onCapture: (payload: CapturePayload) => Promise<CaptureOutcome>
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false; tooLarge: true }> {
  return new Promise((resolvePromise, reject) => {
    let total = 0
    const chunks: Buffer[] = []
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      total += chunk.length
      if (total > maxBytes) {
        tooLarge = true
        req.destroy()
        resolvePromise({ ok: false, tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      resolvePromise({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', reject)
  })
}

function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const origin = req.headers.origin
  if (origin && (allowedOrigins.includes('*') || allowedOrigins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Capture-Token')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * Register the install-page and capture routes on the resolved `webServer`
 * service. Returns the install page URL.
 */
export function registerSocialCaptureServer(ctx: Context, webServer: WebServer, options: ReceiverServerOptions): string {
  const capturePath = `${options.webPath}/capture`

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: options.webPath,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderInstallPage({ captureEndpoint: options.captureEndpoint, platforms: options.platforms, token: options.token }))
    },
  }), 'social-capture: install page route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: capturePath,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      applyCors(req, res, options.corsOrigins)
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end()
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }

      const presentedToken = req.headers['x-capture-token']
      const tokenValue = Array.isArray(presentedToken) ? presentedToken[0] : presentedToken
      if (tokenValue === undefined || !verifyToken(options.token, tokenValue)) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }

      const remoteAddress = req.socket.remoteAddress ?? 'unknown'
      const ipLimit = options.rateLimiter.consume(ipKey(remoteAddress))
      const tokenLimit = options.rateLimiter.consume(tokenKey(tokenValue))
      if (!ipLimit.allowed || !tokenLimit.allowed) {
        sendJson(res, 429, { error: 'rate_limited' })
        return
      }

      const bodyResult = await readBody(req, options.maxBodyBytes)
      if (!bodyResult.ok) {
        sendJson(res, 413, { error: 'payload_too_large' })
        return
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(bodyResult.body)
      } catch {
        sendJson(res, 400, { error: 'invalid_json' })
        return
      }

      const validation = validateCapturePayload(parsed)
      if (!validation.ok) {
        sendJson(res, 400, { error: validation.error })
        return
      }

      try {
        const outcome = await options.onCapture(validation.payload)
        if (outcome.ok) {
          sendJson(res, 200, { id: outcome.id })
        } else {
          sendJson(res, 500, { error: outcome.error })
        }
      } catch (error) {
        ctx.logger?.warn?.(`social-capture: capture handling failed: ${String(error)}`)
        sendJson(res, 500, { error: 'internal_error' })
      }
    },
  }), 'social-capture: capture route')

  return `http://${webServer.host}:${webServer.port}${options.webPath}`
}
