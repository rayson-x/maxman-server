import { computeHairConstraint, applyHairConstraint, type HairSignals, type FilterableHairstyle } from "../features/appearance-agent/rules/hairConstraints.js";

/**
 * 验证决策 6 的四行决策矩阵严格成立。
 * 最关键的一条是第三行：`volume: thin` 单独**不得**施加约束——
 * 实测短发者会被误判为 thin，据此排除高发量发型会误伤大量短发用户。
 */
const CASES: { label: string; signals: HairSignals; expect: { strength: string; excludeHigh: boolean; requireCovers: boolean; cloudFallback?: boolean } }[] = [
  {
    label: "① 发际线后移 + 发量薄 → 强约束",
    signals: { hairline: "receding", volume: "thin" },
    expect: { strength: "strong", excludeHigh: true, requireCovers: true },
  },
  {
    label: "① 发际线偏高 + 发量薄 → 强约束（high 与 receding 等价）",
    signals: { hairline: "high", volume: "thin" },
    expect: { strength: "strong", excludeHigh: true, requireCovers: true },
  },
  {
    label: "② 只有发际线后移 → 中约束（只排露额，不排高发量需求）",
    signals: { hairline: "receding", volume: "medium" },
    expect: { strength: "moderate", excludeHigh: false, requireCovers: true },
  },
  {
    label: "③ 只有 volume=thin → 不约束（短发误判防护，最关键的一条）",
    signals: { hairline: "normal", volume: "thin" },
    expect: { strength: "none", excludeHigh: false, requireCovers: false },
  },
  {
    label: "④ 刘海遮挡且无自报 → 挂起，交云端判断",
    signals: { hairline: "occluded", volume: "unknown" },
    expect: { strength: "deferred", excludeHigh: false, requireCovers: false, cloudFallback: true },
  },
  {
    label: "④ 刘海遮挡 + 自报脱发困扰 → 中约束（自报补上了本地测不到的信号）",
    signals: { hairline: "occluded", volume: "unknown", selfReportedHairLossConcern: true },
    expect: { strength: "moderate", excludeHigh: true, requireCovers: true, cloudFallback: true },
  },
  {
    label: "交叉验证：视觉正常但自报发量少 → 中约束（自报本身即决策依据）",
    signals: { hairline: "normal", volume: "medium", selfReportedVolume: "thin" },
    expect: { strength: "moderate", excludeHigh: true, requireCovers: false },
  },
  {
    label: "全正常 → 不约束",
    signals: { hairline: "normal", volume: "thick" },
    expect: { strength: "none", excludeHigh: false, requireCovers: false },
  },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const r = computeHairConstraint(c.signals);
  const excludeHigh = r.excludeVolumeRequirements.includes("high");
  const ok =
    r.strength === c.expect.strength &&
    excludeHigh === c.expect.excludeHigh &&
    r.requireCoversForehead === c.expect.requireCovers &&
    (c.expect.cloudFallback === undefined || r.needsCloudFallback === c.expect.cloudFallback);
  ok ? pass++ : fail++;
  console.log(`${ok ? "✅" : "❌"} ${c.label}`);
  console.log(`     strength=${r.strength} 排除高发量=${excludeHigh} 要求遮额=${r.requireCoversForehead} 云端兜底=${r.needsCloudFallback} 依据=${r.evidenceBasis}`);
}

console.log("\n=== 合规口径抽查（禁止诊断性表述）===");
const diagnosticWords = ["脱发", "秃", "病", "症状", "诊断", "治疗"];
let copyOk = true;
for (const c of CASES) {
  const r = computeHairConstraint(c.signals);
  // 允许出现"脱发困扰"这类**引用用户自报**的措辞，但不能出现断言用户有脱发的表述
  const bad = diagnosticWords.filter((w) => r.rationale.includes(w));
  if (bad.length > 0) {
    console.log(`❌ "${c.label}" 的文案含诊断性词汇: ${bad.join(", ")}`);
    copyOk = false;
  }
}
if (copyOk) console.log("✅ 所有约束文案均为造型可行性口径，无诊断性表述");
else fail++;

console.log("\n=== 过滤行为验证 ===");
const candidates: FilterableHairstyle[] = [
  { id: "纹理烫（需高发量、遮额）", requiresHairVolume: "high", coversForehead: true },
  { id: "蓬松碎盖（需高发量、遮额）", requiresHairVolume: "high", coversForehead: true },
  { id: "大背头（低发量需求、露额）", requiresHairVolume: "low", coversForehead: false },
  { id: "短寸（低发量需求、遮额）", requiresHairVolume: "low", coversForehead: true },
  { id: "微碎盖（中发量需求、遮额）", requiresHairVolume: "medium", coversForehead: true },
];

for (const sig of [
  { label: "强约束（后移+薄）", signals: { hairline: "receding", volume: "thin" } as HairSignals },
  { label: "中约束（仅后移）", signals: { hairline: "receding", volume: "medium" } as HairSignals },
  { label: "无约束（仅 thin）", signals: { hairline: "normal", volume: "thin" } as HairSignals },
]) {
  const cons = computeHairConstraint(sig.signals);
  const { kept, excluded } = applyHairConstraint(candidates, cons);
  console.log(`\n  ${sig.label}：保留 ${kept.length}/${candidates.length}`);
  for (const k of kept) console.log(`    ✓ ${k.id}`);
  for (const e of excluded) console.log(`    ✗ ${e.item.id} — ${e.reason}`);
}

const strongKept = applyHairConstraint(candidates, computeHairConstraint({ hairline: "receding", volume: "thin" })).kept;
const noneKept = applyHairConstraint(candidates, computeHairConstraint({ hairline: "normal", volume: "thin" })).kept;
const strongOk = strongKept.length === 2 && strongKept.every((k) => k.requiresHairVolume === "low" || k.requiresHairVolume === "medium") && strongKept.every((k) => k.coversForehead);
const noneOk = noneKept.length === candidates.length;
console.log(`\n${strongOk ? "✅" : "❌"} 强约束下只保留低/中发量需求且遮额的发型`);
console.log(`${noneOk ? "✅" : "❌"} 仅 thin 时全部保留（不误伤短发用户）`);
if (!strongOk || !noneOk) fail++;

console.log(`\n${fail === 0 ? "全部通过" : "有失败项"}：${pass} 项矩阵断言通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
