import { describe, expect, it } from 'vitest'
import { WatcherRegistry } from '../src/watchers.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal structural stand-in for Agent, only identity matters to WatcherRegistry
function fakeAgent(id: string): any {
  return { id }
}

describe('WatcherRegistry', () => {
  it('returns no watchers for an unwatched channel', () => {
    const registry = new WatcherRegistry()
    expect(registry.watchersOf('marketing')).toEqual([])
  })

  it('tracks a watcher per channel', () => {
    const registry = new WatcherRegistry()
    const agentA = fakeAgent('a')
    registry.watch('marketing', agentA)
    expect(registry.watchersOf('marketing')).toEqual([agentA])
    expect(registry.watchersOf('cfo')).toEqual([])
  })

  it('excludes the given agent (the poster) from its own watchers list', () => {
    const registry = new WatcherRegistry()
    const agentA = fakeAgent('a')
    const agentB = fakeAgent('b')
    registry.watch('marketing', agentA)
    registry.watch('marketing', agentB)
    expect(registry.watchersOf('marketing', agentA)).toEqual([agentB])
  })

  it('unwatches a single channel', () => {
    const registry = new WatcherRegistry()
    const agentA = fakeAgent('a')
    registry.watch('marketing', agentA)
    registry.unwatch('marketing', agentA)
    expect(registry.watchersOf('marketing')).toEqual([])
  })

  it('unwatchAll drops every channel a disposed agent held', () => {
    const registry = new WatcherRegistry()
    const agentA = fakeAgent('a')
    registry.watch('marketing', agentA)
    registry.watch('cfo', agentA)
    registry.unwatchAll(agentA)
    expect(registry.watchersOf('marketing')).toEqual([])
    expect(registry.watchersOf('cfo')).toEqual([])
  })
})
