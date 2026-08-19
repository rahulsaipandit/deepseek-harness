/**
 * Flat-directory markdown vault store: list/read/write/remove `<id>.md`
 * files. Local filesystem only — no MCP, no remote vault provider — per the
 * "configurable external path" decision in designCognitiveBrainForDSH.md.
 * @module dsh-plugin-knowledge-hub/vault-store
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseMemoryFile, serializeMemoryFile } from './frontmatter.ts'
import type { MemoryFile, MemoryFilter } from './types.ts'

export interface VaultStore {
  /** Full directory scan; malformed files are skipped, never thrown. */
  list(filter?: MemoryFilter): Promise<MemoryFile[]>
  read(id: string): Promise<MemoryFile | undefined>
  write(file: MemoryFile): Promise<void>
  remove(id: string): Promise<boolean>
}

function matchesFilter(file: MemoryFile, filter?: MemoryFilter): boolean {
  if (!filter?.tags || filter.tags.length === 0) return true
  return filter.tags.every(tag => file.frontmatter.tags.includes(tag))
}

/**
 * Resolve `<vaultPath>/<id>.md`, guarding against an id that escapes the
 * vault directory. Uses `path.relative()` rather than a string-prefix check
 * so this works correctly on Windows (backslash separators) as well as
 * POSIX.
 */
function filePathFor(vaultPath: string, id: string): string {
  const root = resolve(vaultPath)
  const filePath = resolve(root, `${id}.md`)
  const rel = relative(root, filePath)
  if (rel.startsWith('..') || rel === '') {
    throw new Error(`knowledge-hub: id "${id}" resolves outside the vault directory`)
  }
  return filePath
}

export function createVaultStore(vaultPath: string): VaultStore {
  const root = resolve(vaultPath)

  return {
    async list(filter?: MemoryFilter): Promise<MemoryFile[]> {
      let names: string[]
      try {
        names = await readdir(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }

      const files: MemoryFile[] = []
      for (const name of names) {
        if (!name.endsWith('.md')) continue
        const path = join(root, name)
        let raw: string
        try {
          raw = await readFile(path, 'utf8')
        } catch {
          continue
        }
        const parsed = parseMemoryFile(raw, path)
        if (!parsed) continue
        if (matchesFilter(parsed, filter)) files.push(parsed)
      }
      return files.sort((a, b) => a.frontmatter.createdAt.localeCompare(b.frontmatter.createdAt))
    },

    async read(id: string): Promise<MemoryFile | undefined> {
      const path = filePathFor(root, id)
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
      return parseMemoryFile(raw, path)
    },

    async write(file: MemoryFile): Promise<void> {
      const path = filePathFor(root, file.frontmatter.id)
      await mkdir(root, { recursive: true })
      await withFileLock(path, async () => {
        await writeFileAtomic(path, serializeMemoryFile(file), { mode: 0o600 })
      })
    },

    async remove(id: string): Promise<boolean> {
      const path = filePathFor(root, id)
      try {
        await rm(path)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    },
  }
}
