/**
 * Builds the Base64-encoded `tfs` Protobuf query Google Flights' search page
 * reads, field-for-field matching the schema
 * https://github.com/AWeirdDev/flights reverse-engineered
 * (`fast_flights/pb/flights.proto`). Field numbers below are copied directly
 * from that `.proto` — they are Google's wire contract, not ours to choose.
 *
 * @module dsh-plugin-flight-search/query
 */

import { PbWriter } from './pb.ts'

/** `enum Seat` (flights.proto) — UNKNOWN_SEAT=0 is never emitted; every query picks a real class. */
const SEAT_ENUM = { economy: 1, 'premium-economy': 2, business: 3, first: 4 } as const

/** `enum Trip` (flights.proto). `multi-city` is accepted for parity with upstream but not implemented end-to-end here (single/round trip only — see README). */
const TRIP_ENUM = { 'round-trip': 1, 'one-way': 2, 'multi-city': 3 } as const

/** `enum Emissions` (flights.proto). */
const EMISSIONS_LESS = 1

export type SeatClass = keyof typeof SEAT_ENUM
export type TripType = keyof typeof TRIP_ENUM

/** One leg of the itinerary — one `FlightData` message. */
export interface FlightLeg {
  /** `YYYY-MM-DD`. */
  date: string
  fromAirport: string
  toAirport: string
  maxStops?: number
  airlines?: readonly string[]
  earliestDepartureHour?: number
  latestDepartureHour?: number
  earliestArrivalHour?: number
  latestArrivalHour?: number
  maxDurationMinutes?: number
  connectingAirports?: readonly string[]
  minLayoverMinutes?: number
  maxLayoverMinutes?: number
  lessEmissionsOnly?: boolean
}

export interface PassengerCounts {
  adults?: number
  children?: number
  infantsInSeat?: number
  infantsOnLap?: number
}

export interface FlightSearchQuery {
  legs: readonly FlightLeg[]
  seat: SeatClass
  trip: TripType
  passengers?: PassengerCounts
  /** BCP-47 language tag, e.g. `en`. Blank lets Google decide. */
  language?: string
  /** ISO 4217 currency code, e.g. `USD`. Blank lets Google decide. */
  currency?: string
  maxPrice?: number
  carryOnBags?: number
  checkedBags?: number
  hideSeparateAndSelfTransfer?: boolean
  excludeBasicEconomy?: boolean
}

function assertAirportCode(code: string, label: string): void {
  if (!/^[A-Za-z]{3}$/.test(code)) {
    throw new Error(`flight-search: ${label} must be a 3-letter IATA airport code, got ${JSON.stringify(code)}`)
  }
}

function assertIsoDate(date: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`flight-search: ${label} must be YYYY-MM-DD, got ${JSON.stringify(date)}`)
  }
}

/** `message Airport { string airport = 2; }` */
function airportMessage(code: string): PbWriter {
  return new PbWriter().stringField(2, code.toUpperCase())
}

/** `message FlightData { ... }` — field numbers per flights.proto. */
function flightDataMessage(leg: FlightLeg): PbWriter {
  assertIsoDate(leg.date, 'date')
  assertAirportCode(leg.fromAirport, 'fromAirport')
  assertAirportCode(leg.toAirport, 'toAirport')
  return new PbWriter()
    .stringField(2, leg.date)
    .varintField(5, leg.maxStops)
    .repeatedStringField(6, leg.airlines)
    .varintField(8, leg.earliestDepartureHour)
    .varintField(9, leg.latestDepartureHour)
    .varintField(10, leg.earliestArrivalHour)
    .varintField(11, leg.latestArrivalHour)
    .varintField(12, leg.maxDurationMinutes)
    .messageField(13, airportMessage(leg.fromAirport))
    .messageField(14, airportMessage(leg.toAirport))
    .repeatedStringField(15, leg.connectingAirports)
    .varintField(17, leg.minLayoverMinutes)
    .varintField(18, leg.maxLayoverMinutes)
    .packedVarintField(19, leg.lessEmissionsOnly === true ? [EMISSIONS_LESS] : undefined)
}

/** `message Baggage { optional int32 carry_on_bags = 2; optional int32 checked_bags = 3; }` */
function baggageMessage(carryOnBags: number, checkedBags: number): PbWriter | undefined {
  if (carryOnBags === 0 && checkedBags === 0) return undefined
  return new PbWriter()
    .varintField(2, carryOnBags || undefined)
    .varintField(3, checkedBags || undefined)
}

function passengerList(passengers: PassengerCounts): number[] {
  const adults = passengers.adults ?? 1
  const children = passengers.children ?? 0
  const infantsInSeat = passengers.infantsInSeat ?? 0
  const infantsOnLap = passengers.infantsOnLap ?? 0
  const total = adults + children + infantsInSeat + infantsOnLap
  if (total > 9) throw new Error('flight-search: too many passengers (> 9)')
  if (infantsOnLap > adults) throw new Error('flight-search: must have at least one adult per infant on lap')
  const ADULT = 1, CHILD = 2, INFANT_IN_SEAT = 3, INFANT_ON_LAP = 4
  return [
    ...Array<number>(adults).fill(ADULT),
    ...Array<number>(children).fill(CHILD),
    ...Array<number>(infantsInSeat).fill(INFANT_IN_SEAT),
    ...Array<number>(infantsOnLap).fill(INFANT_ON_LAP),
  ]
}

/** Build the `Info` message and return it Base64-encoded, ready for the `tfs` query parameter. */
export function encodeFlightSearchQuery(query: FlightSearchQuery): string {
  if (query.legs.length === 0) throw new Error('flight-search: at least one flight leg is required')
  const carryOnBags = query.carryOnBags ?? 0
  const checkedBags = query.checkedBags ?? 0
  const info = new PbWriter()
  for (const leg of query.legs) info.messageField(3, flightDataMessage(leg))
  info
    .packedVarintField(8, passengerList(query.passengers ?? {}))
    .varintField(9, SEAT_ENUM[query.seat])
    .varintField(12, query.maxPrice)
    .messageField(13, baggageMessage(carryOnBags, checkedBags))
    .varintField(17, query.hideSeparateAndSelfTransfer === true ? true : undefined)
    .varintField(19, TRIP_ENUM[query.trip])
    .varintField(25, query.excludeBasicEconomy === true ? true : undefined)
  return Buffer.from(info.finish()).toString('base64')
}

/** Build the full Google Flights search URL for one query. */
export function flightSearchUrl(query: FlightSearchQuery): URL {
  const url = new URL('https://www.google.com/travel/flights/search')
  url.searchParams.set('tfs', encodeFlightSearchQuery(query))
  url.searchParams.set('hl', query.language ?? '')
  url.searchParams.set('curr', query.currency ?? '')
  return url
}
