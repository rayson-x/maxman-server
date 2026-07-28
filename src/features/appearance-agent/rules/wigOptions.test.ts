import assert from "node:assert/strict";
import test from "node:test";

import type { WigFeasibilityAnnotation } from "../data/objectiveHairstyleAttributes.js";
import { deriveWigOptions, type WigMatchableCandidate } from "./wigOptions.js";

/** 只被发量挡住、本身遮额 —— 差集里「只缺量感」那一类 */
const VOLUME_HUNGRY: WigMatchableCandidate = {
  nameZh: "蓬松纹理烫",
  requiresHairVolume: "high",
  coversForehead: true,
};
/** 露额、非极短 —— 差集里「被遮额挡住」那一类 */
const BARES_FOREHEAD: WigMatchableCandidate = {
  nameZh: "大背头",
  requiresHairVolume: "medium",
  coversForehead: false,
};
/** 极短露头皮 —— 整顶假发做不自然，必须排除 */
const BUZZ_CUT: WigMatchableCandidate = {
  nameZh: "圆寸",
  requiresHairVolume: "low",
  coversForehead: false,
};
const ACHIEVABLE: WigMatchableCandidate = {
  nameZh: "微碎盖",
  requiresHairVolume: "medium",
  coversForehead: true,
};

const ANNOTATIONS: Record<string, WigFeasibilityAnnotation> = {
  蓬松纹理烫: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" },
  大背头: { feasible: true, minimumTier: "full_wig", evidenceStrength: "reasoned" },
  圆寸: {
    feasible: false,
    reason: "极短款式头皮可见度高，整顶假发的发根藏不住",
    evidenceStrength: "reasoned",
  },
};

function lookup(name: string): WigFeasibilityAnnotation | null {
  return ANNOTATIONS[name] ?? null;
}

function input(overrides: Partial<Parameters<typeof deriveWigOptions>[0]> = {}) {
  return {
    amplePremiseCandidates: [ACHIEVABLE, VOLUME_HUNGRY],
    ownHairCandidates: [ACHIEVABLE],
    track: "short_term" as const,
    userDeclaredHairConcern: true,
    feasibilityOf: lookup,
    ...overrides,
  };
}

test("the gap set is the first-round candidates minus what the user can already achieve", () => {
  const outcome = deriveWigOptions(input());
  assert.equal(outcome.open, true);
  assert.deepEqual(outcome.options.map((o) => o.candidate.nameZh), ["蓬松纹理烫"]);
});

test("an empty gap set produces no options at all", () => {
  const outcome = deriveWigOptions(
    input({ amplePremiseCandidates: [ACHIEVABLE], ownHairCandidates: [ACHIEVABLE] }),
  );
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "no_gap");
  assert.deepEqual(outcome.options, []);
});

test("a long-term track never opens the entry, even with a non-empty gap", () => {
  // 「就是日常」这类通勤场景不收目标日期，系统无从主张「短期内来不及剪」。
  const outcome = deriveWigOptions(input({ track: "long_term" }));
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "not_short_term");
});

test("without a user-side declaration the entry stays shut", () => {
  // 视觉信号可以影响「推荐哪些发型」，但不能触发「建议你花钱买东西」。
  const outcome = deriveWigOptions(input({ userDeclaredHairConcern: false }));
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "no_user_declaration");
});

test("an explicit in-flow confirmation substitutes for the questionnaire answer", () => {
  const outcome = deriveWigOptions(
    input({ userDeclaredHairConcern: false, explicitlyConfirmed: true }),
  );
  assert.equal(outcome.open, true);
});

test("a style blocked only by volume needs no more than a volume patch", () => {
  const outcome = deriveWigOptions(input());
  assert.equal(outcome.options[0]?.tier, "volume_patch");
});

