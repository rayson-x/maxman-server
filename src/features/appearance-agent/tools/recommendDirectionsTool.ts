import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { TextPlanningProvider } from "../providers/textPlanning/types.js";
import { getRecommendedCatalogEntries } from "../data/candidateTaskCatalog.js";

/**
 * Tool 5/5 — "data engine" for hair/outfit direction recommendations. This
 * is deliberately NOT free-form generation: it only scores entries from the
 * human-curated CandidateTaskCatalog (design.md decision 15), filtered to
 * isRecommended=true before the model ever sees them. The tool returns raw
 * per-dimension scores, not a final ranking — priority/sort order is a fixed
 * weighted-formula business-logic step downstream (design.md decision 6),
 * not something this tool or the agent should compute itself.
 */
export function createRecommendDirectionsTool(provider: TextPlanningProvider) {
  return createTool({
    id: "recommend-appearance-directions",
    description:
      "Given a structured vision-analysis summary of the user (from analyze-appearance-photo) and a domain, return " +
      "candidate hairstyle/outfit improvement directions drawn ONLY from a human-curated method catalog, each with " +
      "raw per-dimension scores (visual benefit, credibility, acceptance, reversibility, time/money cost, risk) and " +
      "a rationale. Does NOT invent new methods and does NOT produce a final ranking — that's separate business logic.",
    inputSchema: z.object({
      analysisSummary: z
        .string()
        .describe("The structured vision-analysis text describing the user's current appearance"),
      domain: z.enum(["hair", "outfit_accessory"]).describe("Which domain to recommend directions for"),
    }),
    execute: async (inputData) => {
      const candidates = getRecommendedCatalogEntries(inputData.domain);
      const result = await provider.scoreCandidates({
        analysisSummary: inputData.analysisSummary,
        candidates,
      });
      return {
        provider: result.provider,
        candidates: result.scores.map((s) => {
          const entry = candidates.find((c) => c.id === s.catalogEntryId);
          return { ...s, methodName: entry?.methodName, description: entry?.description };
        }),
      };
    },
  });
}
