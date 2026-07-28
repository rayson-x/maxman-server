import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceCandidateStore } from "./candidateStore.js";

test("candidate store preserves stable canonical IDs and never marks hybrid output catalog-verified by default", async () => {
  const calls: Array<{ table: string; args: unknown }> = [];
  const tx = {
    recommendationSet: {
      findUnique: async () => null,
      create: async (args: { data: unknown }) => { calls.push({ table: "set.create", args }); return { id: "set" }; },
      update: async (args: unknown) => { calls.push({ table: "set.update", args }); return {}; },
    },
    recommendationCandidate: {
      create: async (args: { data: { providerCandidateKey: string } }) => { calls.push({ table: "candidate.create", args }); return { id: `id-${args.data.providerCandidateKey}`, providerCandidateKey: args.data.providerCandidateKey }; },
    },
    conceptCatalogMapping: { findMany: async () => [] },
  };
  const store = createDualSourceCandidateStore({ $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never);
  const stored = await store.store({
    planId: "plan", domain: "hairstyle", generation: 2, computationKey: "fingerprint", selectedStyleId: "clean-fit",
    candidates: [{ id: "hair-a", canonicalId: "hair-a", rank: 1, nameZh: "短碎发", rationale: "文字可行", systemSupported: true, hardConflict: false, source: "system_supported" }],
  });
  assert.deepEqual(stored.candidateRecordIds, { "hair-a": "id-hair-a" });
  const candidate = calls.find((call) => call.table === "candidate.create")!.args as { data: { styleDirectionId: string; verificationStatus: string; renderInstruction: string } };
  assert.equal(candidate.data.styleDirectionId, "clean-fit");
  assert.equal(candidate.data.verificationStatus, "not_checked");
  assert.equal(candidate.data.renderInstruction, "");
});

test("candidate store resolves a reviewed concept only for a new candidate record", async () => {
  const created: Array<{ providerCandidateKey: string; catalogVariantId: string | null }> = [];
  const tx = {
    conceptCatalogMapping: {
      findMany: async () => [{ conceptItemId: "concept:wardrobe:external", catalogItemId: "wardrobe:reviewed-item" }],
    },
    recommendationSet: {
      findUnique: async () => null,
      create: async () => ({ id: "set" }),
      update: async () => ({}),
    },
    recommendationCandidate: {
      create: async (args: { data: { providerCandidateKey: string; catalogVariantId: string | null } }) => {
        created.push(args.data);
        return { id: "candidate", providerCandidateKey: args.data.providerCandidateKey };
      },
    },
  };
  const store = createDualSourceCandidateStore({ $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never);
  const stored = await store.store({
    planId: "plan", domain: "wardrobe", generation: 1, computationKey: "new-result",
    candidates: [{ id: "concept:wardrobe:external", canonicalId: "concept:wardrobe:external", rank: 1, nameZh: "目录外单品", rationale: "文字可行", systemSupported: false, hardConflict: false, source: "exploration" }],
  });
  assert.deepEqual(
    created.map(({ providerCandidateKey, catalogVariantId }) => ({ providerCandidateKey, catalogVariantId })),
    [{ providerCandidateKey: "wardrobe:reviewed-item", catalogVariantId: "wardrobe:reviewed-item" }],
  );
  assert.deepEqual(stored.candidateRecordIds, { "concept:wardrobe:external": "candidate" });
});

test("candidate store writes a render instruction only for an exact calibrated hairstyle", async () => {
  const created: Array<{ providerCandidateKey: string; renderInstruction: string }> = [];
  const tx = {
    conceptCatalogMapping: { findMany: async () => [] },
    recommendationSet: {
      findUnique: async () => null,
      create: async () => ({ id: "set" }),
      update: async () => ({}),
    },
    recommendationCandidate: {
      create: async (args: { data: { providerCandidateKey: string; renderInstruction: string } }) => {
        created.push(args.data);
        return { id: args.data.providerCandidateKey, providerCandidateKey: args.data.providerCandidateKey };
      },
    },
  };
  const provider = "ark-seedream-image-edit(doubao-seedream-4-5-251128)";
  const store = createDualSourceCandidateStore({ $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as never);
  await store.store({
    planId: "plan", domain: "hairstyle", generation: 1, computationKey: "calibrated", selectedStyleId: "clean-fit",
    previewCalibration: { provider, model: provider },
    candidates: [
      { id: "hair-cn-natural-short-cover", canonicalId: "hair-cn-natural-short-cover", rank: 1, nameZh: "自然短碎盖", rationale: "文字可行", systemSupported: true, hardConflict: false, source: "system_supported" },
      { id: "hair-cn-micro-part-cover", canonicalId: "hair-cn-micro-part-cover", rank: 2, nameZh: "微分碎盖", rationale: "文字可行", systemSupported: true, hardConflict: false, source: "system_supported" },
    ],
  });
  assert.match(created[0]!.renderInstruction, /自然短碎盖/);
  assert.equal(created[1]!.renderInstruction, "");
});
