import { feasibleHairstyleNames } from "../services/recommendationApplication.js";
import { computeHairConstraint } from "../features/appearance-agent/rules/hairConstraints.js";
import { OBJECTIVE_HAIRSTYLE_ATTRIBUTES } from "../features/appearance-agent/data/objectiveHairstyleAttributes.js";

/** 只读排查：各档信号下属性表还剩多少可行造型——可行集为空就是链路对该人群不可用 */
const cases: { label: string; signals: Parameters<typeof computeHairConstraint>[0] }[] = [
  { label: "正常/中等", signals: { hairline: "normal", volume: "medium" } },
  { label: "发际线偏后", signals: { hairline: "receding", volume: "medium" } },
  { label: "发际线偏后+发量少（强约束）", signals: { hairline: "receding", volume: "thin" } },
  { label: "刘海遮挡+自报脱发", signals: { hairline: "occluded", volume: "unknown", selfReportedHairLossConcern: true } },
];
console.log(`属性表共 ${OBJECTIVE_HAIRSTYLE_ATTRIBUTES.length} 条\n`);
for (const c of cases) {
  const k = computeHairConstraint(c.signals);
  const names = feasibleHairstyleNames(k);
  console.log(`${c.label}  强度=${k.strength}  可行 ${names.length} 条`);
  console.log(`   ${names.join("、") || "⛔ 空——该人群拿不到任何候选"}\n`);
}
