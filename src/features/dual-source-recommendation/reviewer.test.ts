import assert from "node:assert/strict";
import test from "node:test";
import { createDualSourceReviewer, reviewerPrompt } from "./reviewer.js";
import { setActiveProviderOperationRecorder, type ProviderOperationRecorder } from "../../services/providerOperationMeter.js";

test("reviewer prompt contains only structured diff/channel evidence, never photo URLs or raw prompts", () => {
  const prompt = reviewerPrompt({
    domain: "hairstyle",
    diffResult: { diffScore: 0.8, invalidBIds: ["unknown"] },
    channels: [{
      channel: "A",
      structuredResult: {
        candidates: [{ nameZh: "短碎发" }],
        photoUrl: "https://short-lived.example/original-front",
        rawPrompt: "SECRET-RAW-PROMPT",
      },
    }],
  });
  assert.match(prompt, /hairstyle/);
  assert.match(prompt, /短碎发/);
  assert.doesNotMatch(prompt, /https?:\/\//);
  assert.doesNotMatch(prompt, /SECRET-RAW-PROMPT/);
});

test("asynchronous reviewer records DeepSeek token usage", async (t) => {
  const records: unknown[] = [];
  const recorder: ProviderOperationRecorder = { record: async (record) => { records.push(record); } };
  setActiveProviderOperationRecorder(recorder);
  t.after(() => setActiveProviderOperationRecorder({ record: async () => {} }));

  const prisma = {
    recommendationComparisonLog: {
      findUnique: async () => ({
        id: "comparison-1",
        domain: "hairstyle",
        reviewerStatus: "pending",
        diffResult: { diffScore: 0.8 },
        channelRuns: [],
      }),
      update: async () => ({}),
    },
    recommendationReviewerResult: { upsert: async () => ({}) },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const reviewer = createDualSourceReviewer(prisma as never, {
    generateReview: async () => ({
      object: {
        classification: "agree",
        relatedRuleIds: [],
        notes: "结构化结果一致",
        suggestion: "无需动作",
      },
      usage: { inputTokens: 160, outputTokens: 24 },
      response: { id: "review-call" },
    }),
  });

  await reviewer.review("comparison-1");
  assert.deepEqual(records, [{
    provider: "deepseek",
    operation: "dual_source_review",
    model: "deepseek-v4-flash",
    status: "completed",
    providerCallId: "review-call",
    usage: { apiRequestCount: 1, inputTokens: 160, outputTokens: 24, cacheMissInputTokens: 160 },
  }]);
});
