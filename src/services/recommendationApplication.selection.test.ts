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

  const result = await app.selectCandidate({ userId: "user-1", planId: "plan-1", candidateId: "candidate-1", expectedKinds: ["outfit"] });
  assert.deepEqual(result, { ok: true, candidateId: "candidate-1", nameZh: "目录外穿搭" });
  assert.deepEqual(calls, ["plan", "decision", "choice", "gap", "asset-priority"]);
});

test("changing hairstyle invalidates dependent outfit sets and active preview assets", async () => {
  const calls: string[] = [];
  const candidate = {
    id: "hair-2",
    nameZh: "短碎发",
    styleDirectionId: "clean-fit",
    set: {
      id: "hair-set-1",
      planId: "plan-1",
      kind: "hairstyle",
      status: "ready",
      plan: { userId: "user-1", selectedStyle: { id: "clean-fit" }, selectedHairstyleId: "hair-1" },
      comparisonLog: null,
    },
  };
  const tx = {
    appearancePlan: { update: async () => { calls.push("plan"); return {}; } },
    recommendationSet: { updateMany: async () => { calls.push("sets"); return { count: 1 }; } },
    generatedAsset: { updateMany: async () => { calls.push("assets"); return { count: 2 }; } },
    conversationDecision: { create: async () => { calls.push("decision"); return {}; } },
  };
  const prisma = {
    recommendationCandidate: { findUnique: async () => candidate },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const provider = { name: "test", version: "v1", source: "hybrid" as const, recommend: async () => ({ candidates: [] }) };
  const app = createRecommendationApplication({ prisma: prisma as never, hairstyleProvider: provider, outfitProvider: provider });

  const result = await app.selectCandidate({ userId: "user-1", planId: "plan-1", candidateId: "hair-2", expectedKinds: ["hairstyle", "hairstyle_wig"] });

  assert.deepEqual(result, { ok: true, candidateId: "hair-2", nameZh: "短碎发" });
  assert.deepEqual(calls, ["plan", "sets", "assets", "decision"]);
});

test("a wig-set candidate is selectable and behaves like a hairstyle selection", async () => {
  /*
   * 假发款落在独立集合（kind: hairstyle_wig）里，好让默认发型列表在结构上不可能被污染。
   * 但对用户来说它就是「选了一个发型」—— 所以写 selectedHairstyleId、按风格方向校验、
   * 失效下游穿搭这几件事都必须照常发生，否则这个集合就是只能看不能选。
   */
  const calls: string[] = [];
  const candidate = {
    id: "wig-1",
    nameZh: "大背头",
    styleDirectionId: "clean-fit",
    set: {
      id: "wig-set-1",
      planId: "plan-1",
      kind: "hairstyle_wig",
      status: "ready",
      plan: { userId: "user-1", selectedStyle: { id: "clean-fit" }, selectedHairstyleId: "hair-1" },
      comparisonLog: null,
    },
  };
  const tx = {
    appearancePlan: { update: async () => { calls.push("plan"); return {}; } },
    recommendationSet: { updateMany: async () => { calls.push("sets"); return { count: 1 }; } },
    generatedAsset: { updateMany: async () => { calls.push("assets"); return { count: 0 }; } },
    conversationDecision: { create: async () => { calls.push("decision"); return {}; } },
  };
  const prisma = {
    recommendationCandidate: { findUnique: async () => candidate },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const provider = { name: "test", version: "v1", source: "hybrid" as const, recommend: async () => ({ candidates: [] }) };
  const app = createRecommendationApplication({ prisma: prisma as never, hairstyleProvider: provider, outfitProvider: provider });

  const result = await app.selectCandidate({
    userId: "user-1",
    planId: "plan-1",
    candidateId: "wig-1",
    expectedKinds: ["hairstyle", "hairstyle_wig"],
  });

  assert.deepEqual(result, { ok: true, candidateId: "wig-1", nameZh: "大背头" });
  assert.deepEqual(calls, ["plan", "sets", "assets", "decision"]);
});

test("a wig-set candidate outside the selected style direction is rejected", async () => {
  const candidate = {
    id: "wig-2",
    nameZh: "飞机头",
    styleDirectionId: "street",
    set: {
      id: "wig-set-1",
      planId: "plan-1",
      kind: "hairstyle_wig",
      status: "ready",
      plan: { userId: "user-1", selectedStyle: { id: "clean-fit" }, selectedHairstyleId: null },
      comparisonLog: null,
    },
  };
  const prisma = {
    recommendationCandidate: { findUnique: async () => candidate },
    $transaction: async () => undefined,
  };
  const provider = { name: "test", version: "v1", source: "hybrid" as const, recommend: async () => ({ candidates: [] }) };
  const app = createRecommendationApplication({ prisma: prisma as never, hairstyleProvider: provider, outfitProvider: provider });

  const result = await app.selectCandidate({ userId: "user-1", planId: "plan-1", candidateId: "wig-2" });
  assert.deepEqual(result, { ok: false, reason: "candidate_not_in_selected_style" });
});
