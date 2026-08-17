/**
 * `skillhub_search` / `skillhub_install` / `skillhub_list` / `skillhub_uninstall`:
 * four model-facing tools that search, install, enumerate, and remove
 * skills from one operator-configured registry.
 *
 * This is our own hardened take on the community `cocofhu/skillhub` plugin
 * reviewed in `docs/adr/rp_dshPlugins.md` ("skillhub (cocofhu)" section,
 * "New plugin: skillhub" section) — see that doc for the full design
 * rationale. In short, relative to the reviewed original:
 *
 * - No archive download/extraction at all (`registry-client.ts`,
 *   `install-path.ts`): the registry contract here is an itemized JSON file
 *   manifest, not a ZIP, closing off the zip-slip/decompression-bomb class
 *   entirely rather than defending against it after the fact.
 * - Every request URL is assembled from the configured `registryUrl` plus a
 *   fixed path and query parameters, never from a field inside a response —
 *   a same-origin guarantee by construction (`registry-client.ts`), unlike
 *   the reviewed original's `http.ts`, which does no URL validation at all.
 * - `skillhub_uninstall` only ever deletes files this plugin itself recorded
 *   installing (`state.ts`, `install.ts`), re-validated for containment
 *   immediately before every write and delete (`install-path.ts`).
 * - No self-update / auto-install-command execution: unlike the reviewed
 *   original's `self-update.ts` (runs an unverified `npx ... plugin add`
 *   from a GitHub release with no signature/checksum check), this plugin has
 *   no update mechanism of its own — it is versioned and updated the same
 *   way any other `dsh-plugins/` package is.
 * - Installed skills land in `.dsh/skills/<name>/` (the existing
 *   project-scoped skill root, `docs/subsystems/skills.md`), so they are
 *   discovered by the already-running `@deepseek-ai/dsh-skill-filesystem`
 *   provider with no new discovery code.
 *
 * @module dsh-plugin-skillhub
 */

import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { installManifest, listInstalledSkills, uninstallSkill } from './install.ts'
import { assertSkillName, isSkillName } from './name.ts'
import { assertHttpsRegistryUrl, assertVersionString, fetchSkillManifest, searchRegistry, type RegistryClientOptions } from './registry-client.ts'
import { STATE_FILE_NAME } from './state.ts'

export const name = 'skillhub'
export const inject = ['tools']

export const Config = z.object({
  /** Base URL of the registry to search/install from. Must be `https:`; validated at plugin load. No default — a real deployment must be configured explicitly. */
  registryUrl: z.string(),
  /** Where installed skills land, relative to the session's cwd. Defaults to the existing project-scoped skill root so installs are discovered with no new code. */
  installDir: z.string().default('.dsh/skills'),
  /** Cooperative timeout for every registry request. */
  requestTimeoutMs: z.number().default(15_000),
  /** Byte cap on one registry HTTP response (search or manifest). */
  maxResponseBytes: z.number().default(256 * 1024),
  /** Upper bound on files a single skill manifest may contain. */
  maxFilesPerSkill: z.number().default(30),
  /** Byte cap on one file's content within a manifest. */
  maxFileBytes: z.number().default(200_000),
  /** Byte cap on a manifest's total file content. */
  maxTotalBytes: z.number().default(1_000_000),
  /** Upper bound on results returned by one `skillhub_search` call. */
  maxSearchResults: z.number().default(20),
  /** A `ctx.credentials` reference resolved to a bearer token sent only to `registryUrl`'s own origin. Empty means an unauthenticated registry. */
  registryCredentialRef: z.string().default(''),
})

export type Config = Schemastery.TypeT<typeof Config>

function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`skillhub: ${field} must be a positive integer`)
  }
}

function resolveInstallRoot(exec: ToolExecution, installDir: string): string {
  const cwd = exec.agent?.session.header.cwd ?? process.cwd()
  return resolve(cwd, installDir)
}

interface SearchArgs {
  query: string
  category?: string
  limit?: number
}

interface InstallArgs {
  name: string
  version?: string
}

interface UninstallArgs {
  name: string
}

