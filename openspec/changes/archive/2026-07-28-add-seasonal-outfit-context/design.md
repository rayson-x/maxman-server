## Context

This first slice focuses only on obtaining reliable temperature data and making it available to the existing Agent. Recommendation sophistication, multiple weather vendors, IP positioning, database weather tables, and predictive modeling are deferred.

## Goals / Non-Goals

### Goals

- Resolve a client-supplied province/city to a canonical city, coordinates, and IANA time zone.
- Keep a reusable local JSON copy of the previous rolling 36 months of daily temperature.
- Fetch current/apparent temperature and a 7–15-day forecast at Agent startup.
- Give both historical and live data to the Agent in a bounded structured system-prompt block.
- Make provider errors, stale data, and prompt contents testable.

### Non-Goals

- IP or GPS positioning.
- A weather database, scheduler, or fleet-wide city prefetch.
- Training/extrapolating a weather prediction model.
- Sending approximately 1,095 raw daily history rows to the Agent.
- Completing the final outfit-ranking/temperature-guard feature in this slice.

## Decisions

### 1. Province and city are the public location contract

The client supplies:

```ts
type CityInput = {
  province: string;
  city: string;
};
```

Both strings are trimmed, length-bounded, normalized, and treated only as location lookup values. The provider's city lookup must match both city and province; an ambiguous or mismatched result is rejected instead of silently choosing the first city with the same name.

The injected server clock supplies the current instant. The provider supplies the resolved city's IANA time zone; the configured server time zone is used only for a disclosed failure fallback.

### 2. One provider interface covers the three required calls

```ts
interface WeatherProvider {
  resolveCity(input: CityInput): Promise<ResolvedWeatherLocation>;
  getHistoricalDaily(
    location: ResolvedWeatherLocation,
    range: LocalDateRange,
  ): Promise<HistoricalTemperatureDay[]>;
  getCurrentAndForecast(
    location: ResolvedWeatherLocation,
    forecastDays: 7 | 10 | 15,
  ): Promise<LiveTemperatureSnapshot>;
}
```

The first adapter uses Open-Meteo city geocoding, Historical Weather, and Forecast APIs. Hosts are fixed/configured allowlisted HTTPS origins; responses have timeouts, size limits, status checks, and runtime schemas. Raw provider responses do not leave the adapter.

### 3. Historical daily temperature is a local JSON cache

Each province/city maps to a deterministic SHA-256 cache key so user input never becomes a filesystem path:

```text
data/weather-history/<sha256(normalizedProvince + "\0" + normalizedCity)>.json
```

The JSON shape is:

```ts
type HistoricalTemperatureFile = {
  schemaVersion: 1;
  location: ResolvedWeatherLocation;
  range: { startDate: string; endDate: string };
  source: string;
  fetchedAt: string;
  daily: Array<{
    date: string;
    tempMinC: number;
    tempMeanC: number;
    tempMaxC: number;
  }>;
};
```

The store validates every read, writes through a temporary sibling file followed by atomic rename, and never serves a corrupt/partial file. A cache is reusable only when it covers the requested rolling 36-month period and satisfies the configured refresh age; otherwise it is replaced from the provider.

Runtime JSON is generated data and is not committed. Tests use a temporary directory rather than the workspace runtime directory.

### 4. The Agent receives summaries, current temperature, and forecast

Before Agent startup, `WeatherContextService`:

1. resolves province/city;
2. loads or refreshes the historical JSON;
3. fetches current/apparent temperature and forecast;
4. summarizes history into 12 monthly rows;
5. builds a bounded context block.

```ts
type AgentWeatherContext = {
  asOf: string;
  province: string;
  city: string;
  timeZone: string;
  historical: {
    periodStart: string;
    periodEnd: string;
    coverageRatio: number;
    months: Array<{
      month: number;
      typicalLowC: number;
      typicalMeanC: number;
      typicalHighC: number;
      sampleDays: number;
    }>;
  } | null;
  live: {
    status: "fresh" | "partial" | "unavailable";
    observedAt: string | null;
    currentTempC: number | null;
    apparentTempC: number | null;
    daily: Array<{ date: string; tempMinC: number; tempMaxC: number }>;
  };
  sources: string[];
};
```

The context is serialized with `JSON.stringify` inside fixed delimiters in the dynamic system prompt. Location/provider strings are data, never executable prompt instructions. The fixed instructions say:

- use historical monthly temperature for long-term/seasonal suggestions;
- use current/apparent temperature and forecast for immediate suggestions;
- never describe historical values as a forecast;
- never describe unavailable live values as current;
- state when a data block is unavailable.

The Agent is still constrained to existing product safety and catalog rules. This slice only provides weather context; deterministic temperature filtering is a follow-up.

### 5. Partial failure is visible

- If historical fetch fails and no valid JSON exists, the Agent may still start with `historical: null` and live data.
- If live fetch fails, the Agent may still start with history, but the prompt forbids current-weather claims.
- If city resolution fails, the Agent is not started with fabricated weather context; the caller receives a typed location error.

## Risks / Trade-offs

- Three years is a recent baseline, not a formal climate normal; period and coverage are explicit.
- Open-Meteo public endpoints are suitable for development/non-commercial evaluation. Production must configure an appropriate commercial or self-hosted endpoint/license.
- JSON files are simple but not suitable for a large multi-instance deployment. A shared database/object-store migration is deferred.
- A dynamic system prompt is user-specific, so a singleton Agent must receive the weather block per run rather than mutate global static instructions.

## Acceptance Test Seams

- Provider seam: province/city disambiguation and historical/live response parsing.
- JSON-store seam: safe key, schema validation, coverage/staleness, atomic replacement, and corrupt-file recovery.
- Summary seam: fixed daily rows produce deterministic 12-month bounded summaries.
- Context seam: missing history/live data is represented explicitly.
- Agent seam: the exact dynamic system prompt contains the bounded two-block context and no raw daily history/provider response.
