/**
 * Writes a validated {@link SkillManifest} to disk and removes a
 * previously-installed skill, updating the local state ledger
 * (`state.ts`) as the single source of truth for what `skillhub_uninstall`
 * is allowed to delete.
 *
 * Writes go through plain `node:fs/promises`, not `ctx.fs`: the install
 * target is the plugin-configured `installRoot` plus an already-validated
 * kebab-case skill name (`name.ts`), never an arbitrary model-supplied path,
 * so there is no sandboxed/arbitrary-path seam to route through here — the
 * same reasoning `@deepseek-ai/dsh-skill-filesystem`'s own local provider
 * uses for its filesystem access. Every path is still re-validated for
 * containment immediately before each write or delete (`install-path.ts`),
 * as defense in depth independent of the upstream validation already done
 * by the registry client.
 * @module dsh-plugin-skillhub/install
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSkillName } from './name.ts'
import { resolveSkillDir, resolveWithinSkillDir } from './install-path.ts'
import { readState, writeState } from './state.ts'
import type { InstalledSkillRecord, SkillManifest } from './types.ts'

export class SkillInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

/** Write every file in `manifest` under `installRoot/manifest.name/`, then record the install in the state ledger. Requires a `SKILL.md` file so the result is discoverable by the existing skill-filesystem provider with no further work. */
export async function installManifest(
  installRoot: string,
  stateFilePath: string,
  manifest: SkillManifest,
  registryUrl: string,
  now: number,
): Promise<InstalledSkillRecord> {
  assertSkillName(manifest.name)
  if (!manifest.files.some(file => file.path === 'SKILL.md')) {
    throw new SkillInstallError(`skillhub: manifest for "${manifest.name}" has no top-level SKILL.md, so it would not be discoverable as a skill`)
  }

  const skillDir = resolveSkillDir(installRoot, manifest.name)
  const writtenPaths: string[] = []
  for (const file of manifest.files) {
    const target = resolveWithinSkillDir(skillDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, file.content, 'utf8')
    writtenPaths.push(file.path)
  }

  const record: InstalledSkillRecord = {
    name: manifest.name,
    version: manifest.version,
    files: writtenPaths,
    installedAt: now,
    registryUrl,
  }
  const state = await readState(stateFilePath)
  state[manifest.name] = record
  await writeState(stateFilePath, state)
  return record
}

/** Delete exactly the files a prior {@link installManifest} recorded for `name`, then remove the (now-empty) skill directory and its state entry. Throws if `name` was never recorded — this plugin will not delete a directory it did not create. */
export async function uninstallSkill(installRoot: string, stateFilePath: string, name: string): Promise<string[]> {
  assertSkillName(name)
  const state = await readState(stateFilePath)
  const record = state[name]
  if (record === undefined) {
    throw new SkillInstallError(`skillhub: "${name}" was not installed by skillhub, refusing to remove it`)
  }

  const skillDir = resolveSkillDir(installRoot, name)
  for (const relPath of record.files) {
    const target = resolveWithinSkillDir(skillDir, relPath)
    await rm(target, { force: true })
  }
  // Only removes the directory this plugin resolved and wrote to above, and only after every recorded file is gone.
  await rm(skillDir, { recursive: true, force: true })

  delete state[name]
  await writeState(stateFilePath, state)
  return record.files
}

export interface InstalledSkillSummary {
  name: string
  version: string
  installedAt: number
  fileCount: number
  /** False when the on-disk directory is missing even though the ledger still lists it (e.g. removed out-of-band). */
  present: boolean
}

/** List every skill this plugin's ledger knows about, cross-checked against what's actually still on disk. */
export async function listInstalledSkills(installRoot: string, stateFilePath: string): Promise<InstalledSkillSummary[]> {
  const state = await readState(stateFilePath)
  const summaries: InstalledSkillSummary[] = []
  for (const record of Object.values(state)) {
    let present = true
    try {
      await readdir(resolveSkillDir(installRoot, record.name))
    } catch {
      present = false
    }
    summaries.push({ name: record.name, version: record.version, installedAt: record.installedAt, fileCount: record.files.length, present })
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name))
  return summaries
}
