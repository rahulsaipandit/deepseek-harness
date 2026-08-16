/** Host HTTP bridge for browser-client RPC. */
import type { IncomingMessage } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
// Activates the webServer Context merge used below.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { HostConnectionService } from './rpc-host.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
  /** Non-loopback authentication mode for remote RPC traffic. */
  remoteAuthMode?: 'none' | 'bearer'
  /** Bearer tokens accepted for non-loopback traffic in bearer mode. */
  remoteAuthTokens?: string[]
  /** Header used for bearer auth (default: Authorization). */
  remoteAuthHeader?: string
  /** Fixed-window rate-limit window in milliseconds for non-loopback traffic. */
  remoteRateLimitWindowMs?: number
  /** Maximum accepted non-loopback requests per window per client key. */
  remoteRateLimitMaxRequests?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  remoteAuthMode: z.union([z.const('none'), z.const('bearer')]).default('none'),
  remoteAuthTokens: z.array(String).default([]),
  remoteAuthHeader: z.string().default('authorization'),
  remoteRateLimitWindowMs: z.natural().min(1).default(60_000),
  remoteRateLimitMaxRequests: z.natural().min(1).default(300),
})

type ResolvedConfig = Required<ConnectionConfig>

interface RateWindow {
  count: number
  resetAt: number
}

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, RateWindow>()

  constructor(private readonly windowMs: number, private readonly maxRequests: number) {}

  take(key: string, now = Date.now()): boolean {
    const current = this.windows.get(key)
    if (current === undefined || now >= current.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    if (current.count >= this.maxRequests) return false
    current.count += 1
    return true
  }
}

// CLAUDE_FIX_SECURITY: the Host header is client-supplied and trivially forged
// (curl -H "Host: localhost" reaches a 0.0.0.0-bound server the same as any
// other request) — checking it here would let a genuine remote attacker claim
// loopback and skip the bearer-auth gate below entirely. Whether a connection
// is actually local can only be judged from the OS-reported TCP peer address.
function isLoopbackAddress(address: string): boolean {
  if (address === '::1') return true
  const v4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const octets = v4.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

function isLoopbackConnection(req: IncomingMessage): boolean {
  const remote = req.socket?.remoteAddress
  return remote !== undefined && isLoopbackAddress(remote)
}

function extractBearer(value: string): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(value.trim())
  return match?.[1]
}

// CLAUDE_FIX_SECURITY: compare with a timing-safe equality so a caller cannot
// use response-time differences to guess a valid token byte-by-byte.
function tokenEquals(candidate: string, presented: string): boolean {
  const candidateBuf = Buffer.from(candidate)
  const presentedBuf = Buffer.from(presented)
  return candidateBuf.length === presentedBuf.length && timingSafeEqual(candidateBuf, presentedBuf)
}

function isAuthenticatedRemote(req: IncomingMessage, config: ResolvedConfig): boolean {
  if (config.remoteAuthMode === 'none') return false
  const raw = req.headers[config.remoteAuthHeader.toLowerCase()]
  if (typeof raw !== 'string') return false
  const token = extractBearer(raw)
  if (token === undefined || token.length === 0) return false
  return config.remoteAuthTokens.some(candidate => tokenEquals(candidate, token))
}

function remoteKey(req: IncomingMessage): string {
  const peer = req.socket?.remoteAddress ?? 'unknown'
  const host = typeof req.headers.host === 'string' ? req.headers.host : 'unknown'
  return `${peer}|${host}`
}

/** The `/api/<method>` RPC method name a raw request path names, or undefined outside that prefix. */
function requestMethodName(rawUrl: string | undefined): string | undefined {
  const pathname = new URL(rawUrl ?? '/', 'http://internal').pathname
  return pathname.startsWith(`${API_PATH}/`) ? pathname.slice(API_PATH.length + 1) : undefined
}

