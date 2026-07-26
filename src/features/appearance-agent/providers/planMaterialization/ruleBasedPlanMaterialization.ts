import type {
  PlanMaterializationProvider,
  PlanScoringWeights,
  PlanTaskDimensions,
} from "./types.js";

export function computeRuleBasedCompositeScore(
  dimensions: PlanTaskDimensions,
  weights: PlanScoringWeights,
): number {
  return (
    weights.visualBenefit * dimensions.visualBenefit +
    weights.credibility * dimensions.credibility +
    weights.acceptance * dimensions.acceptance +
    weights.reversibility * dimensions.reversibility -
    weights.timeCost * dimensions.timeCost -
    weights.moneyCost * dimensions.moneyCost -
    weights.risk * dimensions.risk
  );
}

export function createRuleBasedPlanMaterializationProvider(): PlanMaterializationProvider {
  return {
    name: "rule-based-plan-materialization",
    async scoreTasks(input) {
      return {
        provider: "rule-based-plan-materialization",
        scores: Object.fromEntries(
          input.tasks.map((task) => [
            task.key,
            task.dimensions
              ? computeRuleBasedCompositeScore(task.dimensions, input.weights)
              : null,
          ]),
        ),
      };
    },
  };
}
