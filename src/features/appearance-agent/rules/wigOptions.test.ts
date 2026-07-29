import assert from "node:assert/strict";
import test from "node:test";

import type { WigFeasibilityAnnotation } from "../data/objectiveHairstyleAttributes.js";
import { deriveWigOptions, type WigMatchableCandidate } from "./wigOptions.js";

/** 只被发量挡住、本身遮额 —— 「只缺量感」那一类 */
const VOLUME_HUNGRY: WigMatchableCandidate = {
  nameZh: "蓬松纹理烫",
  requiresHairVolume: "high",
  coversForehead: true,
};
/** 露额、非极短 —— 「被遮额挡住」那一类 */
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
/** 属性表未标注 */
const UNANNOTATED: WigMatchableCandidate = {
  nameZh: "韩式逗号刘海",
  requiresHairVolume: "high",
  coversForehead: true,
};
const CURLY: WigMatchableCandidate = {
  nameZh: "自然卷短发",
  requiresHairVolume: "high",
  coversForehead: true,
};

const ANNOTATIONS: Record<string, WigFeasibilityAnnotation> = {
  蓬松纹理烫: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" },
  自然卷短发: { feasible: true, minimumTier: "volume_patch", evidenceStrength: "reasoned" },
  大背头: { feasible: true, minimumTier: "full_wig_front_lace", evidenceStrength: "reasoned" },
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
    blockedCandidates: [VOLUME_HUNGRY],
    modelRankedNames: ["蓬松纹理烫"],
    track: "short_term" as const,
    userDeclaredHairConcern: true,
    feasibilityOf: lookup,
    ...overrides,
  };
}

test("a style the user's own hair blocks becomes a wig option", () => {
  const outcome = deriveWigOptions(input());
  assert.equal(outcome.open, true);
  assert.deepEqual(outcome.options.map((o) => o.candidate.nameZh), ["蓬松纹理烫"]);
});

test("nothing blocked means no options and no entry", () => {
  const outcome = deriveWigOptions(input({ blockedCandidates: [], modelRankedNames: [] }));
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "no_gap");
  assert.deepEqual(outcome.options, []);
});

test("a long-term track never opens the entry, even with blocked styles", () => {
  // 「就是日常」这类通勤场景不收目标日期，系统无从主张「短期内来不及剪」。
  const outcome = deriveWigOptions(input({ track: "long_term" }));
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "not_short_term");
});

test("without a user-side declaration the entry stays shut", () => {
  // 视觉信号可以影响「推荐哪些发型」，但不能替用户决定他该买东西。
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
  assert.equal(deriveWigOptions(input()).options[0]?.tier, "volume_patch");
});

test("a style blocked by forehead exposure requires a full wig, not a patch", () => {
  const outcome = deriveWigOptions(
    input({ blockedCandidates: [BARES_FOREHEAD], modelRankedNames: ["大背头"] }),
  );
  assert.equal(outcome.options[0]?.tier, "full_wig_front_lace");
});

test("the required tier is the stricter of what blocked the style and what the table claims", () => {
  // 标注只说「补量感就够」，但这一款是露额的 —— 发片补不了发际线，必须升到整顶。
  const outcome = deriveWigOptions(
    input({
      blockedCandidates: [{ ...VOLUME_HUNGRY, coversForehead: false }],
      modelRankedNames: ["蓬松纹理烫"],
    }),
  );
  assert.equal(outcome.options[0]?.tier, "full_wig");
});

test("a style the table marks infeasible is dropped with the table's reason", () => {
  const outcome = deriveWigOptions(
    input({ blockedCandidates: [BUZZ_CUT], modelRankedNames: ["圆寸"] }),
  );
  assert.deepEqual(outcome.options, []);
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "no_feasible_option");
  assert.equal(outcome.unmatched.length, 1);
  assert.match(outcome.unmatched[0]?.reason ?? "", /头皮/);
  assert.equal(outcome.unmatched[0]?.needsHumanReview, false);
});

test("an unannotated style is dropped and flagged for human review", () => {
  // fail closed：未标注 = 未判定 = 不可行，并且要有人去补依据。
  const outcome = deriveWigOptions(
    input({ blockedCandidates: [UNANNOTATED], modelRankedNames: ["韩式逗号刘海"] }),
  );
  assert.deepEqual(outcome.options, []);
  assert.equal(outcome.closedReason, "no_feasible_option");
  assert.equal(outcome.unmatched[0]?.needsHumanReview, true);
});

