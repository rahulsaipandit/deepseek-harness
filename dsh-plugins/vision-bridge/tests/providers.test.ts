import { describe, expect, it } from 'vitest'
import { authHeaders, chatCompletionsUrl, DEFAULT_PROVIDERS, orderedProviders, type ProviderConfig } from '../src/providers.ts'

describe('chatCompletionsUrl', () => {
  it('appends /chat/completions when missing', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('does not duplicate the suffix when already present', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/chat/completions')
  })

  it('strips a trailing slash before appending', () => {
    expect(chatCompletionsUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/chat/completions')
  })
})

describe('authHeaders', () => {
  const base: ProviderConfig = {
    id: 'x', label: 'X', baseUrl: 'https://x.example.com/v1', model: 'x-model', credentialRef: 'X_API_KEY',
  }

  it('defaults to a Bearer Authorization header', () => {
    expect(authHeaders(base, 'secret')).toEqual({ Authorization: 'Bearer secret' })
  })

  it('uses the configured header name when the provider declares one', () => {
    const provider: ProviderConfig = { ...base, authHeaderName: 'api-key' }
    expect(authHeaders(provider, 'secret')).toEqual({ 'api-key': 'secret' })
  })
})

describe('orderedProviders', () => {
  const catalog: ProviderConfig[] = [
    { id: 'a', label: 'A', baseUrl: 'https://a', model: 'a', credentialRef: 'A_KEY' },
    { id: 'b', label: 'B', baseUrl: 'https://b', model: 'b', credentialRef: 'B_KEY' },
    { id: 'c', label: 'C', baseUrl: 'https://c', model: 'c', credentialRef: 'C_KEY' },
  ]

  it('applies the requested order first', () => {
    expect(orderedProviders(catalog, ['c', 'a']).map(p => p.id)).toEqual(['c', 'a', 'b'])
  })

  it('preserves catalog order when providerOrder is empty', () => {
    expect(orderedProviders(catalog, []).map(p => p.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores an order entry not present in the catalog', () => {
    expect(orderedProviders(catalog, ['nonexistent', 'b']).map(p => p.id)).toEqual(['b', 'a', 'c'])
  })
})

describe('DEFAULT_PROVIDERS', () => {
  it('has a unique id and a distinct credential ref per entry', () => {
    const ids = DEFAULT_PROVIDERS.map(p => p.id)
    const refs = DEFAULT_PROVIDERS.map(p => p.credentialRef)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('every base URL is https', () => {
    for (const provider of DEFAULT_PROVIDERS) {
      expect(new URL(provider.baseUrl).protocol).toBe('https:')
    }
  })
})
