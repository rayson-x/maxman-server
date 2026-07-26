import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createHistoricalTemperatureStore } from "./historicalTemperatureStore.js";
import type {
  HistoricalTemperatureDay,
  ResolvedWeatherLocation,
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
  {
    date: "2026-07-23",
    tempMinC: 22,
    tempMeanC: 27,
    tempMaxC: 32,
  },
  {
    date: "2026-07-24",
    tempMinC: 23,
    tempMeanC: 28,
    tempMaxC: 33,
  },
];

test("history cache hashes untrusted city input and reuses a valid JSON file", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let fetchCount = 0;
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const input = { province: "../../浙江", city: "../杭州" };
  const range = { startDate: "2026-07-23", endDate: "2026-07-24" };

  const first = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return daily;
    },
  });
  const second = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return daily;
    },
  });
  const cachePath = store.filePathFor(input);
  const saved = JSON.parse(await readFile(cachePath, "utf8")) as unknown;

  assert.equal(fetchCount, 1);
  assert.deepEqual(second, first);
  assert.equal(cachePath.startsWith(`${rootDir}/`), true);
  assert.match(cachePath, /\/[a-f0-9]{64}\.json$/);
  assert.equal(cachePath.includes("杭州"), false);
  assert.deepEqual(saved, first);
});

test("history cache recovers from corrupt JSON by atomically replacing it", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const input = { province: "浙江省", city: "杭州市" };
  const range = { startDate: "2026-07-23", endDate: "2026-07-24" };
  const cachePath = store.filePathFor(input);

  await writeFile(cachePath, '{"schemaVersion":1,"daily":[', "utf8").catch(
    async () => {
      await store.loadOrRefresh({
        input,
        location,
        range,
        source: "open-meteo",
        fetchDaily: async () => daily,
      });
      await writeFile(cachePath, '{"schemaVersion":1,"daily":[', "utf8");
    },
  );

  const recovered = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => daily,
  });

  assert.deepEqual(recovered.daily, daily);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(recovered)));
  assert.deepEqual(
    JSON.parse(await readFile(cachePath, "utf8")),
    recovered,
  );
});

test("history cache refreshes stale or incomplete data", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let currentTime = new Date("2026-07-26T06:00:00.000Z");
  let fetchCount = 0;
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 60 * 60 * 1_000,
    now: () => currentTime,
  });
  const input = { province: "浙江省", city: "杭州市" };
  const range = { startDate: "2026-07-23", endDate: "2026-07-24" };

  await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return daily;
    },
  });
  currentTime = new Date("2026-07-26T08:00:00.000Z");
  const refreshed = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return daily;
    },
  });

  assert.equal(fetchCount, 2);
  assert.equal(refreshed.fetchedAt, "2026-07-26T08:00:00.000Z");

  await writeFile(
    store.filePathFor(input),
    JSON.stringify({ ...refreshed, range: { ...range, endDate: "2026-07-23" } }),
    "utf8",
  );
  await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return daily;
    },
  });
  assert.equal(fetchCount, 3);
});

test("concurrent cache misses share one fetch and leave no temporary file", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  let fetchCount = 0;
  let releaseFetch: (() => void) | undefined;
  const waitForRelease = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const request = {
    input: { province: "浙江省", city: "杭州市" },
    location,
    range: { startDate: "2026-07-23", endDate: "2026-07-24" },
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      await waitForRelease;
      return daily;
    },
  };

  const first = store.loadOrRefresh(request);
  const second = store.loadOrRefresh(request);
  await new Promise((resolve) => setImmediate(resolve));
  releaseFetch?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(rootDir);

  assert.equal(fetchCount, 1);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[a-f0-9]{64}\.json$/);
});

test("history cache treats missing dates inside the requested range as incomplete", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const input = { province: "浙江省", city: "杭州市" };
  const range = { startDate: "2026-07-23", endDate: "2026-07-25" };
  const completeDaily = [
    ...daily,
    {
      date: "2026-07-25",
      tempMinC: 24,
      tempMeanC: 29,
      tempMaxC: 34,
    },
  ];
  const initial = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => completeDaily,
  });
  await writeFile(
    store.filePathFor(input),
    JSON.stringify({
      ...initial,
      daily: [completeDaily[0], completeDaily[2]],
    }),
    "utf8",
  );
  let fetchCount = 0;

  const refreshed = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => {
      fetchCount += 1;
      return completeDaily;
    },
  });

  assert.equal(fetchCount, 1);
  assert.equal(refreshed.daily.length, 3);
});

test("equivalent Chinese administrative suffixes map to one cache file", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
  });

  assert.equal(
    store.filePathFor({ province: "浙江省", city: "杭州市" }),
    store.filePathFor({ province: "浙江", city: "杭州" }),
  );
});

test("a second caller revalidates its wider range after an in-flight fetch", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const input = { province: "浙江省", city: "杭州市" };
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  let secondFetchCount = 0;
  const first = store.loadOrRefresh({
    input,
    location,
    range: { startDate: "2026-07-23", endDate: "2026-07-24" },
    source: "open-meteo",
    fetchDaily: async () => {
      signalFirstStarted?.();
      await firstBlocked;
      return daily;
    },
  });
  await firstStarted;
  const second = store.loadOrRefresh({
    input,
    location,
    range: { startDate: "2026-07-23", endDate: "2026-07-25" },
    source: "open-meteo",
    fetchDaily: async () => {
      secondFetchCount += 1;
      return [
        ...daily,
        {
          date: "2026-07-25",
          tempMinC: 24,
          tempMeanC: 29,
          tempMaxC: 34,
        },
      ];
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst?.();
  await first;
  const secondResult = await second;

  assert.equal(secondFetchCount, 1);
  assert.equal(secondResult.range.endDate, "2026-07-25");
  assert.equal(secondResult.daily.length, 3);
});

test("cache validation rejects duplicate rows and inconsistent temperatures", async (t) => {
  const rootDir = await mkdtemp(join(tmpdir(), "bettermeet-weather-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = createHistoricalTemperatureStore({
    rootDir,
    maxAgeMs: 24 * 60 * 60 * 1_000,
    now: () => new Date("2026-07-26T06:00:00.000Z"),
  });
  const input = { province: "浙江省", city: "杭州市" };
  const range = { startDate: "2026-07-23", endDate: "2026-07-24" };
  const valid = await store.loadOrRefresh({
    input,
    location,
    range,
    source: "open-meteo",
    fetchDaily: async () => daily,
  });
  const path = store.filePathFor(input);
  let fetchCount = 0;
  const loadFresh = () =>
    store.loadOrRefresh({
      input,
      location,
      range,
      source: "open-meteo",
      fetchDaily: async () => {
        fetchCount += 1;
        return daily;
      },
    });

  await writeFile(
    path,
    JSON.stringify({ ...valid, daily: [daily[0], daily[0], daily[1]] }),
    "utf8",
  );
  await loadFresh();

  await writeFile(
    path,
    JSON.stringify({
      ...valid,
      daily: [{ ...daily[0], tempMinC: 40 }, daily[1]],
    }),
    "utf8",
  );
  await loadFresh();

  assert.equal(fetchCount, 2);
});
