/**
 * Bridges one WebSocket connection to one owner-scoped `ctx.terminals`
 * session: mints a dedicated owner `Agent` (a live `Agent` is required —
 * `ctx.terminals` has no ownerless "give me a shell"), spawns a PTY session
 * on it, and exposes the line-oriented send/read/signal operations the
 * connection needs. Kept independent of `ws`/Cordis types via small
 * structural ports (`AgentsPort`/`TerminalsPort`), so it's testable with
 * plain fakes.
 * @module dsh-plugin-web-terminal/session-bridge
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  TerminalReadRequest,
  TerminalReadResult,
  TerminalSendRead,
  TerminalSendResult,
  TerminalSessionId,
  TerminalSignal,
  TerminalSignalResult,
  TerminalSpawnResult,
} from '@deepseek-ai/dsh-terminal'

export interface AgentHandlePort {
  readonly agent: Agent
  dispose(): Promise<void>
}

export interface AgentsPort {
  create(options: { sessionId: SessionId }): Promise<AgentHandlePort>
}

export interface TerminalsPort {
  spawn(owner: Agent, request: { type: string }): Promise<TerminalSpawnResult>
  startSend(owner: Agent, id: TerminalSessionId, request: { text: string; submit: boolean }): {
    done: Promise<TerminalSendResult>
    readOutput(): TerminalSendRead
    cancel(): boolean
  }
  read(owner: Agent, id: TerminalSessionId, request?: TerminalReadRequest): TerminalReadResult
  signal(owner: Agent, id: TerminalSessionId, signal: TerminalSignal): Promise<TerminalSignalResult>
  kill(owner: Agent, id: TerminalSessionId, reason?: string): Promise<boolean>
}

/** How often `sendLine` polls the live send operation's output while it's in flight. */
const DEFAULT_POLL_INTERVAL_MS = 100

export class TerminalWsBridge {
  private owner: AgentHandlePort | undefined
  private sessionId: TerminalSessionId | undefined

  constructor(
    private readonly agents: AgentsPort,
    private readonly terminals: TerminalsPort,
    private readonly backendType: string,
  ) {}

  /** Mint the owner agent and spawn the PTY session. Must be called exactly once before any other method. */
  async open(ownerSessionId: SessionId): Promise<{ motd: string }> {
    this.owner = await this.agents.create({ sessionId: ownerSessionId })
    const spawned = await this.terminals.spawn(this.owner.agent, { type: this.backendType })
    this.sessionId = spawned.sessionId
    return { motd: spawned.motd }
  }

  private requireOpen(): { agent: Agent; sessionId: TerminalSessionId } {
    if (this.owner === undefined || this.sessionId === undefined) {
      throw new Error('web-terminal: session-bridge used before open() resolved')
    }
    return { agent: this.owner.agent, sessionId: this.sessionId }
  }

  /**
   * Send one line and poll its live operation until settlement, streaming
   * every non-empty delta to `onDelta` as it's produced.
   * @param pollIntervalMs - injectable for tests; production default is 100ms.
   */
  async sendLine(
    text: string,
    submit: boolean,
    onDelta: (read: TerminalSendRead) => void,
    pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ): Promise<TerminalSendResult> {
    const { agent, sessionId } = this.requireOpen()
    const operation = this.terminals.startSend(agent, sessionId, { text, submit })
    const timer = setInterval(() => {
      const read = operation.readOutput()
      if (read.delta.length > 0) onDelta(read)
    }, pollIntervalMs)
    try {
      return await operation.done
    } finally {
      clearInterval(timer)
      const finalRead = operation.readOutput()
      if (finalRead.delta.length > 0) onDelta(finalRead)
    }
  }

  read(request: TerminalReadRequest = {}): TerminalReadResult {
    const { agent, sessionId } = this.requireOpen()
    return this.terminals.read(agent, sessionId, request)
  }

  async signal(signal: TerminalSignal): Promise<TerminalSignalResult> {
    const { agent, sessionId } = this.requireOpen()
    return this.terminals.signal(agent, sessionId, signal)
  }

  /** Idempotent: safe to call even if `open()` never resolved. */
  async close(reason: string = 'web-terminal: socket closed'): Promise<void> {
    if (this.owner === undefined || this.sessionId === undefined) return
    const { agent, sessionId } = { agent: this.owner.agent, sessionId: this.sessionId }
    const owner = this.owner
    this.owner = undefined
    this.sessionId = undefined
    try {
      await this.terminals.kill(agent, sessionId, reason)
    } finally {
      await owner.dispose()
    }
  }
}
