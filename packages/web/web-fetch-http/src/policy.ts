/**
 * URL validation and content-type classification for the local HTTP(S) fetch
 * provider — the pure, network-free half. The provider's `fetch()` composes
 * these with transport (redirect following, byte caps, decoding).
 *
 * @module @deepseek-ai/dsh-web-fetch-http/policy
 */

import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { WebError } from '@deepseek-ai/dsh-web'

/** The body kinds this provider decodes. */
export type FetchableKind = 'html' | 'text'

/** Destination policy mode for host resolution and IP admission. */
export type DestinationPolicyMode = 'block-private' | 'allowlist'

/** One DNS-resolved destination chosen for this request hop. */
export interface DestinationResolution {
  /** The pinned IP address for this hop's outbound connection. */
  address: string
  /** IP family (`4` or `6`) of {@link address}. */
  family: 4 | 6
}

const DENYLIST = new BlockList()

// CLAUDE_FIX_SECURITY: Claude fixed the SSRF/rebinding risk by enforcing mandatory
// destination IP policy after DNS resolution and on each redirect hop.
DENYLIST.addSubnet('0.0.0.0', 8, 'ipv4')
DENYLIST.addSubnet('10.0.0.0', 8, 'ipv4')
DENYLIST.addSubnet('100.64.0.0', 10, 'ipv4')
DENYLIST.addSubnet('127.0.0.0', 8, 'ipv4')
DENYLIST.addSubnet('169.254.0.0', 16, 'ipv4')
DENYLIST.addSubnet('172.16.0.0', 12, 'ipv4')
DENYLIST.addSubnet('192.168.0.0', 16, 'ipv4')
DENYLIST.addSubnet('198.18.0.0', 15, 'ipv4')
DENYLIST.addSubnet('224.0.0.0', 4, 'ipv4')
DENYLIST.addAddress('169.254.169.254', 'ipv4')
DENYLIST.addAddress('100.100.100.200', 'ipv4')
DENYLIST.addAddress('::1', 'ipv6')
DENYLIST.addSubnet('fc00::', 7, 'ipv6')
DENYLIST.addSubnet('fe80::', 10, 'ipv6')
DENYLIST.addSubnet('ff00::', 8, 'ipv6')

function familyName(family: 4 | 6): 'ipv4' | 'ipv6' {
  return family === 4 ? 'ipv4' : 'ipv6'
}

const V4_MAPPED_V6 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i

/**
 * Expand a resolved address into every representation that must be policy-checked.
 * An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is checked both as itself and as
 * the embedded IPv4 address, so an attacker-controlled AAAA record cannot smuggle
 * a private/metadata IPv4 target past IPv4-only denylist rules by wrapping it in
 * IPv6 syntax.
 */
function expandForPolicyCheck(address: string, family: 4 | 6): Array<{ address: string; family: 4 | 6 }> {
  if (family !== 6) return [{ address, family }]
  const mapped = V4_MAPPED_V6.exec(address)
  if (mapped === null) return [{ address, family }]
  return [{ address, family }, { address: mapped[1]!, family: 4 }]
}

function parseCidr(cidr: string): { address: string; prefix: number; family: 4 | 6 } {
  const [address, prefixRaw] = cidr.split('/')
  const family = isIP(address ?? '')
  if (family !== 4 && family !== 6) {
    throw new WebError(`invalid destination allowlist CIDR address: ${cidr}`, 'WEB_INVALID_URL')
  }
  const prefix = Number(prefixRaw)
  const max = family === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new WebError(`invalid destination allowlist CIDR prefix: ${cidr}`, 'WEB_INVALID_URL')
  }
  return { address, prefix, family }
}

/** Compile a destination allowlist CIDR set into a membership checker. */
export function compileDestinationAllowlist(allowCidrs: readonly string[]): BlockList {
  const allow = new BlockList()
  for (const cidr of allowCidrs) {
    const parsed = parseCidr(cidr)
    allow.addSubnet(parsed.address, parsed.prefix, familyName(parsed.family))
  }
  return allow
}

/**
 * Resolve one URL hostname and enforce destination policy over resolved IPs.
 *
 * The returned address is pinned for the current hop's outbound connection.
 */
