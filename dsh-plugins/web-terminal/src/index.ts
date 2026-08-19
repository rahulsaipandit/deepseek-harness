/**
 * `dsh-plugin-web-terminal`: a browser-facing PTY console over
 * `ctx.terminals`, mirroring `dsh-plugin-browser-bridge`'s `ctx.webServer`
 * pattern (its own upgrade route, its own bearer-token auth, zero changes to
 * `packages/`/`apps/`). Closes the "human-facing terminal tab" gap named in
 * `docs/CompareCabinet.md`: `packages/terminal` already provides persistent
 * PTY sessions as a model-facing tool capability, but nothing exposes one to
 * a browser tab the way Cabinet's xterm.js terminal does.
 *
 * **Composition requirement:** unlike most `dsh-plugins/` packages, this one
 * needs `ctx.terminals` to actually have a backend registered (e.g.
 * `@deepseek-ai/dsh-terminal-bash`) reachable from the SAME context tree
 * this plugin loads into — see the README's "Composition" section for the
 * exact row list (mirrors `examples/acp-agent/pty.cordis.yml`'s host-level
 * `dsh-terminal` + `dsh-terminal-bash` mounting, which is a normal,
 * supported pattern independent of any per-preset isolated terminal realm).
 *
 * **Interaction model:** `ctx.terminals`' `TerminalBackendSession` contract
 * is line-oriented (`startSend({text, submit})`, one live operation at a
 * time), not a raw byte-streaming PTY — so this is a solid
 * single-command-at-a-time remote console, not a true interactive terminal.
 * See `domain.ts`'s module doc and the README's "What it is not" section.
 *
 * @module dsh-plugin-web-terminal
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-terminal'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WebTerminalServer } from './server.ts'
import { resolveToken } from './token.ts'
import { renderPage } from './page.ts'

/** Cordis plugin name. */
export const name = 'web-terminal'
/** Services required by this plugin. */
export const inject = ['webServer', 'agents', 'terminals']

export interface Config {
  /** Fixed bearer token. When absent, a token is generated on first boot and persisted under the dsh home (0600). */
  token?: string
  /** `ctx.terminals` backend type to spawn; defaults to `'shell'` (`@deepseek-ai/dsh-terminal-bash`'s default). */
  backendType?: string
  /** Absolute pathname for the WebSocket upgrade route. */
  path?: string
}

export const Config: z<Config> = z.object({
  token: z.string(),
  backendType: z.string().default('shell'),
  path: z.string().default('/ext/web-terminal'),
})

/** Mount the console: resolve the token, register the upgrade + page routes, all effect-scoped for HMR. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const backendType = config.backendType ?? 'shell'
  const path = config.path ?? '/ext/web-terminal'
  const tokenRes = await resolveToken(config.token)

  const server = new WebTerminalServer(
    tokenRes.token,
    ctx.agents,
    ctx.terminals,
    backendType,
    () => SessionId(`web-terminal-${randomUUID()}`),
  )

  const upgradeRoute: WebUpgradeRoute = {
    path,
    handler: (req, socket, head) => { server.handleUpgrade(req, socket, head) },
  }
  ctx.effect(() => ctx.webServer.registerUpgrade(upgradeRoute), 'web-terminal: upgrade route')
  ctx.effect(() => () => { void server.close() }, 'web-terminal: server')

  const pageRoute: WebRoute = {
    kind: 'exact',
    path,
    handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderPage(path))
    },
  }
  ctx.effect(() => ctx.webServer.register(pageRoute), 'web-terminal: page route')

  ctx.logger?.info?.(
    tokenRes.generated
      ? `web terminal: new token generated and persisted at ${tokenRes.file} (chmod 0600); open http://127.0.0.1:${ctx.webServer.port}${path} and paste it in`
      : `web terminal: using token from ${tokenRes.file}; open http://127.0.0.1:${ctx.webServer.port}${path}`,
  )
}
