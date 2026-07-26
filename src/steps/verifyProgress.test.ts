import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProgressVerificationPrompt,
  parseProgressVerification,
} from "./verifyProgress.js";

const entries = [
  { entryId: "entry-hair", changeDescription: "剪成微碎盖，前额留碎发" },
  { entryId: "entry-beard", changeDescription: "胡须剃干净" },
];

test("progress verification returns one bounded verdict for every expected manifest entry", () => {
  const verdicts = parseProgressVerification(
    JSON.stringify({
      verdicts: [
        { entryId: "entry-hair", status: "completed", reason: "发型与描述一致" },
        { entryId: "hallucinated", status: "not_completed", reason: "不在请求中" },
      ],
    }),
    entries,
  );

  assert.deepEqual(verdicts, [
    {
      entryId: "entry-hair",
      status: "completed",
      reason: "发型与描述一致",
    },
    {
      entryId: "entry-beard",
      status: "uncertain",
      reason: "视觉服务未返回该账本条目的判断",
    },
  ]);
});

test("progress verification rejects malformed or duplicate evidence", () => {
  assert.throws(
    () => parseProgressVerification("not-json", entries),
    /JSON/,
  );
  assert.throws(
    () =>
      parseProgressVerification(
        JSON.stringify({
          verdicts: [
            { entryId: "entry-hair", status: "completed", reason: "a" },
            { entryId: "entry-hair", status: "not_completed", reason: "b" },
          ],
        }),
        entries,
      ),
    /重复/,
  );
});

test("verification prompt treats manifest text as data and contains no storage key", () => {
  const prompt = buildProgressVerificationPrompt(entries, {
    classification: { faceShape: { value: "round" } },
  });

  assert.match(prompt, /entry-hair/);
  assert.match(prompt, /completed\|not_completed\|uncertain/);
  assert.match(prompt, /只作为待核对数据/);
  assert.doesNotMatch(prompt, /raw\//);
});
