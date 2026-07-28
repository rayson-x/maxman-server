import assert from "node:assert/strict";
import test from "node:test";
import {
  DualSourceRecommendationEngine,
  type ChannelInvocation,
  type DomainCandidate,
} from "./engine.js";

const candidate = (id: string, rank: number, overrides: Partial<DomainCandidate> = {}): DomainCandidate => ({
  id,
  canonicalId: id,
  rank,
  nameZh: id,
  rationale: `${id} 的造型可行性说明`,
  systemSupported: false,
  hardConflict: false,
  ...overrides,
});

const recalled = [
  { stableId: "a", bytes: 40, candidate: candidate("a", 1, { systemSupported: true }) },
  { stableId: "b", bytes: 40, candidate: candidate("b", 2, { systemSupported: true }) },
  { stableId: "c", bytes: 40, candidate: candidate("c", 3, { systemSupported: true }) },
];

test("runs identical A/B user inputs concurrently while B receives every recalled candidate in stable batches", async () => {
  const calls: ChannelInvocation[] = [];
  const engine = new DualSourceRecommendationEngine({ contextByteBudget: 80, maxMainCandidates: 3 });

  const result = await engine.recommend({
    domain: "hairstyle",
    commonInput: {
      profileSnapshotRef: "profile-v1",
      originalAssetRefs: ["photo-front-v1"],
      selectedUpstream: { styleId: "clean-boy" },
      model: { provider: "fake", model: "fake-v1", temperature: 0.2, tokenLimit: 800 },
    },
    recalled,
    rules: [],
    deterministicFallback: recalled.map((row) => row.candidate),
    async runChannel(invocation) {
      calls.push(invocation);
      return invocation.channel === "A"
        ? { candidates: [candidate("a", 1), candidate("x", 2)] }
        : { candidates: invocation.systemContext!.candidates.map((row, index) => candidate(row.stableId, index + 1, { systemSupported: true })) };
    },
  });

  assert.equal(calls.filter((call) => call.channel === "A").length, 1);
  assert.equal(calls.filter((call) => call.channel === "B").length, 2);
  const [a] = calls.filter((call) => call.channel === "A");
  const bCalls = calls.filter((call) => call.channel === "B");
  assert.deepEqual(a!.commonInput, bCalls[0]!.commonInput);
  assert.equal(a!.systemContext, undefined);
  assert.deepEqual(bCalls.flatMap((call) => call.systemContext!.candidates.map((row) => row.stableId)), ["a", "b", "c"]);
  assert.deepEqual(result.audit.retrieval, { retrievedCount: 3, submittedCount: 3, batchCount: 2, bytes: 120 });
  assert.deepEqual(result.main.map((row) => [row.canonicalId, row.source]), [
    ["a", "consensus"],
    ["b", "system_supported"],
    ["c", "system_supported"],
  ]);
  assert.deepEqual(result.exploration.map((row) => row.canonicalId), ["x"]);
});

test("rejects B candidates outside the recalled batch and never promotes a hard-conflict A-only candidate", async () => {
  const engine = new DualSourceRecommendationEngine({ contextByteBudget: 1000, maxMainCandidates: 3 });
  const result = await engine.recommend({
    domain: "hairstyle",
    commonInput: { profileSnapshotRef: "p", originalAssetRefs: ["front"], selectedUpstream: {}, model: { provider: "fake", model: "v1", temperature: 0, tokenLimit: 1 } },
    recalled: recalled.slice(0, 1),
    rules: [],
    deterministicFallback: [candidate("a", 1, { systemSupported: true })],
    async runChannel(invocation) {
      return invocation.channel === "A"
        ? { candidates: [candidate("unsafe", 1, { hardConflict: true })] }
        : { candidates: [candidate("unknown-to-b", 1, { systemSupported: true })] };
    },
  });

  assert.deepEqual(result.main.map((row) => [row.canonicalId, row.source]), [["a", "deterministic_system"]]);
  assert.deepEqual(result.exploration, []);
  assert.deepEqual(result.audit.invalidBIds, ["unknown-to-b"]);
});

