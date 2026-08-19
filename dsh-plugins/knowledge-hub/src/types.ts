/**
 * Core types for the knowledge-hub plugin. Deliberately lean: no graph
 * relations, no lifecycle/retention fields, no synthesis metadata — every
 * field here has a real consumer in this plugin (see designCognitiveBrainForDSH.md).
 * @module dsh-plugin-knowledge-hub/types
 */

/** Frontmatter fields stored on every memory markdown file. */
export interface MemoryFrontmatter {
  id: string
  title: string
  type: 'note' | 'fact' | 'procedure' | 'entity'
  tags: string[]
  createdAt: string
  updatedAt?: string
  confidence: number
  sourceCount: number
  /** OKF-compatible canonical source URL (designCognitiveBrainForDSH.md §5.6); `null`/absent for a note with no external origin. */
  resource?: string | null
  /** Ids of other memories this one plausibly contradicts. Never set automatically — `memory_remember` only ever *surfaces* a possible contradiction (§5.6); writing this field requires a person or agent to confirm it. */
  contradictedBy?: string[]
}

/** A parsed memory file: frontmatter plus its markdown body. */
export interface MemoryFile {
  frontmatter: MemoryFrontmatter
  content: string
  path: string
}

/** Filter accepted by `VaultStore.list()`; all provided fields must match (AND). */
export interface MemoryFilter {
  tags?: string[]
}
