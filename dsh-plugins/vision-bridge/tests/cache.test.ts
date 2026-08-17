import { describe, expect, it } from 'vitest'
import { cacheKeyFor, VisionResponseCache } from '../src/cache.ts'

describe('cacheKeyFor', () => {
  it('is stable for the same bytes and prompt', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(cacheKeyFor(bytes, 'p')).toBe(cacheKeyFor(bytes, 'p'))
  })

  it('differs when the prompt differs', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(cacheKeyFor(bytes, 'p1')).not.toBe(cacheKeyFor(bytes, 'p2'))
  })

  it('differs when the bytes differ', () => {
    expect(cacheKeyFor(new Uint8Array([1]), 'p')).not.toBe(cacheKeyFor(new Uint8Array([2]), 'p'))
  })
})

describe('VisionResponseCache', () => {
  it('returns a stored value before it expires', () => {
    let now = 1000
    const cache = new VisionResponseCache(1000, 10, () => now)
    cache.set('k', 'v')
    now += 500
    expect(cache.get('k')).toBe('v')
  })

  it('expires an entry after its TTL', () => {
    let now = 1000
    const cache = new VisionResponseCache(1000, 10, () => now)
    cache.set('k', 'v')
    now += 1500
    expect(cache.get('k')).toBeUndefined()
  })

  it('never stores anything when ttlMs is zero (caching disabled)', () => {
    const cache = new VisionResponseCache(0, 10)
    cache.set('k', 'v')
    expect(cache.get('k')).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('evicts the oldest entry once maxEntries is exceeded', () => {
    let now = 0
    const cache = new VisionResponseCache(100_000, 2, () => now)
    cache.set('a', '1'); now += 1
    cache.set('b', '2'); now += 1
    cache.set('c', '3')
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('2')
    expect(cache.get('c')).toBe('3')
  })
})
