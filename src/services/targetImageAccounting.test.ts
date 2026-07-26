import assert from "node:assert/strict";
import test from "node:test";

import { targetImageAccounting } from "./targetImageService.js";

test("only successful user regeneration consumes weekly quota", () => {
  assert.deepEqual(targetImageAccounting("stage_unlock", true), {
    isFreeFirstGeneration: true,
    consumedWeeklyQuota: false,
  });
  assert.deepEqual(targetImageAccounting("progress_recheck", true), {
    isFreeFirstGeneration: true,
    consumedWeeklyQuota: false,
  });
  assert.deepEqual(targetImageAccounting("user_regeneration", true), {
    isFreeFirstGeneration: false,
    consumedWeeklyQuota: true,
  });
  assert.deepEqual(targetImageAccounting("user_regeneration", false), {
    isFreeFirstGeneration: false,
    consumedWeeklyQuota: false,
  });
});
