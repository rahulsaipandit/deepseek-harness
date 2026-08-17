/**
 * Bridge WebSocket carrier: token-authenticated connection registry, gateway
 * RPC passthrough, per-connection event pump, and tool-call dispatch to the
 * connected browser extension.
 *
 * The route this server mounts (`/ext/bridge`) lives OUTSIDE DSH's `/api`
 * trust fence (which only guards the client-connection routes), so the bridge
 * brings its own authentication: a bearer token presented in the `hello` frame
 * within HELLO_TIMEOUT_MS. Gateway RPCs are dispatched through the same
 * fetch-shaped handler the `/api` carrier uses (`toFetchHandler`), so schema
 * validation and error envelopes are identical to the GUI path. Methods the
 * `/api` carrier pins to loopback (`PRIVILEGED_METHODS`) stay loopback-only
 * here regardless of the token, defense in depth for `--host 0.0.0.0`
 * deployments.
 *
 * One active connection at a time: a new authenticated socket replaces the
 * previous one (the old socket is closed and its in-flight tool calls settle
 * as `bridge-closed`).
 *
 * Ported from github.com/Lum1104/dsh-browser
 * (`packages/browser/bridge-browser/src/server.ts`). The security-critical
 * properties are preserved byte-for-byte: token auth with `timingSafeEqual`,
 * the Origin-gated loopback exception, and privileged-method loopback
 * pinning. Adapted only where this repo's real host types differ from
 * upstream's (a generic fetch-shaped `apiHandler`/`openEvents` dependency pair
 * instead of importing `@deepseek-ai/dsh-host-apiproxy`'s exact `MuxFrame`/
 * `RpcRequest` generics, since this package must not depend on that package's
 * internal wire-envelope shape to stay a standalone, independently-installable
 * plugin).
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  HELLO_TIMEOUT_MS,
  PING_INTERVAL_MS,
  parseBridgeFrame,
  type BridgeFrame,
  type BridgeCaps,
  type ClientFrame,
  type ToolErrorCode,
} from './protocol.ts'
import { verifyToken } from './token.ts'

/**
 * Gateway methods the /api carrier pins to loopback (mirror of
 * client-connection's PRIVILEGED_METHODS; kept verbatim so the two fences
 * cannot drift). The bridge rejects these for non-loopback remotes even with
 * a valid token.
 */
const PRIVILEGED_METHODS = new Set([
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
])

/** Session mutations whose WebSocket arrival order is behaviorally significant. */
const ORDERED_SESSION_METHODS = new Set([
  BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD,
  'session.prompt',
  'session.cancel',
])

/** Loopback IPv4/IPv6 literals (IPv4-mapped included). Exported for tests and reuse. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Decide whether a `hello` frame authenticates. Extracted as a pure function
 * (identical logic to upstream's inline check) so the security-critical
 * decision — the loopback shortcut requires BOTH a loopback remote address
 * AND a `chrome-extension://` Origin, never loopback alone — is unit
 * testable without opening a real socket.
 *
 * WebSockets have no same-origin policy, so a malicious web page could open a
 * cross-origin socket to 127.0.0.1 with a loopback remote address; requiring
 * the `chrome-extension://` Origin closes that off because only extension
 * contexts can present that scheme (an ordinary page cannot forge it).
 * Non-loopback remotes must always present the bearer token.
 *
 * @param remoteAddress - the socket's remote address, captured at upgrade time.
 * @param origin - the WebSocket handshake's `Origin` header, if any.
 * @param expectedToken - the configured/persisted bridge token.
 * @param presentedToken - the token presented in the `hello` frame.
 * @returns true when the connection may be promoted to the active slot.
 */
export function authenticatesHello(
  remoteAddress: string | undefined,
  origin: string | undefined,
  expectedToken: string,
  presentedToken: string,
): boolean {
  const loopbackNoToken = isLoopbackAddress(remoteAddress)
    && typeof origin === 'string'
    && origin.startsWith('chrome-extension://')
  return loopbackNoToken || verifyToken(expectedToken, presentedToken)
}

