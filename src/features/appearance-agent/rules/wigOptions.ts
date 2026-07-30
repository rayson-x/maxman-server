import {
  OBJECTIVE_HAIRSTYLE_ATTRIBUTES,
  findObjectiveHairstyleAttributes,
  wigFeasibilityFor,
  type WigCraftTier,
  type WigFeasibilityAnnotation,
} from "../data/objectiveHairstyleAttributes.js";
import type { HairVolumeRequirement } from "./hairConstraints.js";

/**
 * 假发方案推导。**这是本能力唯一新增的接缝** —— 差集、开放条件、形态匹配、fail closed
 * 四类决策全部落在这一个纯函数里，所以不需要数据库、任务队列或模型替身就能测全。
 *
 * 输入是发型可行集计算时**被发量/发际线约束剔除**的那批款式。它们是确定性过滤算出来的
 * 完整补集，不是某次模型输出的残余 —— 所以不需要再跑一轮推荐来取差集，也不存在采样波动。
 *
 * `modelRankedNames` 是同一步里模型通道给出的候选名，按它的排序。它看着照片工作，因此
 * 它提过的款式带个人化的取舍依据，排在前面；它没提过的仍然保留在后面 —— 用户要的是
 * 「戴假发我能多哪些」这个完整集合，缺的只是排序依据。**不新增模型调用。**
 *
 * 与「不回填被排除项」原则不冲突：那条原则防的是拿模型做不出来的东西凑数，而这里每一项
 * 都带明确排除原因、被单独呈现、带达成路径标签，不混进默认列表充数。
 *
 * 推荐能力自己**始终不知道「假发」这个概念存在**。
 */

/** 参与假发匹配所需的最小候选形状。调用方更丰富的候选对象会原样带出。 */
export type WigMatchableCandidate = {
  nameZh: string;
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;
  /** 目录的长度档。用于判断「极短露头皮」那一类；缺失时按不可行处理 */
  lengthBand?: string;
  /** 目录自己的造型描述。原样带出，供落库使用 */
  description?: string;
};

/** 方案的时间取向。只有短期才开放假发 —— 它的主张是「短期内剪发达不到」。 */
export type PlanTrack = "short_term" | "long_term";

