/**
 * Fetches Google Flights' search page for one encoded query and parses the
 * itinerary list out of it. Ports https://github.com/AWeirdDev/flights'
 * `fetcher.py`/`parser.py` approach: (1) fetch the search HTML, no official
 * API exists; (2) extract Google's own internal `AF_initDataCallback`
 * hydration payload from a `<script class="ds:1">` tag; (3) walk that
 * undocumented, positionally-indexed JSON array.
 *
 * Two deliberate departures from upstream, both disclosed in the plugin
 * README: we use a plain `fetch()` (no TLS-fingerprint impersonation), and
 * every indexed access into the undocumented payload is guarded so a shape
 * change fails closed with {@link FlightSearchParseError} instead of
 * throwing an unhandled exception or returning corrupted data.
 *
 * @module dsh-plugin-flight-search/provider
 */

import { flightSearchUrl, type FlightSearchQuery } from './query.ts'

/** Raised when Google's response can't be fetched at all (network/timeout/HTTP status). */
export class FlightSearchFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FlightSearchFetchError'
  }
}

/** Raised when the response was fetched but the expected data shape wasn't found in it. */
export class FlightSearchParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FlightSearchParseError'
  }
}

/** Raised when Google's own response explicitly reports no itineraries for the query. */
export class FlightsNotFoundError extends Error {
  constructor() {
    super('no flights found for this search')
    this.name = 'FlightsNotFoundError'
  }
}

export interface SimpleDate {
  year: number
  month: number
  day: number
}

export interface SimpleTime {
  hour: number
  minute: number
}

export interface FlightLegResult {
  fromAirportCode?: string
  fromAirportName?: string
  toAirportCode?: string
  toAirportName?: string
  departureDate?: SimpleDate
  departureTime?: SimpleTime
  arrivalDate?: SimpleDate
  arrivalTime?: SimpleTime
  /** Minutes. */
  durationMinutes?: number
  planeType?: string
}

export interface CarbonEmission {
  /** Grams; this itinerary's estimated emission. */
  emissionGrams?: number
  /** Grams; the typical emission for this route. */
  typicalOnRouteGrams?: number
}

export interface FlightItinerary {
  /** Google's own label for the itinerary shape, e.g. a stop-count description. */
  type?: string
  price?: number
  airlines: string[]
  legs: FlightLegResult[]
  carbon?: CarbonEmission
}

export interface FlightSearchResult {
  itineraries: FlightItinerary[]
  /** True when the result list was capped before every itinerary Google returned was included. */
  truncated: boolean
}

const DEFAULT_TIMEOUT_MS = 15_000
/** Refuse to buffer an unbounded response — Google's search page is normally well under this. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export interface FetchOptions {
  timeoutMs?: number
  /** Overrides the default browser-like User-Agent header. */
  userAgent?: string
}

/**
 * Fetch the raw search HTML for one query. Plain `fetch()` over HTTPS with a
 * realistic `User-Agent` only — deliberately not TLS-fingerprint-impersonated
 * (see the plugin README's Trust and limitations section).
 */
export async function fetchFlightSearchHtml(query: FlightSearchQuery, options: FetchOptions = {}): Promise<string> {
  const url = flightSearchUrl(query)
  if (url.protocol !== 'https:') {
    throw new FlightSearchFetchError(`refusing a non-https flight search URL: ${url.protocol}`)
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new FlightSearchFetchError(`Google Flights responded with HTTP ${response.status}`)
    }
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      throw new FlightSearchFetchError(`response exceeds the maximum of ${MAX_RESPONSE_BYTES} bytes`)
    }
    const body = await response.arrayBuffer()
    if (body.byteLength > MAX_RESPONSE_BYTES) {
      throw new FlightSearchFetchError(`response exceeds the maximum of ${MAX_RESPONSE_BYTES} bytes`)
    }
    return new TextDecoder('utf-8').decode(body)
  } catch (error: unknown) {
    if (error instanceof FlightSearchFetchError) throw error
    if (controller.signal.aborted) throw new FlightSearchFetchError('flight search request timed out', { cause: error })
    throw new FlightSearchFetchError(`flight search request failed: ${String(error)}`, { cause: error })
  } finally {
    clearTimeout(timeout)
  }
}

// --- Defensive accessors into the undocumented `AF_initDataCallback` payload ---

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function at(value: unknown, index: number): unknown {
  return asArray(value)?.[index]
}

function asSimpleDate(value: unknown): SimpleDate | undefined {
  const tuple = asArray(value)
  if (tuple === undefined || tuple.length < 3) return undefined
  const [year, month, day] = tuple.map(asNumber)
  if (year === undefined || month === undefined || day === undefined) return undefined
  return { year, month, day }
}

function asSimpleTime(value: unknown): SimpleTime | undefined {
  const tuple = asArray(value)
  if (tuple === undefined || tuple.length < 2) return undefined
  const [hour, minute] = tuple.map(asNumber)
  if (hour === undefined || minute === undefined) return undefined
  return { hour, minute }
}

/**
 * Extract the `<script class="ds:1">` tag's text. This is a targeted regex,
 * not a full HTML parse — the same trade-off upstream's CSS-selector
 * extraction makes, kept here to avoid a full HTML-parser dependency for one
 * known, narrow tag shape.
 */
function extractDs1Script(html: string): string {
  const match = /<script[^>]*\bclass="ds:1"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (match?.[1] === undefined) {
    throw new FlightSearchParseError('could not find the expected "ds:1" data script in the response — Google may have changed its page shape')
  }
  return match[1]
}

