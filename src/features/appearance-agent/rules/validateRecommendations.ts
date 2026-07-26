import { applyHairConstraint, computeHairConstraint, type HairSignals } from "./hairConstraints.js";
import type { StyleRecommendationCandidate } from "../providers/styleRecommendation/types.js";

/**
 * 对推荐结果做**可行性校验**。
 *
 * 为什么这一层不放在 provider 里：provider 是可替换的接缝，放进去就会随实现一起被换掉。
 * 而这条约束不该被换——它有实测依据（调研报告：发际线后移判定 0/17 假阳性）
 * 且属于**物理可行性**：发量不够就是做不出那个造型。
 *
 * 审美惯例可以留空、可以交给概率性的 LLM；可行性不行。所以它留在确定性内核里，
 * 对任何实现的输出一视同仁地校验。
 *
 * ⚠ 能力边界要说清：这层挡得住「明显违反」（候选自称需要 high 发量而用户约束排除了 high），
 * 挡不住「标注错误」（LLM 把一个其实需要 high 发量的造型标成了 low）。
 * 残余风险在审美匹配数据到位后由目录标注取代 LLM 标注即可消除。
 */

export type ValidationOutcome = {
  kept: StyleRecommendationCandidate[];
  /** 被剔除的候选与原因。原因已是造型可行性口径，可直接展示给用户 */
  excluded: { candidate: StyleRecommendationCandidate; reason: string }[];
  /** 请求数量与实际保留数量的差额。>0 时上游必须如实告知缺口，不得放宽约束补齐 */
  shortfall: number;
  constraintStrength: string;
  constraintRationale: string;
};

export function validateRecommendationFeasibility(
  candidates: StyleRecommendationCandidate[],
  hairSignals: HairSignals,
  requestedCount: number,
): ValidationOutcome {
  const constraint = computeHairConstraint(hairSignals);
  const excluded: { candidate: StyleRecommendationCandidate; reason: string }[] = [];

  // 缺可行性标注的候选**不放行**：无法校验就等于无法保证，
  // 默认放行会让这层校验在模型偷懒时静默失效。
  const annotated: StyleRecommendationCandidate[] = [];
  for (const c of candidates) {
    const hasAnnotation =
      (c.requiresHairVolume === "low" || c.requiresHairVolume === "medium" || c.requiresHairVolume === "high") &&
      typeof c.coversForehead === "boolean";
    if (!hasAnnotation) {
      excluded.push({ candidate: c, reason: "缺少造型可行性标注，无法确认它与你的发量情况是否匹配" });
      continue;
    }
    annotated.push(c);
  }

  // 复用既有的约束过滤。索引对齐用 index 当 id——候选此时可能还没有 entryId（未落库）
  const filterable = annotated.map((c, i) => ({
    id: String(i),
    requiresHairVolume: c.requiresHairVolume,
    coversForehead: c.coversForehead,
  }));
  const { kept: keptRefs, excluded: excludedRefs } = applyHairConstraint(filterable, constraint);

  for (const e of excludedRefs) {
    excluded.push({ candidate: annotated[Number(e.item.id)], reason: e.reason });
  }
  const kept = keptRefs.map((r) => annotated[Number(r.id)]);

  return {
    kept,
    excluded,
    // 不足就是不足。**不回填被排除项**——那等于放弃这层校验的全部意义
    shortfall: Math.max(0, requestedCount - kept.length),
    constraintStrength: constraint.strength,
    constraintRationale: constraint.rationale,
  };
}
