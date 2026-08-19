import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamChannelStore } from '../src/store.ts'

describe('TeamChannelStore', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'team-channel-'))
    path = join(dir, 'nested', 'messages.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('creates its parent directory and schema on open', () => {
    const store = new TeamChannelStore(path)
    expect(store.listChannels()).toEqual([])
    store.close()
  })

  it('posts and reads back messages in order', () => {
    const store = new TeamChannelStore(path)
    const first = store.post('marketing', 'agent-a', 'Scouting new leads', 1000)
    const second = store.post('marketing', 'agent-b', 'Found three candidates', 2000)

    const messages = store.read('marketing')
    expect(messages).toEqual([first, second])
    store.close()
  })

  it('filters by sinceId', () => {
    const store = new TeamChannelStore(path)
    const first = store.post('cfo', 'agent-a', 'Q1 numbers ready', 1000)
    const second = store.post('cfo', 'agent-b', 'Reviewed, looks good', 2000)

    expect(store.read('cfo', first.id)).toEqual([second])
    store.close()
  })

  it('keeps channels independent', () => {
    const store = new TeamChannelStore(path)
    store.post('marketing', 'agent-a', 'hello marketing', 1000)
    store.post('cfo', 'agent-b', 'hello cfo', 1000)

    expect(store.read('marketing')).toHaveLength(1)
    expect(store.read('cfo')).toHaveLength(1)
    expect(store.listChannels()).toEqual(['cfo', 'marketing'])
    store.close()
  })

  it('supports two independent processes (store instances) writing to the same database concurrently', () => {
    const storeA = new TeamChannelStore(path)
    const storeB = new TeamChannelStore(path)

    for (let i = 0; i < 20; i++) {
      storeA.post('standup', `agent-a`, `update ${i} from a`, 1000 + i)
      storeB.post('standup', `agent-b`, `update ${i} from b`, 1000 + i)
    }

    // Either handle sees every committed row: this is one shared database file,
    // WAL-journaled specifically so unrelated agent processes can write to it at once.
    expect(storeA.read('standup')).toHaveLength(40)
    expect(storeB.read('standup')).toHaveLength(40)

    storeA.close()
    storeB.close()
  })
})
