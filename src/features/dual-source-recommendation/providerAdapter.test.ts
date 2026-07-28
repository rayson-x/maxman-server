import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceProviderAdapter } from "./providerAdapter.js";

test("adapter sends identical raw input to both channels and only B receives compact catalog context", async () => {
  const calls: unknown[] = [];
  const adapter = createDualSourceProviderAdapter({
    contextByteBudget: 10_000,
    maxMainCandidates: 3,
    async invoke(request) {
      calls.push(request);
      return request.channel === "A"
        ? [{ nameZh: "目录外方向", rationale: "自由建议" }]
        : request.systemContext!.candidates.map((candidate) => ({ nameZh: candidate.candidate.nameZh, rationale: "系统投影支持" }));
    },
  });
  const result = await adapter.recommend({
    domain: "style",
    commonInput: {
      profileSnapshotRef: "profile-v1",
      originalAssetRefs: ["original-front-photo-v1"],
      selectedUpstream: {},
      model: { provider: "fake", model: "v1", temperature: 0.2, tokenLimit: 800 },
    },
    recalled: [{
      stableId: "clean-fit", bytes: 20,
      candidate: { id: "clean-fit", canonicalId: "clean-fit", rank: 1, nameZh: "Clean Fit", rationale: "目录", systemSupported: true, hardConflict: false },
    }],
    rules: [],
    deterministicFallback: [],
  });
  const [a, b] = calls as Array<{ channel: string; commonInput: unknown; systemContext?: unknown }>;
  assert.deepEqual(a.commonInput, b.commonInput);
  assert.equal(a.systemContext, undefined);
  assert.deepEqual((b.systemContext as { candidates: unknown[] }).candidates.length, 1);
  assert.deepEqual(result.main.map((candidate) => candidate.canonicalId), ["clean-fit"]);
  assert.match(result.exploration[0]!.canonicalId, /^concept:style:/);
});
