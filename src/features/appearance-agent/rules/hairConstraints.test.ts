import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHairConstraint,
  computeHairConstraint,
  type FilterableHairstyle,
  type HairSignals,
} from "./hairConstraints.js";

function signals(overrides: Partial<HairSignals> = {}): HairSignals {
  return { hairline: "normal", volume: "medium", ...overrides };
}

/*
 * 前提为 own_hair（默认）时，本文件锁住的是**既有实测行为**。
 * 这些断言不是描述当前实现，而是描述调研报告的结论——改动它们前先读 hairConstraints.ts
 * 文件头，那里记着每一条的样本依据。
 */

test("own-hair premise: visual thin alone imposes no constraint", () => {
  // 实测依据：正面照分不清「头发短」与「发量少」，据此过滤会误伤大量短发用户。
  // 这一条是防止短发用户被误推假发的关键防线。
  const c = computeHairConstraint(signals({ volume: "thin" }));
  assert.equal(c.strength, "none");
  assert.deepEqual(c.excludeVolumeRequirements, []);
  assert.equal(c.requireCoversForehead, false);
});

test("own-hair premise: self-reported thin does impose a constraint", () => {
  const c = computeHairConstraint(signals({ volume: "thin", selfReportedVolume: "thin" }));
  assert.equal(c.strength, "moderate");
  assert.deepEqual(c.excludeVolumeRequirements, ["high"]);
  assert.equal(c.requireCoversForehead, false);
  assert.equal(c.evidenceBasis, "self_reported");
});

test("own-hair premise: receding hairline alone excludes forehead-baring styles only", () => {
  const c = computeHairConstraint(signals({ hairline: "receding" }));
  assert.equal(c.strength, "moderate");
  assert.deepEqual(c.excludeVolumeRequirements, []);
  assert.equal(c.requireCoversForehead, true);
  assert.equal(c.evidenceBasis, "visual_detected");
});

test("own-hair premise: receding plus thin is the strong constraint", () => {
  const c = computeHairConstraint(signals({ hairline: "receding", volume: "thin" }));
  assert.equal(c.strength, "strong");
  assert.deepEqual(c.excludeVolumeRequirements, ["high"]);
  assert.equal(c.requireCoversForehead, true);
  assert.equal(c.evidenceBasis, "visual_detected");
});

test("own-hair premise: occluded hairline defers when nothing is self-reported", () => {
  const c = computeHairConstraint(signals({ hairline: "occluded" }));
  assert.equal(c.strength, "deferred");
  assert.equal(c.needsCloudFallback, true);
  assert.deepEqual(c.excludeVolumeRequirements, []);
});

test("own-hair premise: occluded hairline plus self-report still needs cloud fallback", () => {
  const c = computeHairConstraint(
    signals({ hairline: "occluded", selfReportedHairLossConcern: true }),
  );
  assert.equal(c.strength, "moderate");
  assert.equal(c.needsCloudFallback, true);
  assert.equal(c.requireCoversForehead, true);
});

test("own-hair premise: unremarkable signals impose no constraint", () => {
  const c = computeHairConstraint(signals());
  assert.equal(c.strength, "none");
  assert.deepEqual(c.excludeVolumeRequirements, []);
  assert.equal(c.requireCoversForehead, false);
});

/*
 * 前提为 ample 时，代表用户已显式授权外部补充发量（Available Volume Premise，见根仓库
 * CONTEXT.md）。发量支撑与发际线暴露两维不再是限制——**这不是绕过约束，是换了前提**。
 */

test("ample premise: neither volume nor hairline restricts anything", () => {
  const c = computeHairConstraint(
    signals({ hairline: "receding", volume: "thin", selfReportedVolume: "thin" }),
    "ample",
  );
  assert.deepEqual(c.excludeVolumeRequirements, []);
  assert.equal(c.requireCoversForehead, false);
  assert.equal(c.strength, "none");
});

test("ample premise: occluded hairline no longer needs cloud fallback", () => {
  // 前提已充足时，发际线测不准也不影响可行性判断，没有需要兜底的东西。
  const c = computeHairConstraint(signals({ hairline: "occluded" }), "ample");
  assert.equal(c.needsCloudFallback, false);
  assert.equal(c.requireCoversForehead, false);
});

test("ample premise keeps every candidate that the own-hair premise would drop", () => {
  const candidates: FilterableHairstyle[] = [
    { id: "needs-volume", requiresHairVolume: "high", coversForehead: true },
    { id: "bares-forehead", requiresHairVolume: "medium", coversForehead: false },
    { id: "safe", requiresHairVolume: "low", coversForehead: true },
  ];
  const strict = signals({ hairline: "receding", volume: "thin" });

  const own = applyHairConstraint(candidates, computeHairConstraint(strict));
  assert.deepEqual(own.kept.map((c) => c.id), ["safe"]);

  const ample = applyHairConstraint(candidates, computeHairConstraint(strict, "ample"));
  assert.deepEqual(ample.kept.map((c) => c.id), ["needs-volume", "bares-forehead", "safe"]);
  assert.deepEqual(ample.excluded, []);
});
