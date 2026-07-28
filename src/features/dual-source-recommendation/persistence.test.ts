import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceRecommendationPersistence } from "./persistence.js";
import type { DualSourceResult } from "./engine.js";

const result: DualSourceResult = {
  main: [{ id: "catalog-a", canonicalId: "catalog-a", rank: 1, nameZh: "目录项", rationale: "可行", systemSupported: true, hardConflict: false, source: "consensus" }],
  exploration: [],
  audit: {
    retrieval: { retrievedCount: 1, submittedCount: 1, batchCount: 1, bytes: 20 },
    invalidBIds: [], degradation: "none",
    diff: { diffScore: 0, severity: "none", hardConflict: false, diffPolicyVersion: "dual-source-diff-v1" },
    channels: {
      A: { status: "completed", candidates: [], provider: "provider", model: "model" },
      B: { status: "completed", candidates: [], provider: "provider", model: "model" },
    },
  },
};

test("persists structured comparison, both channel outcomes, and exposure before returning", async () => {
  const calls: Array<{ table: string; args: unknown }> = [];
  const tx = {
    recommendationComparisonLog: { upsert: async (args: unknown) => { calls.push({ table: "comparison", args }); return { id: "comparison-1" }; } },
    recommendationChannelRun: { upsert: async (args: unknown) => { calls.push({ table: "channel", args }); return {}; } },
    recommendationExposure: { upsert: async (args: unknown) => { calls.push({ table: "exposure", args }); return {}; } },
    recommendationReviewerResult: { upsert: async (args: unknown) => { calls.push({ table: "reviewer", args }); return {}; } },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) };
  const persistence = createDualSourceRecommendationPersistence(prisma as never);
  await persistence.persist({
    userId: "user", planId: "plan", domain: "style", generation: 1, computationKey: "key",
    commonInput: { profileSnapshotRef: "profile-v1", originalAssetRefs: ["original-photo"], selectedUpstream: {}, model: { provider: "provider", model: "model", temperature: 0, tokenLimit: 100 } },
    promptVersion: "prompt-v1", schemaVersion: "schema-v1", result,
  });
  assert.deepEqual(calls.map((call) => call.table), ["comparison", "channel", "channel", "exposure"]);
  const comparison = calls[0]!.args as { create: { photoAssetRefs: string[]; retrievalAudit: unknown; stochasticComparison: boolean } };
  assert.deepEqual(comparison.create.photoAssetRefs, ["original-photo"]);
  assert.deepEqual(comparison.create.retrievalAudit, result.audit.retrieval);
  assert.equal(comparison.create.stochasticComparison, true);
  const exposure = calls[3]!.args as { create: { source: string; position: number; candidateSnapshot: { canonicalId: string } } };
  assert.equal(exposure.create.source, "consensus");
  assert.equal(exposure.create.position, 1);
  assert.equal(exposure.create.candidateSnapshot.canonicalId, "catalog-a");
});

test("reuses only completed structured channel results with matching immutable input versions", async () => {
  const prisma = {
    recommendationComparisonLog: {
      findUnique: async () => ({
        profileSnapshotRef: "profile-v1",
        photoAssetRefs: ["original-photo"],
        appearanceAnalysisRef: null,
        questionnaireSnapshotRef: null,
        recommendationContextRef: null,
        catalogManifestVersion: "catalog-v1",
        inputVersions: {
          selectedUpstream: { styleId: "clean" },
          model: { provider: "provider", model: "model", temperature: 0, tokenLimit: 100 },
          promptVersion: "prompt-v1",
          schemaVersion: "schema-v1",
        },
        channelRuns: [
          {
            channel: "A",
            status: "completed",
            structuredResult: { candidates: [result.main[0]] },
            provider: "provider",
            model: "model",
            modelVersion: null,
            latencyMs: 12,
            cost: null,
          },
          {
            channel: "B",
            status: "failed",
            structuredResult: null,
            provider: "provider",
            model: "model",
            modelVersion: null,
            latencyMs: null,
            cost: null,
          },
        ],
      }),
    },
  };
  const persistence = createDualSourceRecommendationPersistence(prisma as never);
  const reused = await persistence.findReusableChannels({
    planId: "plan", domain: "style", generation: 1, computationKey: "key",
    commonInput: {
      profileSnapshotRef: "profile-v1",
      originalAssetRefs: ["original-photo"],
      selectedUpstream: { styleId: "clean" },
      model: { provider: "provider", model: "model", temperature: 0, tokenLimit: 100 },
    },
    catalogManifestVersion: "catalog-v1",
    promptVersion: "prompt-v1",
    schemaVersion: "schema-v1",
  });
  assert.deepEqual(Object.keys(reused), ["A"]);
  assert.equal(reused.A?.candidates[0]?.canonicalId, "catalog-a");
});

test("maps a catalog-external concept for future resolution without changing historical exposures", async () => {
  const calls: string[] = [];
  const tx = {
    conceptCatalogMapping: {
      upsert: async () => { calls.push("mapping"); return { id: "mapping-1" }; },
    },
    catalogGap: {
      findUnique: async () => { calls.push("gap-read"); return { id: "gap-1" }; },
      update: async () => { calls.push("gap-update"); return {}; },
    },
    assetGenerationQueue: {
      updateMany: async () => { calls.push("asset-update"); return { count: 1 }; },
    },
  };
  const prisma = { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) };
  const persistence = createDualSourceRecommendationPersistence(prisma as never);
  await persistence.mapConceptToCatalog({
    domain: "wardrobe",
    conceptItemId: "concept:wardrobe:external",
    catalogItemId: "wardrobe:reviewed-item",
    assetStatus: "ready",
    reviewedBy: "catalog-ops",
  });
  assert.deepEqual(calls, ["mapping", "gap-read", "gap-update", "asset-update"]);
});
