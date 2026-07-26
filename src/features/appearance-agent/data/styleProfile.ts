/**
 * 风格数据模型与兼容性计算。
 *
 * 核心设计（design.md 决策 2）：**协调性必须编码在数据里，不能靠 LLM 审美判断。**
 * LLM 的自由度在「从已保证兼容的集合里挑」，绝不在「判断什么和什么搭」。
 *
 * 实现方式是风格向量而非兼容矩阵——新增一个条目的标注成本是 O(1)（只打自己的分），
 * 矩阵是 O(n)（要和所有已有条目建关系）。后者与「建立大量数据」的目标平方级冲突。
 *
 * 数据本体由调研任务产出（见 docs/style-data-research-plan.md），本文件只定义
 * 结构与计算。
 */

// ---------------------------------------------------------------------------
// 风格向量
// ---------------------------------------------------------------------------

/** 四个审美轴，各 1-10。协调判定 = 各轴差值均在阈值内。 */
export type StyleVector = {
  /** 正式度：商务 ↔ 休闲。背头+西装 = 9；寸头+连帽卫衣 = 2 */
  formality: number;
  /** 成熟度：少年感 ↔ 沉稳。微碎盖+宽松T = 3；三七分+羊绒衫 = 8 */
  maturity: number;
  /** 张扬度：低调 ↔ 抓眼。黑素T+直筒裤 = 2；漂染+印花衬衫 = 9 */
  boldness: number;
  /** 维护成本：每天几分钟 ↔ 需定期打理。寸头 = 1；纹理烫+每天吹造型 = 8 */
  upkeep: number;
};

export const STYLE_VECTOR_DIMENSIONS = ["formality", "maturity", "boldness", "upkeep"] as const;

/**
 * 协调阈值：各维度差值 ≤ 此值才算兼容。
 * 未经真实数据校准，需上线后用用户实际选择行为回归调优（design.md Risks）。
 */
export function parseCompatibilityThreshold(value: string | undefined): number {
  const parsed = Number(value ?? "3");
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 9 ? parsed : 3;
}

export const DEFAULT_COMPATIBILITY_THRESHOLD = parseCompatibilityThreshold(
  process.env.STYLE_COMPATIBILITY_THRESHOLD,
);

