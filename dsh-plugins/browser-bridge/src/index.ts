/**
 * `dsh-plugin-browser-bridge`: token-authenticated WebSocket bridge for the
 * companion browser extension (`./extension/`) plus the text-only
 * `browser_*` tool set.
 *
 * The bridge mounts its own upgrade route (`/ext/bridge`) on the host
 * webserver, OUTSIDE the `/api` trust fence — so it brings its own bearer
 * token authentication (first frame `hello` within HELLO_TIMEOUT_MS). Gateway
 * RPCs from the extension are dispatched through the same fetch-shaped
 * handler the `/api` carrier uses (`toFetchHandler`), and session events are
 * pumped per connection. Tools execute by dispatching `tool.call` frames to
 * the connected extension, which performs the action in the tab explicitly
 * controlled by the user.
 *
 * Opt-in by design: nothing is registered unless this plugin appears in the
 * composition. No core DSH code is touched.
 *
 * This is a hardened port of the community
 * `Lum1104/dsh-browser` project's host-side bridge
 * (`packages/browser/bridge-browser/`), reviewed in
 * `docs/adr/rp_dshPlugins.md` ("## dsh-browser" section). Its security
 * architecture is preserved exactly: token auth with `timingSafeEqual`, the
 * Origin-gated loopback exception, and privileged-method loopback pinning
 * (see `server.ts`). See this package's README "Trust and limitations"
 * section for what was adapted or simplified relative to upstream.
 *
 * @module dsh-plugin-browser-bridge
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { BridgeServer, type BridgeEventEnvelope } from './server.ts'
import { BrowserContextInjector } from './browser-context.ts'
import { registerBrowserTools } from './tools.ts'
import {
  BRIDGE_CONFIG_PATH,
  BRIDGE_PATH,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  MIN_SNAPSHOT_MAX_CHARS,
} from './protocol.ts'
import { resolveToken } from './token.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge'

/**
 * Services required by this plugin. `agents` and `systemPrompt` are read
 * defensively through `ctx.get(...)` inside `apply()` instead of being listed
 * here, so the plugin still mounts the bridge and tools in a composition that
 * omits either optional service (see the README "Trust and limitations"
 * section on the browser-context/system-prompt simplifications).
 */
export const inject = ['webServer', 'apiProxy', 'tools']

/** Default per-tool-call budget (ms). */
const DEFAULT_TOOL_TIMEOUT_MS = 90_000

/** Default cap on interactive inventory items per snapshot. */
const DEFAULT_MAX_INTERACTIVE_ITEMS = 60

/** Default persisted-token file location under the dsh home. */
const DEFAULT_TOKEN_FILE = dshHomePath('ext-bridge-token')

/** Plugin config: deployment-varying tunables only; the wire contract stays fixed. */
export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). Never accepted as a tool argument. */
  token?: string
  /** Per-tool-call timeout in ms. Defaults to 90000. */
  toolTimeoutMs?: number
  /** Upper bound on one snapshot's rendered characters. Defaults to 32000; minimum 500. */
  snapshotMaxChars?: number
  /** Upper bound on interactive inventory items per snapshot. Defaults to 60. */
  maxInteractiveItems?: number
}

export const Config: z<Config> = z.object({
  token: z.string(),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  snapshotMaxChars: z.number().step(1).min(MIN_SNAPSHOT_MAX_CHARS).default(DEFAULT_SNAPSHOT_MAX_CHARS),
  maxInteractiveItems: z.number().step(1).min(1).default(DEFAULT_MAX_INTERACTIVE_ITEMS),
})

/** The shape after schemastery applies its defaults to every field. */
type ResolvedConfig = Required<Omit<Config, 'token'>> & Pick<Config, 'token'>

/** Configured budgets must be positive integers. Exported for validation tests. */
export function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`browser-bridge: ${name} must be a positive integer`)
  }
}

