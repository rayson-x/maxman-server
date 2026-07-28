import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceRecommendationAgentTools } from "./dualSourceRecommendationTools.js";

test("Agent recommendation tools delegate only plan IDs to the authorized shared boundary", async () => {
  const calls: unknown[] = [];
  const tools = createDualSourceRecommendationAgentTools({
    recommendStyleDirections: async (input) => { calls.push(["style", input]); return { ok: true }; },
    recommendHairstyles: async (input) => { calls.push(["hair", input]); return { ok: true }; },
    recommendWardrobe: async (input) => { calls.push(["wardrobe", input]); return { ok: true }; },
  });
  await tools["recommend-hairstyles"].execute!({ planId: "plan-1" }, {} as never);
  assert.deepEqual(calls, [["hair", { planId: "plan-1" }]]);
  assert.deepEqual(Object.keys(tools).sort(), ["recommend-hairstyles", "recommend-style-directions", "recommend-wardrobe"]);
});
