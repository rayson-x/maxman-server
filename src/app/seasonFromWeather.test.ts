import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonFromWeather } from "./jobOrchestrator.js";
import type { AgentWeatherContext } from "../features/appearance-agent/weather/types.js";

/**
 * 季节判定的回归护栏。
 *
 * 为什么值得测：`recommendWardrobe` 的打分只按 `item.usage.seasons.includes(season)`
 * 加分，所以这一个字符串直接决定用户看到什么穿搭。判错不会报错，只会给出不合季的建议。
 *
 * 最需要锁住的是**取温要对齐目标日期**这条。最初实现无条件优先用实时体感，
 * 于是「10 月的活动」在 7 月查询时拿到 32°C 判成夏——给三个月后的秋季活动推夏装。
 * 这个 bug 只在真跑时才暴露，单测必须覆盖住。
 */

const NOW = new Date("2026-07-28T00:00:00.000Z");

function ctx(over: {
  apparentTempC?: number | null;
  currentTempC?: number | null;
  status?: "fresh" | "partial" | "unavailable";
  months?: Array<{ month: number; typicalMeanC: number }>;
  daily?: Array<{ date: string; tempMinC: number; tempMaxC: number }>;
}): AgentWeatherContext {
  return {
    schemaVersion: 1,
    asOf: NOW.toISOString(),
    province: "测试省",
    city: "测试市",
    timeZone: "Asia/Shanghai",
    historical: over.months
      ? {
          periodStart: "2023-07-01",
          periodEnd: "2026-06-30",
          coverageRatio: 1,
          months: over.months.map((m) => ({
            month: m.month,
            typicalLowC: m.typicalMeanC - 5,
            typicalMeanC: m.typicalMeanC,
            typicalHighC: m.typicalMeanC + 5,
            sampleDays: 90,
          })),
        }
      : null,
    live: {
      status: over.status ?? "fresh",
      observedAt: NOW.toISOString(),
      currentTempC: over.currentTempC ?? null,
      apparentTempC: over.apparentTempC ?? null,
      daily: over.daily ?? [],
    },
    sources: ["test"],
  };
}

const OCT = new Date("2026-10-15T00:00:00.000Z");
const TOMORROW = new Date("2026-07-29T00:00:00.000Z");

test("没有天气时回落日历判定", () => {
  assert.deepEqual(seasonFromWeather(undefined, OCT, NOW), { season: "秋", basis: "calendar" });
  assert.deepEqual(seasonFromWeather(undefined, new Date("2026-01-10T00:00:00.000Z"), NOW), {
    season: "冬",
    basis: "calendar",
  });
});

test("远期活动不得用今天的实时气温 —— 这是实跑抓到的 bug", () => {
  // 7 月查询、10 月活动。实时体感 32°C，但 10 月历史均温 18°C。
  const c = ctx({ apparentTempC: 32, currentTempC: 31, months: [{ month: 10, typicalMeanC: 18 }] });
  assert.deepEqual(seasonFromWeather(c, OCT, NOW), { season: "秋", basis: "monthly_normal" });
});

test("真实气温压过日历 —— 这是收集省市的全部意义", () => {
  // 十月的广州：日历说秋，历史均温 25°C，实际按夏穿
  const guangzhou = ctx({ months: [{ month: 10, typicalMeanC: 25 }] });
  assert.deepEqual(seasonFromWeather(guangzhou, OCT, NOW), { season: "夏", basis: "monthly_normal" });
  // 十月的哈尔滨：日历说秋，历史均温 6°C，实际按冬穿
  const harbin = ctx({ months: [{ month: 10, typicalMeanC: 6 }] });
  assert.deepEqual(seasonFromWeather(harbin, OCT, NOW), { season: "冬", basis: "monthly_normal" });
});

test("目标日在预报窗口内时用该日预报，而不是今天的实时值", () => {
  const c = ctx({
    apparentTempC: 35, // 今天很热
    daily: [{ date: "2026-07-29", tempMinC: 4, tempMaxC: 8 }], // 明天骤冷
    months: [{ month: 7, typicalMeanC: 28 }],
  });
  // 明天均温 6°C → 冬，且依据是 forecast 而非 live
  assert.deepEqual(seasonFromWeather(c, TOMORROW, NOW), { season: "冬", basis: "forecast" });
});

