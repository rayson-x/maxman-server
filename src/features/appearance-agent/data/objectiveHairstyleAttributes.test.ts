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

/*
 * 回填后的标注要对得上它自己声明的判据（WIG-005）。这些断言不是重复实现，而是钉住
 * 「标注是按什么规则给的」—— 以后有人凭直觉改一条，会在这里被拦下。
 */

test("a forehead-baring style is never dismissed as merely needing a volume patch", () => {
  // 发片补不了发际线。露额款要么整顶（且前额工艺过关），要么直接判不可行。
  for (const entry of OBJECTIVE_HAIRSTYLE_ATTRIBUTES) {
    if (entry.coversForehead) continue;
    const annotation = entry.wigFeasibility;
    if (annotation === undefined || !annotation.feasible) continue;
    assert.notEqual(
      annotation.minimumTier,
      "volume_patch",
      `${entry.canonicalName} 是露额款，不能只靠补量感达成`,
    );
  }
});

test("buzz-cut-class styles are annotated as not wig-feasible", () => {
  // 极短露头皮：从业者一致不建议。这三款是本维度唯一的不可行项。
  for (const name of ["圆寸", "短寸", "美式渐变短发"]) {
    const annotation = wigFeasibilityFor(name);
    assert.equal(annotation?.feasible, false, `${name} 应标注为假发不可行`);
    assert.ok(
      annotation !== null && !annotation.feasible && annotation.reason.length > 0,
      `${name} 的不可行原因不能为空`,
    );
  }
});

test("every wig annotation is present and none overstates its evidence", () => {
  for (const entry of OBJECTIVE_HAIRSTYLE_ATTRIBUTES) {
    assert.ok(
      entry.wigFeasibility !== undefined,
      `${entry.canonicalName} 缺少假发维度标注`,
    );
    // 没有购买样本做实拍对照，因此不得出现比 reasoned 更强的依据声明。
    assert.equal(entry.wigFeasibility?.evidenceStrength, "reasoned");
  }
});

test("perm-dependent styles carry the real-hair caveat", () => {
  // 蛋白丝不可烫染、不可近高温；这两款只靠普通化纤发片做不出来。
  for (const name of ["蓬松纹理烫", "自然卷短发"]) {
    const annotation = wigFeasibilityFor(name);
    assert.equal(annotation?.feasible, true);
    assert.ok(
      annotation !== null && annotation.feasible && (annotation.caveat ?? "").length > 0,
      `${name} 需要烫卷，必须写明材质限制`,
    );
  }
});
