import type { CandidateTaskCatalogEntry } from "../../data/candidateTaskCatalog.js";

export interface TextPlanningInput {
  /** Structured vision-analysis text (from analyze-appearance-photo) plus any self-reported context. */
  analysisSummary: string;
  /** Only entries the model is allowed to choose from — already filtered to isRecommended=true. */
  candidates: CandidateTaskCatalogEntry[];
}

export interface TextPlanningScore {
  catalogEntryId: string;
  /** Each 0-10, raw dimension scores — NOT a final rank. Fixed-weight scoring/sorting is business logic, not the model's job (design.md decision 6). */
  visualBenefit: number;
  credibility: number;
  acceptance: number;
  reversibility: number;
  timeCost: number;
  moneyCost: number;
  risk: number;
  rationale: string;
}

export interface TextPlanningResult {
  provider: string;
  scores: TextPlanningScore[];
  latencyMs: number;
  raw?: unknown;
}

export interface TextPlanningProvider {
  readonly name: string;
  scoreCandidates(input: TextPlanningInput): Promise<TextPlanningResult>;
}
