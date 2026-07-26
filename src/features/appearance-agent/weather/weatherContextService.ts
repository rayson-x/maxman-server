import type {
  AgentWeatherContext,
  CityInput,
  HistoricalTemperatureDay,
  HistoricalTemperatureStore,
  HistoricalWeatherContext,
  LocalDateRange,
  WeatherContextService,
  WeatherProvider,
} from "./types.js";

type WeatherContextServiceOptions = {
  provider: WeatherProvider;
  historyStore: HistoricalTemperatureStore;
  now?: () => Date;
  forecastDays: 7 | 10 | 15;
};

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
};

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function formatLocalDate(parts: LocalDateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function datePartsFromUtcDate(date: Date): LocalDateParts {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function addDays(parts: LocalDateParts, days: number): LocalDateParts {
  return datePartsFromUtcDate(
    new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days)),
  );
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localDateParts(now: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  if (!year || !month || !day) {
    throw new Error("Could not calculate local date for weather location");
  }
  return { year, month, day };
}

export function rollingThreeYearRange(
  now: Date,
  timeZone: string,
): LocalDateRange {
  const end = addDays(localDateParts(now, timeZone), -1);
  const startYear = end.year - 3;
  const sameCalendarDayThreeYearsEarlier = {
    year: startYear,
    month: end.month,
    day: Math.min(end.day, daysInMonth(startYear, end.month)),
  };
  const start = addDays(sameCalendarDayThreeYearsEarlier, 1);
  return {
    startDate: formatLocalDate(start),
    endDate: formatLocalDate(end),
  };
}

function inclusiveDateCount(range: LocalDateRange): number {
  const start = Date.parse(`${range.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${range.endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Invalid historical weather date range");
  }
  return Math.floor((end - start) / (24 * 60 * 60 * 1_000)) + 1;
}

export function summarizeHistoricalTemperature(
  daily: HistoricalTemperatureDay[],
  range: LocalDateRange,
): HistoricalWeatherContext {
  const groups = new Map<
    number,
    {
      minTotal: number;
      meanTotal: number;
      maxTotal: number;
      sampleDays: number;
    }
  >();
  const coveredDates = new Set<string>();
  for (const day of daily) {
    if (day.date < range.startDate || day.date > range.endDate) {
      continue;
    }
    const month = Number(day.date.slice(5, 7));
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      continue;
    }
    const group = groups.get(month) ?? {
      minTotal: 0,
      meanTotal: 0,
      maxTotal: 0,
      sampleDays: 0,
    };
    group.minTotal += day.tempMinC;
    group.meanTotal += day.tempMeanC;
    group.maxTotal += day.tempMaxC;
    group.sampleDays += 1;
    groups.set(month, group);
    coveredDates.add(day.date);
  }

  return {
    periodStart: range.startDate,
    periodEnd: range.endDate,
    coverageRatio: roundOneDecimal(
      Math.min(1, coveredDates.size / inclusiveDateCount(range)),
    ),
    months: [...groups.entries()]
      .sort(([left], [right]) => left - right)
      .slice(0, 12)
      .map(([month, group]) => ({
        month,
        typicalLowC: roundOneDecimal(group.minTotal / group.sampleDays),
        typicalMeanC: roundOneDecimal(group.meanTotal / group.sampleDays),
        typicalHighC: roundOneDecimal(group.maxTotal / group.sampleDays),
        sampleDays: group.sampleDays,
      })),
  };
}

function uniqueSources(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function hasCompleteForecast(
  daily: AgentWeatherContext["live"]["daily"],
  forecastDays: 7 | 10 | 15,
  asOf: Date,
  timeZone: string,
): boolean {
  if (daily.length !== forecastDays) {
    return false;
  }
  const firstDay = localDateParts(asOf, timeZone);
  return daily.every(
    (day, index) => day.date === formatLocalDate(addDays(firstDay, index)),
  );
}

export function createWeatherContextService(
  options: WeatherContextServiceOptions,
): WeatherContextService {
  const now = options.now ?? (() => new Date());

  return {
    async build(input: CityInput): Promise<AgentWeatherContext> {
      const asOfDate = now();
      const location = await options.provider.resolveCity(input);
      const range = rollingThreeYearRange(asOfDate, location.timeZone);
      const providerSource = options.provider.source ?? "open-meteo";
      const [historyResult, liveResult] = await Promise.allSettled([
        options.historyStore.loadOrRefresh({
          input,
          location,
          range,
          source: providerSource,
          fetchDaily: () =>
            options.provider.getHistoricalDaily(location, range),
        }),
        options.provider.getCurrentAndForecast(
          location,
          options.forecastDays,
        ),
      ]);

      const historical =
        historyResult.status === "fulfilled"
          ? summarizeHistoricalTemperature(
              historyResult.value.daily,
              historyResult.value.range,
            )
          : null;
      const live =
        liveResult.status === "fulfilled"
          ? {
              status:
                liveResult.value.currentTempC !== null &&
                liveResult.value.apparentTempC !== null &&
                liveResult.value.observedAt !== null &&
                hasCompleteForecast(
                  liveResult.value.daily,
                  options.forecastDays,
                  asOfDate,
                  location.timeZone,
                )
                  ? ("fresh" as const)
                  : ("partial" as const),
              observedAt: liveResult.value.observedAt,
              currentTempC: liveResult.value.currentTempC,
              apparentTempC: liveResult.value.apparentTempC,
              daily: liveResult.value.daily,
            }
          : {
              status: "unavailable" as const,
              observedAt: null,
              currentTempC: null,
              apparentTempC: null,
              daily: [],
            };

      return {
        schemaVersion: 1,
        asOf: asOfDate.toISOString(),
        province: location.province,
        city: location.city,
        timeZone: location.timeZone,
        historical,
        live,
        sources: uniqueSources([
          historyResult.status === "fulfilled"
            ? historyResult.value.source
            : null,
          liveResult.status === "fulfilled" ? liveResult.value.source : null,
        ]),
      };
    },
  };
}
