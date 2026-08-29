import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditLog } from '../src/audit-log.ts'

describe('createAuditLog', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-capture-audit-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('appends one JSON line per logged event', async () => {
    const log = createAuditLog(dir)
    await log.log({ operation: 'create', entryId: 'social_1', entryType: 'note', summary: 'captured instagram post' })
    await log.log({ operation: 'create', entryId: 'social_2', entryType: 'note', summary: 'captured instagram post' })

    const raw = await readFile(join(dir, '.audit-log.jsonl'), 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!)
    expect(first).toMatchObject({ operation: 'create', entryId: 'social_1', entryType: 'note' })
    expect(typeof first.timestamp).toBe('string')
  })
})
