import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installManifest, listInstalledSkills, SkillInstallError, uninstallSkill } from '../src/install.ts'
import { STATE_FILE_NAME } from '../src/state.ts'
import type { SkillManifest } from '../src/types.ts'

let installRoot: string
let stateFilePath: string

beforeEach(async () => {
  installRoot = await mkdtemp(join(tmpdir(), 'skillhub-install-'))
  stateFilePath = join(installRoot, STATE_FILE_NAME)
})

afterEach(async () => {
  await rm(installRoot, { recursive: true, force: true })
})

function manifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'my-skill',
    version: '1.0.0',
    description: 'desc',
    category: 'cat',
    files: [{ path: 'SKILL.md', content: '# My Skill' }],
    ...overrides,
  }
}

describe('installManifest', () => {
  it('writes every file under installRoot/<name>/ and records the install', async () => {
    const record = await installManifest(installRoot, stateFilePath, manifest({
      files: [{ path: 'SKILL.md', content: '# hi' }, { path: 'reference/notes.md', content: 'notes' }],
    }), 'https://registry.example', 1000)

    expect(record.files.sort()).toEqual(['SKILL.md', 'reference/notes.md'])
    expect(await readFile(join(installRoot, 'my-skill', 'SKILL.md'), 'utf8')).toBe('# hi')
    expect(await readFile(join(installRoot, 'my-skill', 'reference', 'notes.md'), 'utf8')).toBe('notes')
  })

  it('refuses a manifest with no top-level SKILL.md', async () => {
    await expect(installManifest(installRoot, stateFilePath, manifest({ files: [{ path: 'reference/notes.md', content: 'x' }] }), 'https://registry.example', 1000))
      .rejects.toThrow(SkillInstallError)
  })

  it('refuses an invalid skill name even if the registry claims one', async () => {
    await expect(installManifest(installRoot, stateFilePath, manifest({ name: '../escape' }), 'https://registry.example', 1000))
      .rejects.toThrow()
  })

  it('refuses a file whose path would escape the skill directory', async () => {
    await expect(installManifest(installRoot, stateFilePath, manifest({
      files: [{ path: 'SKILL.md', content: 'x' }, { path: '../../escape.md', content: 'x' }],
    }), 'https://registry.example', 1000)).rejects.toThrow()
    // Nothing should have been written, including SKILL.md, since the escape is caught mid-loop
    // (best-effort ordering: this asserts the escaping file specifically never lands outside installRoot).
    await expect(readFile(join(installRoot, '..', 'escape.md'), 'utf8')).rejects.toThrow()
  })
})

describe('uninstallSkill', () => {
  it('removes exactly the files it recorded installing, then the directory and state entry', async () => {
    await installManifest(installRoot, stateFilePath, manifest({
      files: [{ path: 'SKILL.md', content: 'x' }, { path: 'reference/notes.md', content: 'y' }],
    }), 'https://registry.example', 1000)

    const removed = await uninstallSkill(installRoot, stateFilePath, 'my-skill')
    expect(removed.sort()).toEqual(['SKILL.md', 'reference/notes.md'])
    await expect(readdir(join(installRoot, 'my-skill'))).rejects.toThrow()
    expect(await listInstalledSkills(installRoot, stateFilePath)).toEqual([])
  })

  it('refuses to remove a skill it never installed', async () => {
    await expect(uninstallSkill(installRoot, stateFilePath, 'never-installed')).rejects.toThrow(SkillInstallError)
  })

  it('does not remove a directory it did not create, even if a same-named one exists on disk', async () => {
    const foreignDir = join(installRoot, 'foreign-skill')
    await writeFile(join(installRoot, STATE_FILE_NAME), '{}', 'utf8')
    await mkdir(foreignDir, { recursive: true })
    await writeFile(join(foreignDir, 'not-ours.txt'), 'x', 'utf8')

    await expect(uninstallSkill(installRoot, stateFilePath, 'foreign-skill')).rejects.toThrow(SkillInstallError)
    expect(await readFile(join(foreignDir, 'not-ours.txt'), 'utf8')).toBe('x')
  })
})

describe('listInstalledSkills', () => {
  it('lists installed skills and flags one removed out-of-band as not present', async () => {
    await installManifest(installRoot, stateFilePath, manifest(), 'https://registry.example', 1000)
    await rm(join(installRoot, 'my-skill'), { recursive: true, force: true })

    const list = await listInstalledSkills(installRoot, stateFilePath)
    expect(list).toEqual([{ name: 'my-skill', version: '1.0.0', installedAt: 1000, fileCount: 1, present: false }])
  })
})
