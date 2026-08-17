/**
 * Local persisted state (design doc §8): one JSON file per platform adapter,
 * atomic temp-file-then-rename write, a serialized write queue so concurrent
 * inbound messages can't interleave two writes, and explicit `0o600`/`0o700`
 * permissions rather than relying on umask — the floor `dsh-im` already
 * demonstrates, taken as the baseline over `dsh-telegram-duty`'s otherwise
 * equivalent approach (which never sets permissions explicitly).
 * @module dsh-plugin-imchat/core/state-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Persisted shape: a session-mapping table plus one adapter-defined cursor slot. */
export interface StateShape<Cursor> {
  readonly version: 1
  readonly sessions: Record<string, string>
  readonly cursor: Cursor | null
}

function emptyState<Cursor>(): StateShape<Cursor> {
  return { version: 1, sessions: {}, cursor: null }
}

/**
 * Atomic, permissioned, serialized-write JSON state store for one adapter.
 * Every read and mutation is funneled through `queue` so two concurrent
 * `setSession` calls (two inbound messages arriving back to back) read and
 * write in strict sequence rather than racing on the shared in-memory
 * snapshot — a queued task ordered after an earlier one always observes that
 * earlier task's already-applied mutation, never a stale pre-mutation copy.
 */
export class StateStore<Cursor> {
  private state: StateShape<Cursor> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  private async readFromDisk(): Promise<StateShape<Cursor>> {
    try {
      const raw = await readFile(this.path, 'utf8')
      return this.normalize(JSON.parse(raw))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState<Cursor>()
      throw error
    }
  }

  private normalize(parsed: unknown): StateShape<Cursor> {
    if (typeof parsed !== 'object' || parsed === null) return emptyState<Cursor>()
    const candidate = parsed as Partial<StateShape<Cursor>>
    const sessions: Record<string, string> = {}
    if (typeof candidate.sessions === 'object' && candidate.sessions !== null) {
      for (const [key, value] of Object.entries(candidate.sessions)) {
        if (typeof value === 'string') sessions[key] = value
      }
    }
    return { version: 1, sessions, cursor: candidate.cursor ?? null }
  }

  private async writeToDisk(state: StateShape<Cursor>): Promise<void> {
    const json = `${JSON.stringify(state, null, 2)}\n`
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.path}.tmp`
    await writeFile(tmpPath, json, { mode: 0o600 })
    await rename(tmpPath, this.path)
  }

  /** Runs `task` after every previously queued task, against the shared in-memory `this.state`. */
  private async run<T>(task: (state: StateShape<Cursor>) => Promise<T> | T): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.state === undefined) this.state = await this.readFromDisk()
      return task(this.state)
    })
    this.queue = result.then(() => {}).catch((error: unknown) => {
      console.error(`dsh-imchat: state-store operation on ${this.path} failed`, error)
    })
    return result
  }

  async getSession(key: string): Promise<string | undefined> {
    return this.run(state => state.sessions[key])
  }

  async setSession(key: string, sessionId: string): Promise<void> {
    await this.run(async (state) => {
      this.state = { ...state, sessions: { ...state.sessions, [key]: sessionId } }
      await this.writeToDisk(this.state)
    })
  }

  async deleteSession(key: string): Promise<void> {
    await this.run(async (state) => {
      if (!(key in state.sessions)) return
      const sessions = { ...state.sessions }
      delete sessions[key]
      this.state = { ...state, sessions }
      await this.writeToDisk(this.state)
    })
  }

  async getCursor(): Promise<Cursor | null> {
    return this.run(state => state.cursor)
  }

  async setCursor(cursor: Cursor): Promise<void> {
    await this.run(async (state) => {
      this.state = { ...state, cursor }
      await this.writeToDisk(this.state)
    })
  }
}
