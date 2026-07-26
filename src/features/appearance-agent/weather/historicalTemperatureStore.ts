import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import type {
  CityInput,
  HistoricalTemperatureFile,
  HistoricalTemperatureStore,
  LoadOrRefreshHistoryInput,
} from "./types.js";

const MAX_CACHE_FILE_BYTES = 5 * 1024 * 1024;

const locationSchema = z.object({
  providerLocationId: z.string().min(1).max(160),
  province: z.string().min(1).max(120),
  city: z.string().min(1).max(120),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  timeZone: z.string().min(1).max(120),
});

const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const temperatureSchema = z.number().finite().min(-100).max(70);
const historicalDaySchema = z
  .object({
    date: localDateSchema,
    tempMinC: temperatureSchema,
    tempMeanC: temperatureSchema,
    tempMaxC: temperatureSchema,
  })
  .refine(
    (day) =>
      day.tempMinC <= day.tempMeanC && day.tempMeanC <= day.tempMaxC,
    { message: "Historical temperatures must satisfy min <= mean <= max" },
  );
const historicalDailySchema = z
  .array(historicalDaySchema)
  .min(1)
  .max(1_500)
  .superRefine((days, context) => {
    for (let index = 1; index < days.length; index += 1) {
      if (days[index - 1].date >= days[index].date) {
        context.addIssue({
          code: "custom",
          message:
            "Historical weather dates must be unique and strictly ascending",
          path: [index, "date"],
        });
        return;
      }
    }
  });
const historicalTemperatureFileSchema = z.object({
  schemaVersion: z.literal(1),
  location: locationSchema,
  range: z.object({
    startDate: localDateSchema,
    endDate: localDateSchema,
  }),
  source: z.string().min(1).max(120),
  fetchedAt: z.string().datetime(),
  daily: historicalDailySchema,
});

type HistoricalTemperatureStoreOptions = {
  rootDir: string;
  maxAgeMs: number;
  now?: () => Date;
};

function normalizeCachePart(
  value: string,
  kind: "province" | "city",
): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, "");
  const provinceSuffix =
    /(?:壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/u;
  const citySuffix = /(?:自治州|地区|市|县|区|盟)$/u;
  return normalized.replace(
    kind === "province" ? provinceSuffix : citySuffix,
    "",
  );
}

function hasCompleteRange(
  daily: HistoricalTemperatureFile["daily"],
  startDate: string,
  endDate: string,
): boolean {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return false;
  }
  const expectedDays =
    Math.floor((end - start) / (24 * 60 * 60 * 1_000)) + 1;
  const dates = new Set(
    daily
      .filter((day) => day.date >= startDate && day.date <= endDate)
      .map((day) => day.date),
  );
  return (
    dates.size === expectedDays &&
    dates.has(startDate) &&
    dates.has(endDate)
  );
}

function isReusable(
  file: HistoricalTemperatureFile,
  input: LoadOrRefreshHistoryInput,
  now: Date,
  maxAgeMs: number,
): boolean {
  const ageMs = now.getTime() - new Date(file.fetchedAt).getTime();
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return false;
  }
  if (
    file.range.startDate > input.range.startDate ||
    file.range.endDate < input.range.endDate
  ) {
    return false;
  }
  if (
    file.location.providerLocationId !== input.location.providerLocationId ||
    file.source !== input.source
  ) {
    return false;
  }
  return hasCompleteRange(
    file.daily,
    input.range.startDate,
    input.range.endDate,
  );
}

function validateFetchedFile(
  value: HistoricalTemperatureFile,
  requestedRange: LoadOrRefreshHistoryInput["range"],
): HistoricalTemperatureFile {
  const parsed = historicalTemperatureFileSchema.parse(value);
  if (
    !hasCompleteRange(
      parsed.daily,
      requestedRange.startDate,
      requestedRange.endDate,
    )
  ) {
    throw new Error("Historical weather response does not cover requested range");
  }
  return parsed;
}

export function createHistoricalTemperatureStore(
  options: HistoricalTemperatureStoreOptions,
): HistoricalTemperatureStore & {
  filePathFor(input: CityInput): string;
} {
  const rootDir = resolve(options.rootDir);
  const now = options.now ?? (() => new Date());
  if (
    !Number.isInteger(options.maxAgeMs) ||
    options.maxAgeMs < 0 ||
    options.maxAgeMs > 365 * 24 * 60 * 60 * 1_000
  ) {
    throw new Error("History cache max age is outside the safe range");
  }
  const inFlight = new Map<string, Promise<HistoricalTemperatureFile>>();

  const filePathFor = (input: CityInput): string => {
    const cacheKey = createHash("sha256")
      .update(
        `${normalizeCachePart(input.province, "province")}\0${normalizeCachePart(input.city, "city")}`,
        "utf8",
      )
      .digest("hex");
    return join(rootDir, `${cacheKey}.json`);
  };

  const readReusable = async (
    path: string,
    input: LoadOrRefreshHistoryInput,
  ): Promise<HistoricalTemperatureFile | null> => {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_CACHE_FILE_BYTES) {
        return null;
      }
      const parsed = historicalTemperatureFileSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      return isReusable(parsed, input, now(), options.maxAgeMs)
        ? parsed
        : null;
    } catch {
      return null;
    }
  };

  const refresh = async (
    path: string,
    input: LoadOrRefreshHistoryInput,
  ): Promise<HistoricalTemperatureFile> => {
    const cached = await readReusable(path, input);
    if (cached) {
      return cached;
    }

    const fetchedAt = now().toISOString();
    const daily = await input.fetchDaily();
    const file = validateFetchedFile(
      {
        schemaVersion: 1,
        location: input.location,
        range: input.range,
        source: input.source,
        fetchedAt,
        daily,
      },
      input.range,
    );
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(file)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return file;
  };

  const loadOrRefresh = async (
    input: LoadOrRefreshHistoryInput,
  ): Promise<HistoricalTemperatureFile> => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const path = filePathFor(input.input);
    const cached = await readReusable(path, input);
    if (cached) {
      return cached;
    }
    const existing = inFlight.get(path);
    if (existing) {
      await existing.catch(() => undefined);
      const reusableAfterWait = await readReusable(path, input);
      if (reusableAfterWait) {
        return reusableAfterWait;
      }
      return loadOrRefresh(input);
    }
    const pending = refresh(path, input).finally(() => {
      inFlight.delete(path);
    });
    inFlight.set(path, pending);
    return pending;
  };

  return {
    filePathFor,
    loadOrRefresh,
  };
}