export type WigOptionInput<T extends WigMatchableCandidate> = {
  /** 被发量/发际线约束剔除的款式。确定性补集，每一项定义上就是用户自己做不到的 */
  blockedCandidates: readonly T[];
  /** 模型通道给出的候选名，按其排序。仅用于排序，不用于取舍 */
  modelRankedNames: readonly string[];
  /**
   * 默认列表已经提供给用户的款式名。这些一律不进假发入口。
   *
   * 为什么需要它：默认集合里除了确定性可行集，还落了模型独有候选，而那批**绕过了发量
   * 可行性过滤**。不排掉的话，同一个款式会既在默认列表里可直接选、又在假发入口里被说成
   * 需要买假发 —— 等于让用户为一个刚刚推荐给他的发型花钱。
   */
  alreadyOfferedNames?: readonly string[];
  track: PlanTrack;
  /**
   * 问卷自报「受脱发 / 发量变少困扰」为非「没有困扰」。
   *
   * 这是**唯一**的用户侧依据。曾经还留过一个「用户在界面显式确认」的入参，但它按构造
   * 不可能被触发：它服务的是「没自报困扰、却愿意用假发」的用户，而这类用户根本看不到
   * 入口，也就无处确认。真要覆盖他们，得先有一个新的表达入口，那是另一个产品决定。
   */
  userDeclaredHairConcern: boolean;
  /** 可注入的可行性判定，缺省为「手工标注优先、目录推导兜底」 */
  feasibilityOf?: (
    name: string,
    candidate?: WigMatchableCandidate,
  ) => WigFeasibilityAnnotation | null;
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
  /** 被挡住但无法用假发达成的款式。与 open 无关，始终产出 */
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

/**
 * 统一到属性表的规范名再比对，因为不同来源可能用别名指同一款。
 *
 * **规范名优先于别名**：属性表里 `短寸` 的别名包含 `圆寸`，而 `圆寸` 本身是另一条记录的
 * 规范名。按别名先匹配会把两个不同款式塌成一个，标注也就跟着串了。
 */
function identity(name: string): string {
  const exact = OBJECTIVE_HAIRSTYLE_ATTRIBUTES.find((entry) => entry.canonicalName === name);
  if (exact) return exact.canonicalName;
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

/**
 * 模型提过的排前面、按模型的顺序；没提过的按原顺序排在后面。
 *
 * 不丢掉「模型没提过」的那些：模型一次只给几个候选，据此取舍会让入口在多数情况下空着，
 * 而用户想看的是完整的「戴假发能多哪些」。
 */
function byModelPreference<T extends WigMatchableCandidate>(
  candidates: readonly T[],
  modelRankedNames: readonly string[],
): T[] {
  const rank = new Map(modelRankedNames.map((name, i) => [identity(name), i]));
  const ranked = candidates
    .filter((c) => rank.has(identity(c.nameZh)))
    .sort((a, b) => rank.get(identity(a.nameZh))! - rank.get(identity(b.nameZh))!);
  const rest = candidates.filter((c) => !rank.has(identity(c.nameZh)));
  return [...ranked, ...rest];
}

/**
 * 从目录属性推导假发可行性。这不是「猜」——调研给出的判据本来就只有两条，且两条都能由
 * 目录数据机械判定：
 *
 *   1. 极短露头皮（`lengthBand: very-short`）→ 不可行。从业者一致不建议用假发做寸头类长度：
 *      头发极短时头皮成为视觉焦点，网底与不自然发际线立刻暴露。
 *   2. 遮额 → 只补量感就够；露额 → 需整顶且前额工艺过关（完全暴露发际线需要蕾丝前额 +
 *      漂结 + 渐变密度，不是所有价位做得到）。
 *
 * 为什么需要它：运行时目录有 27 款，而逐款手工标注的属性表只覆盖其中 3 个名字 ——
 * 只靠按名字查表，24 款会被 fail closed 判死，入口在生产里几乎永不开启。
 *
 * fail closed 仍然成立，且区分两种「不给」：长度档缺失时返回 null（判据不足，要有人去补），
 * 而不是谎报「确定不可行」——后者会让缺口从升级队列里消失。
 */
function deriveFeasibilityFromCatalog(
  candidate: WigMatchableCandidate,
): WigFeasibilityAnnotation | null {
  if (candidate.lengthBand === undefined) return null;
  if (candidate.lengthBand === "very-short") {
    return {
      feasible: false,
      reason: "极短款式头皮成为视觉焦点，网底与发际线藏不住",
      evidenceStrength: "reasoned",
    };
  }
  /*
   * 长款与中长款不进假发选项。调研覆盖的是男士日常自然向的发片与整顶短款；披肩、丸子头、
   * 马尾这类要靠长发假发实现，属于另一个品类，而本能力的范围声明明确排除女式假发。
   * 这不是判据不足，是范围之外，所以给确定的理由而非升级到人工。
   */
  if (candidate.lengthBand === "long" || candidate.lengthBand === "medium-long") {
    return {
      feasible: false,
      reason: "长发造型要靠长发假发实现，不在男士日常向假发的范围内",
      evidenceStrength: "product_decision",
    };
  }
  return {
    feasible: true,
    minimumTier: candidate.coversForehead ? "volume_patch" : "full_wig_front_lace",
    evidenceStrength: "reasoned",
  };
}

export function deriveWigOptions<T extends WigMatchableCandidate>(
  input: WigOptionInput<T>,
): WigOptionOutcome<T> {
  /*
   * 手工标注优先于推导：属性表里的那 17 条带更具体的信息（例如需要烫卷的款式必须用真人发），
   * 推导给不出这一层。目录里其余款式由推导兜住 —— 否则它们会被 fail closed 判死。
   * 这是「具体压过一般」的分层，不是两个真相来源：优先级是明确的、单向的。
   */
  const feasibilityOf =
    input.feasibilityOf ??
    ((name: string, candidate?: WigMatchableCandidate) =>
      wigFeasibilityFor(name) ?? (candidate ? deriveFeasibilityFromCatalog(candidate) : null));
  const offered = new Set((input.alreadyOfferedNames ?? []).map(identity));
  const gap = byModelPreference(
    input.blockedCandidates.filter((c) => !offered.has(identity(c.nameZh))),
    input.modelRankedNames,
  );

  if (gap.length === 0) return { open: false, closedReason: "no_gap", options: [], unmatched: [] };

  const options: WigOption<T>[] = [];
  const unmatched: WigUnmatched<T>[] = [];

  for (const candidate of gap) {
    const annotation = feasibilityOf(identity(candidate.nameZh), candidate);
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
    // 注意事项直接拼进标签，而不是另开一个字段让下游自己决定要不要显示——
    // 它的作用是防止用户买错，漏显示等于没有它。
    const achievementLabel = annotation.caveat
      ? `${ACHIEVEMENT_LABEL[tier]}（${annotation.caveat}）`
      : ACHIEVEMENT_LABEL[tier];
    options.push({ candidate, tier, achievementLabel });
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
  if (!input.userDeclaredHairConcern) return "no_user_declaration";
  // 入口上的「能解锁 N 款」必须是真实数字，为 0 时不显示入口。
  if (options.length === 0) return "no_feasible_option";
  return null;
}
