import assert from "node:assert/strict";
import test from "node:test";
import { resolveHairstylePreviewCalibration } from "./previewCalibration.js";

const provider = "ark-seedream-image-edit(doubao-seedream-4-5-251128)";

test("resolves only an exact, render-validated hairstyle and provider/model pair", () => {
  const resolved = resolveHairstylePreviewCalibration({
    hairstyleId: "hair-cn-natural-short-cover",
    provider,
    model: provider,
  });

  assert.ok(resolved);
  assert.match(resolved.renderInstruction, /自然短碎盖/);
  assert.equal(resolved.renderSpecVersion, "seedream-4-5-hairstyle-v1");
});

test("does not substitute a nearby hairstyle or a different model", () => {
  assert.equal(resolveHairstylePreviewCalibration({
    hairstyleId: "hair-cn-micro-part-cover",
    provider,
    model: provider,
  }), null);
  assert.equal(resolveHairstylePreviewCalibration({
    hairstyleId: "hair-cn-natural-short-cover",
    provider,
    model: "another-model",
  }), null);
});
