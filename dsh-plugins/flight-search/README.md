# dsh-plugin-flight-search

A DeepSeek Harness (DSH) plugin that registers one model-facing tool,
`flight_search`, so a natural-language ask like *"find me a cheap one-way
economy flight from JFK to LAX on 2026-09-01"* gets turned into a real
flight-price lookup. The model itself extracts the structured fields
(airport codes, dates, cabin class, passenger counts) from the user's free
text and calls the tool — there is no separate NL-parsing layer in this
plugin.

Ported from [AWeirdDev/flights](https://github.com/AWeirdDev/flights)
("fast-flights", Python, MIT) into native TypeScript. See
[`docs/adr/rp_dshPlugins.md`](../../docs/adr/rp_dshPlugins.md) in the parent
repo for the full design rationale, the field-by-field mapping from upstream,
and why this lives in an isolated `dsh-plugins/` folder rather than
`packages/`.

## Why this exists / how it works

No official Google Flights API exists (Google retired it in 2018). This
plugin, like its upstream, gets flight data by:

1. Encoding the search as a Base64 Protobuf message (the `tfs` query
   parameter Google Flights' own web frontend uses) — see `src/pb.ts` (a
   minimal hand-written protobuf writer, no `protobufjs` dependency) and
   `src/query.ts` (the message field mapping).
2. Fetching `https://www.google.com/travel/flights/search?tfs=...` with a
   plain `fetch()` and a realistic browser `User-Agent` — see
   `src/provider.ts`.
3. Extracting and walking Google's own internal, undocumented
   `AF_initDataCallback` hydration payload out of the response HTML — the
   same technique upstream's `parser.py` uses, ported index-for-index with
   defensive guards at every access.

## Trust and limitations (read before enabling)

- **This is unofficial scraping of an undocumented internal payload, not a
  sanctioned API.** The array-index layout in `AF_initDataCallback` can
  change without notice; when it does, this plugin fails closed (a clear
  `FlightSearchParseError` tool error) rather than return corrupted
  itineraries.
- **We deliberately do not replicate upstream's TLS-fingerprint
  impersonation.** `fast-flights` uses `primp` to impersonate a real Chrome
  browser at the TLS/HTTP level specifically to reduce the odds of being
  blocked as automated traffic. This plugin uses a plain `fetch()` with only
  a `User-Agent` header — more likely to be rate-limited by Google over
  time, which we accept as an honest limitation rather than building
  detection-evasion into the harness.
- **Respect Google's Terms of Service and rate limits.** Built for personal,
  low-volume, read-only price lookups driven by a single user's request —
  not for bulk/automated scraping.
- Prices/availability can change between this lookup and booking; the tool's
  own output reminds the model to tell the user to confirm before booking.

## Config

```ts
interface Config {
  /** Upper bound on itineraries returned by one call. Defaults to 10. */
  maxResults?: number
  /** Cooperative fetch timeout (ms). Defaults to 15000. */
  timeoutMs?: number
  /** ISO 4217 currency used when the model doesn't specify one. Blank lets Google decide. */
  defaultCurrency?: string
  /** BCP-47 language used when the model doesn't specify one. Blank lets Google decide. */
  defaultLanguage?: string
}
```

## The `flight_search` tool

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `origin` | string | yes | 3-letter IATA code. The model maps a named city to its primary airport itself. |
| `destination` | string | yes | Same as `origin`. |
| `departDate` | string | yes | `YYYY-MM-DD`. |
| `returnDate` | string | no | `YYYY-MM-DD`. Omit for a one-way search. |
| `seatClass` | `economy` \| `premium-economy` \| `business` \| `first` | no | Defaults to `economy`. |
| `adults` | number | no | Defaults to 1. |
| `children` | number | no | Defaults to 0. |
| `maxStops` | number | no | e.g. `0` for nonstop only. |
| `currency` | string | no | ISO 4217, e.g. `USD`. |
| `language` | string | no | BCP-47, e.g. `en`. |

Output is a list of itineraries (price, operating airline(s), per-leg
departure/arrival airport + date/time, duration, aircraft type, and an
estimated CO₂e emission), rendered as text for the model and available
structured for a UI to build a richer card from later.

## Development

```sh
npm install
npm test    # vitest — pb encoding, query building/validation, and parser
            # tests all run against a synthetic fixture; no live network call
            # is made in tests
npm run build
```
