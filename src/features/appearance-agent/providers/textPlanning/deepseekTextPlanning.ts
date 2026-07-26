import { generateObject } from "ai";
import { z } from "zod";
import { createDeepSeekModel } from "../llm/deepseekModel.js";
import type { TextPlanningInput, TextPlanningProvider, TextPlanningResult } from "./types.js";

const SCORE_SCHEMA = z.object({
  scores: z.array(
    z.object({
      catalogEntryId: z.string(),
      visualBenefit: z.number().min(0).max(10),
      credibility: z.number().min(0).max(10),
      acceptance: z.number().min(0).max(10),
      reversibility: z.number().min(0).max(10),
      timeCost: z.number().min(0).max(10),
      moneyCost: z.number().min(0).max(10),
      risk: z.number().min(0).max(10),
      rationale: z.string(),
    }),
  ),
});

/**
 * TextPlanningProvider (design.md decision 6/15): scores candidates the
 * business layer already filtered from CandidateTaskCatalog — never invents
 * new methods. Output is raw per-dimension scores only; the fixed weighted
 * formula that turns these into a final priority/ranking is separate
 * business logic (tasks.md 7.6), not this provider's job.
 */
export function createDeepSeekTextPlanningProvider(): TextPlanningProvider {
  const model = createDeepSeekModel();

  return {
    name: "deepseek-text-planning",
    async scoreCandidates(input: TextPlanningInput): Promise<TextPlanningResult> {
      const start = Date.now();
      const allowedIds = new Set(input.candidates.map((c) => c.id));

      const { object } = await generateObject({
        model,
        schema: SCORE_SCHEMA,
        prompt:
          "你是形象改善方案的评分助手，只输出JSON，不要输出任何JSON之外的文字，也不要用markdown代码块包裹。" +
          "以下是用户的视觉分析结果和一份人工审核过的候选改造方法目录。" +
          "你的任务：只针对目录中列出的候选项，逐项给出各维度0-10分的原始评分，并给出一句合并理由。" +
          "绝对不能提出目录之外的新方法，绝对不能编造候选项之外的id。\n\n" +
          `用户视觉分析结果：\n${input.analysisSummary}\n\n` +
          `候选方法目录（仅从中选择评分，id字段是唯一标识）：\n${JSON.stringify(input.candidates, null, 2)}\n\n` +
          "维度说明：visualBenefit(视觉收益) credibility(可信度) acceptance(用户接受度) reversibility(可逆性，越高越可逆) " +
          "timeCost(耗时成本，越高越耗时) moneyCost(金钱成本，越高越贵) risk(风险，越高越危险)。\n\n" +
          "输出必须严格符合下面这个JSON结构，scores数组每一项对应一个候选项，字段名和类型必须完全一致" +
          "（每个维度都是0到10之间的纯数字，不能是嵌套对象；catalogEntryId必须原样照抄候选目录里的id字段；rationale是一句话总结理由）：\n" +
          '{"scores":[{"catalogEntryId":"hair-01","visualBenefit":8,"credibility":7,"acceptance":6,"reversibility":5,"timeCost":3,"moneyCost":4,"risk":2,"rationale":"一句话理由"}]}',
      });

      // Defense in depth: drop any score referencing an id outside the allowed candidate set,
      // even though the prompt already forbids it.
      const scores = object.scores.filter((s) => allowedIds.has(s.catalogEntryId));

      return {
        provider: "deepseek-text-planning",
        scores,
        latencyMs: Date.now() - start,
        raw: object,
      };
    },
  };
}
