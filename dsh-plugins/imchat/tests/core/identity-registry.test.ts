import { describe, expect, it } from 'vitest'
import { EmptyAllowlistError, IdentityRegistry } from '../../src/core/identity-registry.ts'

describe('IdentityRegistry', () => {
  it('denies a sender not on the allowlist', () => {
    const registry = new IdentityRegistry({ telegram: [{ senderId: '111' }] })
    expect(registry.isAllowed('telegram', '111')).toBe(true)
    expect(registry.isAllowed('telegram', '222')).toBe(false)
  })

  it('denies every platform with no configured identities at all', () => {
    const registry = new IdentityRegistry({})
    expect(registry.isAllowed('telegram', '111')).toBe(false)
    expect(registry.isAllowed('slack', 'U1')).toBe(false)
  })

  it('resolves an identity\'s bound approval policy', () => {
    const registry = new IdentityRegistry({ slack: [{ senderId: 'U1', approvalPolicy: 'never' }] })
    expect(registry.resolve('slack', 'U1')?.approvalPolicy).toBe('never')
  })

  it('assertConfigured throws EmptyAllowlistError for an unconfigured platform, never treats empty as allow-all', () => {
    const registry = new IdentityRegistry({ telegram: [] })
    expect(() => registry.assertConfigured('telegram')).toThrow(EmptyAllowlistError)
    expect(() => registry.assertConfigured('slack')).toThrow(EmptyAllowlistError)
  })

  it('assertConfigured passes once at least one identity is configured', () => {
    const registry = new IdentityRegistry({ telegram: [{ senderId: '111' }] })
    expect(() => registry.assertConfigured('telegram')).not.toThrow()
  })
})
