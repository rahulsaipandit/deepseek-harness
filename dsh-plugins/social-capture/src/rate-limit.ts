/**
 * Fixed-window rate limiting for the capture receiver, keyed independently
 * by client IP and by a hash of the presented token. Identical shape to
 * `dsh-plugins/mcp-server/src/rate-limit.ts` — a leaked bookmarklet token
 * can't route around a per-source cap by rotating source IPs, and a
 * shared/NATed IP doesn't starve every distinct token behind it.
 * @module dsh-plugin-social-capture/rate-limit
 */

import { createHash } from 'node:crypto'

export interface RateLimitConfig {
  /** Requests allowed per window, per key. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

interface Window {
  count: number
  resetAt: number
}

/** Hash a token for use as a rate-limit key, so the raw secret never sits in memory as a map key. */
export function tokenKey(token: string): string {
  return `token:${createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16)}`
}

export function ipKey(ip: string): string {
  return `ip:${ip}`
}

/** In-memory fixed-window limiter. */
export class RateLimiter {
  private readonly windows = new Map<string, Window>()

  constructor(private readonly config: RateLimitConfig) {}

  /**
   * Record one request against `key` and report whether it's allowed.
   * @param now - injectable clock for tests.
   */
  consume(key: string, now: number = Date.now()): { allowed: boolean; remaining: number; resetAt: number } {
    let window = this.windows.get(key)
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + this.config.windowMs }
      this.windows.set(key, window)
    }
    if (window.count >= this.config.limit) {
      return { allowed: false, remaining: 0, resetAt: window.resetAt }
    }
    window.count += 1
    return { allowed: true, remaining: this.config.limit - window.count, resetAt: window.resetAt }
  }

  /** Drop expired windows, so a long-running process doesn't accumulate one entry per distinct caller forever. */
  prune(now: number = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key)
    }
  }
}
