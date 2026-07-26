import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { AdversarialReviewProvider } from "../providers/adversarialReview/types.js";

const CONSTRAINED_SCORE_SCHEMA = z.object({
  catalogEntryId: z.string(),
  visualBenefit: z.number(),
  credibility: z.number(),
  acceptance: z.number(),
  reversibility: z.number(),
  timeCost: z.number(),
  moneyCost: z.number(),
  risk: z.number(),
  rationale: z.string(),
});

const FREE_SUGGESTION_SCHEMA = z.object({
  title: z.string(),
  description: z.string(),
  estimatedVisualBenefit: z.number(),
  estimatedRisk: z.number(),
  rationale: z.string(),
});

/**
 * Tool 7/7 — the adversarial judge. Takes the outputs of
 * recommend-appearance-directions (catalog-constrained) and
 * suggest-unconstrained-directions (free) and produces a skeptically-vetted
 * verdict per free suggestion plus overall feasibility/improvement-rate
 * scores. Nothing from the free side should be presented to the user unless
 * its verdict here is "accept".
 */
export function createAdversarialReviewTool(provider: AdversarialReviewProvider) {
  return createTool({
    id: "adversarial-review-recommendations",
    description:
      "Adversarially cross-check unconstrained suggestions (from suggest-unconstrained-directions) against the " +
      "catalog-constrained candidates (from recommend-appearance-directions) for the same domain. Returns a " +
      "skeptical accept/reject/needs_professional_review verdict per free suggestion, plus overall feasibility and " +
      "improvement-rate scores for the direction as a whole. Only 'accept' verdicts are safe to present to the user.",
    inputSchema: z.object({
      analysisSummary: z.string(),
      domain: z.enum(["hair", "outfit_accessory"]),
      constrained: z.array(CONSTRAINED_SCORE_SCHEMA).describe("Output from recommend-appearance-directions"),
      free: z.array(FREE_SUGGESTION_SCHEMA).describe("Output from suggest-unconstrained-directions"),
    }),
    execute: async (inputData) => {
      const result = await provider.review({
        analysisSummary: inputData.analysisSummary,
        domain: inputData.domain,
        constrained: inputData.constrained,
        free: inputData.free,
      });
      return {
        provider: result.provider,
        feasibilityScore: result.feasibilityScore,
        improvementRateScore: result.improvementRateScore,
        freeSuggestionVerdicts: result.freeSuggestionVerdicts,
        summary: result.summary,
      };
    },
  });
}
