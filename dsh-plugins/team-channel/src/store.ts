/**
 * SQLite-backed durable channel store. Unlike a JSONL append log (which
 * assumes one writer per file — the model `dsh-schedule`/`dsh-session`
 * persistence both use), team channels need **concurrent writers across
 * independent agent processes**: two unrelated persona sessions posting to
 * the same channel at once. SQLite's own WAL journal plus a busy timeout
 * handles that at the engine level; `node:sqlite`'s `DatabaseSync` API is
 * synchronous, so there's no JS-side write queue to get wrong either —
 * matches the exact library `@deepseek-ai/dsh-session-persistence-sqlite`
 * already uses, for dependency/licensing consistency.
 * @module dsh-plugin-team-channel/store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ChannelMessage } from './domain.ts'

interface MessageRow {
  id: number
  channel: string
  posted_by: string
  body: string
  posted_at: number
}

function rowToMessage(row: MessageRow): ChannelMessage {
  return { id: row.id, channel: row.channel, postedBy: row.posted_by, body: row.body, postedAt: row.posted_at }
}

export class TeamChannelStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        channel   TEXT NOT NULL,
        posted_by TEXT NOT NULL,
        body      TEXT NOT NULL,
        posted_at INTEGER NOT NULL
      ) STRICT
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel, id)')
  }

  post(channel: string, postedBy: string, body: string, postedAt: number): ChannelMessage {
    const result = this.db.prepare(
      'INSERT INTO messages (channel, posted_by, body, posted_at) VALUES (?, ?, ?, ?)',
    ).run(channel, postedBy, body, postedAt)
    const id = Number(result.lastInsertRowid)
    return { id, channel, postedBy, body, postedAt }
  }

  /** Messages in one channel, in post order, optionally only those after `sinceId`. */
  read(channel: string, sinceId = 0): readonly ChannelMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE channel = ? AND id > ? ORDER BY id ASC',
    ).all(channel, sinceId) as unknown as MessageRow[]
    return rows.map(rowToMessage)
  }

  /** Every distinct channel that has at least one message, alphabetically. */
  listChannels(): readonly string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT channel FROM messages ORDER BY channel ASC',
    ).all() as unknown as { channel: string }[]
    return rows.map(row => row.channel)
  }

  close(): void {
    this.db.close()
  }
}