test("a style blocked by forehead exposure requires a full wig, not a patch", () => {
  const outcome = deriveWigOptions(
    input({ amplePremiseCandidates: [ACHIEVABLE, BARES_FOREHEAD] }),
  );
  assert.equal(outcome.options[0]?.tier, "full_wig");
});

test("the required tier is the stricter of what blocked the style and what the table claims", () => {
  // 标注只说「补量感就够」，但这一款是露额的 —— 发片补不了发际线，必须升到整顶。
  const outcome = deriveWigOptions(
    input({
      amplePremiseCandidates: [{ ...BARES_FOREHEAD, nameZh: "蓬松纹理烫", coversForehead: false }],
      ownHairCandidates: [],
    }),
  );
  assert.equal(outcome.options[0]?.tier, "full_wig");
});

test("a style the table marks infeasible is dropped with the table's reason", () => {
  const outcome = deriveWigOptions(
    input({ amplePremiseCandidates: [ACHIEVABLE, BUZZ_CUT] }),
  );
  assert.deepEqual(outcome.options, []);
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "no_feasible_option");
  assert.equal(outcome.unmatched.length, 1);
  assert.equal(outcome.unmatched[0]?.candidate.nameZh, "圆寸");
  assert.match(outcome.unmatched[0]?.reason ?? "", /头皮/);
  assert.equal(outcome.unmatched[0]?.needsHumanReview, false);
});

test("an unannotated style is dropped and raised for human review", () => {
  // fail closed：未标注 = 未判定 = 不可行，并且要有人去补依据。
  const unknown: WigMatchableCandidate = {
    nameZh: "韩式逗号刘海",
    requiresHairVolume: "medium",
    coversForehead: true,
  };
  const outcome = deriveWigOptions(input({ amplePremiseCandidates: [ACHIEVABLE, unknown] }));
  assert.deepEqual(outcome.options, []);
  assert.equal(outcome.closedReason, "no_feasible_option");
  assert.equal(outcome.unmatched[0]?.needsHumanReview, true);
});

test("human review records are produced even when the entry stays shut for this user", () => {
  // 升级记录是关于**款式表**的，不是关于这个用户的 —— 不该被门槛吞掉。
  const unknown: WigMatchableCandidate = {
    nameZh: "韩式逗号刘海",
    requiresHairVolume: "medium",
    coversForehead: true,
  };
  const outcome = deriveWigOptions(
    input({ amplePremiseCandidates: [ACHIEVABLE, unknown], track: "long_term" }),
  );
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "not_short_term");
  assert.equal(outcome.unmatched.length, 1);
  assert.equal(outcome.unmatched[0]?.needsHumanReview, true);
});

test("each option carries a templated achievement label rather than model prose", () => {
  const patch = deriveWigOptions(input()).options[0];
  const full = deriveWigOptions(
    input({ amplePremiseCandidates: [ACHIEVABLE, BARES_FOREHEAD] }),
  ).options[0];

  assert.notEqual(patch?.achievementLabel, full?.achievementLabel);
  for (const label of [patch?.achievementLabel, full?.achievementLabel]) {
    assert.ok((label ?? "").length > 0);
    // 合规口径：只讲造型可行性，不出现健康/诊断字样。
    assert.doesNotMatch(label ?? "", /脱发|稀疏|治疗|病/);
  }
});

test("the caller's richer candidate objects survive into the options", () => {
  const rich = { ...VOLUME_HUNGRY, changeInstruction: "把发型改成蓬松纹理烫" };
  const outcome = deriveWigOptions({
    amplePremiseCandidates: [{ ...ACHIEVABLE, changeInstruction: "把发型改成微碎盖" }, rich],
    ownHairCandidates: [{ ...ACHIEVABLE, changeInstruction: "把发型改成微碎盖" }],
    track: "short_term",
    userDeclaredHairConcern: true,
    feasibilityOf: lookup,
  });
  assert.equal(outcome.options[0]?.candidate.changeInstruction, "把发型改成蓬松纹理烫");
});