test("uses the specified single-channel and catalog-unavailable degradation paths", async () => {
  const engine = new DualSourceRecommendationEngine({ contextByteBudget: 1000, maxMainCandidates: 3 });
  const bOnly = await engine.recommend({
    domain: "style",
    commonInput: { profileSnapshotRef: "p", originalAssetRefs: ["front"], selectedUpstream: {}, model: { provider: "fake", model: "v1", temperature: 0, tokenLimit: 1 } },
    recalled: recalled.slice(0, 1), rules: [], deterministicFallback: [candidate("a", 1, { systemSupported: true })],
    async runChannel(invocation) {
      if (invocation.channel === "A") throw new Error("timeout");
      return { candidates: [candidate("a", 1, { systemSupported: true })] };
    },
  });
  assert.equal(bOnly.audit.degradation, "a_failed");
  assert.deepEqual(bOnly.main.map((row) => row.source), ["system_supported"]);

  const catalogUnavailable = await engine.recommend({
    domain: "style",
    commonInput: { profileSnapshotRef: "p", originalAssetRefs: ["front"], selectedUpstream: {}, model: { provider: "fake", model: "v1", temperature: 0, tokenLimit: 1 } },
    recalled: [], rules: [], deterministicFallback: [], catalogAvailable: false,
    async runChannel(invocation) {
      assert.equal(invocation.channel, "A");
      return { candidates: [candidate("outside-catalog", 1)] };
    },
  });
  assert.equal(catalogUnavailable.audit.degradation, "catalog_unavailable");
  assert.deepEqual(catalogUnavailable.main, []);
  assert.deepEqual(catalogUnavailable.exploration.map((row) => row.source), ["exploration"]);
});

test("times out each channel independently without retrying the successful peer", async () => {
  const calls: string[] = [];
  const engine = new DualSourceRecommendationEngine({
    contextByteBudget: 1000,
    maxMainCandidates: 3,
    channelTimeoutMs: 10,
  });
  const result = await engine.recommend({
    domain: "style",
    commonInput: { profileSnapshotRef: "p", originalAssetRefs: ["front"], selectedUpstream: {}, model: { provider: "fake", model: "v1", temperature: 0, tokenLimit: 1 } },
    recalled: recalled.slice(0, 1), rules: [], deterministicFallback: [candidate("a", 1, { systemSupported: true })],
    async runChannel(invocation) {
      calls.push(invocation.channel);
      if (invocation.channel === "B") await new Promise((resolve) => setTimeout(resolve, 50));
      return { candidates: [candidate("a", 1, { systemSupported: invocation.channel === "B" })] };
    },
  });
  assert.deepEqual(calls.sort(), ["A", "B"]);
  assert.equal(result.audit.degradation, "b_failed");
  assert.deepEqual(result.main.map((row) => row.source), ["deterministic_system"]);
  assert.deepEqual(result.exploration.map((row) => row.source), ["exploration"]);
});

test("reuses a completed channel and retries only the failed peer for the same computation", async () => {
  const calls: string[] = [];
  const engine = new DualSourceRecommendationEngine({ contextByteBudget: 1000, maxMainCandidates: 3 });
  const result = await engine.recommend({
    domain: "style",
    commonInput: { profileSnapshotRef: "p", originalAssetRefs: ["front"], selectedUpstream: {}, model: { provider: "fake", model: "v1", temperature: 0, tokenLimit: 1 } },
    recalled: recalled.slice(0, 1),
    rules: [],
    deterministicFallback: [candidate("a", 1, { systemSupported: true })],
    reusedChannels: {
      A: { candidates: [candidate("a", 1)], provider: "fake", model: "v1" },
    },
    async runChannel(invocation) {
      calls.push(invocation.channel);
      return { candidates: [candidate("a", 1, { systemSupported: true })], provider: "fake", model: "v1" };
    },
  });

  assert.deepEqual(calls, ["B"]);
  assert.equal(result.audit.channels.A.reused, true);
  assert.equal(result.audit.channels.B.reused, false);
  assert.deepEqual(result.main.map((row) => row.source), ["consensus"]);
});
