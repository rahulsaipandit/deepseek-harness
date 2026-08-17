import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateStore } from '../../src/core/state-store.ts'
import { SessionRouter, type AgentHandleLike, type AgentsPort } from '../../src/core/session-router.ts'

class FakeAgents implements AgentsPort {
  readonly created: string[] = []
  readonly followups: { sessionId: string, message: unknown }[] = []
  private readonly live = new Map<string, AgentHandleLike>()

  get(id: string): AgentHandleLike | undefined {
    return this.live.get(id)
  }

  async create(options: { sessionId: string }): Promise<{ agent: AgentHandleLike, dispose(): Promise<void> }> {
    this.created.push(options.sessionId)
    const agent: AgentHandleLike = {
      followup: (message) => this.followups.push({ sessionId: options.sessionId, message }),
    }
    this.live.set(options.sessionId, agent)
    return { agent, dispose: async () => { this.live.delete(options.sessionId) } }
  }
}

describe('SessionRouter', () => {
  let dir: string
  let store: StateStore<unknown>
  let agents: FakeAgents
  let router: SessionRouter
  let now: number

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-imchat-router-'))
    store = new StateStore(join(dir, 'telegram.json'))
    agents = new FakeAgents()
    now = 1000
    let mintCount = 0
    router = new SessionRouter(
      agents,
      store,
      raw => SessionId(raw),
      () => `minted-${(mintCount += 1)}`,
      60_000,
      () => now,
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates exactly one session for a new chat identity, reusing it on later messages', async () => {
    await router.followup('telegram', 'chat-1', 'hello')
    await router.followup('telegram', 'chat-1', 'again')
    expect(agents.created).toHaveLength(1)
    expect(agents.followups.map(f => f.message)).toEqual(['hello', 'again'])
  })

  it('creates separate sessions for distinct chat identities', async () => {
    await router.followup('telegram', 'chat-1', 'a')
    await router.followup('telegram', 'chat-2', 'b')
    expect(agents.created).toHaveLength(2)
  })

  it('resolves a session back to its owning chat via chatFor', async () => {
    await router.followup('telegram', 'chat-1', 'hello')
    const sessionId = SessionId(agents.created[0]!)
    expect(router.chatFor(sessionId)).toEqual({ platform: 'telegram', chatId: 'chat-1' })
  })

  it('reuses a persisted session mapping across a fresh router (simulated restart)', async () => {
    await router.followup('telegram', 'chat-1', 'hello')
    const firstSessionId = agents.created[0]

    let mintCount = 100
    const restarted = new SessionRouter(agents, store, raw => SessionId(raw), () => `minted-${(mintCount += 1)}`, 60_000, () => now)
    await restarted.followup('telegram', 'chat-1', 'again')

    expect(agents.created).toEqual([firstSessionId])
  })

  it('evicts an idle in-memory binding after the TTL, but keeps the persisted mapping so the next message resumes it', async () => {
    await router.followup('telegram', 'chat-1', 'hello')
    const firstSessionId = agents.created[0]
    now += 120_000 // past the 60s TTL
    await router.followup('telegram', 'chat-1', 'again')
    // Same session id resumed via the persisted mapping, even though the in-memory binding was evicted.
    expect(agents.created).toEqual([firstSessionId])
  })

  it('reset() drops both the in-memory and persisted binding so the next message starts a fresh session', async () => {
    await router.followup('telegram', 'chat-1', 'hello')
    await router.reset('telegram', 'chat-1')
    await router.followup('telegram', 'chat-1', 'hello again')
    expect(agents.created).toHaveLength(2)
    expect(agents.created[0]).not.toBe(agents.created[1])
  })
})