/**
 * Whether a gateway RPC method name is loopback-only, regardless of token
 * validity (defense in depth for `--host 0.0.0.0` deployments). Exported for
 * direct unit testing of the privileged-method pinning rule.
 * @param method - gateway RPC method name.
 * @param remoteAddress - the connection's remote address.
 * @returns true when this call must be rejected.
 */
export function isForbiddenPrivilegedCall(method: string, remoteAddress: string | undefined): boolean {
  return PRIVILEGED_METHODS.has(method) && !isLoopbackAddress(remoteAddress)
}

/** Error thrown by requestTool; the tool registry turns it into an isError result. */
export class BridgeToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeToolError'
  }
}

/** One event envelope pumped to the extension over the ready connection. */
export interface BridgeEventEnvelope {
  rpcId: string
  payload: { type: string } & Record<string, unknown>
}

/** Dependencies the bridge needs from the host. */
export interface BridgeServerDeps {
  /** Bearer token the extension must present in `hello`. */
  token: string
  /** Fetch-shaped gateway carrier (`toFetchHandler(ctx.apiProxy)`). */
  apiHandler: { fetch: (request: Request) => Promise<Response> }
  /** Per-connection event stream (usually `ctx.apiProxy.events.mux`). */
  openEvents: (signal: AbortSignal) => AsyncIterable<BridgeEventEnvelope>
  /** Default per-tool-call timeout in ms. */
  toolTimeoutMs: number
  /** Capabilities to echo in `hello.ok` (negotiated snapshot budgets). */
  caps: BridgeCaps
  /** Seed a followed-page snapshot into a live or deferred Agent session. */
  injectBrowserSnapshot: (sessionId: string, snapshot: string) => void | Promise<void>
  /**
   * Test seam: force the remote address seen by the privilege gate. The
   * sandbox cannot bind arbitrary loopback literals, so the non-loopback
   * branch is exercised through this override; production never sets it.
   */
  remoteAddressOverride?: string
  /** Milliseconds a fresh socket may present `hello`; defaults to HELLO_TIMEOUT_MS. */
  helloTimeoutMs?: number
  /** Server ping cadence; defaults to PING_INTERVAL_MS. */
  pingIntervalMs?: number
}

/** One in-flight tool call awaiting the extension's `tool.result`. */
interface PendingTool {
  resolve: (result: unknown) => void
  reject: (error: BridgeToolError) => void
  timer: NodeJS.Timeout
}

/** A socket that passed authentication and owns the single active slot. */
interface ReadyConnection {
  ws: WebSocket
  /** Remote address captured at upgrade time (loopback gate for privileged methods). */
  remoteAddress: string | undefined
  abort: AbortController
  pump: Promise<void>
  ping: NodeJS.Timeout
}

function sendFrame(ws: WebSocket, frame: BridgeFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify(frame))
}

/**
 * Decode one ws message payload to text. Exported so all three delivery
 * shapes (fragmented buffer list, Buffer, ArrayBuffer) are unit-testable
 * directly — node ws only ever delivers Buffers in practice.
 * @param data - ws message payload.
 * @returns the decoded UTF-8 text.
 */
export function messageToText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  return Buffer.from(data).toString('utf8')
}

/**
 * Token-authenticated bridge server. Construct once per plugin instance;
 * dispose with {@link close}.
 */
