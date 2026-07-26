import assert from "node:assert/strict";
import test from "node:test";

import { parseCompatibilityThreshold } from "./styleProfile.js";

test("style compatibility threshold is bounded and falls back safely", () => {
  assert.equal(parseCompatibilityThreshold("4"), 4);
  assert.equal(parseCompatibilityThreshold("0"), 0);
  assert.equal(parseCompatibilityThreshold("10"), 3);
  assert.equal(parseCompatibilityThreshold("not-a-number"), 3);
});
