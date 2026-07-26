import { z } from "zod";

import type {
  CityInput,
  HistoricalTemperatureDay,
  LiveTemperatureSnapshot,
  LocalDateRange,
  ResolvedWeatherLocation,
  WeatherProvider,
} from "./types.js";

const DEFAULT_GEOCODING_ORIGIN = "https://geocoding-api.open-meteo.com";
const DEFAULT_ARCHIVE_ORIGIN = "https://archive-api.open-meteo.com";
const DEFAULT_FORECAST_ORIGIN = "https://api.open-meteo.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type OpenMeteoWeatherProviderOptions = {
  fetchImpl?: FetchLike;
  geocodingOrigin?: string;
  archiveOrigin?: string;
  forecastOrigin?: string;
  allowedOrigins?: string[];
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  apiKey?: string;
};

type WeatherLocationErrorCode =
  | "INVALID_LOCATION"
  | "LOCATION_NOT_FOUND"
  | "LOCATION_AMBIGUOUS";

export class WeatherLocationError extends Error {
  readonly code: WeatherLocationErrorCode;

  constructor(code: WeatherLocationErrorCode, message: string) {
    super(message);
    this.name = "WeatherLocationError";
    this.code = code;
  }
}

const geocodingResponseSchema = z.object({
  results: z
    .array(
      z.object({
        id: z.union([z.string(), z.number()]),
        name: z.string().min(1).max(120),
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
        timezone: z.string().min(1).max(120),
        country_code: z.string().length(2).optional(),
        admin1: z.string().min(1).max(120).optional(),
      }),
    )
    .max(100)
    .optional(),
});

const temperatureSchema = z.number().finite().min(-100).max(70);
const nullableTemperatureSchema = temperatureSchema.nullable();
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const historicalResponseSchema = z.object({
  daily: z.object({
    time: z.array(localDateSchema).max(1_500),
    temperature_2m_min: z.array(nullableTemperatureSchema).max(1_500),
    temperature_2m_mean: z.array(nullableTemperatureSchema).max(1_500),
    temperature_2m_max: z.array(nullableTemperatureSchema).max(1_500),
  }),
});

const liveResponseSchema = z.object({
  current: z
    .object({
      time: z.string().min(1).max(64),
      temperature_2m: nullableTemperatureSchema.optional(),
      apparent_temperature: nullableTemperatureSchema.optional(),
    })
    .optional(),
  daily: z.object({
    time: z.array(localDateSchema).min(1).max(15),
    temperature_2m_min: z.array(nullableTemperatureSchema).max(15),
    temperature_2m_max: z.array(nullableTemperatureSchema).max(15),
  }),
});

function normalizeLocationPart(
  value: string,
  kind: "province" | "city",
): string {
  const trimmed = value.normalize("NFKC").trim().replace(/\s+/gu, "");
  if (trimmed.length === 0 || trimmed.length > 80) {
    throw new WeatherLocationError(
      "INVALID_LOCATION",
      `${kind} must contain between 1 and 80 characters`,
    );
  }

  const provinceSuffix =
    /(?:壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u;
  const citySuffix = /(?:自治州|地区|市|县|区|盟)$/u;
  return trimmed.replace(kind === "province" ? provinceSuffix : citySuffix, "");
}

function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
  } catch {
    throw new Error("Weather provider returned an invalid IANA time zone");
  }
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("Weather API origins must be credential-free HTTPS origins");
  }
  return url.origin;
}

function assertParallelArrays(
  label: string,
  arrays: ReadonlyArray<readonly unknown[]>,
): void {
  const expectedLength = arrays[0]?.length ?? 0;
  if (arrays.some((values) => values.length !== expectedLength)) {
    throw new Error(`${label} contains mismatched parallel arrays`);
  }
}

function requireTemperature(
  value: number | null,
  field: string,
  date: string,
): number {
  if (value === null) {
    throw new Error(`${field} is missing for ${date}`);
  }
  return value;
}

