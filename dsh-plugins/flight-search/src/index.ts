/**
 * `flight_search`: a model-facing DSH tool that answers a natural-language
 * flight-price ask by scraping Google Flights' own search page (no official
 * API exists — see the plugin README for the full design rationale and
 * disclosed trust/limitations). The model itself extracts origin/destination
 * airport codes, dates, and preferences from free text and calls this tool
 * with structured arguments — the same division of labor this repo's own
 * `web_search`/`read` tools use.
 *
 * @module dsh-plugin-flight-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { formatFlightSearchOutput } from './format.ts'
import { fetchFlightSearchHtml, FlightsNotFoundError, parseFlightSearchHtml } from './provider.ts'
import type { FlightSearchQuery, SeatClass, TripType } from './query.ts'

/** Plugin config: search caps and defaults. */
export interface Config {
  /** Upper bound on itineraries returned by one call. Defaults to 10. */
  maxResults?: number
  /** Cooperative fetch timeout (ms). Defaults to 15000. */
  timeoutMs?: number
  /** ISO 4217 currency used when the model doesn't specify one. Blank lets Google decide. */
  defaultCurrency?: string
  /** BCP-47 language used when the model doesn't specify one. Blank lets Google decide. */
  defaultLanguage?: string
}

export const Config: z<Config> = z.object({
  maxResults: z.number().default(10),
  timeoutMs: z.number().default(15_000),
  defaultCurrency: z.string().default(''),
  defaultLanguage: z.string().default(''),
})

type ResolvedConfig = Required<Config>

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`flight-search: ${name} must be a positive integer`)
  }
}

const SEAT_CLASSES = ['economy', 'premium-economy', 'business', 'first'] as const satisfies readonly SeatClass[]

interface FlightSearchArgs {
  origin: string
  destination: string
  departDate: string
  returnDate?: string
  seatClass?: string
  adults?: number
  children?: number
  maxStops?: number
  currency?: string
  language?: string
}

function buildQuery(args: FlightSearchArgs, resolved: ResolvedConfig): FlightSearchQuery {
  const trip: TripType = args.returnDate !== undefined ? 'round-trip' : 'one-way'
  return {
    legs: [{
      date: args.departDate,
      fromAirport: args.origin,
      toAirport: args.destination,
      ...args.maxStops !== undefined ? { maxStops: args.maxStops } : {},
    }],
    seat: (args.seatClass ?? 'economy') as SeatClass,
    trip,
    passengers: {
      adults: args.adults ?? 1,
      ...args.children !== undefined ? { children: args.children } : {},
    },
    language: args.language ?? resolved.defaultLanguage,
    currency: args.currency ?? resolved.defaultCurrency,
  }
}

/** `SimpleDate`/`SimpleTime`-shaped object schema, shared by departure and arrival fields. */
const DATE_FIELD = {
  type: 'object',
  additionalProperties: false,
  properties: {
    year: { type: 'number', required: true },
    month: { type: 'number', required: true },
    day: { type: 'number', required: true },
  },
} as const

const TIME_FIELD = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hour: { type: 'number', required: true },
    minute: { type: 'number', required: true },
  },
} as const

/** Register the `flight_search` tool. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxResults', resolved.maxResults)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)

  ctx.tools.register(defineTool({
    name: 'flight_search',
    description: 'Search Google Flights for one-way or round-trip itineraries between two airports on given dates. '
      + 'Provide 3-letter IATA airport codes for origin/destination — if the user names a city rather than an '
      + 'airport, pick that city\'s primary commercial airport code yourself. Unofficial data source (Google '
      + 'Flights\' own search results, not a sanctioned API): prices/availability can change or the search can '
      + 'occasionally fail — tell the user to confirm on the airline or an OTA before booking.',
    parameters: {
      origin: { type: 'string', required: true, description: '3-letter IATA origin airport code, e.g. "JFK".' },
      destination: { type: 'string', required: true, description: '3-letter IATA destination airport code, e.g. "LAX".' },
      departDate: { type: 'string', required: true, description: 'Departure date, YYYY-MM-DD.' },
      returnDate: { type: 'string', description: 'Return date, YYYY-MM-DD. Omit for a one-way search.' },
      seatClass: { type: 'string', enum: SEAT_CLASSES, description: 'Cabin class. Defaults to economy.' },
      adults: { type: 'number', description: 'Adult passenger count. Defaults to 1.' },
      children: { type: 'number', description: 'Child passenger count. Defaults to 0.' },
      maxStops: { type: 'number', description: 'Maximum stops per leg, if the user asked for nonstop (0) or limited connections.' },
      currency: { type: 'string', description: 'ISO 4217 currency code, e.g. "USD". Defaults to the deployment default.' },
      language: { type: 'string', description: 'BCP-47 language tag, e.g. "en". Defaults to the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          truncated: { type: 'boolean', required: true },
          itineraries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                price: { type: 'number' },
                type: { type: 'string' },
                airlines: { type: 'array', required: true, items: { type: 'string' } },
                legs: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      fromAirportCode: { type: 'string' },
                      fromAirportName: { type: 'string' },
                      toAirportCode: { type: 'string' },
                      toAirportName: { type: 'string' },
                      departureDate: DATE_FIELD,
                      departureTime: TIME_FIELD,
                      arrivalDate: DATE_FIELD,
                      arrivalTime: TIME_FIELD,
                      durationMinutes: { type: 'number' },
                      planeType: { type: 'string' },
                    },
                  },
                },
                carbon: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    emissionGrams: { type: 'number' },
                    typicalOnRouteGrams: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => [{
        type: 'text',
        text: formatFlightSearchOutput(value, args.currency ?? resolved.defaultCurrency),
      }],
    },
    timeoutMs: resolved.timeoutMs,
    // A read-only external search; safe to run alongside sibling tool calls.
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = buildQuery(args, resolved)
      try {
        const html = await fetchFlightSearchHtml(query, { timeoutMs: resolved.timeoutMs })
        return parseFlightSearchHtml(html, resolved.maxResults)
      } catch (error: unknown) {
        if (error instanceof FlightsNotFoundError) return { itineraries: [], truncated: false }
        throw error
      }
    },
  }))
}
