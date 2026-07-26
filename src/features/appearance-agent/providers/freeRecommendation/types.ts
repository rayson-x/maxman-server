export interface FreeRecommendationInput {
  analysisSummary: string;
  domain: "hair" | "outfit_accessory";
}

export interface FreeSuggestion {
  title: string;
  description: string;
  /** Model's own self-assessed scores, 0-10 — not cross-checked against anything yet (that's the adversarial-review step). */
  estimatedVisualBenefit: number;
  estimatedRisk: number;
  rationale: string;
}

export interface FreeRecommendationResult {
  provider: string;
  suggestions: FreeSuggestion[];
  latencyMs: number;
  raw?: unknown;
}

export interface FreeRecommendationProvider {
  readonly name: string;
  suggest(input: FreeRecommendationInput): Promise<FreeRecommendationResult>;
}
