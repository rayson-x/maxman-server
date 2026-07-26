import assert from "node:assert/strict";
import test from "node:test";

import { renderOutfitPreviewsStep } from "./renderPreviews.js";
import type { StepContext, StepDeps } from "./types.js";

test("outfit fallback preserves selectable text candidates without impersonating the user", async () => {
  const outcome = await renderOutfitPreviewsStep.run(
    {
      candidates: [
        {
          candidateId: "outfit-1",
          nameZh: "素色 T 恤 + 直筒裤",
          modelRationale: "颜色克制、版型利落",
          renderInstruction: "换成素色 T 恤和直筒裤",
        },
      ],
    },
    { jobId: "job", userId: "user", planId: "plan" } satisfies StepContext,
    {} as StepDeps,
  );

  assert.notEqual(outcome.status, "failed");
  if (outcome.status === "failed") return;
  assert.equal(outcome.data.mode, "text_and_reference_only");
  assert.deepEqual(outcome.data.previews, [
    {
      candidateId: "outfit-1",
      nameZh: "素色 T 恤 + 直筒裤",
      storageKey: null,
      readUrl: null,
      latencyMs: 0,
      referenceOnly: true,
      rationale: "颜色克制、版型利落",
    },
  ]);
});
