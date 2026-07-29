import {
  findObjectiveHairstyleAttributes,
  wigFeasibilityFor,
  type WigCraftTier,
  type WigFeasibilityAnnotation,
} from "../data/objectiveHairstyleAttributes.js";
import {
  applyHairConstraint,
  computeHairConstraint,
  type HairSignals,
  type HairVolumeRequirement,
} from "./hairConstraints.js";

/**
 * 假发方案推导。**这是本能力唯一新增的接缝** —— 差集、开放条件、形态匹配、fail closed
 * 四类决策全部落在这一个纯函数里，所以不需要数据库、任务队列或模型替身就能测全。
 *
 * 上游怎么用它：推荐能力跑两轮，前提不同（见 hairConstraints 的 AvailableVolumePremise）——
 * 一轮前提为 `ample`，一轮为 `own_hair`（执行先后不影响语义）。
 * **差集 = ample 轮 \ own_hair 轮**，再经自身前提的约束**重新核验**。
 *
 * 那一步核验不是冗余：两轮是两次独立的 LLM 调用，own_hair 轮并不是 ample 轮的子集，
 * 排序与采样波动本身就会让某个款式只出现在 ample 轮里。不核验就会把这种波动当成
 * 「发量不够」，让用户为一个他自己剪得出来的款式去买假发。
 *
 * 为什么不用「一轮 + 把被剔除的候选回填」：回填省一次调用，但被剔除的候选是理想列表的
 * 残余 —— 数量不确定、排序依据缺失，且与 validateRecommendations 的「不回填被排除项」
 * 原则冲突。两轮的代价是多一次调用，换来两个列表各自完整、各自有排序与理由。
 *
 * 推荐能力自己**始终不知道「假发」这个概念存在**，它只是在不同前提下工作。
 */

/** 参与假发匹配所需的最小候选形状。调用方更丰富的候选对象会原样带出。 */
export type WigMatchableCandidate = {
  nameZh: string;
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;
};

/** 方案的时间取向。只有短期才开放假发 —— 它的主张是「短期内剪发达不到」。 */
export type PlanTrack = "short_term" | "long_term";

export type WigOptionInput<T extends WigMatchableCandidate> = {
  /** 第一轮：前提为「补充发量后充足」的候选 */
  amplePremiseCandidates: readonly T[];
  /** 第二轮：前提为用户自身发量信号的候选 */
  ownHairCandidates: readonly T[];
  /** 用户自身的发量信号。用来核验差集里的款式**真的**被自身发量挡住 */
  hairSignals: HairSignals;
  track: PlanTrack;
  /** 问卷自报「受脱发 / 发量变少困扰」为非「没有困扰」 */
  userDeclaredHairConcern: boolean;
  /** 用户在选择界面显式确认愿意用假发。与自报二者其一即可 */
  explicitlyConfirmed?: boolean;
  /** 可注入的可行性查表，缺省用发型客观属性表 */
  feasibilityOf?: (name: string) => WigFeasibilityAnnotation | null;
};

export type WigOption<T> = {
  candidate: T;
  /** 做出该款式所需的最低工艺档位 */
  tier: WigCraftTier;
  /** 达成路径标签。**模板文案**，不由模型生成措辞——它紧邻「不做医学诊断」的红线 */
  achievementLabel: string;
};

export type WigUnmatched<T> = {
  candidate: T;
  reason: string;
  /**
   * true 表示判据不足（属性表未标注）而非确定不可行。
   *
   * 这只是**信号**，不是 CONTEXT.md 定义的 Human Escalation 记录——本函数是纯的，
   * 不建任务。属性表的标注缺口由 WIG-005 直接对着表处理，不依赖运行期是否有人命中。
   */
  needsHumanReview: boolean;
};

export type WigOptionOutcome<T> = {
  /** 入口是否对该用户开放 */
  open: boolean;
  /** 未开放的原因。用于日志与排查，不面向用户 */
  closedReason?: "no_gap" | "not_short_term" | "no_user_declaration" | "no_feasible_option";
  options: WigOption<T>[];
  /** 差集里无法用假发达成的款式。与 open 无关，始终产出 */
  unmatched: WigUnmatched<T>[];
};

/** 档位由宽到严。用于在「被什么挡住」与属性表标注之间取更严的一方 */
const TIER_ORDER: readonly WigCraftTier[] = ["volume_patch", "full_wig", "full_wig_front_lace"];

/**
 * 面向用户的达成路径文案。模板而非模型：已有实测表明模型在 prompt 明确禁止后仍会产出
 * 诊断性表述，而这几句话离那条红线很近。口径只讲造型可行性。
 */
