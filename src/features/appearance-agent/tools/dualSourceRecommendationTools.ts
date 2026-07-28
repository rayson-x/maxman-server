import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Conversation is never trusted to assemble user/profile/photo input. The
 * authorized caller resolves the plan and invokes the same public dual-source
 * domain boundary used by the fixed workflow.
 */
export type AgentRecommendationExecutor = {
  recommendStyleDirections(input: { planId: string }): Promise<unknown>;
  recommendHairstyles(input: { planId: string }): Promise<unknown>;
  recommendWardrobe(input: { planId: string }): Promise<unknown>;
};

const inputSchema = z.object({ planId: z.string().min(1) });

function unavailable(name: string): AgentRecommendationExecutor[keyof AgentRecommendationExecutor] {
  return async () => {
    throw new Error(`${name} requires an authorized recommendation executor`);
  };
}

/** The only recommendation tools exposed to the conversation Agent. */
export function createDualSourceRecommendationAgentTools(executor?: AgentRecommendationExecutor) {
  const resolved: AgentRecommendationExecutor = executor ?? {
    recommendStyleDirections: unavailable("recommend-style-directions"),
    recommendHairstyles: unavailable("recommend-hairstyles"),
    recommendWardrobe: unavailable("recommend-wardrobe"),
  };
  return {
    "recommend-style-directions": createTool({
      id: "recommend-style-directions",
      description: "使用当前已授权方案生成风格方向；不接受候选、照片或目录内容。",
      inputSchema,
      execute: ({ planId }) => resolved.recommendStyleDirections({ planId }),
    }),
    "recommend-hairstyles": createTool({
      id: "recommend-hairstyles",
      description: "使用当前已选择的风格生成发型候选；缺少风格时由授权边界拒绝。",
      inputSchema,
      execute: ({ planId }) => resolved.recommendHairstyles({ planId }),
    }),
    "recommend-wardrobe": createTool({
      id: "recommend-wardrobe",
      description: "使用当前已选择的风格和发型生成穿搭候选；不直接访问系统目录。",
      inputSchema,
      execute: ({ planId }) => resolved.recommendWardrobe({ planId }),
    }),
  };
}

