import assert from "node:assert/strict";
import test from "node:test";
import {
  recallRuntimeHairstyles,
  recallRuntimeStyleDirections,
  recallRuntimeWardrobe,
} from "./catalogRecall.js";

test("style recall projects every deployed style into compact stable-ID candidates without research URLs", () => {
  const recalled = recallRuntimeStyleDirections();
  assert.equal(recalled.length, 41);
  assert.deepEqual(recalled.map((row) => row.stableId), [...recalled.map((row) => row.stableId)].sort());
  assert.ok(recalled.every((row) => row.bytes > 0 && !JSON.stringify(row).includes("https://")));
});

test("hairstyle recall preserves relation coverage degradation and excludes special opt-in candidates", () => {
  const recalled = recallRuntimeHairstyles({
    selectedStyleId: "american-workwear",
    hairSignals: { hairline: "normal", volume: "medium" },
    renderProvider: "ark", renderModel: "seedream",
  });
  assert.equal(recalled.catalogCoverage, "partial");
  assert.ok(recalled.candidates.length > 0);
  assert.ok(recalled.candidates.every((row) => !row.stableId.includes("special")));
  assert.deepEqual(recalled.appliedRules, []);
});

test("wardrobe recall requires the selected style and submits every formula for that style", () => {
  const recalled = recallRuntimeWardrobe({ selectedStyleId: "clean-fit" });
  assert.equal(recalled.length, 8);
  assert.ok(recalled.every((row) => row.stableId.startsWith("of-clean-fit-")));
  assert.ok(recalled.every((row) => !JSON.stringify(row).includes("sourceUrl")));
});
