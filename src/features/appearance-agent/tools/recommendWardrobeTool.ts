import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { recommendWardrobe } from "../../wardrobe-recommendation/recommend.js";

/** The only public wardrobe recommendation tool. Its catalog matcher is shared with fixed workflows. */
export function createRecommendWardrobeTool() {
  return createTool({
    id: "recommend-wardrobe",
    description: "从 BetterMeet 已审核的中国男性系统衣柜中返回可执行穿搭。必须传入用户已选风格；工具保证保留该选择，体型与场景只做软排序。",
    inputSchema: z.object({
      profile: z.object({
        ageBand: z.string().nullable().optional(), heightCm: z.number().nullable().optional(), weightKg: z.number().nullable().optional(),
        bodyType: z.string().nullable().optional(), faceShape: z.string().nullable().optional(), hairVolume: z.string().nullable().optional(),
        hairlineSignal: z.string().nullable().optional(), budgetTier: z.string().nullable().optional(), scene: z.string().nullable().optional(),
        season: z.enum(["春", "夏", "秋", "冬"]).nullable().optional(), formalityNeed: z.number().min(1).max(10).nullable().optional(),
      }),
      request: z.object({ selectedStyleIds: z.array(z.string()).min(1).max(3), requestedLookCount: z.number().int().min(1).max(3).optional(), includeExplorationStyles: z.boolean().optional(), includeSupply: z.boolean().optional() }),
    }),
    execute: async ({ profile, request }) => recommendWardrobe(profile, request),
  });
}