export async function resolveDestination(
  url: URL,
  mode: DestinationPolicyMode,
  allowlist: BlockList | undefined,
): Promise<DestinationResolution> {
  const literalFamily = isIP(url.hostname)
  let candidates: Array<{ address: string; family: 4 | 6 }>
  if (literalFamily === 4 || literalFamily === 6) {
    candidates = [{ address: url.hostname, family: literalFamily }]
  } else {
    try {
      candidates = (await lookup(url.hostname, { all: true, verbatim: true }))
        .map(row => ({ address: row.address, family: row.family as 4 | 6 }))
    } catch (error: unknown) {
      throw new WebError(`could not resolve host "${url.hostname}"`, 'WEB_BLOCKED_URL', { cause: error })
    }
  }

  if (candidates.length === 0) {
    throw new WebError(`host "${url.hostname}" did not resolve to any IP address`, 'WEB_BLOCKED_URL')
  }

  for (const candidate of candidates) {
    for (const check of expandForPolicyCheck(candidate.address, candidate.family)) {
      if (DENYLIST.check(check.address, familyName(check.family))) {
        throw new WebError(
          `resolved destination ${candidate.address} for "${url.hostname}" is blocked by destination policy`,
          'WEB_BLOCKED_URL',
        )
      }
    }
  }

  if (mode === 'allowlist') {
    if (allowlist === undefined) {
      throw new WebError('destination allowlist mode requires configured allowlist CIDRs', 'WEB_BLOCKED_URL')
    }
    for (const candidate of candidates) {
      const checks = expandForPolicyCheck(candidate.address, candidate.family)
      if (!checks.some(check => allowlist.check(check.address, familyName(check.family)))) {
        throw new WebError(
          `resolved destination ${candidate.address} for "${url.hostname}" is not in the destination allowlist`,
          'WEB_BLOCKED_URL',
        )
      }
    }
  }

  return candidates[0]!
}

/**
 * Validate a request URL against the basic transport hygiene the provider
 * enforces before any network access: http(s) only, no embedded credentials,
 * bounded length. Returns the parsed `URL`. Throws {@link WebError} otherwise.
 * Destination-IP policy (SSRF / private-network blocking) is enforced separately,
 * per resolved address, by {@link resolveDestination}.
 *
 * @param input - the raw URL string from the fetch request.
 * @param maxUrlLength - inclusive upper bound on `input`'s length.
 * @returns the parsed `URL`.
 */
export function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/**
 * Two URLs are same-origin when scheme, hostname, and port match. A redirect
 * that crosses origins is refused so each new origin requires a fresh tool call
 * (and thus a fresh provider/permission decision).
 *
 * @param a - one of the two URLs to compare.
 * @param b - the other URL to compare.
 * @returns true when `a` and `b` share scheme, hostname, and port.
 */
export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

/**
 * Classify a response `Content-Type` into a decodable body kind, or `undefined`
 * for an unsupported (e.g. binary) type. `text/html` and `application/xhtml+xml`
 * are `html`; other `text/*` plus a few structured text types are `text`.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none (unsupported).
 * @returns the decodable kind, or `undefined` for an unsupported type.
 */
export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * Extract the `charset` parameter from a response `Content-Type`, lower-cased,
 * or `undefined` when absent. The provider feeds this label to `TextDecoder`
 * so a non-UTF-8 response is decoded with its declared encoding rather than
 * silently mangled into replacement characters.
 *
 * @param contentType - the raw `Content-Type` header, or `null` when the
 *   response carries none.
 * @returns the lower-cased charset label, or `undefined` when none is declared.
 */
export function parseCharset(contentType: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')
  return match?.[1]?.trim().toLowerCase()
}

/**
 * Build a `TextDecoder` for the declared charset, falling back to UTF-8 when
 * none is declared. Throws {@link WebError} `WEB_UNSUPPORTED_CONTENT_TYPE` when
 * the label is present but not a charset `TextDecoder` recognizes — better to
 * fail loudly than return mojibake.
 *
 * @param charset - the declared charset label (from {@link parseCharset}), or
 *   `undefined` to default to UTF-8.
 * @returns a decoder for the declared (or defaulted) encoding.
 */
export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (error: unknown) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause: error })
  }
}
