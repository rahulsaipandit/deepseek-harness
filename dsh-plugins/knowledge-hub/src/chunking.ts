/**
 * Heading-based chunking for concept-graph extraction ONLY — embeddings
 * stay whole-file (an explicit, separate v1 decision; see
 * designCognitiveBrainForDSH.md). Notes are already file-bounded, so
 * heading-based chunking needs no new structural convention, matching
 * Tolaria's ADR-0175 rationale.
 * @module dsh-plugin-knowledge-hub/chunking
 */

export interface Chunk {
  heading?: string
  text: string
}

const HEADING_LINE = /^#{1,6}\s+(.*)$/

/** Split a note body into heading-bounded chunks. A headingless note is one chunk. */
export function chunkByHeading(content: string): Chunk[] {
  const lines = content.split('\n')
  const chunks: Chunk[] = []
  let currentHeading: string | undefined
  let currentLines: string[] = []

  function flush(): void {
    const text = currentLines.join('\n').trim()
    if (text.length > 0 || currentHeading !== undefined) {
      chunks.push({ ...(currentHeading === undefined ? {} : { heading: currentHeading }), text })
    }
  }

  for (const line of lines) {
    const match = HEADING_LINE.exec(line)
    if (match) {
      flush()
      currentHeading = match[1]?.trim() ?? ''
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  flush()

  return chunks.filter(chunk => chunk.text.trim().length > 0)
}
