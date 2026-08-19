/**
 * WebSocket carrier for the web-terminal route: token-authenticated
 * (`hello` frame within `HELLO_TIMEOUT_MS`), one `TerminalWsBridge` per
 * connection. Thin `ws`-specific wiring; the actual frame handling lives in
 * `dispatch.ts` so it stays testable without a real socket.
 * @module dsh-plugin-web-terminal/server
 */

import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dispatchClientMessage } from './dispatch.ts'
import { parseClientMessage } from './domain.ts'
import type { ServerMessage } from './domain.ts'
import { TerminalWsBridge, type AgentsPort, type TerminalsPort } from './session-bridge.ts'
import { verifyToken } from './token.ts'

/** How long a new connection has to present a valid `hello` frame before it's closed. */
export const HELLO_TIMEOUT_MS = 10_000

export class WebTerminalServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private readonly bridges = new Set<TerminalWsBridge>()

  constructor(
    private readonly token: string,
    private readonly agents: AgentsPort,
    private readonly terminals: TerminalsPort,
    private readonly backendType: string,
    private readonly mintOwnerSessionId: () => SessionId,
  ) {}

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => { void this.attach(ws) })
  }

  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  private awaitHello(ws: WebSocket): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve(false)
      }, HELLO_TIMEOUT_MS)
      const onMessage = (data: Buffer | string): void => {
        if (settled) return
        const parsed = parseClientMessage(String(data))
        if ('code' in parsed || parsed.type !== 'hello') return // ignore noise before hello; timeout still governs
        settled = true
        clearTimeout(timer)
        ws.off('message', onMessage)
        resolve(verifyToken(this.token, parsed.token))
      }
      ws.on('message', onMessage)
    })
  }

  private async attach(ws: WebSocket): Promise<void> {
    const authenticated = await this.awaitHello(ws)
    if (!authenticated) {
      ws.close(4001, 'web-terminal: unauthorized')
      return
    }

    const bridge = new TerminalWsBridge(this.agents, this.terminals, this.backendType)
    this.bridges.add(bridge)
    try {
      const { motd } = await bridge.open(this.mintOwnerSessionId())
      this.send(ws, { type: 'motd', text: motd })
    } catch (error: unknown) {
      this.send(ws, { type: 'error', code: 'open_failed', message: error instanceof Error ? error.message : String(error) })
      this.bridges.delete(bridge)
      ws.close(1011, 'web-terminal: failed to open a terminal session')
      return
    }

    ws.on('message', (data: Buffer | string) => {
      const parsed = parseClientMessage(String(data))
      if ('code' in parsed) {
        this.send(ws, { type: 'error', ...parsed })
        return
      }
      void dispatchClientMessage(bridge, parsed, message => this.send(ws, message))
    })
    ws.on('close', () => {
      this.bridges.delete(bridge)
      void bridge.close()
    })
  }

  /** Close every live connection's bridge (kills its PTY session, disposes its owner agent). */
  async close(): Promise<void> {
    const closing = [...this.bridges].map(bridge => bridge.close())
    this.bridges.clear()
    for (const ws of this.wss.clients) ws.close(1001, 'web-terminal: server shutting down')
    await Promise.allSettled(closing)
  }
}
