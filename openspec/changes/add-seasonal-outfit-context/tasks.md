## 1. Contracts and Configuration

- [x] 1.1 Add typed city input, resolved location, historical day/file, live forecast, monthly summary, and Agent weather-context contracts.
- [x] 1.2 Add validated weather hosts, optional API credential, forecast horizon, history directory, refresh age, timeout, and response-size configuration.
- [x] 1.3 Extend the relevant questionnaire/profile input with bounded `province` and `city`.

## 2. Weather Provider

- [x] 2.1 Add provider contract tests for exact province/city matching, ambiguity, historical daily parsing, current/apparent temperature, 7–15-day forecast, malformed data, timeout, and oversized responses.
- [x] 2.2 Implement the Open-Meteo provider with fixed/allowlisted HTTPS hosts, runtime schemas, bounded fetches, and business-only outputs.

## 3. Local Historical JSON

- [x] 3.1 Add store tests for deterministic safe filenames, valid cache hits, stale/incomplete cache refresh, corrupt JSON recovery, atomic writes, and concurrent callers.
- [x] 3.2 Implement rolling-36-month date calculation and the schema-versioned atomic JSON store under the configured runtime data directory.
- [x] 3.3 Add deterministic summary tests and implement the bounded 12-month historical temperature summary.

## 4. Live Context and Agent Startup

- [x] 4.1 Add context-service tests for complete data, missing history, missing live weather, and city-resolution failure.
- [x] 4.2 Implement `WeatherContextService` to load/refresh history, fetch live/forecast data, and return one bounded context.
- [x] 4.3 Add prompt tests proving both data blocks and server `asOf` are injected per run while raw daily history/provider payloads and executable location instructions are absent.
- [x] 4.4 Inject the structured weather block into Appearance Agent system instructions for the corresponding run without mutating singleton/global instructions.

## 5. Validation

- [x] 5.1 Run typecheck, focused tests, full tests, build/start smoke tests, and `openspec validate add-seasonal-outfit-context --strict`.
- [x] 5.2 Update README environment/runtime-data documentation and clearly label Open-Meteo evaluation versus production endpoint/license requirements.