/** 各维度差值均在阈值内即兼容。返回不兼容的维度便于解释与调参。 */
export function checkCompatibility(
  a: StyleVector,
  b: StyleVector,
  threshold = DEFAULT_COMPATIBILITY_THRESHOLD,
): { compatible: boolean; violations: { dimension: string; delta: number }[] } {
  const violations = STYLE_VECTOR_DIMENSIONS.map((d) => ({ dimension: d, delta: Math.abs(a[d] - b[d]) }))
    .filter((v) => v.delta > threshold);
  return { compatible: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 双审美评分
// ---------------------------------------------------------------------------

/**
 * 审美评分。**必须带来源与置信度**——这套数据是从调研整理出来的有偏先验，
 * 不是客观真理。对用户表述时用参考性口气（"在我们参考的数据里评分偏低"），
 * 不用断言口气（"女生不喜欢这个"）。
 */
export type AppealScore = {
  /** 1-10 */
  score: number;
  /** 数据来源。可信度分级：实证调研 > 平台内容聚合观察 > 单个 KOL 观点。禁止无来源。 */
  source: string;
  confidence: "high" | "medium" | "low";
  /** 为什么是这个分——这段文字是「暴露差距」功能向用户解释的原材料 */
  rationale: string;
};

/** 两套独立审美视角。两者背离本身就是产品要呈现给用户的核心信息。 */
export type DualAppeal = {
  /** 中国 15-30 岁女性审美视角 */
  femaleAppeal: AppealScore;
  /** 男性自身审美视角（他自己觉得好看/想要的） */
  maleSelfAppeal: AppealScore;
};

/** 目标群体：中国 18-26 岁男性（学生 → 初入职场） */
export type FaceShape = "oval" | "round" | "square" | "oblong" | "heart" | "diamond" | "pear";
export type BodyType = "lean" | "standard" | "heavy" | "pear" | "inverted_triangle";
export type Scene = "campus_daily" | "date" | "interview" | "social_gathering";

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

export type HairstyleEntry = {
  id: string;
  nameZh: string;
  /** 别称，供用户自由输入的词库归一化使用 */
  aliases: string[];
  description: string;
  styleVector: StyleVector;
  appeal: DualAppeal;
  /** 该发型需要多少发量支撑。与发际线信号组合后作为硬过滤（design.md 决策 6） */
  requiresHairVolume: "low" | "medium" | "high";
  /** 是否遮盖额头/发际线。发际线后移时排除 false 的条目 */
  coversForehead: boolean;
  suitableFaceShapes: FaceShape[];
  unsuitableFaceShapes: { shape: FaceShape; reason: string }[];
  estCostRange: string;
  estTime: string;
  maintenanceNotes: string;
  /** 必须是真实访问过的链接。宁可留空，不可编造。 */
  referenceUrls: { url: string; type: "article" | "video" | "image" }[];
};

export type OutfitComboEntry = {
  id: string;
  nameZh: string;
  /** 品类组合，不是具体可购买单品——可执行性由品类描述承载 */
  items: { category: string; colorFamily: string; fit: string; notes?: string }[];
  styleVector: StyleVector;
  appeal: DualAppeal;
  suitableBodyTypes: BodyType[];
  suitableScenes: Scene[];
  estCostRange: string;
  notes: string;
};

// ---------------------------------------------------------------------------
// 数据本体 —— 由调研任务填充
// ---------------------------------------------------------------------------

/**
 * ⚠ 故意留空。数据由调研任务产出（docs/style-data-research-plan.md），
 * 目标规模：发型 20-30 条、穿搭品类 30-50 条。
 *
 * 不放占位假数据——占位数据一旦混进去就很难和真实数据区分，而这套数据的
 * 可信度（每条都要有 source）是整个推荐引擎的地基。
 */
export const HAIRSTYLE_CATALOG: HairstyleEntry[] = [];
export const OUTFIT_COMBO_CATALOG: OutfitComboEntry[] = [];

// ---------------------------------------------------------------------------
// 组合与加权
// ---------------------------------------------------------------------------

export type StyleCombination = {
  hairstyle: HairstyleEntry;
  outfit: OutfitComboEntry;
  /** 组合的合成向量（取两者均值），用于与已完成变化做兼容性比对 */
  combinedVector: StyleVector;
};

/** 生成所有兼容组合。协调性在此被确定性保证，LLM 只从返回结果里挑。 */
export function buildCompatibleCombinations(
  hairstyles: HairstyleEntry[],
  outfits: OutfitComboEntry[],
  threshold = DEFAULT_COMPATIBILITY_THRESHOLD,
): StyleCombination[] {
  const out: StyleCombination[] = [];
  for (const h of hairstyles) {
    for (const o of outfits) {
      if (!checkCompatibility(h.styleVector, o.styleVector, threshold).compatible) continue;
      out.push({
        hairstyle: h,
        outfit: o,
        combinedVector: {
          formality: (h.styleVector.formality + o.styleVector.formality) / 2,
          maturity: (h.styleVector.maturity + o.styleVector.maturity) / 2,
          boldness: (h.styleVector.boldness + o.styleVector.boldness) / 2,
          upkeep: (h.styleVector.upkeep + o.styleVector.upkeep) / 2,
        },
      });
    }
  }
  return out;
}

/**
 * 双审美加权。按用户目标决定权重（design.md 决策 22 方案 E）：
 * 目标偏异性吸引（如约会场景）→ 女性视角权重高；目标偏自我认同 → 自身审美权重高。
 * 权重是显式参数而非隐式常量，因为要向用户展示"为什么这样推荐"。
 */
export function weightedAppeal(appeal: DualAppeal, femaleWeight: number): number {
  const w = Math.min(1, Math.max(0, femaleWeight));
  return appeal.femaleAppeal.score * w + appeal.maleSelfAppeal.score * (1 - w);
}

/**
 * 审美落差。这是产品的核心信息差——用户在别处拿不到。
 * 正值表示女性视角评分更高，负值表示用户自身审美评分更高（他喜欢但可能不讨喜）。
 */
export function appealGap(appeal: DualAppeal): number {
  return appeal.femaleAppeal.score - appeal.maleSelfAppeal.score;
}

/** 落差是否显著到值得主动向用户指出 */
export function isGapWorthDisclosing(appeal: DualAppeal, minGap = 3): boolean {
  return Math.abs(appealGap(appeal)) >= minGap;
}