export class BridgeServer {
  private readonly wss = new WebSocketServer({ noServer: true })
  private current: ReadyConnection | null = null
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly orderedSessionRpcs = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly deps: BridgeServerDeps) {}

  /**
   * Handle one HTTP upgrade for the bridge path.
   * @param req - upgrade request (carries the client's remote address).
   * @param socket - raw socket transferred by the HTTP server.
   * @param head - bytes already read after the upgrade headers.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = this.deps.remoteAddressOverride ?? req.socket.remoteAddress
    const origin = req.headers.origin
    this.wss.handleUpgrade(req, socket, head, (ws) => { this.attach(ws, remote, origin) })
  }

  /**
   * Request one browser action from the connected extension.
   * @param name - tool name (also the wire action name).
   * @param args - validated tool arguments.
   * @param signal - caller cancellation (abort settles the call as cancelled).
   * @param timeoutMs - per-call budget; defaults to the plugin config value.
   * @param sessionId - optional owning Agent session for approval continuity.
   * @returns the extension's action result.
   * @throws BridgeToolError when no extension is connected, the call times
   *   out, is cancelled, or the extension reports a failure.
   */
  requestTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number = this.deps.toolTimeoutMs,
    sessionId?: string,
  ): Promise<unknown> {
    const conn = this.current
    if (conn === null) {
      throw new BridgeToolError('bridge-closed', 'no browser extension is connected to the bridge')
    }
    // A caller that already aborted must not dispatch: the abort listener
    // below does not replay for pre-aborted signals, so the call would be
    // sent to the extension and executed despite the cancellation.
    if (signal.aborted) {
      throw new BridgeToolError('bridge-closed', 'tool call cancelled before dispatch')
    }
    const id = randomUUID()
    const expiresAt = Date.now() + timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      let timer: NodeJS.Timeout
      const settle = (error: BridgeToolError): void => {
        clearTimeout(timer)
        this.pendingTools.delete(id)
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
      const cancel = (error: BridgeToolError): void => {
        // The extension may be paused on a user approval after the caller has
        // stopped waiting. Withdraw that approval before settling locally so
        // a late click cannot execute an expired action.
        sendFrame(conn.ws, { t: 'tool.cancel', id })
        settle(error)
      }
      const onAbort = (): void => {
        cancel(new BridgeToolError('bridge-closed', 'tool call cancelled before the extension answered'))
      }
      timer = setTimeout(() => {
        cancel(new BridgeToolError('timeout', `browser action "${name}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      this.pendingTools.set(id, { resolve, reject, timer })
      conn.ws.send(JSON.stringify({
        t: 'tool.call',
        id,
        name,
        args,
        expiresAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      } satisfies BridgeFrame), (error) => {
        if (error != null) {
          settle(new BridgeToolError('bridge-closed', `bridge socket failed before delivery: ${error.message}`))
        }
      })
    })
  }

  /**
   * Terminate the server: close the acceptor, drop all sockets, reject all
   * in-flight tool calls.
   * @returns a promise resolving after the acceptor and all pumps stop.
   */
  async close(): Promise<void> {
    // Idempotent: a second close must not touch the acceptor (ws throws
    // "The server is not running" when closing an already-closed server).
    if (this.closed) return
    this.closed = true
    // Capture the live pump BEFORE replaceConnection nulls the connection.
    const pumps = this.current === null ? [] : [this.current.pump]
    this.replaceConnection()
    for (const socket of this.wss.clients) socket.terminate()
    this.current = null
    await new Promise<void>((resolve, reject) => {
      this.wss.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await Promise.all(pumps)
  }

  /** @returns whether an authenticated extension is currently connected. */
  hasConnection(): boolean {
    return this.current !== null
  }

  private attach(ws: WebSocket, remoteAddress: string | undefined, origin: string | undefined): void {
    let helloTimer: NodeJS.Timeout | undefined = setTimeout(() => {
      ws.close(4001, 'hello timeout')
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS)

    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]): void => {
      const text = messageToText(data)
      const frame = parseBridgeFrame(text)
      if (frame === undefined) {
        ws.close(1008, 'unparseable frame')
        return
      }
      if (helloTimer !== undefined) {
        // Pending state: only `hello` is legal.
        if (frame.t !== 'hello') {
          ws.close(1008, 'hello first')
          return
        }
        // Zero-config local mode: loopback sockets skip the token (the
        // extension auto-discovers the bridge and connects without setup),
        // but only when paired with a chrome-extension:// Origin — see
        // authenticatesHello's doc comment for why loopback alone is unsafe.
        if (!authenticatesHello(remoteAddress, origin, this.deps.token, frame.token)) {
          ws.close(4002, 'bad token')
          return
        }
        clearTimeout(helloTimer)
        helloTimer = undefined
        this.promote(ws, remoteAddress)
        return
      }
      this.handleReadyFrame(frame)
    }
    const onClose = (): void => {
      if (helloTimer !== undefined) clearTimeout(helloTimer)
      if (this.current !== null && this.current.ws === ws) this.replaceConnection()
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onClose)
  }

  /** Promote an authenticated socket to the single active slot. */
  private promote(ws: WebSocket, remoteAddress: string | undefined): void {
    this.replaceConnection()
    const abort = new AbortController()
    const ping = setInterval(() => { sendFrame(ws, { t: 'ping' }) }, this.deps.pingIntervalMs ?? PING_INTERVAL_MS)
    const pump = (async () => {
      try {
        for await (const envelope of this.deps.openEvents(abort.signal)) {
          if (ws.readyState !== WebSocket.OPEN) break
          sendFrame(ws, {
            t: 'event',
            frame: { rpcId: envelope.rpcId, method: envelope.payload.type, payload: envelope.payload },
          })
        }
      } catch (error: unknown) {
        if (!abort.signal.aborted && ws.readyState === WebSocket.OPEN) {
          sendFrame(ws, { t: 'error', code: 'stream-failed', message: String(error) })
        }
      }
    })()
    this.current = { ws, remoteAddress, abort, pump, ping }
    sendFrame(ws, { t: 'hello.ok', caps: this.deps.caps })
    ws.once('close', () => {
      clearInterval(ping)
      abort.abort()
    })
  }

  private handleReadyFrame(frame: BridgeFrame): void {
    switch (frame.t) {
      case 'rpc':
        this.routeRpc(frame)
        break
      case 'respond':
        void this.handleRespond(frame)
        break
      case 'tool.result':
        this.settleTool(frame.id, frame.ok, frame.ok ? frame.result : frame.error)
        break
      case 'pong':
      case 'hello':
      case 'hello.ok':
      case 'rpc.result':
      case 'respond.result':
      case 'event':
      case 'tool.call':
      case 'tool.cancel':
      case 'ping':
      case 'error':
        // Protocol violations and unsolicited server-side shapes are ignored;
        // the extension is the only sender on this channel.
        break
    }
  }

  /**
   * Preserve prompt/cancel arrival order per session. In particular, the
   * first prompt may still be materializing a provisional session; its cancel
   * must not reach the gateway until that admission has completed.
   */
  private routeRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): void {
    const sessionId = orderedSessionId(frame)
    if (sessionId === undefined) {
      void this.handleRpc(frame)
      return
    }
    const previous = this.orderedSessionRpcs.get(sessionId) ?? Promise.resolve()
    const task = previous.then(
      () => this.handleRpc(frame),
      () => this.handleRpc(frame),
    )
    this.orderedSessionRpcs.set(sessionId, task)
    const clear = (): void => {
      if (this.orderedSessionRpcs.get(sessionId) === task) this.orderedSessionRpcs.delete(sessionId)
    }
    void task.then(clear, clear)
  }

  private async handleRpc(frame: Extract<ClientFrame, { t: 'rpc' }>): Promise<void> {
    const conn = this.current
    if (conn === null) return
    const forbidden = isForbiddenPrivilegedCall(frame.method, conn.remoteAddress)
    if (forbidden) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'forbidden', message: 'method is loopback-only' } })
      return
    }
    if (frame.method === BRIDGE_INJECT_BROWSER_SNAPSHOT_METHOD) {
      const payload = browserSnapshotPayload(frame.payload)
      if (payload === undefined) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'bad-request', message: 'sessionId and snapshot must be non-empty strings' },
        })
        return
      }
      try {
        await this.deps.injectBrowserSnapshot(payload.sessionId, payload.snapshot)
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result: { accepted: true } })
      } catch (error: unknown) {
        sendFrame(conn.ws, {
          t: 'rpc.result',
          id: frame.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      }
      return
    }
    // The request URL is always assembled from a fixed internal base plus the
    // method name that is already validated against PRIVILEGED_METHODS above
    // and dispatched through the fixed apiHandler; no part of this URL is
    // ever built from a field inside a response.
    const body = JSON.stringify({ type: 'client-request', rpcId: frame.id, method: frame.method, payload: frame.payload })
    const request = new Request(new URL(`/api/${frame.method}`, 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    try {
      const response = await this.deps.apiHandler.fetch(request)
      const text = await response.text()
      if (!response.ok) {
        sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'http', message: text } })
        return
      }
      let result: unknown
      try {
        result = JSON.parse(text)
      } catch {
        result = text
      }
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'rpc.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  /** Relay a pending host-interaction response through the GUI's /api/respond channel. */
  private async handleRespond(frame: Extract<ClientFrame, { t: 'respond' }>): Promise<void> {
    const conn = this.current
    if (conn === null) return
    const request = new Request(new URL('/api/respond', 'http://dsh.internal'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: frame.rpcId, result: frame.result }),
    })
    try {
      const response = await this.deps.apiHandler.fetch(request)
      const text = await response.text()
      if (!response.ok) {
        sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'http', message: text } })
        return
      }
      let result: unknown
      try {
        result = JSON.parse(text)
      } catch {
        result = text
      }
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: true, result })
    } catch (error: unknown) {
      sendFrame(conn.ws, { t: 'respond.result', id: frame.id, ok: false, error: { code: 'internal', message: String(error) } })
    }
  }

  private settleTool(id: string, ok: boolean, payload: unknown): void {
    const pending = this.pendingTools.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pendingTools.delete(id)
    if (ok) pending.resolve(payload)
    else pending.reject(new BridgeToolError(payloadCode(payload), payloadMessage(payload)))
  }

  /** Close the current connection (if any) and settle its in-flight calls. */
  private replaceConnection(): void {
    const conn = this.current
    if (conn === null) return
    this.current = null
    clearInterval(conn.ping)
    conn.abort.abort()
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(4000, 'replaced')
    }
    for (const [id, pending] of this.pendingTools) {
      clearTimeout(pending.timer)
      this.pendingTools.delete(id)
      pending.reject(new BridgeToolError('bridge-closed', 'the extension connection was replaced'))
    }
  }
}

function browserSnapshotPayload(payload: unknown): { sessionId: string; snapshot: string } | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const { sessionId, snapshot } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return undefined
  if (typeof snapshot !== 'string' || snapshot.trim() === '') return undefined
  return { sessionId, snapshot }
}

function orderedSessionId(frame: Extract<ClientFrame, { t: 'rpc' }>): string | undefined {
  if (!ORDERED_SESSION_METHODS.has(frame.method)) return undefined
  if (typeof frame.payload !== 'object' || frame.payload === null || Array.isArray(frame.payload)) return undefined
  const sessionId = (frame.payload as Record<string, unknown>).sessionId
  return typeof sessionId === 'string' ? sessionId : undefined
}

/**
 * Tool error payload → stable code. The wire parser enforces string fields,
 * so the fallback branches are parser-gated; exported so the fallback
 * contract is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the stable error code.
 */
export function payloadCode(payload: unknown): ToolErrorCode {
  if (typeof payload === 'object' && payload !== null) {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string') return code as ToolErrorCode
    return 'internal'
  }
  return 'internal'
}

/**
 * Tool error payload → message. The wire parser enforces string fields, so
 * the fallback branches are parser-gated; exported so the fallback contract
 * is unit-testable directly.
 * @param payload - extension-reported error payload.
 * @returns the human-readable message.
 */
export function payloadMessage(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
    return 'browser action failed'
  }
  return 'browser action failed'
}
