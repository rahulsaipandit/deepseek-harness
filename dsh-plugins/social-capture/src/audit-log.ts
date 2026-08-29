/**
 * Append-only audit log, same JSONL shape as
 * `dsh-plugin-knowledge-hub/src/audit-log.ts`. Deliberately writing to the
 * *same* `.audit-log.jsonl` file when this plugin's `vaultPath` is pointed
 * at a knowledge-hub vault: a capture then shows up in `memory_audit`
 * alongside hand-written notes, with no coupling beyond the shared file
 * format. Kept as an independent copy for the same reason as `id.ts` — see
 * this plugin's README.
 * @module dsh-plugin-social-capture/audit-log
 */

import { appendFile, mkdir } from 'node:fs/promises'
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

export interface AuditLog {
  log(event: Omit<AuditEvent, 'id' | 'timestamp'>): Promise<void>
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
  }
}
