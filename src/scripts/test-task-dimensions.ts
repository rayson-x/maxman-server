import "dotenv/config";
import { deriveTaskDimensions, __internals } from "../features/appearance-agent/data/taskDimensions.js";

/**
 * 维度推导的边界测试。零成本、秒级。
 * 重点是**单位陷阱**：「2-4 周」若被当成 4 分钟，一个需要一个月的任务会被判成
 * 低成本高优先，直接落到阶段 0 让用户当天做——这类错在 UI 上看不出来。
 */
const { parseTimeCost, parseMoneyCost, parseAcceptance } = __internals;

let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

// ── 时间单位不能混淆 ──
check(parseTimeCost("10-15 分钟") === 1, "「10-15 分钟」→ 最低时间成本档");
// 2 小时 = 120 分钟，落「≤1 天」档 = 5。分档偏粗是已知取舍（见 taskDimensions.ts）
check(parseTimeCost("2 小时") === 5, "「2 小时」→「≤1 天」档", `得 ${parseTimeCost("2 小时")}`);
check(parseTimeCost("2-4 周") > parseTimeCost("2 小时"), "**「2-4 周」成本必须高于「2 小时」**（单位不可混淆）", `周=${parseTimeCost("2-4 周")} 时=${parseTimeCost("2 小时")}`);
check(parseTimeCost("45 分钟") === 3, "「45 分钟」→「≤1 小时」档");
check(parseTimeCost("6-12 周") === 9, "「6-12 周」→ 最高档", `得 ${parseTimeCost("6-12 周")}`);
check(parseTimeCost("3 个月") === 9, "「3 个月」→ 最高档");
check(parseTimeCost(null) === 5, "未标注时间 → 中位（不假设轻松）");

// ── 金额取区间上界 ──
check(parseMoneyCost("¥0（自备剃须刀）") === 0, "「¥0」→ 零成本");
check(parseMoneyCost("¥0-30") === 1, "「¥0-30」→ 最低档");
check(parseMoneyCost("¥30-80（修剪器一次性投入）") === 3, "跨档取上界（80 → 第二档）", `得 ${parseMoneyCost("¥30-80（修剪器一次性投入）")}`);
check(parseMoneyCost("¥200-400") === 5, "「¥200-400」→ 中档", `得 ${parseMoneyCost("¥200-400")}`);
check(parseMoneyCost(null) === 5, "未标注金额 → 中位");

// ── 接受度来自用户，不是我们猜的 ──
check(parseAcceptance({ skincare: 9 }, "skincare") === 9, "数值型接受度直接采用");
check(parseAcceptance({ fitness: false }, "fitness") === 2, "布尔 false → 低接受度");
check(parseAcceptance({ dental: "high" }, "dental") === 9, "字符串档位映射");
check(parseAcceptance({}, "posture") === 5, "未表态 → 中位（既不当抗拒也不当热情）");
check(parseAcceptance({ skincare: 99 }, "skincare") === 10, "越界值被夹到 0-10");

// ── 完整推导 ──
const d = deriveTaskDimensions(
  { domain: "face_grooming", evidenceBasis: "visual_detected", reversibility: "full", riskLevel: "low", visualBenefitLevel: "high", estTime: "10 分钟", estCostRange: "¥0-30" },
  { face_grooming: 9 },
);
check(d.visualBenefit === 9 && d.credibility === 9 && d.reversibility === 9, "高收益+视觉实测+全可逆 → 三项收益均高");
check(d.timeCost === 1 && d.moneyCost === 1 && d.risk === 1, "低时间/低花费/低风险 → 三项成本均低");

const heavy = deriveTaskDimensions(
  { domain: "fitness", evidenceBasis: "general_best_practice", reversibility: "partial", riskLevel: "medium", visualBenefitLevel: "high", estTime: "6-12 周", estCostRange: "¥2000-5000" },
  { fitness: 3 },
);
check(heavy.timeCost === 9 && heavy.moneyCost === 9, "长周期高花费任务成本拉满");
check(heavy.credibility === 3, "通用最佳实践可信度最低（但不为 0）");

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
