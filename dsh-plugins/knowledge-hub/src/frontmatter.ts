/**
 * Markdown-with-YAML-frontmatter (de)serialization for memory files.
 * Modeled on `packages/skill/skill-filesystem`'s frontmatter parsing (a real
 * YAML parser, not the hand-rolled regex parsers found across
 * `docs/packages/cognitiveBrain`'s vault providers).
 * @module dsh-plugin-knowledge-hub/frontmatter
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { MemoryFile, MemoryFrontmatter } from './types.ts'

const DEFAULT_CONFIDENCE = 0.5
const DEFAULT_SOURCE_COUNT = 1
const VALID_TYPES = new Set(['note', 'fact', 'procedure', 'entity'])

/** Split `---\n<yaml>\n---\n<body>` into raw parts. Returns `undefined` if the leading delimiter is missing or unclosed. */
function splitFrontmatter(raw: string): { yamlText: string; body: string } | undefined {
  if (!raw.startsWith('---')) return undefined
  const afterOpen = raw.indexOf('\n', 3)
  if (afterOpen === -1) return undefined
  const closeIndex = raw.indexOf('\n---', afterOpen)
  if (closeIndex === -1) return undefined
  const yamlText = raw.slice(afterOpen + 1, closeIndex)
  const bodyStart = raw.indexOf('\n', closeIndex + 1)
  const body = bodyStart === -1 ? '' : raw.slice(bodyStart + 1)
  return { yamlText, body }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse a memory markdown file's raw content into frontmatter + body.
 * Returns `undefined` (never throws) on malformed YAML or a missing
 * required field, so one bad file never breaks a full-vault scan.
 */
export function parseMemoryFile(raw: string, path: string): MemoryFile | undefined {
  const split = splitFrontmatter(raw)
  if (!split) return undefined

  let data: unknown
  try {
    data = parseYaml(split.yamlText)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>

  const id = record.id
  const title = record.title
  const type = record.type
  const createdAt = record.createdAt
  if (!isNonEmptyString(id) || !isNonEmptyString(title) || !isNonEmptyString(createdAt)) return undefined
  if (!isNonEmptyString(type) || !VALID_TYPES.has(type)) return undefined

  const tags = Array.isArray(record.tags) ? record.tags.filter(isNonEmptyString) : []
  const updatedAt = isNonEmptyString(record.updatedAt) ? record.updatedAt : undefined
  const confidence = typeof record.confidence === 'number' ? record.confidence : DEFAULT_CONFIDENCE
  const sourceCount = typeof record.sourceCount === 'number' ? record.sourceCount : DEFAULT_SOURCE_COUNT
  const resource = isNonEmptyString(record.resource) || record.resource === null ? record.resource : undefined
  const contradictedBy = Array.isArray(record.contradictedBy) ? record.contradictedBy.filter(isNonEmptyString) : undefined

  const frontmatter: MemoryFrontmatter = {
    id,
    title,
    type: type as MemoryFrontmatter['type'],
    tags,
    createdAt,
    confidence,
    sourceCount,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(resource === undefined ? {} : { resource }),
    ...(contradictedBy === undefined ? {} : { contradictedBy }),
  }

  return { frontmatter, content: split.body.trim(), path }
}

/** Serialize a memory file back into `---\n<yaml>\n---\n<body>\n` form. */
export function serializeMemoryFile(file: MemoryFile): string {
  const { frontmatter } = file
  const ordered: Record<string, unknown> = {
    id: frontmatter.id,
    title: frontmatter.title,
    type: frontmatter.type,
    ...(frontmatter.resource === undefined ? {} : { resource: frontmatter.resource }),
    tags: frontmatter.tags,
    createdAt: frontmatter.createdAt,
    ...(frontmatter.updatedAt === undefined ? {} : { updatedAt: frontmatter.updatedAt }),
    confidence: frontmatter.confidence,
    sourceCount: frontmatter.sourceCount,
    ...(frontmatter.contradictedBy === undefined ? {} : { contradictedBy: frontmatter.contradictedBy }),
  }
  const yamlText = stringifyYaml(ordered).trimEnd()
  return `---\n${yamlText}\n---\n${file.content}\n`
}
