/**
 * HTTP client for one configured skillhub-style registry.
 *
 * The upstream `cocofhu/skillhub` project's own `src/http.ts` does no URL
 * validation at all — no protocol allowlist, no origin pinning on redirects —
 * and its `src/self-update.ts` runs an install command from unverified
 * GitHub release metadata with no signature/checksum check
 * (`docs/adr/rp_dshPlugins.md`'s "skillhub (cocofhu)" review). This client
 * closes both gaps by construction rather than by validating a
 * server-supplied URL after the fact:
 *
 * - Every request URL is assembled here from the operator-configured
 *   `registryUrl` plus a fixed, hardcoded path and query parameters — never
 *   from a field inside a JSON response. The registry can return whatever it
 *   wants in its payload; nothing in that payload is ever treated as a
 *   fetch destination. This is a same-origin guarantee by construction, not
 *   a check that could be bypassed by a clever response.
 * - `registryUrl` itself must be `https:`, checked once at plugin `apply()`
 *   time (`assertHttpsRegistryUrl`) — an operator-config value, not
 *   attacker-reachable input.
 * - Redirects are refused outright (`redirect: 'error'`) rather than
 *   followed, so a compromised or misconfigured registry cannot silently
 *   retarget a request.
 * - This plugin never downloads or extracts an archive at all (see
 *   `install-path.ts`): the manifest contract below is an itemized JSON list
 *   of `{ path, content }` text files, bounded by count/size here, so there
 *   is no decompression-bomb or zip-slip surface to defend against on this
 *   side either.
 *
 * This is a plugin-authored contract, not a real published skillhub API —
 * point `registryUrl` at a deployment that implements these two endpoints.
 * @module dsh-plugin-skillhub/registry-client
 */

import type { SkillBundleFile, SkillManifest, SkillSearchResult } from './types.ts'

export class RegistryClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RegistryClientError'
  }
}

export interface RegistryClientOptions {
  registryUrl: string
  timeoutMs: number
  maxResponseBytes: number
  maxFilesPerSkill: number
  maxFileBytes: number
  maxTotalBytes: number
  /** Sent as `Authorization: Bearer <token>` to the configured registry origin only. Never forwarded anywhere else. */
  bearerToken?: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Throws unless `url` is `https:` — refuses to talk to a registry over plaintext or any other scheme. */
export function assertHttpsRegistryUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error: unknown) {
    throw new RegistryClientError(`skillhub: registryUrl "${url}" is not a valid URL`, { cause: error })
  }
  if (parsed.protocol !== 'https:') {
    throw new RegistryClientError(`skillhub: refusing a non-https registryUrl: ${parsed.protocol}`)
  }
  return parsed
}

const VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,32}$/

