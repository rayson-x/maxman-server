import type { TextPlanningScore } from "../textPlanning/types.js";
import type { FreeSuggestion } from "../freeRecommendation/types.js";

export interface AdversarialReviewInput {
  analysisSummary: string;
  domain: "hair" | "outfit_accessory";
  constrained: TextPlanningScore[];
  free: FreeSuggestion[];
}

export interface FreeSuggestionVerdict {
  title: string;
  /** Adversarial judge's own verdict — deliberately skeptical, biased toward rejecting unless justified. */
  verdict: "accept" | "reject" | "needs_professional_review";
  reason: string;
  /** True if this free suggestion is materially the same idea as an existing catalog-scored candidate. */
  duplicatesCatalogEntry: boolean;
}

export interface AdversarialReviewResult {
  provider: string;
  /** 0-10 — how realistically achievable the overall direction is for this user, given cost/time/risk. */
  feasibilityScore: number;
  /** 0-10 — 提升率: expected magnitude of visible improvement if the accepted suggestions are followed. */
  improvementRateScore: number;
  freeSuggestionVerdicts: FreeSuggestionVerdict[];
  summary: string;
  latencyMs: number;
  raw?: unknown;
  usage?: unknown;
}

export interface AdversarialReviewProvider {
  readonly name: string;
  review(input: AdversarialReviewInput): Promise<AdversarialReviewResult>;
}
