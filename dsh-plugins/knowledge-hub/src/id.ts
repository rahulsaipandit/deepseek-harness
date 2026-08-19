/**
 * Id generation for memory files. Ported from cognitiveBrain's
 * `memory/src/utils/nextId.ts`: a monotonic, dependency-free id, safe to use
 * directly as a filename stem.
 * @module dsh-plugin-knowledge-hub/id
 */

let counter = 0

/** Generate a monotonic id: `${prefix}_${timestamp}_${counter}`. */
export function nextId(prefix = 'mem'): string {
  counter += 1
  return `${prefix}_${Date.now()}_${counter}`
}
