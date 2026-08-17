/**
 * Session binding (design doc §2): one DSH session per `(platform,
 * externalChatId)` pair. First contact creates a session via `ctx.agents`;
 * later messages reuse it through `followup()` — the pattern
 * `docs/cookbook/extension-cookbook.md` documents for a UI/protocol-driver
 * plugin, not the external HTTP/WebSocket RPC surface a browser or VS Code
 * client uses. The `(platform, externalChatId) -> sessionId` mapping
 * survives a restart via `StateStore`; idle bindings are evicted from the
 * in-memory router after `idleTtlMs` without touching the persisted mapping,
 * so a later message from the same chat resumes the same session.
 * @module dsh-plugin-imchat/core/session-router
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Platform } from './types.ts'
import type { StateStore } from './state-store.ts'

/** The slice of a DSH `Agent` this router drives — a follow-up injector, nothing more. */
export interface AgentHandleLike {
  followup(message: unknown): void
}

/** The slice of `ctx.agents` this router needs, kept narrow so it's fake-able in tests. */
export interface AgentsPort {
  get(id: SessionId): AgentHandleLike | undefined
  create(options: { sessionId: SessionId }): Promise<{ agent: AgentHandleLike, dispose(): Promise<void> }>
}

/** Mints session ids; injected so tests get deterministic ids instead of `randomUUID()`. */
export type SessionIdFactory = () => string

function bindingKey(platform: Platform, chatId: string): string {
  return `${platform}:${chatId}`
}

interface RouterEntry {
  readonly sessionId: SessionId
  lastActiveAt: number
}

/** Where a bound session's replies and prompts should go. */
export interface ChatLocation {
  readonly platform: Platform
  readonly chatId: string
}

/** Routes inbound chat messages to a bound DSH session, creating one on first contact. */
export class SessionRouter {
  private readonly bindings = new Map<string, RouterEntry>()
  private readonly bySessionId = new Map<SessionId, ChatLocation>()

  constructor(
    private readonly agents: AgentsPort,
    private readonly store: StateStore<unknown>,
    private readonly sessionIdOf: (raw: string) => SessionId,
    private readonly mintSessionId: SessionIdFactory,
    private readonly idleTtlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Evicts in-memory bindings idle past `idleTtlMs`; the persisted mapping is untouched. */
  private evictIdle(): void {
    const cutoff = this.now() - this.idleTtlMs
    for (const [key, entry] of this.bindings) {
      if (entry.lastActiveAt < cutoff) this.bindings.delete(key)
    }
  }

  /** Resolves (creating if needed) the session bound to `(platform, chatId)`, and drives it with `message`. */
  async followup(platform: Platform, chatId: string, message: unknown): Promise<void> {
    this.evictIdle()
    const key = bindingKey(platform, chatId)
    let entry = this.bindings.get(key)
    if (entry === undefined) {
      const persistedRaw = await this.store.getSession(key)
      const sessionId = persistedRaw !== undefined ? this.sessionIdOf(persistedRaw) : this.sessionIdOf(this.mintSessionId())
      const agent = this.agents.get(sessionId) ?? await this.attach(key, sessionId)
      entry = { sessionId, lastActiveAt: this.now() }
      this.bindings.set(key, entry)
      this.bySessionId.set(sessionId, { platform, chatId })
      agent.followup(message)
      return
    }
    entry.lastActiveAt = this.now()
    const agent = this.agents.get(entry.sessionId)
    if (agent === undefined) throw new Error(`dsh-imchat: session ${entry.sessionId} for ${key} is bound but no longer live`)
    agent.followup(message)
  }

  private async attach(key: string, sessionId: SessionId): Promise<AgentHandleLike> {
    const { agent } = await this.agents.create({ sessionId })
    await this.store.setSession(key, sessionId)
    return agent
  }

  /** The chat a bound session's replies/prompts belong to, or `undefined` for a session this router didn't bind. */
  chatFor(sessionId: SessionId): ChatLocation | undefined {
    return this.bySessionId.get(sessionId)
  }

  /** Drops the persisted and in-memory binding for `(platform, chatId)`, so the next message starts fresh. */
  async reset(platform: Platform, chatId: string): Promise<void> {
    const key = bindingKey(platform, chatId)
    const entry = this.bindings.get(key)
    if (entry !== undefined) this.bySessionId.delete(entry.sessionId)
    this.bindings.delete(key)
    await this.store.deleteSession(key)
  }
}
