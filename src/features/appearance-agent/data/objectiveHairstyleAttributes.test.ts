import assert from "node:assert/strict";
import test from "node:test";

import {
  isHairstyleRenderProviderCalibrated,
} from "./objectiveHairstyleAttributes.js";

test("hairstyle render calibration is bound to the exact provider and model", () => {
  assert.equal(
    isHairstyleRenderProviderCalibrated(
      "ark-seedream-image-edit(doubao-seedream-4-5-251128)",
    ),
    true,
  );
  assert.equal(isHairstyleRenderProviderCalibrated("qwen-image-edit-plus"), false);
  assert.equal(
    isHairstyleRenderProviderCalibrated(
      "ark-seedream-image-edit(doubao-seedream-5-0-260128)",
    ),
    false,
  );
});
