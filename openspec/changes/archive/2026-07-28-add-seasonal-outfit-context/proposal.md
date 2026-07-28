# Change: Add city temperature data to the outfit Agent

## Why

The first server implementation starts the Appearance Agent without trustworthy local temperature context. It can therefore recommend clothing that is inconsistent with the user's city, season, current temperature, or near-term forecast.

## What Changes

- Accept a client-supplied `province` and `city` as the only location input for this first version.
- Use the injected server clock as the trusted current-time source and resolve the city's IANA time zone through the weather provider.
- Add one typed weather provider, initially implemented with Open-Meteo:
  - resolve province/city to one canonical weather location;
  - fetch the rolling previous 36 months of daily temperature;
  - fetch current/apparent temperature and the next 7–15 days of minimum/maximum temperatures.
- Save historical temperature locally as a schema-versioned JSON file per province/city. Refresh it when missing or stale.
- Fetch current and future temperature through the API when starting an Agent recommendation.
- Build one bounded weather context containing a 12-month historical summary plus live/forecast data and inject it as structured system-prompt context.
- Keep raw daily history out of the model prompt.

## Impact

- Affected specs: new capability `contextual-outfit-recommendation`.
- Affected code: questionnaire/profile location input, weather provider/client, local JSON storage, history summarization, and Appearance Agent prompt construction/startup.
- Runtime data: `data/weather-history/` contains generated JSON cache files and remains outside version-controlled source.
- Privacy: no GPS or IP geolocation in this version; only client-supplied province/city is used.
