import assert from "node:assert/strict";
import test from "node:test";

import { completePreviewFallback } from "./renderPreviews.js";

test("all image failures produce an internal partial result instead of a blocked flow", () => {
  const outcome = completePreviewFallback(
    [{ item: "短碎发", reason: "provider timeout" }],
    1200,
  );

  assert.equal(outcome.status, "completed_partial");
  assert.deepEqual(outcome.data.previews, []);
  assert.equal(outcome.data.totalMs, 1200);
  assert.deepEqual(outcome.missing, [{ item: "短碎发", reason: "provider timeout" }]);
});
