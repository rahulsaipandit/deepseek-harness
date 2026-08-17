/**
 * Renders a {@link FlightSearchResult} as model-facing text.
 * @module dsh-plugin-flight-search/format
 */

import type { FlightItinerary, FlightSearchResult, SimpleDate, SimpleTime } from './provider.ts'

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}

function formatDate(date: SimpleDate | undefined): string {
  if (date === undefined) return 'unknown date'
  return `${date.year.toString()}-${pad2(date.month)}-${pad2(date.day)}`
}

function formatTime(time: SimpleTime | undefined): string {
  if (time === undefined) return 'unknown time'
  return `${pad2(time.hour)}:${pad2(time.minute)}`
}

function formatDuration(minutes: number | undefined): string {
  if (minutes === undefined) return 'unknown duration'
  const hours = Math.floor(minutes / 60)
  const remaining = minutes % 60
  return hours > 0 ? `${hours.toString()}h ${remaining.toString()}m` : `${remaining.toString()}m`
}

function formatItinerary(itinerary: FlightItinerary, index: number, currency: string | undefined): string {
  const lines: string[] = []
  const priceLabel = itinerary.price === undefined
    ? 'price unavailable'
    : currency !== undefined && currency.length > 0 ? `${currency} ${itinerary.price.toString()}` : itinerary.price.toString()
  const header = [`${(index + 1).toString()}. ${priceLabel}`]
  if (itinerary.airlines.length > 0) header.push(`— ${itinerary.airlines.join(', ')}`)
  if (itinerary.type !== undefined && itinerary.type.length > 0) header.push(`(${itinerary.type})`)
  lines.push(header.join(' '))

  for (const leg of itinerary.legs) {
    const from = leg.fromAirportCode ?? '???'
    const to = leg.toAirportCode ?? '???'
    lines.push(
      `   ${from} ${formatDate(leg.departureDate)} ${formatTime(leg.departureTime)}`
      + ` → ${to} ${formatDate(leg.arrivalDate)} ${formatTime(leg.arrivalTime)}`
      + ` (${formatDuration(leg.durationMinutes)}${leg.planeType !== undefined ? `, ${leg.planeType}` : ''})`,
    )
  }

  if (itinerary.carbon?.emissionGrams !== undefined) {
    const kg = (itinerary.carbon.emissionGrams / 1000).toFixed(1)
    const typicalNote = itinerary.carbon.typicalOnRouteGrams !== undefined
      ? ` (typical for this route: ${(itinerary.carbon.typicalOnRouteGrams / 1000).toFixed(1)} kg)`
      : ''
    lines.push(`   Estimated emissions: ${kg} kg CO₂e${typicalNote}`)
  }

  return lines.join('\n')
}

/** Render a full search result as model-facing text. */
export function formatFlightSearchOutput(result: FlightSearchResult, currency: string | undefined): string {
  if (result.itineraries.length === 0) {
    return 'No flights found for this search. Try widening the dates or removing filters.'
  }
  const parts = result.itineraries.map((itinerary, index) => formatItinerary(itinerary, index, currency))
  if (result.truncated) {
    parts.push(`(Showing the first ${result.itineraries.length} itineraries. Narrow the search for a more specific set.)`)
  }
  parts.push(
    'This data is scraped from Google Flights’ own search page (no official API exists) and prices/availability '
    + 'can change or be temporarily unreachable — confirm on the airline or an OTA before booking.',
  )
  return parts.join('\n\n')
}
