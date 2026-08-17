import { describe, expect, it, vi } from 'vitest'
import {
  assertHttpsRegistryUrl,
  assertVersionString,
  fetchSkillManifest,
  RegistryClientError,
  searchRegistry,
  type RegistryClientOptions,
} from '../src/registry-client.ts'

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', 'content-length': String(text.length), ...init?.headers },
  })
}

const baseOptions: RegistryClientOptions = {
  registryUrl: 'https://registry.example',
  timeoutMs: 5000,
  maxResponseBytes: 1_000_000,
  maxFilesPerSkill: 10,
  maxFileBytes: 10_000,
  maxTotalBytes: 100_000,
}

describe('assertHttpsRegistryUrl', () => {
  it('accepts an https URL', () => {
    expect(() => assertHttpsRegistryUrl('https://registry.example')).not.toThrow()
  })

  it('rejects http and other schemes', () => {
    expect(() => assertHttpsRegistryUrl('http://registry.example')).toThrow(RegistryClientError)
    expect(() => assertHttpsRegistryUrl('ftp://registry.example')).toThrow(RegistryClientError)
    expect(() => assertHttpsRegistryUrl('file:///etc/passwd')).toThrow(RegistryClientError)
  })

  it('rejects a malformed URL', () => {
    expect(() => assertHttpsRegistryUrl('not a url')).toThrow(RegistryClientError)
  })
})

describe('assertVersionString', () => {
  it('accepts a well-formed version', () => {
    expect(() => assertVersionString('1.2.3')).not.toThrow()
    expect(() => assertVersionString('v1_beta-2+build')).not.toThrow()
  })

  it('rejects anything with unexpected characters or excessive length', () => {
    expect(() => assertVersionString('1.2.3; rm -rf /')).toThrow()
    expect(() => assertVersionString('a'.repeat(33))).toThrow()
    expect(() => assertVersionString('')).toThrow()
  })
})

describe('searchRegistry', () => {
  it('builds a request against the fixed search path under the configured origin, never a response-supplied URL', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      expect(String(url)).toBe('https://registry.example/api/v1/skills/search?q=notes&limit=5')
      return jsonResponse({ results: [{ name: 'note-taker', version: '1.0.0', category: 'productivity', description: 'Takes notes', downloads: 42 }] })
    })
    const result = await searchRegistry('notes', undefined, 5, { ...baseOptions, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.truncated).toBe(false)
    expect(result.results).toEqual([{ name: 'note-taker', version: '1.0.0', category: 'productivity', description: 'Takes notes', downloads: 42 }])
  })

  it('never follows a redirect', async () => {
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      return jsonResponse({ results: [] })
    })
    await searchRegistry('q', undefined, 10, { ...baseOptions, fetchImpl })
  })

  it('truncates to the requested limit and reports truncation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: Array.from({ length: 5 }, (_unused, index) => ({ name: `skill-${index}`, version: '1.0.0', category: 'x', description: '', downloads: 0 })),
    }))
    const result = await searchRegistry('q', undefined, 2, { ...baseOptions, fetchImpl })
    expect(result.results).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('rejects an oversized response even when content-length under-reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': '1' },
    }))
    await expect(searchRegistry('q', undefined, 10, { ...baseOptions, maxResponseBytes: 1, fetchImpl })).rejects.toThrow(RegistryClientError)
  })

  it('surfaces a non-2xx registry response as an error', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    await expect(searchRegistry('q', undefined, 10, { ...baseOptions, fetchImpl })).rejects.toThrow(RegistryClientError)
  })
})

describe('fetchSkillManifest', () => {
  it('parses a well-formed manifest', async () => {
    const fetchImpl = vi.fn(async (url: URL | string) => {
      expect(String(url)).toBe('https://registry.example/api/v1/skills/manifest?name=my-skill&version=latest')
      return jsonResponse({
        name: 'my-skill',
        version: '2.0.0',
        description: 'desc',
        category: 'cat',
        files: [{ path: 'SKILL.md', content: '# hi' }],
      })
    })
    const manifest = await fetchSkillManifest('my-skill', 'latest', { ...baseOptions, fetchImpl })
    expect(manifest.files).toEqual([{ path: 'SKILL.md', content: '# hi' }])
  })

  it('rejects a manifest with no files', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'x', version: '1', files: [] }))
    await expect(fetchSkillManifest('x', '1', { ...baseOptions, fetchImpl })).rejects.toThrow(/no files/)
  })

  it('rejects a manifest exceeding the file-count cap', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      name: 'x',
      version: '1',
      files: Array.from({ length: 20 }, (_unused, index) => ({ path: `f${index}.md`, content: 'x' })),
    }))
    await expect(fetchSkillManifest('x', '1', { ...baseOptions, maxFilesPerSkill: 10, fetchImpl })).rejects.toThrow(/exceeding the maximum/)
  })

  it('rejects a single file exceeding the per-file byte cap', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'x', version: '1', files: [{ path: 'SKILL.md', content: 'a'.repeat(50) }] }))
    await expect(fetchSkillManifest('x', '1', { ...baseOptions, maxFileBytes: 10, fetchImpl })).rejects.toThrow(/exceeding the maximum/)
  })

  it('rejects a bundle exceeding the total byte cap across multiple files', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      name: 'x',
      version: '1',
      files: [{ path: 'a.md', content: 'a'.repeat(60) }, { path: 'b.md', content: 'b'.repeat(60) }],
    }))
    await expect(fetchSkillManifest('x', '1', { ...baseOptions, maxFileBytes: 100, maxTotalBytes: 100, fetchImpl })).rejects.toThrow(/total bundle maximum/)
  })

  it('rejects a file entry with no path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: 'x', version: '1', files: [{ path: '', content: 'x' }] }))
    await expect(fetchSkillManifest('x', '1', { ...baseOptions, fetchImpl })).rejects.toThrow(/no path/)
  })
})
