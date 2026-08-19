import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorker } from '../src/domain.ts'
import { PersonaWorkerStore } from '../src/store.ts'

describe('PersonaWorkerStore', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'persona-scheduler-'))
    path = join(dir, 'workers.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lists nothing before any write', async () => {
    const store = new PersonaWorkerStore(path)
    expect(await store.list()).toEqual([])
  })

  it('persists an added worker across store instances, with owner-only permissions', async () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60 }, 1_000_000)
    const store = new PersonaWorkerStore(path)
    await store.add(worker)

    const reopened = new PersonaWorkerStore(path)
    expect(await reopened.list()).toEqual([worker])

    if (process.platform !== 'win32') {
      const info = await stat(path)
      // eslint-disable-next-line no-bitwise -- checking the exact owner-only mode bits; NTFS has no POSIX mode bits, so this only applies off Windows
      expect(info.mode & 0o777).toBe(0o600)
    }
  })

  it('removes a worker by id and reports whether it existed', async () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60 }, 1_000_000)
    const store = new PersonaWorkerStore(path)
    await store.add(worker)

    expect(await store.remove('missing')).toBe(false)
    expect(await store.remove('w1')).toBe(true)
    expect(await store.list()).toEqual([])
  })

  it('reschedules a worker\'s nextFireAt in place', async () => {
    const worker = createWorker('w1', { presetId: 'cfo', seedPrompt: 'hi', everySeconds: 300 }, 0)
    const store = new PersonaWorkerStore(path)
    await store.add(worker)

    await store.reschedule('w1', 999_999)
    const [updated] = await store.list()
    expect(updated?.nextFireAt).toBe(999_999)
  })

  it('serializes concurrent writes without corrupting the file', async () => {
    const store = new PersonaWorkerStore(path)
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        store.add(createWorker(`w${index}`, { presetId: 'cfo', seedPrompt: 'hi', afterSeconds: 60 }, 0))),
    )
    const workers = await store.list()
    expect(workers).toHaveLength(10)
    const raw = await readFile(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('degrades a corrupt file to an empty roster rather than throwing', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })
    await writeFile(path, 'not json', 'utf8')
    const store = new PersonaWorkerStore(path)
    expect(await store.list()).toEqual([])
  })
})
