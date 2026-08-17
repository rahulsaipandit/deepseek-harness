import { describe, expect, it } from 'vitest'
import { BrowserContextInjector, createBrowserSnapshotMessage } from '../src/browser-context.ts'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'

function fakeAgent(id: string): Agent & { inject: ReturnType<typeof injectSpy> } {
  const injects: unknown[] = []
  return {
    id,
    inject: injectSpy(injects),
  } as unknown as Agent & { inject: ReturnType<typeof injectSpy> }
}

function injectSpy(sink: unknown[]) {
  const fn = (message: unknown): void => { sink.push(message) }
  ;(fn as unknown as { calls: unknown[] }).calls = sink
  return fn
}

describe('createBrowserSnapshotMessage', () => {
  it('builds a plugin-sourced user message carrying the snapshot text', () => {
    const message = createBrowserSnapshotMessage('Title: Example\nURL: https://example.com')
    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-plugin-browser-bridge', form: 'snapshot' })
    expect(message.content[0]).toMatchObject({ type: 'text' })
    const text = (message.content[0] as { text: string }).text
    expect(text).toContain('https://example.com')
  })
})

describe('BrowserContextInjector', () => {
  it('injects immediately into a live agent', () => {
    const agent = fakeAgent('sess-1')
    const registry = { get: () => agent } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(registry)
    const outcome = injector.inject('sess-1', 'page text')
    expect(outcome).toBe('injected')
    expect(agent.inject).toHaveProperty('calls')
    expect((agent.inject as unknown as { calls: unknown[] }).calls).toHaveLength(1)
  })

  it('queues the snapshot when no live agent exists yet, then activates it once', () => {
    const registry = { get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(registry)
    expect(injector.inject('sess-2', 'page text')).toBe('queued')
    const agent = fakeAgent('sess-2')
    expect(injector.activate(agent)).toBe(true)
    expect((agent.inject as unknown as { calls: unknown[] }).calls).toHaveLength(1)
    // A second activation finds nothing pending (already flushed).
    expect(injector.activate(agent)).toBe(false)
  })

  it('only the newest queued snapshot per session survives (re-following overwrites)', () => {
    const registry = { get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(registry)
    injector.inject('sess-3', 'first page')
    injector.inject('sess-3', 'second page')
    const agent = fakeAgent('sess-3')
    injector.activate(agent)
    const [message] = (agent.inject as unknown as { calls: unknown[] }).calls as [{ content: { text: string }[] }]
    expect(message.content[0]!.text).toContain('second page')
    expect(message.content[0]!.text).not.toContain('first page')
  })

  it('evicts the oldest pending session once maxPending is exceeded', () => {
    const registry = { get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(registry, 2)
    injector.inject('a', 'A')
    injector.inject('b', 'B')
    injector.inject('c', 'C')
    const agentA = fakeAgent('a')
    // "a" was evicted, so activation finds nothing pending for it.
    expect(injector.activate(agentA)).toBe(false)
    const agentC = fakeAgent('c')
    expect(injector.activate(agentC)).toBe(true)
  })

  it('rejects a non-positive-integer maxPending', () => {
    const registry = { get: () => undefined } as unknown as Pick<AgentRegistry, 'get'>
    expect(() => new BrowserContextInjector(registry, 0)).toThrow(/maxPending/)
    expect(() => new BrowserContextInjector(registry, 1.5)).toThrow(/maxPending/)
  })
})