export function createOpenMeteoWeatherProvider(
  options: OpenMeteoWeatherProviderOptions = {},
): WeatherProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const geocodingOrigin = normalizeOrigin(
    options.geocodingOrigin ?? DEFAULT_GEOCODING_ORIGIN,
  );
  const archiveOrigin = normalizeOrigin(
    options.archiveOrigin ?? DEFAULT_ARCHIVE_ORIGIN,
  );
  const forecastOrigin = normalizeOrigin(
    options.forecastOrigin ?? DEFAULT_FORECAST_ORIGIN,
  );
  const allowedOrigins = new Set(
    (
      options.allowedOrigins ?? [
        DEFAULT_GEOCODING_ORIGIN,
        DEFAULT_ARCHIVE_ORIGIN,
        DEFAULT_FORECAST_ORIGIN,
      ]
    ).map(normalizeOrigin),
  );
  for (const origin of [geocodingOrigin, archiveOrigin, forecastOrigin]) {
    if (!allowedOrigins.has(origin)) {
      throw new Error(`Weather API origin is not allowlisted: ${origin}`);
    }
  }

  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("Weather API timeout must be between 100 and 60000 ms");
  }
  if (
    !Number.isInteger(maxResponseBytes) ||
    maxResponseBytes < 1_024 ||
    maxResponseBytes > 10 * 1024 * 1024
  ) {
    throw new Error("Weather API response limit is outside the safe range");
  }

  const fetchJson = async (url: URL): Promise<unknown> => {
    if (!allowedOrigins.has(url.origin)) {
      throw new Error(`Weather API request origin is not allowlisted: ${url.origin}`);
    }
    if (options.apiKey) {
      url.searchParams.set("apikey", options.apiKey);
    }

    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Weather API returned HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > maxResponseBytes
    ) {
      throw new Error("Weather API response exceeded the size limit");
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
      throw new Error("Weather API response exceeded the size limit");
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Weather API returned invalid JSON");
    }
  };

  return {
    source: "open-meteo",
    async resolveCity(input) {
      const normalizedProvince = normalizeLocationPart(
        input.province,
        "province",
      );
      const normalizedCity = normalizeLocationPart(input.city, "city");
      const url = new URL("/v1/search", geocodingOrigin);
      // GeoNames/Open-Meteo commonly stores Chinese city names without the
      // administrative suffix (e.g. "杭州", not "杭州市").
      url.searchParams.set("name", normalizedCity);
      url.searchParams.set("count", "20");
      url.searchParams.set("language", "zh");
      url.searchParams.set("format", "json");
      url.searchParams.set("countryCode", "CN");

      const parsed = geocodingResponseSchema.parse(await fetchJson(url));
      const matches = (parsed.results ?? []).filter((candidate) => {
        if (candidate.country_code && candidate.country_code !== "CN") {
          return false;
        }
        if (!candidate.admin1) {
          return false;
        }
        return (
          normalizeLocationPart(candidate.name, "city") === normalizedCity &&
          normalizeLocationPart(candidate.admin1, "province") ===
            normalizedProvince
        );
      });
      if (matches.length === 0) {
        throw new WeatherLocationError(
          "LOCATION_NOT_FOUND",
          "No weather location matched both province and city",
        );
      }
      if (matches.length !== 1) {
        throw new WeatherLocationError(
          "LOCATION_AMBIGUOUS",
          "Province and city matched more than one weather location",
        );
      }

      const match = matches[0];
      assertValidTimeZone(match.timezone);
      return {
        providerLocationId: String(match.id),
        province: match.admin1!,
        city: match.name,
        latitude: match.latitude,
        longitude: match.longitude,
        timeZone: match.timezone,
      };
    },

    async getHistoricalDaily(location, range) {
      const url = new URL("/v1/archive", archiveOrigin);
      url.searchParams.set("latitude", String(location.latitude));
      url.searchParams.set("longitude", String(location.longitude));
      url.searchParams.set("start_date", range.startDate);
      url.searchParams.set("end_date", range.endDate);
      url.searchParams.set(
        "daily",
        [
          "temperature_2m_min",
          "temperature_2m_mean",
          "temperature_2m_max",
        ].join(","),
      );
      url.searchParams.set("timezone", location.timeZone);
      url.searchParams.set("temperature_unit", "celsius");

      const parsed = historicalResponseSchema.parse(await fetchJson(url));
      const { daily } = parsed;
      assertParallelArrays("Historical weather response", [
        daily.time,
        daily.temperature_2m_min,
        daily.temperature_2m_mean,
        daily.temperature_2m_max,
      ]);
      return daily.time.map((date, index) => ({
        date,
        tempMinC: requireTemperature(
          daily.temperature_2m_min[index],
          "temperature_2m_min",
          date,
        ),
        tempMeanC: requireTemperature(
          daily.temperature_2m_mean[index],
          "temperature_2m_mean",
          date,
        ),
        tempMaxC: requireTemperature(
          daily.temperature_2m_max[index],
          "temperature_2m_max",
          date,
        ),
      }));
    },

    async getCurrentAndForecast(location, forecastDays) {
      const url = new URL("/v1/forecast", forecastOrigin);
      url.searchParams.set("latitude", String(location.latitude));
      url.searchParams.set("longitude", String(location.longitude));
      url.searchParams.set(
        "current",
        "temperature_2m,apparent_temperature",
      );
      url.searchParams.set(
        "daily",
        "temperature_2m_min,temperature_2m_max",
      );
      url.searchParams.set("timezone", location.timeZone);
      url.searchParams.set("forecast_days", String(forecastDays));
      url.searchParams.set("temperature_unit", "celsius");

      const parsed = liveResponseSchema.parse(await fetchJson(url));
      const { daily } = parsed;
      assertParallelArrays("Forecast weather response", [
        daily.time,
        daily.temperature_2m_min,
        daily.temperature_2m_max,
      ]);

      return {
        source: "open-meteo",
        observedAt: parsed.current?.time ?? null,
        currentTempC: parsed.current?.temperature_2m ?? null,
        apparentTempC: parsed.current?.apparent_temperature ?? null,
        daily: daily.time.map((date, index) => ({
          date,
          tempMinC: requireTemperature(
            daily.temperature_2m_min[index],
            "temperature_2m_min",
            date,
          ),
          tempMaxC: requireTemperature(
            daily.temperature_2m_max[index],
            "temperature_2m_max",
            date,
          ),
        })),
      };
    },
  };
}
