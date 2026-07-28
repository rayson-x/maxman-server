import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceProviderAdapter } from "./providerAdapter.js";
import { createDualSourceRecommendationTools } from "./tools.js";

const common = {
  userId: "u", planId: "p", generation: 1, computationKey: "key",
  commonInput: { profileSnapshotRef: "profile", originalAssetRefs: ["original-front"], selectedUpstream: {}, model: { provider: "fake", model: "fake-v1", temperature: 0, tokenLimit: 100 } },
  profileSnapshotRef: "profile", promptVersion: "prompt-v1", schemaVersion: "schema-v1",
};

test("the three public domain tools use one adapter and enforce upstream waiting points", async () => {
  const calls: string[] = [];
  const adapter = createDualSourceProviderAdapter({
    contextByteBudget: 200_000,
    maxMainCandidates: 3,
    async invoke(request) {
      calls.push(`${request.domain}:${request.channel}`);
      return request.channel === "B"
        ? request.systemContext!.candidates.map((candidate) => ({ nameZh: candidate.candidate.nameZh, rationale: "目录支持" }))
        : [];
    },
  });
  const persisted: unknown[] = [];
  const tools = createDualSourceRecommendationTools({
    adapter,
    persistence: {
      findReusableChannels: async () => ({}),
      persist: async (input: unknown) => { persisted.push(input); return { id: "comparison" }; },
    } as never,
  });

  await assert.rejects(
    () => tools.recommendHairstyles({ ...common, selectedStyleId: null, hairSignals: { hairline: "normal", volume: "medium" }, renderProvider: "ark", renderModel: "seedream" }),
    /style_not_selected/,
  );
  await assert.rejects(
    () => tools.recommendWardrobe({ ...common, selectedStyleId: "clean-fit", selectedHairstyleId: null }),
    /hairstyle_not_selected/,
  );
  const style = await tools.recommendStyleDirections(common);
  assert.equal(style.audit.retrieval.retrievedCount, 41);
  assert.deepEqual(calls.slice(0, 2).sort(), ["style:A", "style:B"]);
  assert.equal(persisted.length, 1);
});

test("underfed hairstyle relations create a catalog gap instead of claiming catalog verification", async () => {
  const adapter = createDualSourceProviderAdapter({
    contextByteBudget: 200_000,
    maxMainCandidates: 3,
    async invoke(request) {
      return request.channel === "B"
        ? request.systemContext!.candidates.map((candidate) => ({ nameZh: candidate.candidate.nameZh, rationale: "目录支持" }))
        : [];
    },
  });
  const gaps: unknown[] = [];
  const tools = createDualSourceRecommendationTools({
    adapter,
    persistence: {
      findReusableChannels: async () => ({}),
      persist: async () => ({ id: "comparison" }),
      recordCatalogGap: async (input: unknown) => { gaps.push(input); return { id: "gap" }; },
    } as never,
  });
  await tools.recommendHairstyles({
    ...common,
    selectedStyleId: "american-workwear",
    commonInput: { ...common.commonInput, selectedUpstream: { styleId: "american-workwear" } },
    hairSignals: { hairline: "normal", volume: "medium" },
    renderProvider: "ark",
    renderModel: "seedream",
  });
  assert.deepEqual(gaps, [{
    planId: "p",
    domain: "hairstyle",
    generation: 1,
    computationKey: "key",
    conceptItemId: "american-workwear",
    reason: "incomplete_hairstyle_relation_coverage",
  }]);
});
