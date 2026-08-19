import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createVaultStore } from '../src/vault-store.ts'
import type { MemoryFile } from '../src/types.ts'

describe('createVaultStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'knowledge-hub-vault-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function makeFile(id: string, tags: string[] = []): MemoryFile {
    return {
      frontmatter: {
        id,
        title: `Title ${id}`,
        type: 'note',
        tags,
        createdAt: new Date().toISOString(),
        confidence: 0.5,
        sourceCount: 1,
      },
      content: `Content for ${id}`,
      path: '',
    }
  }

  it('writes then reads a file back', async () => {
    const store = createVaultStore(dir)
    await store.write(makeFile('a'))
    const read = await store.read('a')
    expect(read?.frontmatter.title).toBe('Title a')
    expect(read?.content).toBe('Content for a')
  })

  it('read() returns undefined for a missing id', async () => {
    const store = createVaultStore(dir)
    expect(await store.read('missing')).toBeUndefined()
  })

  it('list() returns [] for a vault directory that does not exist yet', async () => {
    const store = createVaultStore(join(dir, 'does-not-exist'))
    expect(await store.list()).toEqual([])
  })

  it('list() finds hand-written files not created via write()', async () => {
    await writeFile(join(dir, 'hand.md'), '---\nid: hand\ntitle: Hand-written\ntype: note\ncreatedAt: "2026-01-01T00:00:00.000Z"\n---\nBody.\n', 'utf8')
    const store = createVaultStore(dir)
    const files = await store.list()
    expect(files.map(f => f.frontmatter.id)).toEqual(['hand'])
  })

  it('list() filters by tags (AND semantics)', async () => {
    const store = createVaultStore(dir)
    await store.write(makeFile('a', ['x', 'y']))
    await store.write(makeFile('b', ['x']))
    const filtered = await store.list({ tags: ['x', 'y'] })
    expect(filtered.map(f => f.frontmatter.id)).toEqual(['a'])
  })

  it('remove() deletes an existing file and returns true, false for a missing one', async () => {
    const store = createVaultStore(dir)
    await store.write(makeFile('a'))
    expect(await store.remove('a')).toBe(true)
    expect(await store.read('a')).toBeUndefined()
    expect(await store.remove('a')).toBe(false)
  })

  it('rejects an id that would escape the vault directory', async () => {
    const store = createVaultStore(dir)
    await expect(store.write(makeFile('../escape'))).rejects.toThrow(/outside the vault directory/)
  })
})
