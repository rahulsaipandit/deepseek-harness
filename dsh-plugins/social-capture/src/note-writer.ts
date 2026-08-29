/**
 * Builds a `dsh-plugin-knowledge-hub`-compatible markdown+frontmatter note
 * from a captured social post and writes it into the vault directory.
 * Frontmatter shape matches `dsh-plugin-knowledge-hub/src/types.ts`'s
 * `MemoryFrontmatter` exactly (including its `type` enum, which only
 * accepts `note | fact | procedure | entity` — this always writes `note`
 * and expresses "this came from social capture" via tags instead) so a
 * knowledge-hub instance pointed at the same `vaultPath` picks up captures
 * as ordinary searchable notes on its next boot, with no code coupling
 * between the two plugins.
 * @module dsh-plugin-social-capture/note-writer
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stringify as stringifyYaml } from 'yaml'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { entitiesToTags, extractEntities } from './entity-extract.ts'
import { nextId } from './id.ts'
import type { CapturePayload } from './capture-payload.ts'

export interface SocialNoteFrontmatter {
  id: string
  title: string
  type: 'note'
  tags: string[]
  createdAt: string
  confidence: number
  sourceCount: number
  resource: string
}

export interface WrittenNote {
  id: string
  path: string
  frontmatter: SocialNoteFrontmatter
}

const MAX_TITLE_CHARS = 100

function deriveTitle(payload: CapturePayload): string {
  const base = payload.author ? `${payload.platform} post by ${payload.author}` : `${payload.platform} post`
  const snippet = payload.text?.trim().split('\n')[0]?.slice(0, 60)
  const title = snippet ? `${base}: ${snippet}` : base
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title
}

function buildBody(payload: CapturePayload, aiSummary: string | undefined): string {
  const lines: string[] = []
  lines.push(`Captured **${payload.platform}** post from [${payload.url}](${payload.url}).`)
  if (payload.author) lines.push(`\n**Author:** ${payload.author}`)
  if (aiSummary) lines.push(`\n## Summary\n\n${aiSummary}`)
  if (payload.text) lines.push(`\n## Original text\n\n${payload.text}`)
  if (payload.mediaUrls && payload.mediaUrls.length > 0) {
    lines.push(`\n## Media\n\n${payload.mediaUrls.map(url => `- ${url}`).join('\n')}`)
  }
  return lines.join('\n')
}

export interface BuildNoteOptions {
  /** AI-generated summary/tags, when a summarizer was configured and succeeded. */
  aiSummary?: string
  aiTags?: string[]
}

/** Build the frontmatter + markdown body for one captured post. Pure — does not touch the filesystem. */
export function buildSocialNote(payload: CapturePayload, options: BuildNoteOptions = {}): { frontmatter: SocialNoteFrontmatter; content: string } {
  const entities = extractEntities(payload.text)
  const freeTags = entitiesToTags(entities)
  const tags = [...new Set(['social', payload.platform, ...freeTags, ...(options.aiTags ?? [])])]

  const frontmatter: SocialNoteFrontmatter = {
    id: nextId('social'),
    title: deriveTitle(payload),
    type: 'note',
    tags,
    createdAt: payload.capturedAt ?? new Date().toISOString(),
    confidence: 0.6,
    sourceCount: 1,
    resource: payload.url,
  }
  return { frontmatter, content: buildBody(payload, options.aiSummary) }
}

/** Serialize into the same `---\n<yaml>\n---\n<body>\n` shape `dsh-plugin-knowledge-hub` parses. */
export function serializeSocialNote(frontmatter: SocialNoteFrontmatter, content: string): string {
  const yamlText = stringifyYaml({ ...frontmatter }).trimEnd()
  return `---\n${yamlText}\n---\n${content.trim()}\n`
}

/**
 * Write a captured note as `<vaultPath>/<id>.md`, atomically and under a
 * cross-process file lock — same durability posture as
 * `dsh-plugin-knowledge-hub`'s `vault-store.ts`, since both plugins may
 * write into the same vault directory.
 */
export async function writeSocialNote(vaultPath: string, payload: CapturePayload, options: BuildNoteOptions = {}): Promise<WrittenNote> {
  const { frontmatter, content } = buildSocialNote(payload, options)
  const root = resolve(vaultPath)
  const path = resolve(root, `${frontmatter.id}.md`)
  // withFileLock requires the parent directory to already exist — a first
  // capture into a fresh vaultPath must create it before the lock file can
  // be created inside it.
  await mkdir(root, { recursive: true, mode: 0o700 })
  await withFileLock(path, async () => {
    await writeFileAtomic(path, serializeSocialNote(frontmatter, content), { mode: 0o600, dirMode: 0o700 })
  })
  return { id: frontmatter.id, path, frontmatter }
}
