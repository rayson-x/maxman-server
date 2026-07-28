import assert from "node:assert/strict";
import test from "node:test";
import { createRecommendationApplication } from "./recommendationApplication.js";

test("selecting an exposed catalog-external candidate raises its gap and asset priority", async () => {
  const calls: string[] = [];
  const candidate = {
    id: "candidate-1",
    nameZh: "目录外穿搭",
    set: {
      planId: "plan-1",
      kind: "outfit",
      status: "ready",
      plan: { userId: "user-1", selectedStyle: { id: "clean-fit" }, selectedHairstyleId: "hair-1" },
      comparisonLog: { id: "comparison-1", domain: "wardrobe" },
    },
  };
  const tx = {
    appearancePlan: { update: async () => { calls.push("plan"); return {}; } },
    conversationDecision: { create: async () => { calls.push("decision"); return {}; } },
    recommendationExposure: {
      findFirst: async () => ({ id: "exposure-1", candidateSnapshot: { canonicalId: "concept:wardrobe:external" } }),
    },
    recommendationChoice: { upsert: async () => { calls.push("choice"); return {}; } },
    catalogGap: {
      findUnique: async () => ({ id: "gap-1" }),
      update: async () => { calls.push("gap"); return {}; },
    },
    assetGenerationQueue: { updateMany: async () => { calls.push("asset-priority"); return { count: 1 }; } },
  };
  const prisma = {
    recommendationCandidate: { findUnique: async () => candidate },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const provider = { name: "test", version: "v1", source: "hybrid" as const, recommend: async () => ({ candidates: [] }) };
  const app = createRecommendationApplication({ prisma: prisma as never, hairstyleProvider: provider, outfitProvider: provider });

  const result = await app.selectCandidate({ userId: "user-1", planId: "plan-1", candidateId: "candidate-1", expectedKind: "outfit" });
  assert.deepEqual(result, { ok: true, candidateId: "candidate-1", nameZh: "目录外穿搭" });
  assert.deepEqual(calls, ["plan", "decision", "choice", "gap", "asset-priority"]);
});
