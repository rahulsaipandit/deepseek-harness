import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditLog } from '../src/audit-log.ts'

describe('createAuditLog', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'knowledge-hub-audit-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('getLog() returns [] before anything has been logged', async () => {
    const log = createAuditLog(dir)
    expect(await log.getLog()).toEqual([])
  })

  it('logs and reads back events, newest first', async () => {
    const log = createAuditLog(dir)
    await log.log({ operation: 'create', entryId: 'a', entryType: 'note', summary: 'Created a' })
    await log.log({ operation: 'update', entryId: 'a', entryType: 'note', summary: 'Updated a' })
    const events = await log.getLog()
    expect(events).toHaveLength(2)
    expect(events[0]?.operation).toBe('update')
    expect(events[1]?.operation).toBe('create')
  })

  it('filters by entryId and operation', async () => {
    const log = createAuditLog(dir)
    await log.log({ operation: 'create', entryId: 'a', entryType: 'note', summary: 'a' })
    await log.log({ operation: 'create', entryId: 'b', entryType: 'note', summary: 'b' })
    await log.log({ operation: 'delete', entryId: 'a', entryType: 'note', summary: 'deleted a' })

    expect((await log.getLog({ entryId: 'a' })).map(e => e.operation)).toEqual(['delete', 'create'])
    expect((await log.getLog({ operation: 'create' })).map(e => e.entryId).sort()).toEqual(['a', 'b'])
  })

  it('respects limit', async () => {
    const log = createAuditLog(dir)
    for (let i = 0; i < 5; i++) {
      await log.log({ operation: 'create', entryId: `e${i}`, entryType: 'note', summary: `entry ${i}` })
    }
    expect(await log.getLog({ limit: 2 })).toHaveLength(2)
  })
})
