import assert from "node:assert/strict";
import test from "node:test";

import {
  meterProviderMethod,
  setActiveProviderOperationRecorder,
  usageFromProviderResult,
  type ProviderOperationRecorder,
} from "./providerOperationMeter.js";

test("provider operation decorator records provider-reported tokens once", async (t) => {
  const records: unknown[] = [];
  const recorder: ProviderOperationRecorder = { record: async (record) => { records.push(record); } };
  setActiveProviderOperationRecorder(recorder);
  t.after(() => setActiveProviderOperationRecorder({ record: async () => {} }));

  const provider = meterProviderMethod({
    name: "text-provider",
    async generate() { return { usage: { inputTokens: 100, outputTokens: 20 } }; },
  }, { provider: "deepseek", operation: "text_planning", model: "deepseek-v4-flash", method: "generate" });

  await provider.generate();
  assert.deepEqual(records, [{
    provider: "deepseek",
    operation: "text_planning",
    model: "deepseek-v4-flash",
    status: "completed",
    usage: { apiRequestCount: 1, inputTokens: 100, outputTokens: 20, cacheMissInputTokens: 100 },
    providerCallId: undefined,
  }]);
});

test("AI SDK total input tokens are conservatively charged as uncached when detail is absent", () => {
  assert.deepEqual(usageFromProviderResult({ usage: { inputTokens: 100, outputTokens: 20 } }), {
    apiRequestCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheMissInputTokens: 100,
  });
});