/** Same grammar the upstream project's `parseVersion` uses — kept narrow since a version string only ever needs to name a release, not carry arbitrary content. */
export function assertVersionString(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new RegistryClientError(`skillhub: "${version}" is not a valid version string`)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

async function requestJson(
  url: URL,
  options: Pick<RegistryClientOptions, 'timeoutMs' | 'maxResponseBytes' | 'bearerToken' | 'fetchImpl'>,
): Promise<unknown> {
  assertHttpsRegistryUrl(url.toString())
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, options.timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...options.bearerToken !== undefined ? { authorization: `Bearer ${options.bearerToken}` } : {},
      },
      redirect: 'error',
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new RegistryClientError(`skillhub registry responded with HTTP ${response.status} for ${url.pathname}`)
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > options.maxResponseBytes) {
      throw new RegistryClientError(`skillhub registry response exceeds the maximum of ${options.maxResponseBytes} bytes`)
    }
    const raw = await response.text()
    if (raw.length > options.maxResponseBytes) {
      throw new RegistryClientError(`skillhub registry response exceeds the maximum of ${options.maxResponseBytes} bytes`)
    }
    try {
      return JSON.parse(raw)
    } catch (error: unknown) {
      throw new RegistryClientError('skillhub registry response was not valid JSON', { cause: error })
    }
  } catch (error: unknown) {
    if (error instanceof RegistryClientError) throw error
    if (controller.signal.aborted) throw new RegistryClientError(`skillhub registry request timed out after ${options.timeoutMs}ms`, { cause: error })
    throw new RegistryClientError(`skillhub registry request failed: ${String(error)}`, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

/** GET a fixed search endpoint under the configured registry origin. `query`/`category` travel as query-string values only, never interpolated into the path. */
export async function searchRegistry(
  query: string,
  category: string | undefined,
  limit: number,
  options: RegistryClientOptions,
): Promise<{ results: SkillSearchResult[]; truncated: boolean }> {
  const base = assertHttpsRegistryUrl(options.registryUrl)
  const url = new URL('api/v1/skills/search', base.href.endsWith('/') ? base.href : `${base.href}/`)
  url.searchParams.set('q', query)
  if (category !== undefined) url.searchParams.set('category', category)
  url.searchParams.set('limit', String(limit))

  const body = await requestJson(url, options)
  const root = asRecord(body)
  const rawResults = Array.isArray(root?.results) ? root.results : []
  const results: SkillSearchResult[] = []
  for (const entry of rawResults) {
    const record = asRecord(entry)
    if (record === undefined) continue
    results.push({
      name: asString(record.name),
      version: asString(record.version),
      category: asString(record.category),
      description: asString(record.description),
      downloads: asNumber(record.downloads),
    })
  }
  const truncated = results.length > limit
  return { results: truncated ? results.slice(0, limit) : results, truncated }
}

/** GET a fixed skill-manifest endpoint. `name`/`version` travel as query-string values only. Enforces file-count and byte-size bounds on the whole bundle before returning it. */
export async function fetchSkillManifest(
  name: string,
  version: string,
  options: RegistryClientOptions,
): Promise<SkillManifest> {
  const base = assertHttpsRegistryUrl(options.registryUrl)
  const url = new URL('api/v1/skills/manifest', base.href.endsWith('/') ? base.href : `${base.href}/`)
  url.searchParams.set('name', name)
  url.searchParams.set('version', version)

  const body = await requestJson(url, options)
  const root = asRecord(body)
  if (root === undefined) {
    throw new RegistryClientError(`skillhub registry returned no manifest for "${name}"@"${version}"`)
  }
  const rawFiles = Array.isArray(root.files) ? root.files : []
  if (rawFiles.length === 0) {
    throw new RegistryClientError(`skillhub registry manifest for "${name}"@"${version}" has no files`)
  }
  if (rawFiles.length > options.maxFilesPerSkill) {
    throw new RegistryClientError(
      `skillhub registry manifest for "${name}"@"${version}" has ${rawFiles.length} files, exceeding the maximum of ${options.maxFilesPerSkill}`,
    )
  }
  const files: SkillBundleFile[] = []
  let totalBytes = 0
  for (const entry of rawFiles) {
    const record = asRecord(entry)
    const path = record !== undefined ? asString(record.path) : ''
    const content = record !== undefined ? asString(record.content) : ''
    if (path.length === 0) {
      throw new RegistryClientError(`skillhub registry manifest for "${name}"@"${version}" has a file with no path`)
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > options.maxFileBytes) {
      throw new RegistryClientError(
        `skillhub registry manifest file "${path}" is ${bytes} bytes, exceeding the maximum of ${options.maxFileBytes}`,
      )
    }
    totalBytes += bytes
    if (totalBytes > options.maxTotalBytes) {
      throw new RegistryClientError(
        `skillhub registry manifest for "${name}"@"${version}" exceeds the total bundle maximum of ${options.maxTotalBytes} bytes`,
      )
    }
    files.push({ path, content })
  }

  return {
    name: asString(root.name, name),
    version: asString(root.version, version),
    description: asString(root.description),
    category: asString(root.category),
    files,
  }
}
