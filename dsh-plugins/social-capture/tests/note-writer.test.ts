import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSocialNote, serializeSocialNote, writeSocialNote } from '../src/note-writer.ts'
import type { CapturePayload } from '../src/capture-payload.ts'

const payload: CapturePayload = {
  platform: 'instagram',
  url: 'https://instagram.com/p/abc123',
  author: 'jane_doe',
  text: 'Loving this #sunset shot, thanks @friend! https://example.com',
  capturedAt: '2026-08-28T10:00:00.000Z',
}

describe('buildSocialNote', () => {
  it('builds frontmatter with the platform and free-extracted tags, plus the OKF resource field', () => {
    const { frontmatter } = buildSocialNote(payload)
    expect(frontmatter.type).toBe('note')
    expect(frontmatter.resource).toBe(payload.url)
    expect(frontmatter.tags).toEqual(expect.arrayContaining(['social', 'instagram', '#sunset', '@friend']))
    expect(frontmatter.createdAt).toBe(payload.capturedAt)
  })

  it('falls back to the current time when capturedAt is absent', () => {
    const { frontmatter } = buildSocialNote({ ...payload, capturedAt: undefined })
    expect(() => new Date(frontmatter.createdAt).toISOString()).not.toThrow()
  })

  it('merges AI tags in when a summary is supplied, deduplicated against free-extracted tags', () => {
    const { frontmatter, content } = buildSocialNote(payload, { aiSummary: 'A nice sunset photo.', aiTags: ['photography', '#sunset'] })
    expect(frontmatter.tags.filter(t => t === '#sunset')).toHaveLength(1)
    expect(frontmatter.tags).toContain('photography')
    expect(content).toContain('A nice sunset photo.')
  })

  it('includes the original text and media in the body', () => {
    const { content } = buildSocialNote({ ...payload, mediaUrls: ['https://example.com/a.jpg'] })
    expect(content).toContain(payload.text)
    expect(content).toContain('https://example.com/a.jpg')
  })
})

describe('serializeSocialNote', () => {
  it('produces a parseable --- frontmatter --- body shape', () => {
    const { frontmatter, content } = buildSocialNote(payload)
    const raw = serializeSocialNote(frontmatter, content)
    expect(raw.startsWith('---\n')).toBe(true)
    expect(raw).toContain(`id: ${frontmatter.id}`)
    expect(raw.trimEnd().endsWith(content)).toBe(true)
  })
})

describe('writeSocialNote', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-capture-vault-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes the note to <vaultPath>/<id>.md', async () => {
    const written = await writeSocialNote(dir, payload)
    const raw = await readFile(written.path, 'utf8')
    expect(raw).toContain(payload.text!)
    expect(written.path.endsWith(`${written.id}.md`)).toBe(true)
  })

  it('creates a fresh vault directory on first write', async () => {
    const fresh = join(dir, 'nested', 'vault')
    const written = await writeSocialNote(fresh, payload)
    await expect(readFile(written.path, 'utf8')).resolves.toContain('instagram')
  })
})