test("annotation gaps are reported even when the entry stays shut for this user", () => {
  // 缺口是关于**款式表**的，不是关于这个用户的 —— 不该被门槛吞掉。
  const outcome = deriveWigOptions(
    input({
      blockedCandidates: [UNANNOTATED],
      modelRankedNames: ["韩式逗号刘海"],
      track: "long_term",
    }),
  );
  assert.equal(outcome.open, false);
  assert.equal(outcome.closedReason, "not_short_term");
  assert.equal(outcome.unmatched.length, 1);
  assert.equal(outcome.unmatched[0]?.needsHumanReview, true);
});

test("each option carries a templated achievement label rather than model prose", () => {
  const patch = deriveWigOptions(input()).options[0];
  const full = deriveWigOptions(
    input({ blockedCandidates: [BARES_FOREHEAD], modelRankedNames: ["大背头"] }),
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
    blockedCandidates: [rich],
    modelRankedNames: ["蓬松纹理烫"],
    track: "short_term",
    userDeclaredHairConcern: true,
    feasibilityOf: lookup,
  });
  assert.equal(outcome.options[0]?.candidate.changeInstruction, "把发型改成蓬松纹理烫");
});

/*
 * 排序：模型通道看着照片给出的候选自带排序与针对这个人的理由，所以它提过的款式排在前面、
 * 且按它的顺序。它没提过的仍然保留 —— 用户要的是「戴假发我能多哪些」这个完整集合，
 * 只是那部分没有个人化排序依据，排在后面。
 */

test("styles the model ranked come first, in the model's own order", () => {
  const outcome = deriveWigOptions(
    input({
      // 输入顺序与模型顺序刻意相反，用来证明排序真的来自模型
      blockedCandidates: [VOLUME_HUNGRY, CURLY],
      modelRankedNames: ["自然卷短发", "蓬松纹理烫"],
    }),
  );
  assert.deepEqual(outcome.options.map((o) => o.candidate.nameZh), ["自然卷短发", "蓬松纹理烫"]);
});

test("a blocked style the model never mentioned is still offered, just after the ranked ones", () => {
  const outcome = deriveWigOptions(
    input({
      blockedCandidates: [CURLY, VOLUME_HUNGRY],
      modelRankedNames: ["蓬松纹理烫"],
    }),
  );
  assert.deepEqual(outcome.options.map((o) => o.candidate.nameZh), ["蓬松纹理烫", "自然卷短发"]);
});

test("an empty model ranking still yields the full blocked set", () => {
  // 模型通道降级时假发入口不该跟着消失 —— 少的只是排序依据。
  const outcome = deriveWigOptions(input({ modelRankedNames: [] }));
  assert.equal(outcome.open, true);
  assert.deepEqual(outcome.options.map((o) => o.candidate.nameZh), ["蓬松纹理烫"]);
});

test("a material caveat is spelled out in the label, not left to the caller", () => {
  // 需要烫卷的款式不能用普通化纤补量（蛋白丝不可烫染）。漏说这一句，用户会买错。
  const outcome = deriveWigOptions(
    input({
      feasibilityOf: () => ({
        feasible: true,
        minimumTier: "volume_patch",
        caveat: "需要烫卷纹理，发片必须是真人发或已烫好的成品",
        evidenceStrength: "reasoned",
      }),
    }),
  );
  assert.match(outcome.options[0]?.achievementLabel ?? "", /真人发/);
});

test("styles whose canonical name is another style's alias are not collapsed", () => {
  // 属性表里 短寸 的别名含 圆寸，而 圆寸 是另一条记录的规范名。
  const buzzA: WigMatchableCandidate = { nameZh: "圆寸", requiresHairVolume: "low", coversForehead: false };
  const buzzB: WigMatchableCandidate = { nameZh: "短寸", requiresHairVolume: "low", coversForehead: false };
  const outcome = deriveWigOptions(
    input({ blockedCandidates: [buzzA, buzzB], modelRankedNames: [] }),
  );
  assert.equal(outcome.unmatched.length, 2, "两个不同款式不能被塌成一条");
});