/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. `trustedHosts` is a
 * DNS-rebinding fence, explicitly not authentication, so the whole
 * configuration plane stays loopback-same-origin until a real authentication
 * layer exists. `llm.discoverModels` belongs to that plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const resolved = {
    trustedHosts: config?.trustedHosts ?? [],
    maxRequestBodyBytes: config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES,
    remoteAuthMode: config?.remoteAuthMode ?? 'none',
    remoteAuthTokens: config?.remoteAuthTokens ?? [],
    remoteAuthHeader: (config?.remoteAuthHeader ?? 'authorization').toLowerCase(),
    remoteRateLimitWindowMs: config?.remoteRateLimitWindowMs ?? 60_000,
    remoteRateLimitMaxRequests: config?.remoteRateLimitMaxRequests ?? 300,
  } satisfies ResolvedConfig
  const trustedHosts = resolved.trustedHosts
  const maxRequestBodyBytes = resolved.maxRequestBodyBytes
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  // CLAUDE_FIX_SECURITY: Claude fixed remote-RPC exposure risk by failing
  // closed: any non-loopback deployment must declare auth.
  if (trustedHosts.length > 0 && resolved.remoteAuthMode === 'none') {
    throw new Error('client-connection: non-loopback trustedHosts require remote auth (set remoteAuthMode=bearer)')
  }
  if (resolved.remoteAuthMode === 'bearer' && resolved.remoteAuthTokens.length === 0) {
    throw new Error('client-connection: remoteAuthTokens must be non-empty in bearer mode')
  }
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts)
  const remoteLimiter = new FixedWindowRateLimiter(resolved.remoteRateLimitWindowMs, resolved.remoteRateLimitMaxRequests)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      if (method !== undefined
        && PRIVILEGED_METHODS.has(method)
        && !isTrustedApiRequest(request, [])) {
        return new Response('forbidden', { status: 403 })
      }
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      return toFetchHandler(apiProxy).fetch(request)
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        if (!isLoopbackConnection(req)) {
          ctx.logger.warn('remote-rpc audit: denied untrusted request host=%s remote=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown')
        }
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (!isLoopbackConnection(req)) {
        if (!isAuthenticatedRemote(req, resolved)) {
          ctx.logger.warn('remote-rpc audit: denied unauthenticated request host=%s remote=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown')
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        if (!remoteLimiter.take(remoteKey(req))) {
          ctx.logger.warn('remote-rpc audit: denied rate-limited request host=%s remote=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown')
          res.writeHead(429)
          res.end('too many requests')
          return
        }
        // CLAUDE_FIX_SECURITY: the inner fetchHandler's PRIVILEGED_METHODS
        // check below only inspects the (forgeable) Host header via
        // isTrustedApiRequest, so a caller holding a valid bearer token could
        // otherwise still spoof Host: localhost to reach settings/credentials
        // methods documented as loopback-only. Pin them here against the real
        // socket peer, which cannot be forged, before a bearer-authenticated
        // remote caller ever reaches that inner check.
        const requestMethod = requestMethodName(req.url)
        if (requestMethod !== undefined && PRIVILEGED_METHODS.has(requestMethod)) {
          ctx.logger.warn('remote-rpc audit: denied non-loopback privileged method=%s remote=%s', requestMethod, req.socket?.remoteAddress ?? 'unknown')
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        ctx.logger.info('remote-rpc audit: accepted request host=%s remote=%s method=%s url=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown', req.method ?? 'unknown', req.url ?? 'unknown')
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            if (!isLoopbackConnection(req)) {
              ctx.logger.warn('remote-rpc audit: denied untrusted websocket host=%s remote=%s path=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown', path)
            }
            rejectWebSocketUpgrade(socket)
            return
          }
          if (!isLoopbackConnection(req)) {
            if (!isAuthenticatedRemote(req, resolved)) {
              ctx.logger.warn('remote-rpc audit: denied unauthenticated websocket host=%s remote=%s path=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown', path)
              rejectWebSocketUpgrade(socket)
              return
            }
            if (!remoteLimiter.take(remoteKey(req))) {
              ctx.logger.warn('remote-rpc audit: denied rate-limited websocket host=%s remote=%s path=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown', path)
              rejectWebSocketUpgrade(socket)
              return
            }
            ctx.logger.info('remote-rpc audit: accepted websocket host=%s remote=%s path=%s', req.headers.host ?? 'unknown', req.socket?.remoteAddress ?? 'unknown', path)
          }
          // CLAUDE_FIX_SECURITY: Claude fixed remote-RPC abuse risk by
          // enforcing auth + rate limits before accepting non-loopback sockets.
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
  })
}
