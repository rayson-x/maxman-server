import assert from "node:assert/strict";
import test from "node:test";

import {
  createWeatherContextService,
  rollingThreeYearRange,
  summarizeHistoricalTemperature,
} from "./weatherContextService.js";
import type {
  HistoricalTemperatureDay,
  HistoricalTemperatureFile,
  ResolvedWeatherLocation,
  WeatherProvider,
} from "./types.js";

const location: ResolvedWeatherLocation = {
  providerLocationId: "1808926",
  province: "浙江省",
  city: "杭州市",
  latitude: 30.2936,
  longitude: 120.1614,
  timeZone: "Asia/Shanghai",
};

const daily: HistoricalTemperatureDay[] = [
  { date: "2024-01-01", tempMinC: 1, tempMeanC: 6, tempMaxC: 11 },
  { date: "2025-01-01", tempMinC: 3, tempMeanC: 8, tempMaxC: 13 },
  { date: "2024-07-01", tempMinC: 25, tempMeanC: 30, tempMaxC: 35 },
  { date: "2025-07-01", tempMinC: 27, tempMeanC: 32, tempMaxC: 37 },
];

test("rolling history range clamps leap day before subtracting three years", () => {
  assert.deepEqual(
    rollingThreeYearRange(
      new Date("2024-03-01T08:00:00.000Z"),
      "Asia/Shanghai",
    ),
    {
      startDate: "2021-03-01",
      endDate: "2024-02-29",
    },
  );
});

test("monthly history summary is deterministic and contains at most 12 rows", () => {
  const summary = summarizeHistoricalTemperature(daily, {
    startDate: "2023-07-26",
    endDate: "2026-07-25",
  });

  assert.deepEqual(summary.months, [
    {
      month: 1,
      typicalLowC: 2,
      typicalMeanC: 7,
      typicalHighC: 12,
      sampleDays: 2,
    },
    {
      month: 7,
      typicalLowC: 26,
      typicalMeanC: 31,
      typicalHighC: 36,
      sampleDays: 2,
    },
  ]);
  assert.equal(summary.months.length <= 12, true);
  assert.equal(summary.periodStart, "2023-07-26");
  assert.equal(summary.periodEnd, "2026-07-25");
});

test("context keeps usable history when the live API fails", async () => {
  const historyFile: HistoricalTemperatureFile = {
    schemaVersion: 1,
    location,
    range: { startDate: "2023-07-26", endDate: "2026-07-25" },
    source: "open-meteo",
    fetchedAt: "2026-07-26T05:00:00.000Z",
    daily,
  };
  const provider: WeatherProvider = {
    resolveCity: async () => location,
    getHistoricalDaily: async () => daily,
    getCurrentAndForecast: async () => {
      throw new Error("forecast timed out");
    },
  };
  const service = createWeatherContextService({
    provider,
    historyStore: {
      loadOrRefresh: async () => historyFile,
    },
    now: () => new Date("2026-07-26T06:00:00.000Z"),
    forecastDays: 7,
  });

  const context = await service.build({ province: "浙江", city: "杭州" });

  assert.notEqual(context.historical, null);
  assert.deepEqual(context.live, {
    status: "unavailable",
    observedAt: null,
    currentTempC: null,
    apparentTempC: null,
    daily: [],
  });
  assert.deepEqual(context.sources, ["open-meteo"]);
});

test("context keeps usable live weather when history fetch and cache fail", async () => {
  const provider: WeatherProvider = {
    resolveCity: async () => location,
    getHistoricalDaily: async () => {
      throw new Error("archive unavailable");
    },
    getCurrentAndForecast: async () => ({
      source: "open-meteo",
      observedAt: "2026-07-26T14:00",
      currentTempC: 35,
      apparentTempC: 40,
      daily: [
        { date: "2026-07-26", tempMinC: 27, tempMaxC: 36 },
      ],
    }),
  };
  const service = createWeatherContextService({
    provider,
    historyStore: {
      loadOrRefresh: async () => {
        throw new Error("disk and archive unavailable");
      },
    },
    now: () => new Date("2026-07-26T06:00:00.000Z"),
    forecastDays: 7,
  });

  const context = await service.build({ province: "浙江", city: "杭州" });

  assert.equal(context.historical, null);
  assert.equal(context.live.status, "partial");
  assert.equal(context.live.currentTempC, 35);
  assert.deepEqual(context.sources, ["open-meteo"]);
});

test("context exposes both historical and live blocks with server asOf", async () => {
  const provider: WeatherProvider = {
    source: "open-meteo",
    resolveCity: async () => location,
    getHistoricalDaily: async () => daily,
    getCurrentAndForecast: async () => ({
      source: "open-meteo",
      observedAt: "2026-07-26T14:00",
      currentTempC: 35,
      apparentTempC: 40,
      daily: [
        "2026-07-26",
        "2026-07-27",
        "2026-07-28",
        "2026-07-29",
        "2026-07-30",
        "2026-07-31",
        "2026-08-01",
      ].map((date) => ({
        date,
        tempMinC: 27,
        tempMaxC: 36,
      })),
    }),
  };
  const service = createWeatherContextService({
    provider,
    historyStore: {
      loadOrRefresh: async () => ({
        schemaVersion: 1,
        location,
        range: { startDate: "2023-07-26", endDate: "2026-07-25" },
        source: "open-meteo",
        fetchedAt: "2026-07-26T05:00:00.000Z",
        daily,
      }),
    },
    now: () => new Date("2026-07-26T06:00:00.000Z"),
    forecastDays: 7,
  });

  const context = await service.build({ province: "浙江省", city: "杭州市" });

  assert.equal(context.asOf, "2026-07-26T06:00:00.000Z");
  assert.notEqual(context.historical, null);
  assert.equal(context.live.status, "fresh");
});

test("context marks a truncated forecast partial even when current values exist", async () => {
  const provider: WeatherProvider = {
    resolveCity: async () => location,
    getHistoricalDaily: async () => daily,
    getCurrentAndForecast: async () => ({
      source: "open-meteo",
      observedAt: "2026-07-26T14:00",
      currentTempC: 35,
      apparentTempC: 40,
      daily: [
        { date: "2026-07-26", tempMinC: 27, tempMaxC: 36 },
      ],
    }),
  };
  const service = createWeatherContextService({
    provider,
    historyStore: {
      loadOrRefresh: async () => {
        throw new Error("history unavailable");
      },
    },
    now: () => new Date("2026-07-26T06:00:00.000Z"),
    forecastDays: 7,
  });

  const context = await service.build({ province: "浙江省", city: "杭州市" });

  assert.equal(context.live.status, "partial");
});

test("context propagates a city-resolution error without fetching weather", async () => {
  let downstreamCalls = 0;
  const provider: WeatherProvider = {
    resolveCity: async () => {
      throw new Error("location rejected");
    },
    getHistoricalDaily: async () => {
      downstreamCalls += 1;
      return daily;
    },
    getCurrentAndForecast: async () => {
      downstreamCalls += 1;
      throw new Error("should not run");
    },
  };
  const service = createWeatherContextService({
    provider,
    historyStore: {
      loadOrRefresh: async () => {
        downstreamCalls += 1;
        throw new Error("should not run");
      },
    },
    forecastDays: 7,
  });

  await assert.rejects(
    service.build({ province: "错误省", city: "错误市" }),
    /location rejected/,
  );
  assert.equal(downstreamCalls, 0);
});
