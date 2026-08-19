/**
 * Serves the concept-graph page and its JSON data feed via the resolved
 * `webServer` service, modeled directly on `dsh-plugins/web-terminal`'s
 * route-registration pattern. This exists because DSH's chat-facing tool
 * output has no interactive-card render type (confirmed against
 * `packages/core/tools/src/schema.ts`/`presentation.ts`) — a graph
 * visualization has to be a separately served page.
 * @module dsh-plugin-knowledge-hub/web/concept-graph-server
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { ConceptGraph } from '../concept-graph.ts'
import { renderConceptGraphPage } from './concept-graph-page.ts'

export interface ConceptGraphServerOptions {
  /** Base path the page is served under, e.g. `/knowledge-hub/concept-graph`. */
  webPath: string
  /** Reads the current graph fresh on every data request — always up to date, no cache invalidation needed. */
  readGraph: () => Promise<ConceptGraph>
}

/**
 * Register the concept-graph page + data routes on the resolved `webServer`
 * service, disposed automatically with the plugin fiber via `ctx.effect`
 * (matching `web-terminal`'s exact pattern). `webServer` is passed in
 * explicitly — rather than read from `ctx.webServer` — because this plugin
 * deliberately does not declare `inject: ['webServer']` (only needed when
 * `enableConceptGraph` is on), and Cordis only populates `ctx.<service>`
 * direct-property access for services listed in a plugin's static `inject`.
 * Returns the page URL.
 */
export function registerConceptGraphServer(ctx: Context, webServer: WebServer, options: ConceptGraphServerOptions): string {
  const dataPath = `${options.webPath}/data.json`

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: options.webPath,
    handler: (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(renderConceptGraphPage(dataPath))
    },
  }), 'knowledge-hub: concept-graph page route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: dataPath,
    handler: async (_req: IncomingMessage, res: ServerResponse) => {
      try {
        const graph = await options.readGraph()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(graph))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    },
  }), 'knowledge-hub: concept-graph data route')

  return `http://${webServer.host}:${webServer.port}${options.webPath}`
}
