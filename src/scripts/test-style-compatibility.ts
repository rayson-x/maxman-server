import {
  checkCompatibility,
  buildCompatibleCombinations,
  weightedAppeal,
  appealGap,
  isGapWorthDisclosing,
  type HairstyleEntry,
  type OutfitComboEntry,
  type StyleVector,
  type DualAppeal,
} from "../features/appearance-agent/data/styleProfile.js";

/**
 * 风格兼容性计算的行为验证。用内联 fixture 而非真实目录数据——
 * 真实数据由调研任务产出，这里只验证计算逻辑本身。
 */

const v = (formality: number, maturity: number, boldness: number, upkeep: number): StyleVector => ({
  formality, maturity, boldness, upkeep,
});

const appeal = (female: number, male: number): DualAppeal => ({
  femaleAppeal: { score: female, source: "fixture", confidence: "low", rationale: "测试用" },
  maleSelfAppeal: { score: male, source: "fixture", confidence: "low", rationale: "测试用" },
});

const hair = (id: string, vec: StyleVector, ap: DualAppeal): HairstyleEntry => ({
  id, nameZh: id, aliases: [], description: "", styleVector: vec, appeal: ap,
  requiresHairVolume: "medium", coversForehead: true,
  suitableFaceShapes: [], unsuitableFaceShapes: [],
  estCostRange: "", estTime: "", maintenanceNotes: "", referenceUrls: [],
});

const outfit = (id: string, vec: StyleVector, ap: DualAppeal): OutfitComboEntry => ({
  id, nameZh: id, items: [], styleVector: vec, appeal: ap,
  suitableBodyTypes: [], suitableScenes: [], estCostRange: "", notes: "",
});

console.log("=== 1. 协调性判定 ===");
const cases: { a: StyleVector; b: StyleVector; label: string; expectCompatible: boolean }[] = [
  {
    label: "寸头(2/4/2/1) + 素色T直筒裤(3/4/2/2) —— 各轴接近",
    a: v(2, 4, 2, 1), b: v(3, 4, 2, 2), expectCompatible: true,
  },
  {
    label: "寸头(2/4/2/1) + 文艺针织衫(6/7/4/3) —— 正式度差4、成熟度差3",
    a: v(2, 4, 2, 1), b: v(6, 7, 4, 3), expectCompatible: false,
  },
  {
    label: "背头(9/8/5/7) + 连帽卫衣(2/3/3/1) —— 全面背离",
    a: v(9, 8, 5, 7), b: v(2, 3, 3, 1), expectCompatible: false,
  },
  {
    label: "边界情况：各轴恰好差 3",
    a: v(5, 5, 5, 5), b: v(8, 2, 8, 2), expectCompatible: true,
  },
  {
    label: "边界情况：某轴差 4",
    a: v(5, 5, 5, 5), b: v(9, 5, 5, 5), expectCompatible: false,
  },
];

let pass = 0;
for (const c of cases) {
  const r = checkCompatibility(c.a, c.b);
  const ok = r.compatible === c.expectCompatible;
  if (ok) pass += 1;
  const detail = r.compatible
    ? "兼容"
    : `不兼容 ← ${r.violations.map((x) => `${x.dimension}差${x.delta}`).join(", ")}`;
  console.log(`  ${ok ? "✅" : "❌"} ${detail.padEnd(42)} ${c.label}`);
}
console.log(`  ${pass}/${cases.length} 通过\n`);

console.log("=== 2. 组合生成（协调性在此被确定性保证，LLM 只从结果里挑）===");
const hairstyles = [
  hair("寸头", v(2, 4, 2, 1), appeal(7, 5)),
  hair("微碎盖", v(3, 3, 4, 4), appeal(8, 8)),
  hair("背头", v(9, 8, 5, 7), appeal(5, 7)),
];
const outfits = [
  outfit("素色T+直筒裤", v(3, 4, 2, 2), appeal(7, 6)),
  outfit("针织衫+休闲裤", v(6, 6, 3, 3), appeal(8, 6)),
  outfit("西装+衬衫", v(9, 8, 4, 6), appeal(7, 6)),
];
const combos = buildCompatibleCombinations(hairstyles, outfits);
console.log(`  ${hairstyles.length} 发型 × ${outfits.length} 穿搭 = ${hairstyles.length * outfits.length} 种理论组合`);
console.log(`  过滤后保留 ${combos.length} 种兼容组合：`);
for (const c of combos) console.log(`    · ${c.hairstyle.nameZh} + ${c.outfit.nameZh}`);
const rejected = hairstyles.length * outfits.length - combos.length;
console.log(`  被排除 ${rejected} 种（这些 LLM 永远看不到，无法推荐出不协调组合）\n`);

console.log("=== 3. 双审美加权与落差暴露 ===");
const samples = [
  { name: "微碎盖（两边都高）", ap: appeal(8, 8) },
  { name: "漂染潮流款（他爱我们不推荐）", ap: appeal(3, 9) },
  { name: "清爽短发（我们推荐他没感觉）", ap: appeal(9, 4) },
];
for (const s of samples) {
  const gap = appealGap(s.ap);
  const dateScore = weightedAppeal(s.ap, 0.8);
  const selfScore = weightedAppeal(s.ap, 0.2);
  const flag = isGapWorthDisclosing(s.ap) ? "⚠ 需向用户指出落差" : "  落差不显著";
  console.log(
    `  ${s.name.padEnd(24)} 女性视角=${s.ap.femaleAppeal.score} 自身=${s.ap.maleSelfAppeal.score} ` +
      `落差=${gap > 0 ? "+" : ""}${gap}  约会场景加权=${dateScore.toFixed(1)} 自我认同加权=${selfScore.toFixed(1)}  ${flag}`,
  );
}
