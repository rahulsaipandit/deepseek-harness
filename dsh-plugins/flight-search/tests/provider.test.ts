import { describe, expect, it } from 'vitest'
import { FlightSearchParseError, FlightsNotFoundError, parseFlightSearchHtml } from '../src/provider.ts'

/**
 * Builds a synthetic fixture matching the undocumented `AF_initDataCallback`
 * shape our parser walks by index (see provider.ts). This is hand-built from
 * the documented index mapping, not captured from a live Google response —
 * we never fetch the real service in tests.
 */
function buildFixtureHtml(): string {
  const leg: unknown[] = []
  leg[3] = 'JFK'
  leg[4] = 'John F. Kennedy International'
  leg[5] = 'Los Angeles International'
  leg[6] = 'LAX'
  leg[8] = [9, 30]
  leg[20] = [2026, 9, 1]
  leg[10] = [12, 45]
  leg[21] = [2026, 9, 1]
  leg[11] = 375
  leg[17] = 'Boeing 737'

  const extras: unknown[] = []
  extras[7] = 95_000
  extras[8] = 110_000

  const flight: unknown[] = []
  flight[0] = 'Nonstop'
  flight[1] = ['Delta']
  flight[2] = [leg]
  flight[22] = extras

  const entry = [flight, [[0, 299]]]

  const payload: unknown[] = []
  payload[3] = [[entry]]
  payload[7] = [undefined, [[['SA', 'SkyTeam Alliance']], [['DL', 'Delta Air Lines']]]]

  const json = JSON.stringify(payload)
  return `<html><body><script class="ds:1">AF_initDataCallback({key: 'ds:1', data:${json}, sideChannel: {}});</script></body></html>`
}

describe('parseFlightSearchHtml', () => {
  it('parses a well-formed fixture into one itinerary', () => {
    const result = parseFlightSearchHtml(buildFixtureHtml(), 10)
    expect(result.truncated).toBe(false)
    expect(result.itineraries).toHaveLength(1)
    const [itinerary] = result.itineraries
    expect(itinerary?.price).toBe(299)
    expect(itinerary?.type).toBe('Nonstop')
    expect(itinerary?.airlines).toEqual(['Delta'])
    expect(itinerary?.carbon).toEqual({ emissionGrams: 95_000, typicalOnRouteGrams: 110_000 })

    const [leg] = itinerary?.legs ?? []
    expect(leg?.fromAirportCode).toBe('JFK')
    expect(leg?.fromAirportName).toBe('John F. Kennedy International')
    expect(leg?.toAirportCode).toBe('LAX')
    expect(leg?.toAirportName).toBe('Los Angeles International')
    expect(leg?.departureDate).toEqual({ year: 2026, month: 9, day: 1 })
    expect(leg?.departureTime).toEqual({ hour: 9, minute: 30 })
    expect(leg?.arrivalTime).toEqual({ hour: 12, minute: 45 })
    expect(leg?.durationMinutes).toBe(375)
    expect(leg?.planeType).toBe('Boeing 737')
  })

  it('caps results at maxResults and reports truncation', () => {
    const html = buildFixtureHtml()
    const result = parseFlightSearchHtml(html, 0)
    expect(result.itineraries).toHaveLength(0)
    expect(result.truncated).toBe(true)
  })

  it('throws FlightSearchParseError when the ds:1 script is missing', () => {
    expect(() => parseFlightSearchHtml('<html><body>no data here</body></html>', 10))
      .toThrow(FlightSearchParseError)
  })

  it('throws FlightsNotFoundError when Google reports an error status', () => {
    const html = '<script class="ds:1">AF_initDataCallback({key: \'ds:1\', data: null, errorHasStatus: true});</script>'
    expect(() => parseFlightSearchHtml(html, 10)).toThrow(FlightsNotFoundError)
  })

  it('throws FlightSearchParseError on malformed JSON in the data payload', () => {
    const html = '<script class="ds:1">AF_initDataCallback({key: \'ds:1\', data: {not valid json, sideChannel: {}});</script>'
    expect(() => parseFlightSearchHtml(html, 10)).toThrow(FlightSearchParseError)
  })

  it('returns an empty result (not a throw) when the entry list is absent', () => {
    const payload: unknown[] = []
    payload[3] = [null]
    payload[7] = [undefined, [[], []]]
    const json = JSON.stringify(payload)
    const html = `<script class="ds:1">AF_initDataCallback({key: 'ds:1', data:${json}, sideChannel: {}});</script>`
    const result = parseFlightSearchHtml(html, 10)
    expect(result.itineraries).toEqual([])
    expect(result.truncated).toBe(false)
  })
})
