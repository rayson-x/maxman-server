import { generateObject } from "ai";
import { z } from "zod";
import { createDeepSeekModel } from "../llm/deepseekModel.js";
import type { FreeRecommendationInput, FreeRecommendationProvider, FreeRecommendationResult } from "./types.js";

const SUGGESTION_SCHEMA = z.object({
  suggestions: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
      estimatedVisualBenefit: z.number().min(0).max(10),
      estimatedRisk: z.number().min(0).max(10),
      rationale: z.string(),
    }),
  ),
});

/**
 * FreeRecommendationProvider — deliberately the OPPOSITE of TextPlanningProvider:
 * no CandidateTaskCatalog constraint, the model can suggest anything. This
 * exists purely as the "unconstrained" half of the adversarial-review pair
 * (see adversarialReview/) — its raw output must never reach the user
 * directly, only after the adversarial judge has checked it.
 */
export function createDeepSeekFreeRecommendationProvider(): FreeRecommendationProvider {
  const model = createDeepSeekModel();

  return {
    name: "deepseek-free-recommendation",
    async suggest(input: FreeRecommendationInput): Promise<FreeRecommendationResult> {
      const start = Date.now();
      const { object, usage } = await generateObject({
        model,
        schema: SUGGESTION_SCHEMA,
        prompt:
          "你是一个大胆的形象改善顾问，只输出JSON，不要输出任何JSON之外的文字，也不要用markdown代码块包裹。" +
          "不受任何预设方法目录限制，尽你所知给出针对用户情况的改善建议，可以包括小众/进阶/需要专业指导的方法，" +
          "只要你认为对用户有价值就可以提出，不必保守。\n\n" +
          `领域：${input.domain}\n用户视觉分析结果：\n${input.analysisSummary}\n\n` +
          "输出必须严格符合下面这个JSON结构（数字是0到10的纯数字）：\n" +
          '{"suggestions":[{"title":"方法名称","description":"具体做法描述","estimatedVisualBenefit":8,"estimatedRisk":3,"rationale":"你认为这个建议合理的理由"}]}',
      });

      return {
        provider: "deepseek-free-recommendation",
        suggestions: object.suggestions,
        latencyMs: Date.now() - start,
        raw: object,
        usage,
      };
    },
  };
}
