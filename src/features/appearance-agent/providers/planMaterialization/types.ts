export type PlanTaskDimensions = {
  visualBenefit: number;
  credibility: number;
  acceptance: number;
  reversibility: number;
  timeCost: number;
  moneyCost: number;
  risk: number;
};

export type PlanScoringWeights = PlanTaskDimensions;

export type PlanMaterializationInput = {
  tasks: { key: string; dimensions?: PlanTaskDimensions }[];
  weights: PlanScoringWeights;
};

export type PlanMaterializationResult = {
  provider: string;
  scores: Record<string, number | null>;
};

/** Scoring seam only; stage placement and hard gates stay deterministic. */
export interface PlanMaterializationProvider {
  readonly name: string;
  scoreTasks(input: PlanMaterializationInput): Promise<PlanMaterializationResult>;
}
