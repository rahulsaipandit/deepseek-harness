/**
 * Shared value types for the skillhub plugin. Pure types only, no runtime
 * code, per this repo's package-layout convention.
 * @module dsh-plugin-skillhub/types
 */

export interface SkillSearchResult {
  name: string
  version: string
  category: string
  description: string
  downloads: number
}

export interface SkillBundleFile {
  /** Forward-slash bundle-relative path, e.g. "SKILL.md" or "reference/notes.md". */
  path: string
  /** UTF-8 text content. The registry contract never carries binary payloads (see registry-client.ts). */
  content: string
}

export interface SkillManifest {
  name: string
  version: string
  description: string
  category: string
  files: SkillBundleFile[]
}

/** One entry in the local `.skillhub-state.json` install ledger. */
export interface InstalledSkillRecord {
  name: string
  version: string
  /** Bundle-relative paths written for this install, exactly as validated at install time. */
  files: string[]
  installedAt: number
  registryUrl: string
}

export type InstalledSkillState = Record<string, InstalledSkillRecord>
