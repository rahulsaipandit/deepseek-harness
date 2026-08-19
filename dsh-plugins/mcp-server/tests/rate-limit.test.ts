import { describe, expect, it } from 'vitest'
import { ipKey, RateLimiter, tokenKey } from '../src/rate-limit.ts'

describe('RateLimiter', () => {
  it('allows requests up to the limit within one window', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 })
    const now = 1_000_000
    expect(limiter.consume('a', now).allowed).toBe(true)
    expect(limiter.consume('a', now).allowed).toBe(true)
    expect(limiter.consume('a', now).allowed).toBe(true)
    expect(limiter.consume('a', now).allowed).toBe(false)
  })

  it('reports decreasing remaining count as the window fills', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000 })
    const now = 1_000_000
    expect(limiter.consume('a', now).remaining).toBe(2)
    expect(limiter.consume('a', now).remaining).toBe(1)
    expect(limiter.consume('a', now).remaining).toBe(0)
  })

  it('resets the count once the window elapses', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 })
    const now = 1_000_000
    expect(limiter.consume('a', now).allowed).toBe(true)
    expect(limiter.consume('a', now).allowed).toBe(false)
    expect(limiter.consume('a', now + 1000).allowed).toBe(true)
  })

  it('tracks distinct keys independently', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 })
    const now = 1_000_000
    expect(limiter.consume('a', now).allowed).toBe(true)
    expect(limiter.consume('b', now).allowed).toBe(true)
    expect(limiter.consume('a', now).allowed).toBe(false)
    expect(limiter.consume('b', now).allowed).toBe(false)
  })

  it('prune() removes only expired windows', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 })
    const now = 1_000_000
    limiter.consume('expired', now)
    limiter.consume('fresh', now + 2000)
    limiter.prune(now + 2500)
    // 'expired' window elapsed (reset at now+1000, pruned at now+2500) so its
    // budget is available again; 'fresh' window is still active (reset at
    // now+3000) so it's still exhausted.
    expect(limiter.consume('expired', now + 2500).allowed).toBe(true)
    expect(limiter.consume('fresh', now + 2500).allowed).toBe(false)
  })
})

describe('ipKey / tokenKey', () => {
  it('namespace their keys distinctly, so an IP and a token can never collide', () => {
    expect(ipKey('token:abc')).not.toBe(tokenKey('token:abc'))
    expect(ipKey('1.2.3.4')).toBe('ip:1.2.3.4')
  })

  it('tokenKey never embeds the raw token in the key', () => {
    const key = tokenKey('super-secret-token')
    expect(key).not.toContain('super-secret-token')
  })

  it('tokenKey is stable for the same token', () => {
    expect(tokenKey('same-token')).toBe(tokenKey('same-token'))
  })
})
