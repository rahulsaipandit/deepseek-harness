import { describe, expect, it } from 'vitest'
import { encodeFlightSearchQuery, flightSearchUrl, type FlightSearchQuery } from '../src/query.ts'

const baseQuery: FlightSearchQuery = {
  legs: [{ date: '2026-09-01', fromAirport: 'jfk', toAirport: 'lax' }],
  seat: 'economy',
  trip: 'one-way',
}

describe('encodeFlightSearchQuery', () => {
  it('produces a non-empty base64 string', () => {
    const encoded = encodeFlightSearchQuery(baseQuery)
    expect(encoded.length).toBeGreaterThan(0)
    // valid base64 (Node's Buffer round-trips without throwing and preserves bytes)
    expect(Buffer.from(encoded, 'base64').toString('base64')).toBe(encoded)
  })

  it('uppercases lowercase airport codes going into the wire message', () => {
    const encodedLower = encodeFlightSearchQuery(baseQuery)
    const encodedUpper = encodeFlightSearchQuery({
      ...baseQuery,
      legs: [{ date: '2026-09-01', fromAirport: 'JFK', toAirport: 'LAX' }],
    })
    expect(encodedLower).toBe(encodedUpper)
  })

  it('rejects a malformed airport code', () => {
    expect(() => encodeFlightSearchQuery({
      ...baseQuery,
      legs: [{ date: '2026-09-01', fromAirport: 'NEWYORK', toAirport: 'LAX' }],
    })).toThrow(/3-letter IATA airport code/)
  })

  it('rejects a malformed date', () => {
    expect(() => encodeFlightSearchQuery({
      ...baseQuery,
      legs: [{ date: '09/01/2026', fromAirport: 'JFK', toAirport: 'LAX' }],
    })).toThrow(/YYYY-MM-DD/)
  })

  it('rejects more than 9 total passengers', () => {
    expect(() => encodeFlightSearchQuery({
      ...baseQuery,
      passengers: { adults: 9, children: 1 },
    })).toThrow(/too many passengers/)
  })

  it('rejects an infant-on-lap count exceeding adults', () => {
    expect(() => encodeFlightSearchQuery({
      ...baseQuery,
      passengers: { adults: 1, infantsOnLap: 2 },
    })).toThrow(/at least one adult per infant on lap/)
  })

  it('rejects zero flight legs', () => {
    expect(() => encodeFlightSearchQuery({ ...baseQuery, legs: [] })).toThrow(/at least one flight leg/)
  })
})

describe('flightSearchUrl', () => {
  it('builds a well-formed Google Flights search URL', () => {
    const url = flightSearchUrl({ ...baseQuery, currency: 'USD', language: 'en' })
    expect(url.protocol).toBe('https:')
    expect(url.hostname).toBe('www.google.com')
    expect(url.pathname).toBe('/travel/flights/search')
    expect(url.searchParams.get('curr')).toBe('USD')
    expect(url.searchParams.get('hl')).toBe('en')
    expect(url.searchParams.get('tfs')).not.toBeNull()
  })

  it('defaults language/currency to blank (lets Google decide)', () => {
    const url = flightSearchUrl(baseQuery)
    expect(url.searchParams.get('curr')).toBe('')
    expect(url.searchParams.get('hl')).toBe('')
  })
})
