/**
 * Id generation for captured social notes. Same shape as
 * `dsh-plugin-knowledge-hub/src/id.ts` (monotonic, dependency-free, safe as
 * a filename stem) — kept as an independent copy rather than an import
 * because the two plugins are deliberately decoupled packages (see this
 * plugin's README), sharing a markdown-file *format* contract, not code.
 * @module dsh-plugin-social-capture/id
 */

let counter = 0

/** Generate a monotonic id: `${prefix}_${timestamp}_${counter}`. */
export function nextId(prefix = 'social'): string {
  counter += 1
  return `${prefix}_${Date.now()}_${counter}`
}
