import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { FreeRecommendationProvider } from "../providers/freeRecommendation/types.js";

/**
 * Tool 6/7 — the "unconstrained" half of the adversarial-review pair (see
 * design's data-engine vs free-agent split). Output here is NOT vetted —
 * the agent must always follow this up with adversarial-review-recommendations
 * before presenting any of these suggestions to the user as if they were
 * trustworthy.
 */
export function createSuggestUnconstrainedDirectionsTool(provider: FreeRecommendationProvider) {
  return createTool({
    id: "suggest-unconstrained-directions",
    description:
      "Get UNVETTED, unconstrained improvement suggestions for a domain (hair/outfit_accessory) — no catalog " +
      "restriction, the model can propose anything. These suggestions are NOT safe to show the user as-is: always " +
      "follow this with adversarial-review-recommendations before presenting any of them.",
    inputSchema: z.object({
      analysisSummary: z.string().describe("The structured vision-analysis text describing the user's current appearance"),
      domain: z.enum(["hair", "outfit_accessory"]),
    }),
    execute: async (inputData) => {
      const result = await provider.suggest({ analysisSummary: inputData.analysisSummary, domain: inputData.domain });
      return {
        provider: result.provider,
        suggestions: result.suggestions,
      };
    },
  });
}
