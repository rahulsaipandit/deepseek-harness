import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { describe, expect, it, vi } from 'vitest'
import { registerConceptGraphServer } from '../src/web/concept-graph-server.ts'
import { emptyConceptGraph } from '../src/concept-graph.ts'

function fakeCtx() {
  const ctx = { effect: (execute: () => unknown) => { execute() } } as unknown as Context
  return ctx
}

function fakeWebServer() {
  const registered: { kind: string; path: string; handler: unknown }[] = []
  const webServer = {
    host: '127.0.0.1',
    port: 4123,
    register: vi.fn((route: { kind: string; path: string; handler: unknown }) => {
      registered.push(route)
      return () => {}
    }),
  } as unknown as WebServer
  return { webServer, registered }
}

describe('registerConceptGraphServer', () => {
  it('registers a page route and a data route under the configured path, and returns the page URL', () => {
    const ctx = fakeCtx()
    const { webServer, registered } = fakeWebServer()
    const url = registerConceptGraphServer(ctx, webServer, {
      webPath: '/knowledge-hub/concept-graph',
      readGraph: async () => emptyConceptGraph(),
    })
    expect(url).toBe('http://127.0.0.1:4123/knowledge-hub/concept-graph')
    expect(registered.map(r => r.path)).toEqual([
      '/knowledge-hub/concept-graph',
      '/knowledge-hub/concept-graph/data.json',
    ])
    expect(registered.every(r => r.kind === 'exact')).toBe(true)
  })

  it('the data route handler responds with the current graph as JSON', async () => {
    const ctx = fakeCtx()
    const { webServer, registered } = fakeWebServer()
    const graph = emptyConceptGraph()
    graph.nodes.push({ id: 'a', label: 'A', degree: 0, community: 0, noteIds: [] })
    registerConceptGraphServer(ctx, webServer, {
      webPath: '/knowledge-hub/concept-graph',
      readGraph: async () => graph,
    })
    const dataRoute = registered.find(r => r.path.endsWith('data.json'))
    const handler = dataRoute?.handler as (req: unknown, res: { writeHead: (code: number) => void; end: (body: string) => void }) => Promise<void>
    let statusCode = 0
    let body = ''
    await handler({}, { writeHead: code => { statusCode = code }, end: text => { body = text } })
    expect(statusCode).toBe(200)
    expect(JSON.parse(body)).toEqual(graph)
  })
})
