import assert from "node:assert/strict";
import test from "node:test";
import { buildDualSourceProviderPrompt, createZhipuDualSourceChannelProvider } from "./zhipuChannelProvider.js";

const commonInput = {
  profileSnapshotRef: "profile", originalAssetRefs: ["front-original"], selectedUpstream: { styleId: "clean-fit" },
  userContext: { heightCm: 175, hasFullBodyPhoto: false },
  model: { provider: "zhipu", model: "glm", temperature: 0.2, tokenLimit: 600 },
};

test("real channel adapter keeps A catalog-blind and gives both channels the same original photos and model settings", async () => {
  const requests: Array<{ prompt: string; photoReadUrls: readonly string[]; temperature: number; tokenLimit: number }> = [];
  const invoke = createZhipuDualSourceChannelProvider({
    originalPhotoReadUrls: ["https://short-lived.example/original-front"],
    invoke: async (input) => { requests.push(input); return { candidates: [{ nameZh: "Clean Fit", rationale: "适合日常" }] }; },
  });
  const a = { channel: "A" as const, domain: "style" as const, commonInput };
  const b = {
    channel: "B" as const, domain: "style" as const, commonInput,
    systemContext: { candidates: [{ stableId: "clean-fit", bytes: 1, candidate: { id: "clean-fit", canonicalId: "clean-fit", rank: 1, nameZh: "Clean Fit", rationale: "目录理由", systemSupported: true, hardConflict: false } }], rules: [] },
  };
  await invoke(a);
  await invoke(b);
  assert.deepEqual(requests.map((row) => row.photoReadUrls), [["https://short-lived.example/original-front"], ["https://short-lived.example/original-front"]]);
  assert.deepEqual(requests.map((row) => [row.temperature, row.tokenLimit]), [[0.2, 600], [0.2, 600]]);
  assert.doesNotMatch(requests[0]!.prompt, /系统候选投影|Clean Fit|目录理由/);
  assert.match(requests[1]!.prompt, /系统候选投影/);
  assert.doesNotMatch(buildDualSourceProviderPrompt(a), /目录理由/);
});

test("wardrobe recommendation without a full-body photo forbids visual-proportion claims in both channels", () => {
  const input = {
    ...commonInput,
    userContext: { visualBodyEvidence: "missing", heightCm: 175, weightKg: 65 },
  };
  const a = { channel: "A" as const, domain: "wardrobe" as const, commonInput: input };
  const b = {
    ...a,
    channel: "B" as const,
    systemContext: { candidates: [], rules: [] },
  };
  for (const request of [a, b]) {
    assert.match(buildDualSourceProviderPrompt(request), /没有全身照.*不得声称观察到身材比例/);
  }
});