const ACHIEVEMENT_LABEL: Record<WigCraftTier, string> = {
  volume_patch: "这个款式需要更多量感，可以用发片补足",
  full_wig: "这个款式会露出发际线，需要整顶假发才能做到",
  full_wig_front_lace: "这个款式把发际线完全露在正面，需要整顶假发且前额工艺要过关",
};

function stricter(a: WigCraftTier, b: WigCraftTier): WigCraftTier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

/** 同一款式在两轮里可能用了别名，统一到属性表的规范名再比对 */
function identity(name: string): string {
  return findObjectiveHairstyleAttributes(name)?.canonicalName ?? name;
}

/**
 * 做出这个款式**至少**需要哪一档：露额款要整顶（发片补不了发际线），其余补量感就够。
 *
 * 这一步必须与属性表标注取更严的一方：标注讲的是款式本身的工艺门槛，这里讲的是
 * 用户为什么做不到，两者都成立才是真的可行。
 */
function tierRequiredToWear(candidate: WigMatchableCandidate): WigCraftTier {
  return candidate.coversForehead ? "volume_patch" : "full_wig";
}

/** 该款式是否真的被用户自身的发量/发际线挡住。复用同一份确定性过滤，不另写判断。 */
function isBlockedByOwnHair(
  candidate: WigMatchableCandidate,
  constraint: ReturnType<typeof computeHairConstraint>,
): boolean {
  return (
    applyHairConstraint(
      [
        {
          id: candidate.nameZh,
          requiresHairVolume: candidate.requiresHairVolume,
          coversForehead: candidate.coversForehead,
        },
      ],
      constraint,
    ).excluded.length > 0
  );
}

export function deriveWigOptions<T extends WigMatchableCandidate>(
  input: WigOptionInput<T>,
): WigOptionOutcome<T> {
  const feasibilityOf = input.feasibilityOf ?? wigFeasibilityFor;
  const achievable = new Set(input.ownHairCandidates.map((c) => identity(c.nameZh)));
  const ownHairConstraint = computeHairConstraint(input.hairSignals, "own_hair");
  const gap = input.amplePremiseCandidates.filter(
    (c) => !achievable.has(identity(c.nameZh)) && isBlockedByOwnHair(c, ownHairConstraint),
  );

  if (gap.length === 0) return { open: false, closedReason: "no_gap", options: [], unmatched: [] };

  const options: WigOption<T>[] = [];
  const unmatched: WigUnmatched<T>[] = [];

  for (const candidate of gap) {
    const annotation = feasibilityOf(identity(candidate.nameZh));
    // fail closed：未标注 = 未判定 = 不可行。标错的代价是让用户花钱买一顶做不出
    // 目标效果的假发，比少推荐一款严重得多。
    if (annotation === null) {
      unmatched.push({
        candidate,
        reason: "尚未确认这个款式能否用假发自然做出",
        needsHumanReview: true,
      });
      continue;
    }
    if (!annotation.feasible) {
      unmatched.push({ candidate, reason: annotation.reason, needsHumanReview: false });
      continue;
    }
    const tier = stricter(annotation.minimumTier, tierRequiredToWear(candidate));
    options.push({ candidate, tier, achievementLabel: ACHIEVEMENT_LABEL[tier] });
  }

  // 门槛判定放在匹配之后：升级记录是关于**款式表**的，不是关于这个用户的，
  // 不该被门槛吞掉。
  const closedReason = closureReason(input, options);
  return closedReason
    ? { open: false, closedReason, options: [], unmatched }
    : { open: true, options, unmatched };
}

function closureReason<T extends WigMatchableCandidate>(
  input: WigOptionInput<T>,
  options: readonly WigOption<T>[],
): Exclude<WigOptionOutcome<T>["closedReason"], "no_gap" | undefined> | null {
  // 场景门槛：假发的主张是「**短期内**剪发达不到」，而只有短期这一支收集了目标日期。
  // 其余场景无从主张「来不及」。
  if (input.track !== "short_term") return "not_short_term";
  // 用户侧依据是硬门槛：视觉信号可以影响「推荐哪些发型」，但不能替用户决定他该买假发。
  if (!input.userDeclaredHairConcern && input.explicitlyConfirmed !== true) {
    return "no_user_declaration";
  }
  // 入口上的「能解锁 N 款」必须是真实数字，为 0 时不显示入口。
  if (options.length === 0) return "no_feasible_option";
  return null;
}