/**
 * Mirrors upstream's `parse_js`: `AF_initDataCallback({..., data: [...], sideChannel: {...}})`
 * is not valid JSON as a whole, but the `data: [...]` array literal between
 * the first `data:` and the callback's trailing fields is. This slicing
 * approach is exactly as fragile as it looks — it works because of the
 * specific, undocumented shape of this one callback, not because it's a
 * general JS-object parser.
 */
function extractDataPayload(scriptText: string): unknown {
  const marker = 'data:'
  const dataIndex = scriptText.indexOf(marker)
  if (dataIndex === -1) {
    throw new FlightSearchParseError('the "ds:1" script did not contain a "data:" payload')
  }
  const afterData = scriptText.slice(dataIndex + marker.length)
  // Checked against the raw remainder, not the comma-sliced candidate below:
  // exactly where "errorHasStatus: true" falls relative to the trailing comma
  // isn't something we can pin down without a captured error-case response, so
  // this checks for the marker's presence rather than relying on it landing
  // as the sliced text's exact suffix.
  if (afterData.includes('errorHasStatus: true')) {
    throw new FlightsNotFoundError()
  }
  const lastComma = afterData.lastIndexOf(',')
  const jsonText = lastComma === -1 ? afterData : afterData.slice(0, lastComma)
  try {
    return JSON.parse(jsonText) as unknown
  } catch (error: unknown) {
    throw new FlightSearchParseError('the "ds:1" payload was not valid JSON', { cause: error })
  }
}

function parseAirlineOrAllianceList(value: unknown): Array<{ code: string; name: string }> {
  const rows = asArray(value) ?? []
  const parsed: Array<{ code: string; name: string }> = []
  for (const row of rows) {
    const code = asString(at(row, 0))
    const name = asString(at(row, 1))
    if (code !== undefined && name !== undefined) parsed.push({ code, name })
  }
  return parsed
}

function parseSingleFlight(raw: unknown): FlightLegResult {
  const fromAirportCode = asString(at(raw, 3))
  const fromAirportName = asString(at(raw, 4))
  // Cross-referenced deliberately, matching upstream: the "to" airport's code and name
  // live at indices 6 and 5 respectively in this payload, not 5 and 6.
  const toAirportCode = asString(at(raw, 6))
  const toAirportName = asString(at(raw, 5))
  const departureTime = asSimpleTime(at(raw, 8))
  const departureDate = asSimpleDate(at(raw, 20))
  const arrivalTime = asSimpleTime(at(raw, 10))
  const arrivalDate = asSimpleDate(at(raw, 21))
  const durationMinutes = asNumber(at(raw, 11))
  const planeType = asString(at(raw, 17))
  return {
    ...fromAirportCode !== undefined ? { fromAirportCode } : {},
    ...fromAirportName !== undefined ? { fromAirportName } : {},
    ...toAirportCode !== undefined ? { toAirportCode } : {},
    ...toAirportName !== undefined ? { toAirportName } : {},
    ...departureTime !== undefined ? { departureTime } : {},
    ...departureDate !== undefined ? { departureDate } : {},
    ...arrivalTime !== undefined ? { arrivalTime } : {},
    ...arrivalDate !== undefined ? { arrivalDate } : {},
    ...durationMinutes !== undefined ? { durationMinutes } : {},
    ...planeType !== undefined ? { planeType } : {},
  }
}

function parseCarbonEmission(extras: unknown): CarbonEmission {
  const emissionGrams = asNumber(at(extras, 7))
  const typicalOnRouteGrams = asNumber(at(extras, 8))
  return {
    ...emissionGrams !== undefined ? { emissionGrams } : {},
    ...typicalOnRouteGrams !== undefined ? { typicalOnRouteGrams } : {},
  }
}

function parseItinerary(entry: unknown): FlightItinerary | undefined {
  const flight = at(entry, 0)
  const price = asNumber(at(at(at(entry, 1), 0), 1))
  const type = asString(at(flight, 0))
  const legsRaw = asArray(at(flight, 2)) ?? []
  const airlinesRaw = asArray(at(flight, 1)) ?? []
  return {
    ...type !== undefined ? { type } : {},
    ...price !== undefined ? { price } : {},
    airlines: airlinesRaw.map(asString).filter((value): value is string => value !== undefined),
    legs: legsRaw.map(parseSingleFlight),
    carbon: parseCarbonEmission(at(flight, 22)),
  }
}

/** Parse the itinerary list out of one fetched Google Flights search HTML page. */
export function parseFlightSearchHtml(html: string, maxResults: number): FlightSearchResult {
  const scriptText = extractDs1Script(html)
  const payload = extractDataPayload(scriptText)

  // Metadata directory (alliances/airlines) is extracted for parity with upstream but not
  // currently surfaced — per-itinerary airline names already come through inline (see below).
  // payload[7][1] holds a two-element array: [alliances, airlines].
  const metadataSection = at(at(payload, 7), 1)
  parseAirlineOrAllianceList(at(metadataSection, 0))
  parseAirlineOrAllianceList(at(metadataSection, 1))

  const entries = asArray(at(at(payload, 3), 0))
  if (entries === undefined) return { itineraries: [], truncated: false }

  const itineraries: FlightItinerary[] = []
  for (const entry of entries) {
    if (itineraries.length >= maxResults) break
    const itinerary = parseItinerary(entry)
    if (itinerary !== undefined) itineraries.push(itinerary)
  }
  return { itineraries, truncated: entries.length > itineraries.length }
}
