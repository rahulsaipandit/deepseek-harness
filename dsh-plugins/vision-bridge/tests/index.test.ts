import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, Config } from '../src/index.ts'

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const NOT_AN_IMAGE = new TextEncoder().encode('just some text, not an image')

interface MockFsFile {
  path: string
  bytes: Uint8Array
}

/** Minimal ctx.fs stand-in: one file resolves to one path, everything else is "not found". */
function mockFs(file: MockFsFile) {
  return {
    async resolve(path: string) {
      return { displayPath: path, key: path }
    },
    async stat(target: { displayPath: string }) {
      return target.displayPath === file.path ? { type: 'file' as const } : undefined
    },
    async readBytes(target: { displayPath: string }) {
      if (target.displayPath !== file.path) throw new Error('not found')
      return file.bytes
    },
  }
}

function mockCredentials(values: Record<string, string | undefined>) {
  return {
    async resolve(ref: string) {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'test' }
    },
  }
}

function makeCtx(fs: unknown, credentials: unknown): { ctx: Context, registered: () => ToolDefinition } {
  let registered: ToolDefinition | undefined
  const ctx = {
    tools: { register: (def: ToolDefinition) => { registered = def; return () => {} } },
    fs,
    credentials,
  } as unknown as Context
  return { ctx, registered: () => registered as ToolDefinition }
}

function exec() {
  return { signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]
}

describe('describe_image tool registration', () => {
  it('registers with exactly the file_path/url/prompt/mode parameters, no destination-url or credential field', () => {
    const { ctx, registered } = makeCtx(mockFs({ path: '/img.png', bytes: PNG_BYTES }), mockCredentials({}))
    apply(ctx, Config({}))
    const tool = registered()
    expect(tool.name).toBe('describe_image')
    const props = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)
    expect(props.sort()).toEqual(['file_path', 'mode', 'prompt', 'url'].sort())
    expect(props).not.toContain('base_url')
    expect(props).not.toContain('api_key')
    expect(props).not.toContain('apiKey')
  })
})

describe('describe_image argument validation', () => {
  it('rejects a call with neither file_path nor url', async () => {
    const { ctx, registered } = makeCtx(mockFs({ path: '/img.png', bytes: PNG_BYTES }), mockCredentials({}))
    apply(ctx, Config({}))
    await expect(registered().execute({}, exec())).rejects.toThrow(/exactly one/)
  })

  it('rejects a call with both file_path and url', async () => {
    const { ctx, registered } = makeCtx(mockFs({ path: '/img.png', bytes: PNG_BYTES }), mockCredentials({}))
    apply(ctx, Config({}))
    await expect(registered().execute({ file_path: '/img.png', url: 'https://x/y.png' }, exec())).rejects.toThrow(/exactly one/)
  })
})

describe('describe_image image validation', () => {
  it('fails closed when the local file does not sniff as a real image', async () => {
    const { ctx, registered } = makeCtx(mockFs({ path: '/img.png', bytes: NOT_AN_IMAGE }), mockCredentials({}))
    apply(ctx, Config({}))
    await expect(registered().execute({ file_path: '/img.png' }, exec())).rejects.toThrow(/does not look like/)
  })
})

describe('describe_image provider dispatch', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('skips a provider with no configured credential and uses the next one that has one', async () => {
    let calledUrl: string | undefined
    globalThis.fetch = vi.fn(async (url: URL | string) => {
      calledUrl = String(url)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'a cat' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    const { ctx, registered } = makeCtx(
      mockFs({ path: '/img.png', bytes: PNG_BYTES }),
      mockCredentials({ GLM_API_KEY: 'glm-secret' }), // mimo (first in catalog) has no key configured
    )
    apply(ctx, Config({}))
    const result = await registered().execute({ file_path: '/img.png' }, exec()) as { text: string, source: string, provider?: string }

    expect(result.source).toBe('provider')
    expect(result.provider).toBe('glm')
    expect(result.text).toBe('a cat')
    expect(calledUrl).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
  })

  it('serves a repeated identical request from cache without a second provider call', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'a dog' } }] }), { status: 200 }))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    const { ctx, registered } = makeCtx(
      mockFs({ path: '/img.png', bytes: PNG_BYTES }),
      mockCredentials({ MIMO_API_KEY: 'mimo-secret' }),
    )
    apply(ctx, Config({}))
    const tool = registered()
    const first = await tool.execute({ file_path: '/img.png' }, exec()) as { source: string }
    const second = await tool.execute({ file_path: '/img.png' }, exec()) as { source: string }

    expect(first.source).toBe('provider')
    expect(second.source).toBe('cache')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('throws a clear error when no provider has a credential and offline OCR fallback is disabled', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('should not be called') }) as unknown as typeof fetch
    const { ctx, registered } = makeCtx(
      mockFs({ path: '/img.png', bytes: PNG_BYTES }),
      mockCredentials({}),
    )
    apply(ctx, Config({ localOcrFallback: false }))
    await expect(registered().execute({ file_path: '/img.png' }, exec()))
      .rejects.toThrow(/no vision provider has a configured credential/)
  })
})
