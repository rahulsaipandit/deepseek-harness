/**
 * Durable worker roster: one JSON file, atomic temp-file-then-rename write,
 * a serialized write queue, and explicit `0o600`/`0o700` permissions — the
 * same shape as `dsh-plugin-imchat`'s `StateStore`, adapted for a worker
 * roster instead of a chat-session map.
 * @module dsh-plugin-persona-scheduler/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PersonaWorker } from './domain.ts'

interface RosterShape {
  readonly version: 1
  readonly workers: readonly PersonaWorker[]
}

function emptyRoster(): RosterShape {
  return { version: 1, workers: [] }
}

function isPersonaWorker(value: unknown): value is PersonaWorker {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<PersonaWorker>
  return typeof candidate.id === 'string'
    && typeof candidate.presetId === 'string'
    && typeof candidate.seedPrompt === 'string'
    && typeof candidate.createdAt === 'number'
    && typeof candidate.nextFireAt === 'number'
}

/** Atomic, permissioned, serialized-write JSON roster store for one process's persona workers. */
export class PersonaWorkerStore {
  private roster: RosterShape | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async readFromDisk(): Promise<RosterShape> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRoster()
      throw error
    }
    try {
      return this.normalize(JSON.parse(raw))
    } catch {
      // A corrupt roster file degrades to empty rather than throwing — the next
      // successful write repairs it, and a launcher plugin should never crash on boot.
      return emptyRoster()
    }
  }

  private normalize(parsed: unknown): RosterShape {
    if (typeof parsed !== 'object' || parsed === null) return emptyRoster()
    const candidate = parsed as Partial<RosterShape>
    const workers = Array.isArray(candidate.workers) ? candidate.workers.filter(isPersonaWorker) : []
    return { version: 1, workers }
  }

  private async writeToDisk(roster: RosterShape): Promise<void> {
    const json = `${JSON.stringify(roster, null, 2)}\n`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.path}.tmp`
    await writeFile(tmpPath, json, { mode: 0o600 })
    await rename(tmpPath, this.path)
  }

  /** Runs `task` after every previously queued task, against the shared in-memory roster. */
  private async run<T>(task: (roster: RosterShape) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.roster === undefined) this.roster = await this.readFromDisk()
      return task(this.roster)
    })
    this.queue = result.then(() => {}).catch((error: unknown) => {
      console.error(`dsh-plugin-persona-scheduler: roster operation on ${this.path} failed`, error)
    })
    return result
  }

  async list(): Promise<readonly PersonaWorker[]> {
    return this.run(roster => roster.workers)
  }

  async add(worker: PersonaWorker): Promise<void> {
    await this.run(async (roster) => {
      this.roster = { ...roster, workers: [...roster.workers, worker] }
      await this.writeToDisk(this.roster)
    })
  }

  async remove(id: string): Promise<boolean> {
    return this.run(async (roster) => {
      if (!roster.workers.some(worker => worker.id === id)) return false
      this.roster = { ...roster, workers: roster.workers.filter(worker => worker.id !== id) }
      await this.writeToDisk(this.roster)
      return true
    })
  }

  /** Replace one worker's `nextFireAt` in place (fixed-rate rescheduling) and persist. */
  async reschedule(id: string, nextFireAt: number): Promise<void> {
    await this.run(async (roster) => {
      const index = roster.workers.findIndex(worker => worker.id === id)
      if (index === -1) return
      const workers = [...roster.workers]
      const existing = workers[index]
      if (existing === undefined) return
      workers[index] = { ...existing, nextFireAt }
      this.roster = { ...roster, workers }
      await this.writeToDisk(this.roster)
    })
  }
}
