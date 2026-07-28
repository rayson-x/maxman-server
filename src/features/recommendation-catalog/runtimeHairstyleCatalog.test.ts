import assert from "node:assert/strict";
import test from "node:test";
import { projectRuntimeHairstyleCatalog } from "./runtimeHairstyleCatalog.js";

test("runtime hairstyle recall uses the deployment manifest gate rather than the legacy objective attribute table", () => {
  const result = projectRuntimeHairstyleCatalog({
    selectedStyleId: "american-workwear",
    hairSignals: { hairline: "normal", volume: "medium" },
    renderProvider: "ark-seedream-image-edit(doubao-seedream-4-5-251128)",
    renderModel: "doubao-seedream-4-5-251128",
  });

  assert.equal(result.catalogCoverage, "partial");
  assert.equal(result.appliedFitRules.length, 0);
  assert.ok(result.candidates.length > 0);
  assert.ok(result.candidates.every((candidate) => candidate.verificationStatus === "not_checked"));
  assert.equal(result.candidates.some((candidate) => candidate.hairstyleId.includes("special")), false);
  assert.ok(result.candidates.every((candidate) => candidate.rendering.status === "not_calibrated"));
});
