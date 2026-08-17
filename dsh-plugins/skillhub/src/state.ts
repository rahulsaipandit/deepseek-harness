/**
 * The local install ledger, `<installRoot>/.skillhub-state.json`. Recording
 * exactly which bundle-relative paths this plugin itself wrote for each
 * installed skill is what lets `skillhub_uninstall` delete only files it
 * put there — never a raw path the model or a tampered response supplies —
 * matching this repo's "enforce a decision in the operation that makes it"
 * convention rather than trusting the skill name alone at uninstall time.
 * @module dsh-plugin-skillhub/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { InstalledSkillRecord, InstalledSkillState } from './types.ts'

/** The state file's name is fixed and does not match the `<name>/SKILL.md` or `<name>.md` discovery grammar, so it is never mistaken for an installed skill. */
export const STATE_FILE_NAME = '.skillhub-state.json'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toInstalledSkillRecord(value: unknown): InstalledSkillRecord | undefined {
  if (!isRecord(value)) return undefined
  const { name, version, files, installedAt, registryUrl } = value
  if (typeof name !== 'string' || typeof version !== 'string' || typeof registryUrl !== 'string') return undefined
  if (!Array.isArray(files) || !files.every((entry): entry is string => typeof entry === 'string')) return undefined
  if (typeof installedAt !== 'number' || !Number.isFinite(installedAt)) return undefined
  return { name, version, files, installedAt, registryUrl }
}

/** Load the state file. A missing or unreadable/corrupt file is treated as "no skills installed yet", never thrown — this is our own advisory ledger, not the source of truth for what's on disk. */
export async function readState(stateFilePath: string): Promise<InstalledSkillState> {
  let raw: string
  try {
    raw = await readFile(stateFilePath, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!isRecord(parsed)) return {}
  const state: InstalledSkillState = {}
  for (const [name, value] of Object.entries(parsed)) {
    const record = toInstalledSkillRecord(value)
    if (record !== undefined) state[name] = record
  }
  return state
}

/** Persist the state file atomically (write to a sibling temp file, then rename) so a crash mid-write never leaves a half-written ledger. */
export async function writeState(stateFilePath: string, state: InstalledSkillState): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true })
  const tempPath = `${stateFilePath}.${process.pid}.tmp`
  await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf8')
  await rename(tempPath, stateFilePath)
}
