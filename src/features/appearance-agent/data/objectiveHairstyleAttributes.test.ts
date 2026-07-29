import assert from "node:assert/strict";
import test from "node:test";

import {
  OBJECTIVE_HAIRSTYLE_ATTRIBUTES,
  isHairstyleRenderProviderCalibrated,
  wigFeasibilityFor,
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

/*
 * 假发维度（WIG-002）。这一维**留空即不可行**（fail closed）——因为它标错的代价是让用户
 * 花钱买一顶做不出目标效果的假发，比少推荐一款严重得多。
 */

test("wig feasibility is fail closed: an unannotated style is not wig-feasible", () => {
  for (const entry of OBJECTIVE_HAIRSTYLE_ATTRIBUTES) {
    if (entry.wigFeasibility === undefined) {
      assert.equal(
        wigFeasibilityFor(entry.canonicalName),
        null,
        `${entry.canonicalName} 未标注假发维度，查表必须返回 null（调用方按不可行处理）`,
      );
    }
  }
});

test("wig feasibility lookup treats an unknown style name as not feasible", () => {
  assert.equal(wigFeasibilityFor("完全不存在的发型"), null);
});

test("wig feasibility annotations that exist are internally consistent", () => {
  for (const entry of OBJECTIVE_HAIRSTYLE_ATTRIBUTES) {
    const annotation = entry.wigFeasibility;
    if (annotation === undefined) continue;
    if (annotation.feasible) {
      assert.ok(
        annotation.minimumTier.length > 0,
        `${entry.canonicalName} 标注为可行，必须给出最低工艺档位`,
      );
      assert.equal(
        wigFeasibilityFor(entry.canonicalName)?.feasible === true
          ? wigFeasibilityFor(entry.canonicalName)
          : null,
        annotation,
      );
    } else {
      assert.ok(
        annotation.reason.length > 0,
        `${entry.canonicalName} 标注为不可行，必须写明原因`,
      );
      assert.equal(wigFeasibilityFor(entry.canonicalName)?.feasible, false);
    }
  }
});
