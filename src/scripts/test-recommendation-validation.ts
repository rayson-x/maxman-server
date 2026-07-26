import "dotenv/config";
import { validateRecommendationFeasibility } from "../features/appearance-agent/rules/validateRecommendations.js";
import type { StyleRecommendationCandidate } from "../features/appearance-agent/providers/styleRecommendation/types.js";

/**
 * 可行性校验的边界测试（零成本、毫秒级）。
 *
 * 这一层存在的意义是**不信任 provider 的输出**：审美判断可以交给概率性的 LLM，
 * 可行性不行。所以这里要验的不是"正常情况能通过"，而是
 * **provider 给出违规或残缺输出时，校验是否真的挡住了**。
 */

let pass = 0, fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
};

const c = (
  nameZh: string,
  requiresHairVolume: "low" | "medium" | "high",
  coversForehead: boolean,
): StyleRecommendationCandidate => ({
  nameZh,
  description: "d",
  rationale: "r",
  changeInstruction: "i",
  requiresHairVolume,
  coversForehead,
  source: "vision_llm",
  confidence: "low",
});

// ── 强约束（发际线后移 + 发量薄）：排除 high 发量需求 + 要求遮额 ──
{
  const signals = { hairline: "receding" as const, volume: "thin" as const };
  const out = validateRecommendationFeasibility(
    [c("需要高发量的蓬松造型", "high", true), c("遮额碎盖", "medium", true), c("露额背头", "medium", false)],
    signals,
    3,
  );
  check(out.constraintStrength === "strong", "发际线后移+发量薄 → 强约束", `实际 ${out.constraintStrength}`);
  check(out.kept.length === 1 && out.kept[0].nameZh === "遮额碎盖", "**只保留遮额且不需高发量的候选**", `保留 ${out.kept.map((k) => k.nameZh).join("/")}`);
  check(out.excluded.length === 2, "两个候选被剔除", `实际 ${out.excluded.length}`);
  check(out.shortfall === 2, "如实报缺口 2，**不回填被排除项**", `实际 ${out.shortfall}`);
  check(
    out.excluded.every((e) => !/脱发|秃|病|症状|诊断|治疗/.test(e.reason)),
    "剔除原因无诊断性词汇（可直接展示给用户）",
    out.excluded.map((e) => e.reason).join(" | "),
  );
}

// ── 仅发量薄：实测短发者会被误判为 thin，据此过滤会误伤大量短发用户 ──
{
  const out = validateRecommendationFeasibility(
    [c("需要高发量的蓬松造型", "high", true), c("露额背头", "medium", false)],
    { hairline: "normal", volume: "thin" },
    2,
  );
  check(out.kept.length === 2, "**仅 volume=thin 不施加任何约束**（防短发误判，已单独实测过）", `保留 ${out.kept.length}/2`);
  check(out.shortfall === 0, "无缺口");
}

// ── 缺标注必须剔除，不能默认放行 ──
{
  const broken = { nameZh: "无标注造型", description: "d", rationale: "r", changeInstruction: "i" } as unknown as StyleRecommendationCandidate;
  const missingBool = { ...c("缺遮额标注", "medium", true), coversForehead: undefined } as unknown as StyleRecommendationCandidate;
  const badEnum = { ...c("发量档位拼错", "medium", true), requiresHairVolume: "very_high" } as unknown as StyleRecommendationCandidate;

  const out = validateRecommendationFeasibility([broken, missingBool, badEnum, c("正常候选", "low", true)], { hairline: "receding", volume: "thin" }, 4);
  check(out.kept.length === 1 && out.kept[0].nameZh === "正常候选", "**缺标注/枚举错误的候选被剔除而非放行**", `保留 ${out.kept.map((k) => k.nameZh).join("/")}`);
  check(
    out.excluded.filter((e) => /缺少造型可行性标注/.test(e.reason)).length === 3,
    "三种残缺形态都被识别为不可校验",
    `实际 ${out.excluded.filter((e) => /缺少造型可行性标注/.test(e.reason)).length}`,
  );
}

// ── 遮挡时挂起：needsCloudFallback，不因测不到就放行全部 ──
{
  const out = validateRecommendationFeasibility(
    [c("露额背头", "medium", false), c("遮额碎盖", "medium", true)],
    { hairline: "occluded", volume: "unknown", selfReportedHairLossConcern: true },
    2,
  );
  check(out.kept.length === 1, "刘海遮挡 + 自报脱发困扰 → 自报补位施加约束（露额被剔除）", `保留 ${out.kept.map((k) => k.nameZh).join("/")}`);
}

// ── 空输入不崩 ──
{
  const out = validateRecommendationFeasibility([], { hairline: "normal", volume: "medium" }, 3);
  check(out.kept.length === 0 && out.shortfall === 3, "空候选集：保留 0、缺口 3，不抛异常");
}

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exitCode = 1;
