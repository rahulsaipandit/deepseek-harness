/**
 * Default-deny per-identity allowlist (design doc §5): a platform adapter
 * refuses to start unless its allowlist is explicit and non-empty. An empty
 * or missing list is a misconfigured deployment, never "allow everyone" —
 * the specific `dsh-overdrive` fail-open default this plugin rejects.
 * @module dsh-plugin-imchat/core/identity-registry
 */

import type { Platform } from './types.ts'

/** One allow-listed sender identity, optionally bound to a DSH approval policy. */
export interface IdentityEntry {
  /** Platform-native sender id (Telegram user id, WhatsApp JID, Slack user id). */
  readonly senderId: string
  /** Approval policy to apply to sessions this identity drives; omitted inherits the deployment default. */
  readonly approvalPolicy?: 'ask' | 'never'
}

/** Thrown by `IdentityRegistry` construction when a platform's allowlist is empty or missing. */
export class EmptyAllowlistError extends Error {
  constructor(platform: Platform) {
    super(`dsh-imchat: refusing to start the ${platform} adapter with an empty allowlist — `
      + 'an empty list means "explicitly allow nobody," never "allow everyone." '
      + `Configure at least one identity under identities.${platform}.`)
    this.name = 'EmptyAllowlistError'
  }
}

/** Per-platform allowlists, keyed by platform. */
export type IdentityConfig = Partial<Record<Platform, readonly IdentityEntry[] | IdentityEntry[]>>

/** Resolves whether a sender may act, and under which approval policy, for one platform. */
export class IdentityRegistry {
  private readonly byPlatform = new Map<Platform, Map<string, IdentityEntry>>()

  constructor(config: IdentityConfig) {
    for (const [platform, entries] of Object.entries(config) as [Platform, readonly IdentityEntry[] | undefined][]) {
      if (entries === undefined) continue
      const bySender = new Map<string, IdentityEntry>()
      for (const entry of entries) bySender.set(entry.senderId, entry)
      this.byPlatform.set(platform, bySender)
    }
  }

  /** Throws {@link EmptyAllowlistError} unless `platform` has at least one configured identity. */
  assertConfigured(platform: Platform): void {
    const bySender = this.byPlatform.get(platform)
    if (bySender === undefined || bySender.size === 0) throw new EmptyAllowlistError(platform)
  }

  /** Resolves the entry for `(platform, senderId)`, or `undefined` when not allow-listed. */
  resolve(platform: Platform, senderId: string): IdentityEntry | undefined {
    return this.byPlatform.get(platform)?.get(senderId)
  }

  isAllowed(platform: Platform, senderId: string): boolean {
    return this.resolve(platform, senderId) !== undefined
  }
}
