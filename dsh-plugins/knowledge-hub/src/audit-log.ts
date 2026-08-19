/**
 * Append-only audit log: one JSONL record per create/update/delete. Ported
 * in spirit (not code — the reference was IndexedDB-backed) from
 * cognitiveBrain's `core/audit/{MutationEvent,IMutationLogStore,MutationLogStore}.ts`.
 * Explicitly distinct from the similarly-named but unrelated
 * `core/journal/MutationJournal.ts` (browser cache-invalidation plumbing,
 * not adopted). This is the plugin's direct answer to "memory should be
 * auditable."
 * @module dsh-plugin-knowledge-hub/audit-log
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

export interface AuditEvent {
  id: string
  timestamp: string
  operation: 'create' | 'update' | 'delete'
  entryId: string
  entryType: string
  summary: string
}

export interface AuditLogQuery {
  entryId?: string
  operation?: AuditEvent['operation']
  limit?: number
}

export interface AuditLog {
  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void>
  getLog(query?: AuditLogQuery): Promise<AuditEvent[]>
}

let auditCounter = 0

export function createAuditLog(vaultPath: string): AuditLog {
  const filePath = resolve(vaultPath, '.audit-log.jsonl')

  return {
    async log(event): Promise<void> {
      auditCounter += 1
      const full: AuditEvent = {
        id: `audit_${Date.now()}_${auditCounter}`,
        timestamp: new Date().toISOString(),
        ...event,
      }
      await mkdir(dirname(filePath), { recursive: true })
      await withFileLock(filePath, async () => {
        await appendFile(filePath, `${JSON.stringify(full)}\n`, 'utf8')
      })
    },

    async getLog(query: AuditLogQuery = {}): Promise<AuditEvent[]> {
      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }

      const events: AuditEvent[] = []
      for (const line of raw.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          events.push(JSON.parse(line) as AuditEvent)
        } catch {
          // skip a corrupted line rather than failing the whole read
        }
      }

      // The file is append-only, so reversing file order is "newest first" —
      // more robust than sorting by timestamp string, which can tie when two
      // events land in the same millisecond.
      const newestFirst = events.reverse()
      const filtered = newestFirst.filter(event =>
        (query.entryId === undefined || event.entryId === query.entryId)
        && (query.operation === undefined || event.operation === query.operation),
      )
      return query.limit === undefined ? filtered : filtered.slice(0, query.limit)
    },
  }
}
