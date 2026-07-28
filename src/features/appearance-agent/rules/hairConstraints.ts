/**
 * 发际线/发量的组合过滤规则（design.md 决策 6，tasks 第 6 节）。
 *
 * 依据是客户端调研报告的实测数据（17 例）+ 云端视觉对比（10 例）：
 *   - `hairline: receding` 单独可靠：误报率 0/17，唯一真后移者被判出
 *   - `volume: thin` 单独**不可靠**：短发者被误判（正面照里"头发短"与"发量少"不可区分）
 *   - 两者同时命中才是强证据：短发不会抬高发际线，所以短发者不会同时命中
 *   - `hairline: occluded`（刘海遮挡）本地不可测，必须降级到云端语义或自报
 *
 * 合规边界：所有输出只表述为**造型可行性**（"这个发型需要的量感你不够"），
 * 绝不表述为**诊断结论**（"检测到你有脱发"）。
 */

export type HairlineSignal = "normal" | "high" | "receding" | "occluded";
export type VolumeSignal = "thin" | "medium" | "thick" | "unknown";

export type HairSignals = {
  /** 客户端 FaceMetrics 测得 */
  hairline: HairlineSignal;
  /** 客户端 FaceMetrics 测得。单独不可用，见文件头 */
  volume: VolumeSignal;
  /** 问卷自报（AppearanceProfile.hairLossConcern），evidence_basis=self_reported */
  selfReportedHairLossConcern?: boolean;
  /** 问卷自报发量 */
  selfReportedVolume?: "thin" | "medium" | "thick";
};

export type ConstraintStrength = "strong" | "moderate" | "none" | "deferred";

/**
 * 用户造型时**实际可动用**的发量前提（Available Volume Premise，定义见根仓库 CONTEXT.md）。
 *
 * `own_hair` —— 只算用户自己的头发，由 HairSignals 推导。
 * `ample`    —— 用户已显式授权外部补充发量（假发），发量支撑与发际线暴露两维不再是限制。
 *
 * 这个区分是「假发」在系统里的全部表达方式：**假发改变前提，不绕过约束**。
 * 所以这里没有第二套规则，只有同一个函数的两个前提；下游的 applyHairConstraint 一无所知。
 *
 * 注意 `ample` **只**放宽这两维。脸型适配不在本函数内，且假发改变不了脸型——
 * 放宽它只会产出永远无法转化成假发方案的候选。
 */
export type AvailableVolumePremise = "own_hair" | "ample";

export type HairConstraint = {
  strength: ConstraintStrength;
  /** 排除掉的 requiresHairVolume 档位 */
  excludeVolumeRequirements: ("low" | "medium" | "high")[];
  /** true 表示必须排除不遮额头的发型（大背头/飞机头/露额造型） */
  requireCoversForehead: boolean;
  /** 用于向用户解释的理由。已按合规要求写成造型可行性口径 */
  rationale: string;
  /** 证据基础，进规则引擎时作为 evidence_basis */
  evidenceBasis: "visual_detected" | "self_reported" | "visual_and_self_reported" | "none";
  /** true 表示本地信号不足，需要云端视觉语义判断兜底 */
  needsCloudFallback: boolean;
};

const NO_CONSTRAINT: HairConstraint = {
  strength: "none",
  excludeVolumeRequirements: [],
  requireCoversForehead: false,
  rationale: "发际线与发量没有需要特别规避的地方，发型选择不受此限制。",
  evidenceBasis: "none",
  needsCloudFallback: false,
};

/**
 * 前提为 ample 时的约束。发际线信号在这里**完全不被读取**，所以也不存在需要云端兜底的
 * 不确定性——`needsCloudFallback` 为 false 不是省略，是「没有东西要兜底」。
 */
const AMPLE_PREMISE: HairConstraint = {
  strength: "none",
  excludeVolumeRequirements: [],
  requireCoversForehead: false,
  rationale: "在补充发量的前提下，发量支撑与发际线位置都不再限制发型选择。",
  evidenceBasis: "none",
  needsCloudFallback: false,
};

function isReceded(h: HairlineSignal): boolean {
  return h === "high" || h === "receding";
}

/**
 * 计算发型过滤约束。
 *
 * 注意 `volume: thin` 单独出现时**返回无约束**——这不是遗漏，是实测结论：
 * 短发者会被误判为 thin（02-square 即为误判例），据此排除高发量需求发型
 * 会误伤大量短发用户。
 *
 * `premise` 缺省为 `own_hair`，即本函数原有的唯一行为；传 `ample` 表示用户已授权补充发量。
 */
