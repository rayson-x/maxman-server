import assert from "node:assert/strict";
import test from "node:test";

import { buildPreferenceDecisionPayload } from "./conversation.js";

test("preference decision payload never persists the user's raw message", () => {
  const rawText = "我想要更成熟一点，但不要太正式";
  const payload = buildPreferenceDecisionPayload({
    normalizedStyleTag: null,
  });

  assert.deepEqual(payload, {
    normalizedStyleTag: null,
    userSpecified: true,
  });
  assert.equal(JSON.stringify(payload).includes(rawText), false);
  assert.equal("text" in payload, false);
});
