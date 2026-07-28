import assert from "node:assert/strict";
import test from "node:test";

import { selectRenderablePreviewCandidates } from "./previewCandidateSelector.js";

test("only calibrated render instructions enter a three-candidate preview batch", () => {
  const selected = selectRenderablePreviewCandidates([
    { id: "one", nameZh: "候选一", renderInstruction: "  " },
    { id: "two", nameZh: "候选二", renderInstruction: "保持身份，修剪短层次" },
    { id: "three", nameZh: "候选三", renderInstruction: "保持身份，侧分短发" },
    { id: "four", nameZh: "候选四", renderInstruction: "保持身份，轻薄刘海" },
    { id: "five", nameZh: "候选五", renderInstruction: "保持身份，利落短发" },
  ]);

  assert.deepEqual(selected.map((candidate) => candidate.id), ["two", "three", "four"]);
});