/**
 * Apply defaults and direct-call validation at the plugin boundary.
 * @param config - Loader-resolved or directly supplied plugin configuration.
 * @returns a complete configuration ready for runtime use.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const resolved: ResolvedConfig = {
    ...(config.token === undefined ? {} : { token: config.token }),
    toolTimeoutMs: config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    snapshotMaxChars: config.snapshotMaxChars ?? DEFAULT_SNAPSHOT_MAX_CHARS,
    maxInteractiveItems: config.maxInteractiveItems ?? DEFAULT_MAX_INTERACTIVE_ITEMS,
  }
  assertPositiveInteger('toolTimeoutMs', resolved.toolTimeoutMs)
  assertPositiveInteger('snapshotMaxChars', resolved.snapshotMaxChars)
  if (resolved.snapshotMaxChars < MIN_SNAPSHOT_MAX_CHARS) {
    throw new Error(`browser-bridge: snapshotMaxChars must be at least ${MIN_SNAPSHOT_MAX_CHARS}`)
  }
  assertPositiveInteger('maxInteractiveItems', resolved.maxInteractiveItems)
  return resolved
}

/**
 * Mount the bridge: resolve the token, register the upgrade route, the tool
 * set, and an optional system-prompt section, all effect-scoped for HMR.
 *
 * @param ctx - Cordis context.
 * @param config - plugin config (schema defaults applied).
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const tokenRes = await resolveToken(resolved.token, DEFAULT_TOKEN_FILE)

  // Browser-context injection (seeding a followed-tab snapshot into a live
  // Agent session) is optional: it only activates when `ctx.agents` is
  // mounted in this composition. Omitting it here is a deliberate
  // simplification relative to upstream's session-deferral/session-workspace
  // wrappers — see README "Trust and limitations".
  const agents = ctx.get('agents')
  const browserContext = agents === undefined ? undefined : new BrowserContextInjector(agents)
  if (browserContext !== undefined) {
    ctx.on('agent/created', ({ agent }) => { browserContext.activate(agent) })
  }

  const apiHandler = toFetchHandler(ctx.apiProxy)
  const server = new BridgeServer({
    token: tokenRes.token,
    apiHandler,
    openEvents: (signal): AsyncIterable<BridgeEventEnvelope> =>
      ctx.apiProxy.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal) as AsyncIterable<BridgeEventEnvelope>,
    toolTimeoutMs: resolved.toolTimeoutMs,
    caps: {
      textOnly: true,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    },
    injectBrowserSnapshot: (sessionId, snapshot) => {
      if (browserContext === undefined) {
        throw new Error('browser-bridge: no ctx.agents service is mounted; cannot inject a browser snapshot into a session')
      }
      browserContext.inject(sessionId, snapshot)
    },
  })

  const route: WebUpgradeRoute = {
    path: BRIDGE_PATH,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(route), 'browser-bridge: /ext/bridge upgrade route')
  ctx.effect(() => () => { void server.close() }, 'browser-bridge: bridge server')

  // Zero-config discovery endpoint: the extension fetches this to learn the
  // bridge WebSocket URL without any manual configuration. The URL carries no
  // secret (loopback connections skip the token); non-loopback deployments
  // keep requiring the token on the WS itself.
  const configRoute: WebRoute = {
    kind: 'exact',
    path: BRIDGE_CONFIG_PATH,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ wsUrl: `ws://127.0.0.1:${ctx.webServer.port}${BRIDGE_PATH}` }))
    },
  }
  ctx.effect(() => ctx.webServer.register(configRoute), 'browser-bridge: /ext/bridge-config route')

  ctx.effect(() => {
    const toolDisposers = registerBrowserTools(ctx, server, {
      toolTimeoutMs: resolved.toolTimeoutMs,
      snapshotMaxChars: resolved.snapshotMaxChars,
      maxInteractiveItems: resolved.maxInteractiveItems,
    })
    return () => { for (const dispose of toolDisposers.values()) dispose() }
  }, 'browser-bridge: browser tools')

  // Optional system-prompt contribution: a one-line hint only — the model is
  // told to fetch snapshots on demand instead of hoarding page text.
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'tool:browser-bridge',
      order: 107,
      text: 'A browser bridge may be connected. To read or operate the user\'s active browser page, call browser_snapshot '
        + '(text-only; numbered items are the click/type targets). Never assume page content you have not snapshotted.',
    }), 'browser-bridge: system prompt section')
  }

  ctx.logger?.info?.(
    tokenRes.generated
      ? `browser bridge: new token generated and persisted at ${tokenRes.file} (chmod 0600); connect the extension and paste it in its settings`
      : `browser bridge: using token from ${tokenRes.file}`,
  )
  ctx.logger?.info?.(`browser bridge: listening on ${BRIDGE_PATH}`)
}
