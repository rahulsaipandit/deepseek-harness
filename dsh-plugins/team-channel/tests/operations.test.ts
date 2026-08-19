import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listChannels, postMessage, readMessages, unwatchChannel, watchChannel } from '../src/operations.ts'
import { TeamChannelStore } from '../src/store.ts'
import { WatcherRegistry } from '../src/watchers.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a minimal structural stand-in for Agent
function fakeAgent(id: string): any {
  return { id, followups: [] as unknown[], followup(message: unknown) { this.followups.push(message) } }
}

describe('team-channel operations', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'team-channel-ops-'))
    path = join(dir, 'messages.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lets two agents with no parent/child relationship post and read the same channel', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const marketing = fakeAgent('persona-marketing')
    const cfo = fakeAgent('persona-cfo')

    postMessage(store, watchers, marketing, 'budget-review', 'Requesting Q3 ad spend approval', 1000)
    postMessage(store, watchers, cfo, 'budget-review', 'Approved, send the breakdown', 2000)

    const messages = readMessages(store, 'budget-review')
    expect(Array.isArray(messages)).toBe(true)
    expect(messages).toHaveLength(2)
    expect((messages as { postedBy: string }[]).map(m => m.postedBy)).toEqual(['persona-marketing', 'persona-cfo'])
    expect(listChannels(store)).toEqual(['budget-review'])
    store.close()
  })

  it('rejects an invalid channel name without touching the store', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const agent = fakeAgent('a')

    const result = postMessage(store, watchers, agent, 'Not Valid', 'hi', 1000)
    expect('code' in result && result.code).toBe('invalid_channel')
    expect(listChannels(store)).toEqual([])
    store.close()
  })

  it('rejects an empty body', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const agent = fakeAgent('a')

    const result = postMessage(store, watchers, agent, 'general', '   ', 1000)
    expect('code' in result && result.code).toBe('invalid_body')
    store.close()
  })

  it('pushes a follow-up to every live watcher except the poster', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const marketing = fakeAgent('persona-marketing')
    const cfo = fakeAgent('persona-cfo')
    const cos = fakeAgent('persona-chief-of-staff')

    watchChannel(watchers, cfo, 'budget-review')
    watchChannel(watchers, cos, 'budget-review')

    postMessage(store, watchers, marketing, 'budget-review', 'Requesting approval', 1000)

    expect(cfo.followups).toHaveLength(1)
    expect(cos.followups).toHaveLength(1)
    expect(marketing.followups).toHaveLength(0) // the poster never receives its own push
    store.close()
  })

  it('stops pushing once unwatched', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const marketing = fakeAgent('persona-marketing')
    const cfo = fakeAgent('persona-cfo')

    watchChannel(watchers, cfo, 'budget-review')
    unwatchChannel(watchers, cfo, 'budget-review')
    postMessage(store, watchers, marketing, 'budget-review', 'Requesting approval', 1000)

    expect(cfo.followups).toHaveLength(0)
    store.close()
  })

  it('filters read results by sinceId', () => {
    const store = new TeamChannelStore(path)
    const watchers = new WatcherRegistry()
    const agent = fakeAgent('a')

    const first = postMessage(store, watchers, agent, 'general', 'first', 1000)
    postMessage(store, watchers, agent, 'general', 'second', 2000)

    const firstId = 'id' in first ? first.id : -1
    const filtered = readMessages(store, 'general', firstId)
    expect(Array.isArray(filtered) && filtered).toHaveLength(1)
    store.close()
  })
})