export function computeHairConstraint(
  signals: HairSignals,
  premise: AvailableVolumePremise = "own_hair",
): HairConstraint {
  // 前提已充足时不读任何发量/发际线信号——信号只用来推断用户**自身**的发量。
  if (premise === "ample") return AMPLE_PREMISE;

  const { hairline, volume, selfReportedHairLossConcern, selfReportedVolume } = signals;

  // 刘海遮挡：本地测不到发际线，交云端语义判断或依赖自报
  if (hairline === "occluded") {
    // 自报有脱发困扰时，即使本地测不到也已有足够依据施加中约束
    if (selfReportedHairLossConcern || selfReportedVolume === "thin") {
      return {
        strength: "moderate",
        excludeVolumeRequirements: ["high"],
        requireCoversForehead: true,
        rationale:
          "你的刘海遮住了额头，我们无法从照片测量发际线位置；结合你自己填写的情况，优先推荐对发量要求不高、且能自然覆盖前额的发型。",
        evidenceBasis: "self_reported",
        needsCloudFallback: true,
      };
    }
    return {
      ...NO_CONSTRAINT,
      strength: "deferred",
      rationale: "你的刘海遮住了额头，无法从这张照片测量发际线，需要进一步判断后再给发型约束。",
      needsCloudFallback: true,
    };
  }

  const receded = isReceded(hairline);
  // 视觉发量与自报发量取"更保守"的一方：任一指向 thin 即视为 thin
  const volumeThin = volume === "thin" || selfReportedVolume === "thin";

  // 强约束：两个独立信号同时指向。短发者不会命中（短发不抬高发际线）
  if (receded && volumeThin) {
    const basis =
      volume === "thin" && selfReportedVolume === "thin"
        ? "visual_and_self_reported"
        : volume === "thin"
          ? "visual_detected"
          : "self_reported";
    return {
      strength: "strong",
      excludeVolumeRequirements: ["high"],
      requireCoversForehead: true,
      rationale:
        // 举例必须落在过滤器**真的会给出**的可行集里。原文举的是「短寸、textured crop」，
        // 而短寸露额、正被这条约束的 requireCoversForehead 剔除——
        // 等于告诉用户一个系统永远不会推荐的方向。
        "你的发际线位置偏高，同时整体发量偏少——需要靠蓬松堆叠撑起来的发型（如蓬松纹理烫）做出来达不到参考图的效果。" +
        "更稳的方向是微碎盖、法式碎盖、法式刘海短发这类不依赖量感、且能自然覆盖前额的发型。",
      evidenceBasis: basis,
      needsCloudFallback: false,
    };
  }

  // 中约束：只有发际线信号（这一条实测误报率 0/17）
  if (receded) {
    return {
      strength: "moderate",
      excludeVolumeRequirements: [],
      requireCoversForehead: true,
      rationale:
        "你的发际线位置偏高，把额头完全露出来的造型（大背头、飞机头）会更强调这一点。" +
        "碎盖、前刺、带刘海的方向会更修饰。",
      evidenceBasis: "visual_detected",
      needsCloudFallback: false,
    };
  }

  // 只有 volume=thin：实测不可靠（短发误判），不施加约束。
  // 但如果用户**自己**说发量少，那是 self_reported 证据，可以施加约束——
  // 用户对自己发量的主观感知本身就是决策依据。
  if (volume === "thin" && !selfReportedVolume && !selfReportedHairLossConcern) {
    return {
      ...NO_CONSTRAINT,
      rationale:
        "照片上看头发偏短，但正面照无法区分「头发短」和「发量少」，所以不据此限制发型。" +
        "如果你自己觉得发量偏少，可以在问卷里勾选，我们会据此调整推荐。",
    };
  }

  if (selfReportedVolume === "thin" || selfReportedHairLossConcern) {
    return {
      strength: "moderate",
      excludeVolumeRequirements: ["high"],
      requireCoversForehead: false,
      rationale:
        "根据你自己填写的发量情况，优先推荐对发量要求不高的发型——需要蓬松堆叠的款式做出来容易和参考图有差距。",
      evidenceBasis: "self_reported",
      needsCloudFallback: false,
    };
  }

  return NO_CONSTRAINT;
}

/** 发型所需的发量档位。与 Prisma 的 `HairVolumeRequirement` 枚举同值 */
export type HairVolumeRequirement = "low" | "medium" | "high";

export type FilterableHairstyle = {
  id: string;
  requiresHairVolume: HairVolumeRequirement;
  coversForehead: boolean;
};

/** 按约束过滤发型候选。返回保留项与被排除项（含原因，供解释文案使用）。 */
export function applyHairConstraint<T extends FilterableHairstyle>(
  candidates: T[],
  constraint: HairConstraint,
): { kept: T[]; excluded: { item: T; reason: string }[] } {
  const kept: T[] = [];
  const excluded: { item: T; reason: string }[] = [];

  for (const c of candidates) {
    if (constraint.excludeVolumeRequirements.includes(c.requiresHairVolume)) {
      excluded.push({ item: c, reason: `需要 ${c.requiresHairVolume} 档发量支撑，与你的发量情况不匹配` });
      continue;
    }
    if (constraint.requireCoversForehead && !c.coversForehead) {
      excluded.push({ item: c, reason: "属于露额造型，会更强调发际线位置" });
      continue;
    }
    kept.push(c);
  }

  return { kept, excluded };
}
