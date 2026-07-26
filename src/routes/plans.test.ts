import assert from "node:assert/strict";
import test from "node:test";

import { evaluateStyleSelectionEvidence } from "./plans.js";

test("style selection fails closed when no completed job supplied candidates", () => {
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: true,
      offeredIds: [],
      requestedEntryId: "hair-1",
    }),
    {
      ok: false,
      error: "candidate_evidence_unavailable",
    },
  );
});

test("style selection rejects globally excluded and unoffered entries", () => {
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: false,
      offeredIds: ["hair-1"],
      requestedEntryId: "hair-1",
    }),
    { ok: false, error: "style_not_recommended" },
  );
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: true,
      offeredIds: ["hair-2"],
      requestedEntryId: "hair-1",
    }),
    { ok: false, error: "not_in_candidates" },
  );
});

test("style selection accepts only a recommended entry present in offered ids", () => {
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: true,
      offeredIds: ["hair-1"],
      requestedEntryId: "hair-1",
    }),
    { ok: true },
  );
});

test("style selection accepts only an owned, offered vision-LLM entry", () => {
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: false,
      source: "vision_llm_generated",
      generatedForPlanId: "plan-1",
      expectedPlanId: "plan-1",
      offeredIds: ["llm-owned"],
      requestedEntryId: "llm-owned",
    }),
    { ok: true },
  );
  assert.deepEqual(
    evaluateStyleSelectionEvidence({
      entryExists: true,
      kindMatches: true,
      isRecommended: false,
      source: "vision_llm_generated",
      generatedForPlanId: "plan-2",
      expectedPlanId: "plan-1",
      offeredIds: ["llm-foreign"],
      requestedEntryId: "llm-foreign",
    }),
    { ok: false, error: "style_not_recommended" },
  );
});
