import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateStore } from '../../src/core/state-store.ts'

describe('StateStore', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-imchat-state-'))
    path = join(dir, 'nested', 'telegram.json')
  })

  it('returns undefined for an unknown session key before anything is written', async () => {
    const store = new StateStore(path)
    await expect(store.getSession('telegram:123')).resolves.toBeUndefined()
  })

  it('persists a session mapping across a fresh StateStore instance (simulated restart)', async () => {
    const store = new StateStore(path)
    await store.setSession('telegram:123', 'session-abc')
    const reopened = new StateStore(path)
    await expect(reopened.getSession('telegram:123')).resolves.toBe('session-abc')
  })

  it('persists and reads back a cursor', async () => {
    const store = new StateStore<number>(path)
    await store.setCursor(42)
    const reopened = new StateStore<number>(path)
    await expect(reopened.getCursor()).resolves.toBe(42)
  })

  it('deletes a session mapping', async () => {
    const store = new StateStore(path)
    await store.setSession('telegram:123', 'session-abc')
    await store.deleteSession('telegram:123')
    await expect(store.getSession('telegram:123')).resolves.toBeUndefined()
  })

  it('writes the state file with restrictive permissions, matching the design doc\'s floor', async () => {
    const store = new StateStore(path)
    await store.setSession('telegram:123', 'session-abc')
    const fileStat = await stat(path)
    // POSIX-only assertion (Windows ACLs don't map onto the same bits); skip the mode check there.
    if (process.platform !== 'win32') {
      expect(fileStat.mode & 0o777).toBe(0o600)
    }
    const raw = await readFile(path, 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ sessions: { 'telegram:123': 'session-abc' } })
  })

  it('serializes concurrent writes without corrupting the file', async () => {
    const store = new StateStore(path)
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.setSession(`telegram:${i}`, `session-${i}`)))
    const reopened = new StateStore(path)
    for (let i = 0; i < 20; i += 1) {
      await expect(reopened.getSession(`telegram:${i}`)).resolves.toBe(`session-${i}`)
    }
  })

  afterEach(async () => {
    await import('node:fs/promises').then(fs => fs.rm(dir, { recursive: true, force: true }))
  })
})