/** Register the four skillhub tools. */
export function apply(ctx: Context, config: Config): void {
  assertHttpsRegistryUrl(config.registryUrl)
  assertPositiveInteger('requestTimeoutMs', config.requestTimeoutMs)
  assertPositiveInteger('maxResponseBytes', config.maxResponseBytes)
  assertPositiveInteger('maxFilesPerSkill', config.maxFilesPerSkill)
  assertPositiveInteger('maxFileBytes', config.maxFileBytes)
  assertPositiveInteger('maxTotalBytes', config.maxTotalBytes)
  assertPositiveInteger('maxSearchResults', config.maxSearchResults)

  async function resolveBearerToken(): Promise<string | undefined> {
    if (config.registryCredentialRef.length === 0) return undefined
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      throw new Error('skillhub: registryCredentialRef is configured but no ctx.credentials service is mounted')
    }
    const resolved = await credentials.resolve(credentialRef(config.registryCredentialRef))
    if (resolved === undefined) {
      throw new Error(`skillhub: credential reference "${config.registryCredentialRef}" did not resolve to a value`)
    }
    return resolved.value
  }

  async function registryOptions(): Promise<RegistryClientOptions> {
    const bearerToken = await resolveBearerToken()
    return {
      registryUrl: config.registryUrl,
      timeoutMs: config.requestTimeoutMs,
      maxResponseBytes: config.maxResponseBytes,
      maxFilesPerSkill: config.maxFilesPerSkill,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
      ...bearerToken !== undefined ? { bearerToken } : {},
    }
  }

  ctx.tools.register(defineTool({
    name: 'skillhub_search',
    description: 'Search the configured skillhub registry for installable skills by keyword and optional category. '
      + 'Read-only: does not install anything.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keywords.' },
      category: { type: 'string', description: 'Optional category filter.' },
      limit: { type: 'number', description: 'Maximum results to return. Defaults to the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                version: { type: 'string', required: true },
                category: { type: 'string', required: true },
                description: { type: 'string', required: true },
                downloads: { type: 'number', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No matching skills found.'
          : value.results.map(r => `${r.name} (v${r.version}, ${r.category}, ${r.downloads} downloads): ${r.description}`).join('\n')
            + (value.truncated ? '\n(results truncated)' : ''),
      }],
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(args: SearchArgs) {
      const query = args.query.trim()
      if (query.length === 0 || query.length > 200) {
        throw new Error('skillhub_search: query must be 1-200 characters')
      }
      const limit = Math.min(Math.max(args.limit ?? config.maxSearchResults, 1), config.maxSearchResults)
      return searchRegistry(query, args.category, limit, await registryOptions())
    },
    presentCall(args: SearchArgs) {
      return { card: 'generic', title: `Search skillhub for "${args.query}"`, kind: 'search', rawInput: args.query }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_install',
    description: 'Install a skill by exact name from the configured skillhub registry into the project skill directory '
      + '(.dsh/skills), so it becomes usable immediately. Overwrites a prior install of the same name.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact kebab-case skill name, as returned by skillhub_search.' },
      version: { type: 'string', description: 'Exact version to install. Defaults to "latest".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          version: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Installed "${value.name}"@${value.version} (${value.files.length} file(s): ${value.files.join(', ')}).`,
      }],
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args: InstallArgs, exec) {
      assertSkillName(args.name)
      const version = args.version ?? 'latest'
      if (version !== 'latest') assertVersionString(version)

      const manifest = await fetchSkillManifest(args.name, version, await registryOptions())
      const installRoot = resolveInstallRoot(exec, config.installDir)
      const stateFilePath = join(installRoot, STATE_FILE_NAME)
      const record = await installManifest(installRoot, stateFilePath, manifest, config.registryUrl, Date.now())
      return { name: record.name, version: record.version, files: record.files }
    },
    presentCall(args: InstallArgs) {
      return { card: 'generic', title: `Install skill "${args.name}"${args.version !== undefined ? `@${args.version}` : ''}`, kind: 'edit' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_list',
    description: 'List skills previously installed through skillhub_install in this project, with version and file count.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                version: { type: 'string', required: true },
                installedAt: { type: 'number', required: true },
                fileCount: { type: 'number', required: true },
                present: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.skills.length === 0
          ? 'No skills installed via skillhub in this project.'
          : value.skills.map(s => `${s.name}@${s.version}${s.present ? '' : ' (missing on disk)'}`).join('\n'),
      }],
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const installRoot = resolveInstallRoot(exec, config.installDir)
      const stateFilePath = join(installRoot, STATE_FILE_NAME)
      return { skills: await listInstalledSkills(installRoot, stateFilePath) }
    },
    presentCall() {
      return { card: 'generic', title: 'List skillhub-installed skills', kind: 'read' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_uninstall',
    description: 'Remove a skill previously installed through skillhub_install. Refuses to remove a skill this tool did '
      + 'not itself install.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact name of a skillhub-installed skill, as returned by skillhub_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          removedFiles: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Removed "${value.name}" (${value.removedFiles.length} file(s)).`,
      }],
    },
    timeoutMs: config.requestTimeoutMs,
    isConcurrencySafe: () => false,
    async execute(args: UninstallArgs, exec) {
      if (!isSkillName(args.name)) {
        throw new Error(`skillhub_uninstall: "${args.name}" is not a valid skill name`)
      }
      const installRoot = resolveInstallRoot(exec, config.installDir)
      const stateFilePath = join(installRoot, STATE_FILE_NAME)
      const removedFiles = await uninstallSkill(installRoot, stateFilePath, args.name)
      return { name: args.name, removedFiles }
    },
    presentCall(args: UninstallArgs) {
      return { card: 'generic', title: `Uninstall skill "${args.name}"`, kind: 'delete' }
    },
  }))
}