test("无活动日期时按当天判，体感优先于实测气温", () => {
  const c = ctx({ apparentTempC: 8, currentTempC: 15, months: [{ month: 7, typicalMeanC: 28 }] });
  assert.deepEqual(seasonFromWeather(c, null, NOW), { season: "冬", basis: "live_apparent" });
});

test("无体感时退到实测气温", () => {
  const c = ctx({ currentTempC: 24, months: [{ month: 7, typicalMeanC: 10 }] });
  assert.deepEqual(seasonFromWeather(c, null, NOW), { season: "夏", basis: "live_actual" });
});

test("实时不可用时退到目标月的历史均温", () => {
  const c = ctx({ status: "unavailable", apparentTempC: 30, months: [{ month: 7, typicalMeanC: 26 }] });
  assert.deepEqual(seasonFromWeather(c, null, NOW), { season: "夏", basis: "monthly_normal" });
});

test("目标月没有历史数据时回落日历", () => {
  const c = ctx({ status: "unavailable", months: [{ month: 1, typicalMeanC: -5 }] });
  assert.deepEqual(seasonFromWeather(c, OCT, NOW), { season: "秋", basis: "calendar" });
});

test("过渡带用升温/降温趋势消歧春秋 —— 温度本身给不出方向", () => {
  // 同样 15°C：3月→4月升温判春，9月→10月降温判秋
  const spring = ctx({ months: [{ month: 3, typicalMeanC: 8 }, { month: 4, typicalMeanC: 15 }] });
  const autumn = ctx({ months: [{ month: 9, typicalMeanC: 21 }, { month: 10, typicalMeanC: 15 }] });
  assert.equal(seasonFromWeather(spring, new Date("2026-04-15T00:00:00.000Z"), NOW).season, "春");
  assert.equal(seasonFromWeather(autumn, OCT, NOW).season, "秋");
  // basis 仍如实记为温度来源 —— 温度参与了分档，趋势只决定春/秋
  assert.equal(seasonFromWeather(autumn, OCT, NOW).basis, "monthly_normal");
});

test("过渡带趋势判定要能跨年取上月（1月的上月是12月）", () => {
  // 广州 1 月：12°C→14°C 这种升温会判春；14←16 降温判秋。
  // 硬编码「月份≤7 判春」在这里是错的——1 月是全年最冷，方向上离冬更近。
  const cooling = ctx({ months: [{ month: 12, typicalMeanC: 16 }, { month: 1, typicalMeanC: 14 }] });
  const jan = new Date("2027-01-15T00:00:00.000Z");
  assert.equal(seasonFromWeather(cooling, jan, NOW).season, "秋");
});

test("拿不到相邻月数据时回落月份切分", () => {
  const only = ctx({ months: [{ month: 10, typicalMeanC: 15 }] });
  assert.equal(seasonFromWeather(only, OCT, NOW).season, "秋");
  const onlyApr = ctx({ months: [{ month: 4, typicalMeanC: 15 }] });
  assert.equal(seasonFromWeather(onlyApr, new Date("2026-04-15T00:00:00.000Z"), NOW).season, "春");
});

test("分档边界：10 与 22 的开闭", () => {
  const at = (t: number) => seasonFromWeather(ctx({ months: [{ month: 10, typicalMeanC: t }] }), OCT, NOW).season;
  assert.equal(at(9.9), "冬");
  assert.equal(at(10), "秋");
  assert.equal(at(21.9), "秋");
  assert.equal(at(22), "夏");
});

test("0°C 不能被当成缺值", () => {
  // 用 typeof === "number" 而不是真值判断，否则 0°C 会掉到下一档
  const c = ctx({ apparentTempC: 0, months: [{ month: 7, typicalMeanC: 28 }] });
  assert.deepEqual(seasonFromWeather(c, null, NOW), { season: "冬", basis: "live_apparent" });
});
