import assert from "node:assert/strict";
import test from "node:test";
import { buildWardrobeRecommendationContext } from "./jobOrchestrator.js";

test("wardrobe context retains the client portrait measurements used by prior stages", () => {
  const context = buildWardrobeRecommendationContext({
    geometry: { lengthWidthRatio: 1.42 },
    hairSignals: { hairline: "normal", volume: "medium" },
    clientSignals: { faceShape: "oval" },
    portraitProfile: { faceShape: { value: "oval", source: "client_measurement" } },
  });

  assert.deepEqual(context.geometry, { lengthWidthRatio: 1.42 });
  assert.deepEqual(context.hairSignals, { hairline: "normal", volume: "medium" });
  assert.deepEqual(context.portraitProfile, { faceShape: { value: "oval", source: "client_measurement" } });
});
