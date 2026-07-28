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
