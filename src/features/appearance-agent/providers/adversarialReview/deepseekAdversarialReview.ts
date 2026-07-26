import { generateObject } from "ai";
import { z } from "zod";
import { createDeepSeekModel } from "../llm/deepseekModel.js";
import type { AdversarialReviewInput, AdversarialReviewProvider, AdversarialReviewResult } from "./types.js";

const REVIEW_SCHEMA = z.object({
  feasibilityScore: z.number().min(0).max(10),
  improvementRateScore: z.number().min(0).max(10),
  freeSuggestionVerdicts: z.array(
    z.object({
      title: z.string(),
      verdict: z.enum(["accept", "reject", "needs_professional_review"]),
      reason: z.string(),
      duplicatesCatalogEntry: z.boolean(),
    }),
  ),
  summary: z.string(),
});

/**
 * AdversarialReviewProvider — the judge between TextPlanningProvider's
 * catalog-constrained scores and FreeRecommendationProvider's unconstrained
 * suggestions. Deliberately skeptical of the free side: default posture is
 * to REJECT a free suggestion unless it survives scrutiny (evidence, safety,
 * genuine incremental value over what the catalog already covers). This is
 * the only place a free-agent suggestion can become "accept" — nothing from
 * FreeRecommendationProvider should reach the user pre-judgment.
 */
export function createDeepSeekAdversarialReviewProvider(): AdversarialReviewProvider {
  const model = createDeepSeekModel();

  return {
    name: "deepseek-adversarial-review",
    async review(input: AdversarialReviewInput): Promise<AdversarialReviewResult> {
      const start = Date.now();
      const { object } = await generateObject({
        model,
        schema: REVIEW_SCHEMA,
        prompt:
          "你是一个严格的形象改善方案评审员，只输出JSON，不要输出任何JSON之外的文字，也不要用markdown代码块包裹。" +
          "你的任务是对抗式地审查两组建议：第一组来自人工审核过的目录（可信但可能保守），第二组来自不受限制的自由建议" +
          "（可能有价值但也可能缺乏证据支撑、夸大效果、或有未声明的风险）。\n\n" +
          "对第二组（自由建议）的每一条，默认持怀疑态度，只有真正经得起推敲才判定 accept：" +
          "- 如果它的效果宣称缺乏合理依据或明显夸大 → reject\n" +
          "- 如果它涉及医疗/生理干预且无法在文字层面确认安全性 → needs_professional_review\n" +
          "- 如果它实质上和目录里已有的某条建议是同一件事 → duplicatesCatalogEntry=true\n" +
          "- 只有确实提供了目录覆盖不到的、有合理依据、风险可控的增量价值时才 accept\n\n" +
          `领域：${input.domain}\n用户视觉分析结果：\n${input.analysisSummary}\n\n` +
          `第一组（目录约束评分）：\n${JSON.stringify(input.constrained, null, 2)}\n\n` +
          `第二组（自由建议）：\n${JSON.stringify(input.free, null, 2)}\n\n` +
          "同时给出两个整体评分（0-10）：feasibilityScore（这个方向对该用户而言现实可行的程度，综合考虑成本/时间/风险）、" +
          "improvementRateScore（如果用户真的执行了被接受的建议，预期能带来多明显的提升）。\n\n" +
          "输出必须严格符合下面这个JSON结构：\n" +
          '{"feasibilityScore":7,"improvementRateScore":6,"freeSuggestionVerdicts":[{"title":"建议标题","verdict":"accept","reason":"理由","duplicatesCatalogEntry":false}],"summary":"一段总结"}',
      });

      return {
        provider: "deepseek-adversarial-review",
        feasibilityScore: object.feasibilityScore,
        improvementRateScore: object.improvementRateScore,
        freeSuggestionVerdicts: object.freeSuggestionVerdicts,
        summary: object.summary,
        latencyMs: Date.now() - start,
        raw: object,
      };
    },
  };
}
