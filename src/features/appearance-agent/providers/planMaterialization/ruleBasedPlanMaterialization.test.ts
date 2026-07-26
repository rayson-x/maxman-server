import assert from "node:assert/strict";
import test from "node:test";
import { createRuleBasedPlanMaterializationProvider } from "./ruleBasedPlanMaterialization.js";

test("rule-based materialization provider preserves the existing score and leaves unknown dimensions unavailable", async () => {
  const provider = createRuleBasedPlanMaterializationProvider();
  const result = await provider.scoreTasks({
    tasks: [
      {
        key: "known",
        dimensions: {
          visualBenefit: 8,
          credibility: 7,
          acceptance: 6,
          reversibility: 5,
          timeCost: 4,
          moneyCost: 3,
          risk: 2,
        },
      },
      { key: "unknown" },
    ],
    weights: {
      visualBenefit: 1,
      credibility: 1,
      acceptance: 1,
      reversibility: 1,
      timeCost: 1,
      moneyCost: 1,
      risk: 1,
    },
  });
  assert.equal(result.scores.known, 17);
  assert.equal(result.scores.unknown, null);
});
