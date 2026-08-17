/**
 * Per-file path safety for an installed skill bundle.
 *
 * This is the zip-slip defense the upstream `cocofhu/skillhub` project needs
 * because it downloads and extracts an opaque ZIP archive (`src/unzip.ts`,
 * `src/install.ts`'s `safeRelPath`/`skillDir`). This plugin sidesteps that
 * whole attack surface by design: the registry contract (`registry-client.ts`)
 * never hands back a raw archive, only an itemized JSON list of
 * `{ path, content }` text files, so there is no compression bomb and no
 * "seek anywhere in the file" primitive to defend against — only the file
 * list itself, which still has to be checked exactly as carefully, since it
 * is untrusted server response content either way.
 * @module dsh-plugin-skillhub/install-path
 */

import { resolve, sep } from 'node:path'

/** Extensions a skill bundle file may use. Deliberately excludes anything executable. */
const ALLOWED_EXTENSIONS = ['.md', '.yaml', '.yml', '.json', '.txt']

export class UnsafeSkillPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeSkillPathError'
  }
}

/**
 * Validate one bundle-relative path from a registry response: forward
 * slashes only, no empty segments, no `.`/`..` segments, no leading slash,
 * no drive letter, no null byte, and an allowlisted extension. Rejects
 * outright rather than trying to "sanitize" a bad path into a good one.
 */
export function assertSafeSkillRelativePath(relPath: string): void {
  if (relPath.length === 0 || relPath.length > 512) {
    throw new UnsafeSkillPathError(`skillhub: rejecting bundle path of invalid length: ${JSON.stringify(relPath)}`)
  }
  if (relPath.includes('\0')) {
    throw new UnsafeSkillPathError('skillhub: rejecting bundle path containing a null byte')
  }
  if (relPath.includes('\\')) {
    throw new UnsafeSkillPathError(`skillhub: rejecting bundle path with a backslash: ${JSON.stringify(relPath)}`)
  }
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new UnsafeSkillPathError(`skillhub: rejecting absolute bundle path: ${JSON.stringify(relPath)}`)
  }
  const segments = relPath.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      throw new UnsafeSkillPathError(`skillhub: rejecting bundle path with an unsafe segment: ${JSON.stringify(relPath)}`)
    }
  }
  const lower = relPath.toLowerCase()
  if (!ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext))) {
    throw new UnsafeSkillPathError(`skillhub: rejecting bundle file with a disallowed extension: ${JSON.stringify(relPath)}`)
  }
}

/**
 * Resolve `relPath` under `skillDir` and re-verify, by the resolved absolute
 * path, that it did not escape — the same defense-in-depth the reviewed
 * upstream project applies via `relative()` in `skillDir()`, kept here as a
 * second, independent check rather than trusting the lexical validation
 * above alone.
 */
export function resolveWithinSkillDir(skillDir: string, relPath: string): string {
  assertSafeSkillRelativePath(relPath)
  const resolvedDir = resolve(skillDir)
  const resolvedFile = resolve(resolvedDir, relPath)
  if (resolvedFile !== resolvedDir && !resolvedFile.startsWith(resolvedDir + sep)) {
    throw new UnsafeSkillPathError(`skillhub: bundle path escapes its skill directory: ${JSON.stringify(relPath)}`)
  }
  return resolvedFile
}

/**
 * Resolve `name` under `installRoot` and verify it did not escape — same
 * containment discipline applied to the skill-directory level, guarding the
 * (already-validated) kebab-case name against a future relaxation of
 * {@link import('./name.ts').isSkillName} rather than trusting one check alone.
 */
export function resolveSkillDir(installRoot: string, name: string): string {
  const resolvedRoot = resolve(installRoot)
  const resolvedDir = resolve(resolvedRoot, name)
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + sep)) {
    throw new UnsafeSkillPathError(`skillhub: skill name escapes the install root: ${JSON.stringify(name)}`)
  }
  return resolvedDir
}
